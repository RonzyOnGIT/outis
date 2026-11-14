import { ENTITY_TYPES, type Span } from '../types.js';
import { Vault, type VaultEntry } from './vault.js';

export interface Replacement {
  span: Span;
  placeholder: string;
  /** Position of the placeholder in the anonymized output. */
  outStart: number;
  outEnd: number;
}

export interface AnonymizeResult {
  text: string;
  replacements: Replacement[];
}

/**
 * Replace each span with its vault placeholder. The vault is mutated (new entries are added);
 * pass `vault.clone()` for previews you might throw away.
 */
export function anonymize(text: string, spans: Span[], vault: Vault): AnonymizeResult {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let out = '';
  let cursor = 0;
  const replacements: Replacement[] = [];
  for (const span of sorted) {
    if (span.start < cursor) continue; // overlapping input; first one wins
    out += text.slice(cursor, span.start);
    const placeholder = vault.assign(span.type, span.text);
    replacements.push({ span, placeholder, outStart: out.length, outEnd: out.length + placeholder.length });
    out += placeholder;
    cursor = span.end;
  }
  out += text.slice(cursor);
  return { text: out, replacements };
}

const TYPE_ALT = ENTITY_TYPES.join('|');
/**
 * Matches placeholders in the forms an AI tends to echo them back:
 * "[PERSON_1]", "\[PERSON_1\]" (markdown-escaped), "[Person_1]", "[PERSON 1]" and bare "PERSON_1".
 */
const PLACEHOLDER_RE = new RegExp(String.raw`\\?\[\s*(${TYPE_ALT})[ _-]?(\d+)\s*\\?\]|\b(${TYPE_ALT})_(\d+)\b`, 'gi');

export interface PlaceholderMatch {
  start: number;
  end: number;
  placeholder: string;
  entry?: VaultEntry;
}

export function findPlaceholders(text: string, vault?: Vault): PlaceholderMatch[] {
  const out: PlaceholderMatch[] = [];
  PLACEHOLDER_RE.lastIndex = 0;
  for (const m of text.matchAll(PLACEHOLDER_RE)) {
    const type = (m[1] ?? m[3])!.toUpperCase();
    // Bare form must be upper-case to avoid touching normal prose like "person_1" in code.
    if (m[3] && m[3] !== type) continue;
    const placeholder = `[${type}_${m[2] ?? m[4]}]`;
    const entry = vault?.byPlaceholder(placeholder);
    if (vault && !entry) continue;
    out.push({ start: m.index!, end: m.index! + m[0].length, placeholder, entry });
  }
  return out;
}

/** Put real values back in place of placeholders (e.g. in an AI answer). */
export function restore(text: string, vault: Vault): string {
  const matches = findPlaceholders(text, vault);
  if (!matches.length) return text;
  let out = '';
  let cursor = 0;
  for (const m of matches) {
    out += text.slice(cursor, m.start) + m.entry!.value;
    cursor = m.end;
  }
  return out + text.slice(cursor);
}

/** Exact placeholders ("[TYPE_N]") in canonical form — used to verify rewrites kept them all. */
export function canonicalPlaceholders(text: string): string[] {
  return [...text.matchAll(new RegExp(String.raw`\[(?:${TYPE_ALT})_\d+\]`, 'g'))].map((m) => m[0]).sort();
}
