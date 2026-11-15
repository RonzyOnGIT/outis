import { DEFAULT_POLICY, type DetectOptions, type DictionaryEntry, type EntityType, type Span, type SpanSource } from '../types.js';
import { isPublicReference, isSensitiveDate, isUsefulQuantity } from './context.js';
import { findLinks, linkMentions, type Link } from './links.js';

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

/** Remembered values are suggestions, not the user's explicit Always hide overrides. */
export function detectKnownValues(text: string, entries: DictionaryEntry[] = []): Span[] {
  return detectDictionary(text, entries)
    .filter((s) => s.type !== 'ID' || completeIdentifierOccurrence(text, s.start, s.end))
    .map((s) => ({ ...s, source: 'propagated' }));
}

/** Do not remember/propagate a short ID into part of a longer ID or calendar date. */
function completeIdentifierOccurrence(text: string, start: number, end: number): boolean {
  const before = text[start - 1] ?? '';
  const after = text[end] ?? '';
  return !/[-/]/.test(before + after) &&
    !(before === '.' && /\w/.test(text[start - 2] ?? '')) &&
    !(after === '.' && /\w/.test(text[end + 1] ?? ''));
}

function sensitiveInContext(text: string, span: Span): boolean {
  if (span.source === 'dictionary') return true;
  if (span.type === 'DATE') return isSensitiveDate(text, span.start, span.end);
  // A remembered bare account number can later be an unrelated balance/quantity.
  // Structured identifiers (SSNs, tokens, etc.) retain their existing protection.
  if (span.type === 'ID' && span.source === 'propagated' && /^\d+$/.test(span.text)) {
    return !isUsefulQuantity(text, span.start, span.end);
  }
  return !isPublicReference(text, span);
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
        if (s.type === 'ID' && !completeIdentifierOccurrence(text, start, end)) continue;
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

  const links = findLinks(text);
  const insideLink = (s: Span) => links.some((l) => l.start <= s.start && s.end <= l.end);

  const filtered = candidates.filter((s) => {
    if (!policy[s.type] && !s.contains?.some((type) => policy[type])) return false;
    if (s.source === 'ner' && GENERIC_TERMS.test(s.text.trim())) return false;
    if (s.source === 'ner' && s.score < threshold) return false;
    // Domain and path words look like organisations and places to the name model ("google", "com").
    // Inside a link only a confident person name counts.
    if (s.source === 'ner' && insideLink(s) && (s.type !== 'PERSON' || s.score < LINK_NAME_SCORE)) return false;
    if (never.has(s.text.trim().toLowerCase())) return false;
    if (insidePlaceholder(s)) return false;
    if (!sensitiveInContext(text, s)) return false;
    return s.end > s.start;
  });
  // A name from Always hide (or a remembered name) can occur inside an address/token:
  // Alice Example → alice@example.com. Keep the complete identifier instead of leaving pieces
  // of it visible. Full dictionary matches still retain their normal priority.
  const completeIdentifiers = filtered.filter((s) => s.source === 'rule' &&
    ['EMAIL', 'URL', 'SECRET', 'CARD', 'IBAN', 'IP', 'PHONE', 'ID'].includes(s.type));
  const whole = filtered.filter((s) => s.source !== 'dictionary' || !completeIdentifiers.some((r) =>
    r.start <= s.start && r.end >= s.end && r.end - r.start > s.end - s.start));
  const resolved = propagate(text, removeOverlaps(whole));
  const hidden = resolved.filter((s) => !never.has(s.text.trim().toLowerCase()) && !insidePlaceholder(s) && sensitiveInContext(text, s));
  const intact = links.filter((l) => !placeholders.some(([a, b]) => l.start < b && a < l.end));
  return wholeLinks(text, hidden, intact, { policy, never, alwaysHide: opts.alwaysHide ?? [] });
}

/** Minimum name-model confidence for a person name found inside a link. */
const LINK_NAME_SCORE = 0.8;
const NAMED_TYPES = new Set<EntityType>(['PERSON', 'ORG', 'LOCATION', 'USER']);

/**
 * A link is one element: it is never left half replaced. A link that holds something personal
 * (an email, a token, a name, …) or that spells out a name hidden elsewhere in the text is hidden
 * as a whole; every other link stays exactly as written.
 */
function wholeLinks(
  text: string,
  spans: Span[],
  links: Link[],
  opts: { policy: Record<EntityType, boolean>; never: Set<string>; alwaysHide: DictionaryEntry[] },
): Span[] {
  if (!links.length) return spans;
  // Values hidden in this text, plus the user's own list: a profile link often is the name.
  const values = new Map<string, EntityType>();
  for (const s of spans) if (NAMED_TYPES.has(s.type)) values.set(s.text.trim().toLowerCase(), s.type);
  for (const e of opts.alwaysHide) {
    const value = e.value.trim().toLowerCase();
    if (value.length >= 2 && opts.policy[e.type] && !opts.never.has(value)) values.set(value, e.type);
  }

  let out = spans;
  for (const link of links) {
    const inside = out.filter((s) => s.start < link.end && link.start < s.end);
    if (inside.some((s) => s.start <= link.start && s.end >= link.end)) continue; // already hidden as a whole
    const keep = opts.never.has(link.text.toLowerCase());
    const contains = new Set<EntityType>(inside.flatMap((s) => s.contains ?? [s.type]));
    if (!inside.length && !keep) {
      for (const [value, type] of values) if (linkMentions(link.text, value, type === 'PERSON')) contains.add(type);
    }
    if (!contains.size) continue;
    out = out.filter((s) => !inside.includes(s));
    if (keep) continue;
    const start = Math.min(link.start, ...inside.map((s) => s.start));
    const end = Math.max(link.end, ...inside.map((s) => s.end));
    out.push({ start, end, type: 'URL', text: text.slice(start, end), source: 'rule', score: 1, contains: [...contains] });
  }
  return out.sort((a, b) => a.start - b.start);
}
