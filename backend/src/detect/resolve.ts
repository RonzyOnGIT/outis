import { DEFAULT_POLICY, type DetectOptions, type DictionaryEntry, type EntityType, type Span, type SpanSource } from '../types.js';

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Case-insensitive, Unicode-aware whole-word search. */
export function findWord(text: string, term: string, caseSensitive = false): Array<[number, number]> {
  const trimmed = term.trim();
  if (trimmed.length < 2) return [];
  const re = new RegExp(`(?<![\\p{L}\\p{N}_])${escapeRegExp(trimmed)}(?![\\p{L}\\p{N}_])`, caseSensitive ? 'gu' : 'giu');
  const out: Array<[number, number]> = [];
  for (const m of text.matchAll(re)) out.push([m.index!, m.index! + m[0].length]);
  return out;
}

/** Spans for the user's "always hide" list. Person names also match each name part. */
export function detectDictionary(text: string, entries: DictionaryEntry[] = []): Span[] {
  const spans: Span[] = [];
  for (const entry of entries) {
    const terms = new Set<string>([entry.value.trim()]);
    if (entry.type === 'PERSON') {
      for (const part of entry.value.split(/\s+/)) if (part.length >= 3) terms.add(part);
    }
    for (const term of terms) {
      for (const [start, end] of findWord(text, term)) {
        spans.push({ start, end, type: entry.type, text: text.slice(start, end), source: 'dictionary', score: 1 });
      }
    }
  }
  return spans;
}

const SOURCE_RANK: Record<SpanSource, number> = { dictionary: 40, rule: 30, ner: 20, propagated: 10 };
const TYPE_RANK: Partial<Record<EntityType, number>> = {
  SECRET: 9,
  EMAIL: 8,
  CARD: 7,
  IBAN: 7,
  ID: 6,
  ADDRESS: 6,
  USER: 5,
  URL: 4,
  PHONE: 4,
  IP: 4,
  DATE: 3,
  PERSON: 3,
  ORG: 2,
  LOCATION: 2,
};

function rank(s: Span): number {
  return SOURCE_RANK[s.source] + (TYPE_RANK[s.type] ?? 0) + Math.min(s.end - s.start, 200) / 1000;
}

function overlaps(a: Span, b: Span): boolean {
  return a.start < b.end && b.start < a.end;
}

/** Greedy non-overlapping selection: highest-ranked span wins every conflict. */
export function removeOverlaps(spans: Span[]): Span[] {
  const accepted: Span[] = [];
  for (const s of [...spans].sort((a, b) => rank(b) - rank(a))) {
    if (!accepted.some((a) => overlaps(a, s))) accepted.push(s);
  }
  return accepted.sort((a, b) => a.start - b.start);
}

const PROPAGATE_TYPES = new Set<EntityType>(['PERSON', 'ORG', 'LOCATION', 'USER', 'ADDRESS', 'EMAIL', 'PHONE', 'ID']);

/**
 * If "Jonathan Smithers" was found once, hide every other mention too — including
 * "Smithers" alone. Models often miss the 2nd or 3rd mention of the same name.
 */
export function propagate(text: string, spans: Span[]): Span[] {
  const extra: Span[] = [];
  const seen = new Set<string>();
  for (const s of spans) {
    if (!PROPAGATE_TYPES.has(s.type)) continue;
    // Proper nouns are matched case-sensitively ("Will" the name vs "will" the verb).
    const caseSensitiveType = s.type === 'PERSON' || s.type === 'ORG' || s.type === 'LOCATION';
    const terms: Array<[string, boolean]> = [[s.text, caseSensitiveType]];
    if (s.type === 'PERSON') {
      for (const part of s.text.split(/\s+/)) {
        if (part.length >= 3 && /^\p{Lu}/u.test(part)) terms.push([part, true]);
      }
    }
    for (const [term, caseSensitive] of terms) {
      const key = `${s.type}:${term.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      for (const [start, end] of findWord(text, term, caseSensitive)) {
        extra.push({ start, end, type: s.type, text: text.slice(start, end), source: 'propagated', score: s.score });
      }
    }
  }
  return removeOverlaps([...spans, ...extra]);
}

/** Departments, roles and common acronyms that NER models like to tag as organisations. */
const GENERIC_TERMS =
  /^(?:HR|IT|PR|QA|PM|R&D|CEO|CFO|CTO|COO|CMO|CIO|VP|SVP|EVP|MRI|CT|ER|ICU|ED|PTO|FMLA|FAQ|PDF|AI|ML|API|SQL|ASAP|ETA|FYI|TBD|OK|USA|US|UK|EU|DMV|IRS|ATM|GP|ENT|OB|IV|PT|OT)$/i;

/**
 * Combine detections from every source into the final list of spans to hide:
 * apply the category policy and allowlist, resolve overlaps, propagate repeated mentions.
 */
export function resolveSpans(text: string, candidates: Span[], opts: DetectOptions = {}): Span[] {
  const policy = { ...DEFAULT_POLICY, ...opts.policy };
  const never = new Set((opts.neverHide ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean));
  const threshold = opts.nerThreshold ?? 0.6;

  // Text that was already cleaned contains "[PERSON_1]" etc. — never treat those as personal data.
  const placeholders = [...text.matchAll(/\[[A-Z]+_\d+\]/g)].map((m) => [m.index!, m.index! + m[0].length] as const);
  const insidePlaceholder = (s: Span) => placeholders.some(([a, b]) => s.start < b && a < s.end);

  const filtered = candidates.filter((s) => {
    if (!policy[s.type]) return false;
    if (s.source === 'ner' && GENERIC_TERMS.test(s.text.trim())) return false;
    if (s.source === 'ner' && s.score < threshold) return false;
    if (never.has(s.text.trim().toLowerCase())) return false;
    if (insidePlaceholder(s)) return false;
    return s.end > s.start;
  });
  const resolved = propagate(text, removeOverlaps(filtered));
  return resolved.filter((s) => !never.has(s.text.trim().toLowerCase()) && !insidePlaceholder(s));
}
