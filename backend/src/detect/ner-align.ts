import type { EntityType, Span } from '../types.js';

/**
 * Pure helpers that turn per-token NER predictions back into character spans.
 * Transformers.js does not expose token offsets, so we re-align WordPiece tokens
 * against the original text ourselves. Kept free of model code so it is unit-testable.
 */

export interface TokenPrediction {
  /** Raw WordPiece token, e.g. "Smith" or "##ers". */
  token: string;
  /** BIO label, e.g. "B-PER", "I-ORG", "O". */
  label: string;
  score: number;
}

const UNKNOWN_TOKENS = new Set(['[UNK]', '<unk>']);

/** Map each token to [start, end) in `text`, or null if it could not be located. */
export function alignTokens(text: string, tokens: string[]): Array<[number, number] | null> {
  let cursor = 0;
  return tokens.map((tok) => {
    if (UNKNOWN_TOKENS.has(tok)) {
      let start = cursor;
      while (start < text.length && /\s/.test(text[start]!)) start++;
      let end = start;
      while (end < text.length && !/\s/.test(text[end]!)) end++;
      if (end === start) return null;
      cursor = end;
      return [start, end];
    }
    const piece = tok.startsWith('##') ? tok.slice(2) : tok.replace(/^▁/, '');
    if (!piece) return null;
    const idx = text.indexOf(piece, cursor);
    // Tokens appear in order; a large jump means we lost sync, so skip this one.
    if (idx < 0 || idx - cursor > 24) return null;
    cursor = idx + piece.length;
    return [idx, cursor];
  });
}

/** Label tag (without B-/I-) → our entity type. Unknown tags are ignored. */
const TAG_TO_TYPE: Record<string, EntityType> = {
  PER: 'PERSON',
  PERSON: 'PERSON',
  GIVENNAME: 'PERSON',
  SURNAME: 'PERSON',
  ORG: 'ORG',
  LOC: 'LOCATION',
  GPE: 'LOCATION',
  CITY: 'LOCATION',
  STREET: 'ADDRESS',
  BUILDINGNUM: 'ADDRESS',
  ZIPCODE: 'ADDRESS',
  EMAIL: 'EMAIL',
  TELEPHONENUM: 'PHONE',
  USERNAME: 'USER',
  IDCARDNUM: 'ID',
  SOCIALNUM: 'ID',
  DRIVERLICENSENUM: 'ID',
  TAXNUM: 'ID',
  ACCOUNTNUM: 'ID',
  CREDITCARDNUMBER: 'CARD',
  DATEOFBIRTH: 'DATE',
  PASSWORD: 'SECRET',
};

function splitLabel(label: string): [string, string] {
  const m = /^([BIES])-(.+)$/.exec(label);
  return m ? [m[1]!, m[2]!] : ['I', label];
}

interface Word {
  start: number;
  end: number;
  label: string;
  score: number;
}

/**
 * Group token predictions into entity spans.
 * - WordPiece continuations ("##ers") join their word; a word takes its first token's label.
 * - Consecutive words with the same tag merge unless a new "B-" starts.
 */
export function groupPredictions(text: string, preds: TokenPrediction[], offset = 0): Span[] {
  const positions = alignTokens(text, preds.map((p) => p.token));
  const words: Word[] = [];
  preds.forEach((p, i) => {
    const pos = positions[i];
    if (!pos) return;
    const prev = words[words.length - 1];
    if (p.token.startsWith('##') && prev && prev.end === pos[0]) {
      prev.end = pos[1];
      return;
    }
    words.push({ start: pos[0], end: pos[1], label: p.label, score: p.score });
  });

  const spans: Span[] = [];
  let current: { tag: string; start: number; end: number; scores: number[] } | null = null;
  const flush = () => {
    if (!current) return;
    const type = TAG_TO_TYPE[current.tag.toUpperCase()];
    if (type) {
      const score = current.scores.reduce((a, b) => a + b, 0) / current.scores.length;
      spans.push({
        start: current.start + offset,
        end: current.end + offset,
        type,
        text: text.slice(current.start, current.end),
        source: 'ner',
        score,
      });
    }
    current = null;
  };

  for (const w of words) {
    if (w.label === 'O') {
      flush();
      continue;
    }
    const [prefix, tag] = splitLabel(w.label);
    const gap = current ? text.slice(current.end, w.start) : '';
    const contiguous = current !== null && /^[\s'’.-]{0,2}$/.test(gap);
    if (current && current.tag === tag && prefix !== 'B' && prefix !== 'S' && contiguous) {
      current.end = w.end;
      current.scores.push(w.score);
    } else {
      flush();
      current = { tag, start: w.start, end: w.end, scores: [w.score] };
    }
    if (prefix === 'E' || prefix === 'S') flush();
  }
  flush();
  return spans;
}

/** Split long text into model-sized chunks at paragraph/sentence boundaries. */
export function chunkText(text: string, maxChars = 1200): Array<{ text: string; offset: number }> {
  if (text.length <= maxChars) return [{ text, offset: 0 }];
  const chunks: Array<{ text: string; offset: number }> = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxChars, text.length);
    if (end < text.length) {
      const window = text.slice(start, end);
      const cut = Math.max(window.lastIndexOf('\n'), window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
      if (cut > maxChars * 0.5) end = start + cut + 1;
      else {
        const space = window.lastIndexOf(' ');
        if (space > maxChars * 0.5) end = start + space + 1;
      }
    }
    chunks.push({ text: text.slice(start, end), offset: start });
    start = end;
  }
  return chunks;
}
