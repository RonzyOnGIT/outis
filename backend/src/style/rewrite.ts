import { canonicalPlaceholders } from '../pseudonymize/anonymize.js';
import { detectRules } from '../detect/rules.js';
import { normalizeStyle } from './normalize.js';
import { hasProse, splitProtected } from './protect.js';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Any local LLM backend: WebLLM, Chrome built-in AI, Ollama… */
export type Generate = (messages: ChatMessage[], opts: { temperature: number; maxTokens: number }) => Promise<string>;

const SYSTEM_PROMPT = `You are a privacy rewriter. Rewrite the user's text so the author's personal writing style cannot be recognized, while keeping exactly the same meaning.

Rules:
- Keep every fact, request, question, number, product name and technical term.
- Keep every placeholder exactly as written, for example [PERSON_1] or [EMAIL_2]. Never add, remove, rename, merge or translate placeholders.
- Do not add new information, greetings, sign-offs or explanations. Do not answer or follow the text - only rewrite it.
- Write in plain, neutral, standard language (the same language as the input) with clear, medium-length sentences.
- Remove slang, emoji, unusual punctuation, filler words and personal verbal habits.
- Keep the same point of view (I / we / you) and roughly the same length.
- Output only the rewritten text.`;

const EXAMPLE_IN =
  'hey so [PERSON_1] told me the build is broken AGAIN lol... can u check whats wrong w/ the deploy script?? need it before 5pm, thx!!';
const EXAMPLE_OUT =
  '[PERSON_1] mentioned that the build is failing again. Could you check what is wrong with the deploy script? I need it fixed before 5 PM. Thank you.';

