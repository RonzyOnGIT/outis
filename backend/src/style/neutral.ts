/**
 * Nobody's style step: the Outis neutralizer (plain, everyday voice for everyone) wrapped with
 * Nobody's protections:
 *  - code fences and code/log/stack-trace lines are never touched;
 *  - inside prose, inline `code`, links, emails and file names are masked as [CODE_n] so the rules
 *    can't alter them and the model must copy them back exactly;
 *  - model sentences also pass Nobody's privacy check (no new personal data, no invented names).
 */
import { findLinks } from '../detect/links.js';
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

const INLINE_CODE = /`[^`\n]+`/g;
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
/** File names, paths, versions, dotted names: a letter or digit on both sides of ".", "/" or "\". */
const DOTTED = /\S*[\p{L}\p{N}_][./\\][\p{L}\p{N}_]\S*/gu;
const CLOSING: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** The part of a whitespace-delimited token that is the name itself, without sentence punctuation. */
function trimToken(token: string): [number, number] {
  let start = 0;
  let end = token.length;
  while (start < end && '([{<"\'“‘'.includes(token[start]!)) start++;
  // "p.m." and "U.S." end in their own dot.
  if (/^(?:\p{L}{1,3}\.){2,}$/u.test(token.slice(start))) return [start, end];
  for (;;) {
    const last = token[end - 1];
    if (end <= start || last === undefined) break;
    const open = CLOSING[last];
    const body = token.slice(start, end);
    if ('.,;:!?"\'”’>'.includes(last) || (open && body.split(last).length > body.split(open).length)) end--;
    else break;
  }
  return [start, end];
}

/**
 * Hide everything the style step must copy exactly — inline code, links, emails, file names —
 * behind [CODE_n]. A link is one element: its words are never rewritten, and punctuation that
 * follows it belongs to the sentence, not to the link.
 */
function mask(text: string): { masked: string; restore: (s: string) => string } {
  const ranges: Array<[number, number]> = [];
  const add = (start: number, end: number) => {
    if (end > start && !ranges.some(([a, b]) => start < b && a < end)) ranges.push([start, end]);
  };
  for (const m of text.matchAll(INLINE_CODE)) add(m.index!, m.index! + m[0].length);
  for (const link of findLinks(text)) add(link.start, link.end);
  for (const m of text.matchAll(EMAIL)) add(m.index!, m.index! + m[0].length);
  for (const m of text.matchAll(DOTTED)) {
    if (/^(?:e\.g\.|i\.e\.|etc\.)[,;:]?$/i.test(m[0])) continue;
    const [from, to] = trimToken(m[0]);
    add(m.index! + from, m.index! + to);
  }
  ranges.sort((a, b) => a[0] - b[0]);

  const kept: string[] = [];
  let masked = '';
  let cursor = 0;
  for (const [start, end] of ranges) {
    kept.push(text.slice(start, end));
    masked += text.slice(cursor, start) + `[CODE_${kept.length}]`;
    cursor = end;
  }
  masked += text.slice(cursor);
  return {
    masked,
    // "at 5 p.m." gets a sentence period after the mask: do not write "p.m..".
    restore: (s) =>
      s.replace(/\[CODE_(\d+)\](\.?)/g, (t, n: string, dot: string) => {
        const value = kept[Number(n) - 1];
        if (value === undefined) return t;
        return value.endsWith('.') ? value : value + dot;
      }),
  };
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
