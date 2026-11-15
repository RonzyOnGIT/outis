/**
 * Nobody's style step: the Outis neutralizer (plain, everyday voice for everyone) wrapped with
 * Nobody's protections:
 *  - code fences and code/log/stack-trace lines are never touched;
 *  - inside prose, inline `code`, links, emails and file names are masked as [CODE_n] so the rules
 *    can't alter them and the model must copy them back exactly;
 *  - model sentences also pass Nobody's privacy check (no new personal data, no invented names).
 */
import { detectRules } from '../detect/rules.js';
import { createNeutralizer, neutralizeRules, type NeutralizeMode, type NeutralizeResult } from './neutralizer.js';
import { CODE_LINE } from './protect.js';
import type { Generate, RewriteResult } from './rewrite.js';

type Block = { text: string; prose: boolean };

/** Fenced code and code-like lines are kept verbatim; consecutive other lines form prose blocks. */
function splitBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const push = (t: string, prose: boolean) => {
    if (!t) return;
    const last = blocks[blocks.length - 1];
    if (last && last.prose === prose) last.text += t;
    else blocks.push({ text: t, prose });
  };
  let cursor = 0;
  for (const m of text.matchAll(/```[\s\S]*?(?:```|$)/g)) {
    for (const line of text.slice(cursor, m.index).split(/(?<=\n)/)) push(line, !CODE_LINE.test(line.replace(/\n$/, '')));
    push(m[0], false);
    cursor = m.index! + m[0].length;
  }
  for (const line of text.slice(cursor).split(/(?<=\n)/)) push(line, !CODE_LINE.test(line.replace(/\n$/, '')));
  return blocks;
}

const MASK_RE = /`[^`\n]+`|(?:https?:\/\/|www\.)\S+[^\s.,;:!?)\]]|[\w.+-]+@[\w-]+\.[\w.-]+|\S*[\p{L}\p{N}_][./\\][\p{L}\p{N}_]\S*/gu;

function mask(text: string): { masked: string; restore: (s: string) => string } {
  const kept: string[] = [];
  const masked = text.replace(MASK_RE, (m) => {
    if (/^\[[A-Z]+_\d+\]$/.test(m) || /^(?:e\.g\.|i\.e\.|etc\.)$/i.test(m)) return m;
    kept.push(m);
    return `[CODE_${kept.length}]`;
  });
  return { masked, restore: (s) => s.replace(/\[CODE_(\d+)\]/g, (t, n: string) => kept[Number(n) - 1] ?? t) };
}

function eachProse(text: string, fn: (prose: string) => string): string {
  return splitBlocks(text)
    .map((b) => {
      if (!b.prose || !/\p{L}{2,}/u.test(b.text)) return b.text;
      const lead = /^\s*/.exec(b.text)![0];
      const trail = /\s*$/.exec(b.text)![0];
      const { masked, restore } = mask(b.text.trim());
      return lead + restore(fn(masked)) + trail;
    })
    .join('');
}

/** "Light" style: the neutralizer's rules only. Instant, synchronous, never changes facts. */
export function neutralizeLight(text: string): string {
  return eachProse(text, neutralizeRules);
}

export interface NeutralOptions {
  /** all: every sentence goes to the model (most neutral); auto: only sentences rules can't finish. */
  mode?: NeutralizeMode;
  batchSize?: number;
  /** Extra privacy check on model sentences (e.g. NER "invented names"). */
  extraCheck?: (original: string, rewrite: string) => Promise<string[]>;
  onProgress?: (done: number, total: number) => void;
}

/** "AI" style: the neutralizer with a local model, checked sentence by sentence. */
export async function neutralizeWithModel(text: string, generate: Generate, opts: NeutralOptions = {}): Promise<RewriteResult & { stats: NeutralizeResult['stats'][] }> {
  const t0 = Date.now();
  const blocks = splitBlocks(text);
  const proseBlocks = blocks.filter((b) => b.prose && /\p{L}{2,}/u.test(b.text));
  const problems: string[] = [];
  const stats: NeutralizeResult['stats'][] = [];
  let fellBack = 0;
  let doneBefore = 0;
  const totalSentences = Math.max(1, proseBlocks.length); // refined per block below

  const out: string[] = [];
  for (const b of blocks) {
    if (!proseBlocks.includes(b)) {
      out.push(b.text);
      continue;
    }
    const lead = /^\s*/.exec(b.text)![0];
    const trail = /\s*$/.exec(b.text)![0];
    const { masked, restore } = mask(b.text.trim());
    const neutralizer = createNeutralizer({
      generate,
      mode: opts.mode ?? 'all',
      batchSize: opts.batchSize ?? 4,
      extraCheck: async (original, rewrite) => {
        // No personal data that wasn't already there (the model must not invent emails, phones, …).
        const leaked = detectRules(rewrite).filter((s) => !original.includes(s.text));
        const found = leaked.length ? [`do not add personal details (${leaked.map((s) => s.type.toLowerCase()).join(', ')})`] : [];
        return found.concat(opts.extraCheck ? await opts.extraCheck(original, rewrite) : []);
      },
      onProgress: (e) => opts.onProgress?.(doneBefore + e.done, doneBefore + e.total),
    });
    const r = await neutralizer.neutralize(masked);
    doneBefore += r.stats.sentences;
    stats.push(r.stats);
    fellBack += r.stats.fellBack;
    for (const u of r.units) problems.push(...u.problems);
    out.push(lead + restore(r.text) + trail);
  }
  void totalSentences;
  return { text: out.join(''), rewritten: fellBack === 0, problems: [...new Set(problems)], ms: Date.now() - t0, stats };
}