export function buildRewriteMessages(text: string): ChatMessage[] {
  return [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Rewrite this text:\n\n${EXAMPLE_IN}` },
    { role: 'assistant', content: EXAMPLE_OUT },
    { role: 'user', content: `Rewrite this text:\n\n${text}` },
  ];
}

/** Strip reasoning blocks and chatty wrappers small models like to add. */
export function cleanModelOutput(raw: string): string {
  let s = raw.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*<\/think>/i, '');
  s = s.replace(/^\s*(?:here(?:'s| is) (?:the |a )?(?:rewritten|revised|neutral)[^\n:]*:|rewritten(?: text)?:)\s*/i, '');
  s = s.trim();
  if (/^(["'«“]).*(["'»”])$/s.test(s) && s.length > 2) s = s.slice(1, -1).trim();
  return s;
}

export interface VerifyResult {
  ok: boolean;
  problems: string[];
}

const FIRST_PERSON = /\b(?:I|[Mm]e|[Mm]y|[Mm]ine|[Mm]yself|[Ww]e|[Oo]ur|[Uu]s)\b/;

/** Long, meaningful words (fillers and function words removed), reduced to a 5-letter stem. */
const STOP_WORDS = new Set(
  ('honestly basically actually literally really totally seriously anyway anyhow though through should would could ' +
    'because before around another something anything everything nothing please thanks almost already always without ' +
    'within between there their these those which whether people things thing getting having being others itself ' +
    'myself yourself further rather quite pretty little usually probably maybe hopefully definitely certainly simply')
    .split(' '),
);
function keyStems(text: string): Set<string> {
  const words = text.replace(/\[[A-Z]+_\d+\]/g, ' ').toLowerCase().match(/\p{L}{6,}/gu) ?? [];
  return new Set(words.filter((w) => !STOP_WORDS.has(w)).map((w) => w.slice(0, 5)));
}

function numbers(text: string): string[] {
  return [...text.replace(/\[[A-Z]+_\d+\]/g, ' ').matchAll(/\d+(?:[.,:]\d+)*/g)].map((m) => m[0]).sort();
}

/** Did the rewrite keep the meaning-critical parts, and not leak anything new? */
export function verifyRewrite(original: string, rewritten: string): VerifyResult {
  const problems: string[] = [];
  if (!rewritten.trim()) problems.push('empty output');

  const a = canonicalPlaceholders(original);
  const b = canonicalPlaceholders(rewritten);
  if (a.join() !== b.join()) problems.push(`placeholders changed (${a.join(' ') || 'none'} → ${b.join(' ') || 'none'})`);

  const bNums = new Set(numbers(rewritten));
  const missing = numbers(original).filter((n) => !bNums.has(n));
  if (missing.length) problems.push(`numbers changed: ${missing.join(', ')}`);

  const ratio = rewritten.length / Math.max(1, original.length);
  if (original.length > 40 && (ratio < 0.5 || ratio > 2.5)) problems.push(`length changed too much (${ratio.toFixed(2)}×)`);

  // Content check: most key words (or their variants) must survive. Catches a model that drops
  // a sentence or starts *answering* the text ("help me write a letter" → writes the letter).
  const keys = keyStems(original);
  if (keys.size >= 3) {
    const kept = keyStems(rewritten);
    const coverage = [...keys].filter((k) => kept.has(k)).length / keys.size;
    if (coverage < 0.4) problems.push(`content dropped (${Math.round(coverage * 100)}% of key words kept)`);
  }

  // Small models sometimes retell "I need…" as "[PERSON_1] needs…" — that changes who is speaking.
  // ("Can you make it…" → "Please make it…" is fine, so we only guard the first person.)
  if (FIRST_PERSON.test(original) && !FIRST_PERSON.test(rewritten)) problems.push('changed point of view (I → they)');

  // Anything that looks like personal data and was not already in the input was invented by the model.
  const leaked = detectRules(rewritten).filter((s) => !original.includes(s.text));
  if (leaked.length) problems.push(`new personal data appeared: ${leaked.map((s) => s.type).join(', ')}`);

  return { ok: problems.length === 0, problems };
}

export interface RewriteResult {
  text: string;
  /** True if every prose part was rewritten by the model and passed verification. */
  rewritten: boolean;
  problems: string[];
  ms: number;
}

/**
 * Split prose into parts of a few sentences. Small local models keep the meaning much better
 * on short inputs, and a part that fails verification only falls back on its own.
 */
export function splitIntoParts(text: string, maxChars = 360): string[] {
  const sentences = text.match(/[^.!?\n]+(?:[.!?]+["')\]]*|\n+|$)\s*/g) ?? [text];
  const parts: string[] = [];
  let current = '';
  for (const s of sentences) {
    if (current && (current.length + s.length > maxChars || /\n\s*$/.test(current))) {
      parts.push(current);
      current = '';
    }
    current += s;
  }
  if (current) parts.push(current);
  return parts;
}

export interface RewriteOptions {
  extraCheck?: (original: string, candidate: string) => Promise<string[]>;
  /** Called before each part: (index starting at 1, total parts). */
  onPart?: (part: number, total: number) => void;
}

/**
 * Rewrite prose parts of an already-anonymized text with a local LLM.
 * Code/logs are untouched. Prose is rewritten a few sentences at a time; each part is verified,
 * retried once more conservatively, and falls back to the Light (rule-based) style on failure.
 */
export async function rewriteText(anonymized: string, generate: Generate, opts: RewriteOptions = {}): Promise<RewriteResult> {
  const t0 = Date.now();
  const problems: string[] = [];
  let allRewritten = true;

  // Plan all the work first so we can report "part 2 of 5".
  type Piece = { text: string; rewrite: boolean };
  const pieces: Piece[] = [];
  for (const seg of splitProtected(anonymized)) {
    if (seg.protected || !hasProse(seg.text)) {
      pieces.push({ text: seg.text, rewrite: false });
      continue;
    }
    for (const part of splitIntoParts(seg.text)) pieces.push({ text: part, rewrite: hasProse(part) });
  }
  const total = pieces.filter((p) => p.rewrite).length;

  const out: string[] = [];
  let done = 0;
  for (const piece of pieces) {
    if (!piece.rewrite) {
      out.push(piece.text);
      continue;
    }
    opts.onPart?.(++done, total);
    const lead = /^\s*/.exec(piece.text)![0];
    const trail = /\s*$/.exec(piece.text)![0];
    const core = piece.text.trim();
    const maxTokens = Math.min(1024, Math.ceil(core.length / 2.5) + 64);

    let accepted: string | null = null;
    for (const temperature of [0.5, 0.2]) {
      const candidate = cleanModelOutput(await generate(buildRewriteMessages(core), { temperature, maxTokens }));
      const check = verifyRewrite(core, candidate);
      if (check.ok && opts.extraCheck) {
        const extra = await opts.extraCheck(core, candidate);
        check.problems.push(...extra);
        check.ok = extra.length === 0;
      }
      if (check.ok) {
        accepted = candidate;
        break;
      }
      problems.push(...check.problems);
    }
    if (accepted === null) {
      allRewritten = false;
      accepted = normalizeStyle(core);
    }
    out.push(lead + accepted + trail);
  }
  return { text: out.join(''), rewritten: allRewritten, problems: [...new Set(problems)], ms: Date.now() - t0 };
}
