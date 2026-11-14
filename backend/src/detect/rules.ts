import type { EntityType, Span } from '../types.js';
import { digitsOnly, ibanValid, luhnValid, shannonEntropy } from './validators.js';

/**
 * Pattern recognizers, modelled on Microsoft Presidio's approach:
 * a regex finds candidates, an optional validator (checksum, context words, shape)
 * rejects false positives. All of this is synchronous and runs in well under a millisecond
 * for a typical chat message, so it is also safe to call from a content script.
 */
interface Recognizer {
  name: string;
  type: EntityType;
  /** Must have the `g` and `d` flags. */
  pattern: RegExp;
  /** Capture group holding the sensitive value (defaults to the whole match). */
  group?: number;
  validate?: (value: string, text: string, start: number, end: number) => boolean;
}

const CONTEXT_WINDOW = 32;

function hasContext(text: string, start: number, words: RegExp): boolean {
  const before = text.slice(Math.max(0, start - CONTEXT_WINDOW), start);
  return words.test(before);
}

const PHONE_CONTEXT = /(phone|tel|call|mobile|cell|whats\s?app|signal|telegram|fax|contact|text me|reach me|номер|телефон)\W*$/i;

const STREET_SUFFIX =
  '(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl|Terrace|Ter|Parkway|Pkwy|Circle|Cir|Highway|Hwy|Square|Sq|Trail|Trl)';

const RECOGNIZERS: Recognizer[] = [
  // --- Secrets first: they often contain things that look like other entities. ---
  {
    name: 'private-key',
    type: 'SECRET',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/dg,
  },
  { name: 'aws-key', type: 'SECRET', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/dg },
  { name: 'github-token', type: 'SECRET', pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/dg },
  { name: 'llm-api-key', type: 'SECRET', pattern: /\bsk-(?:proj-|ant-[a-z0-9]+-)?[A-Za-z0-9_-]{20,}/dg },
  { name: 'slack-token', type: 'SECRET', pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/dg },
  { name: 'google-api-key', type: 'SECRET', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/dg },
  { name: 'stripe-key', type: 'SECRET', pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/dg },
  { name: 'jwt', type: 'SECRET', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/dg },
  { name: 'bearer', type: 'SECRET', pattern: /\bBearer\s+([A-Za-z0-9._~+/-]{16,}=*)/dg, group: 1 },
  {
    name: 'assigned-secret',
    type: 'SECRET',
    pattern:
      /\b(?:password|passwd|pwd|pass|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret|auth)\b["']?\s*[:=]\s*["']?([^\s"',;]{6,})/dgi,
    group: 1,
    validate: (v) => !/^(?:true|false|null|none|undefined|\*+|x+)$/i.test(v) && (shannonEntropy(v) >= 2.5 || /\d/.test(v)),
  },
  {
    name: 'connection-string-password',
    type: 'SECRET',
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:([^\s@/]{3,})@/dgi,
    group: 1,
  },

  // --- Contact details ---
  { name: 'email', type: 'EMAIL', pattern: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/dg },
  {
    name: 'url',
    type: 'URL',
    pattern: /\b(?:https?:\/\/|www\.)[^\s<>"'`]+[^\s<>"'`.,;:!?)\]}]/dgi,
  },

  // --- Financial ---
  {
    name: 'card',
    type: 'CARD',
    pattern: /(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/dg,
    validate: (v) => {
      const d = digitsOnly(v);
      return d.length >= 13 && d.length <= 19 && luhnValid(d) && !/^(\d)\1+$/.test(d);
    },
  },
  {
    name: 'iban',
    type: 'IBAN',
    pattern: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){2,7}(?: ?[A-Z0-9]{1,4})?\b/dg,
    validate: (v) => ibanValid(v),
  },

  // --- Government / account IDs ---
  { name: 'us-ssn', type: 'ID', pattern: /\b(?!000|666|9\d\d)\d{3}-(?!00)\d{2}-(?!0000)\d{4}\b/dg },
  {
    name: 'labelled-id',
    type: 'ID',
    pattern:
      /\b(?:passport|ssn|social security|driver'?s? licen[cs]e|licen[cs]e|employee|student|customer|member|client|patient|account|acct|policy|tax|national|personal|order|ticket)\s*(?:id|no\.?|number|num|#)\s*(?:is\s*)?[:#]?\s*([A-Z0-9][A-Z0-9-]{3,24})\b/dgi,
    group: 1,
    validate: (v) => /\d/.test(v),
  },
  { name: 'mac-address', type: 'ID', pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/dg },

  // --- Dates of birth (plain dates are usually harmless) ---
  {
    name: 'birth-date',
    type: 'DATE',
    pattern:
      /\b(?:dob|d\.o\.b\.|date of birth|born(?: on)?|birthday(?: is)?)\s*[:-]?\s*(\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2}|(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]*\.? \d{1,2}(?:st|nd|rd|th)?,? \d{4}|\d{1,2}(?:st|nd|rd|th)? (?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)[a-z]* \d{4})/dgi,
    group: 1,
  },

  // --- Network ---
  {
    name: 'ipv4',
    type: 'IP',
    pattern: /(?<!\d)(?<!\d\.)(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(?!\d)(?!\.\d)/dg,
    validate: (v) => v !== '127.0.0.1' && v !== '0.0.0.0' && v !== '255.255.255.255',
  },
  {
    name: 'ipv6',
    type: 'IP',
    pattern: /(?<![\w:])(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{1,4}(?![\w:])/dg,
    validate: (v) => v.split(':').some((g) => g.length >= 3 || /[a-f]/i.test(g)),
  },

  // --- Usernames leaking through file paths ---
  {
    name: 'path-username',
    type: 'USER',
    pattern: /(?:\/Users\/|\/home\/|[A-Za-z]:\\(?:Users|Documents and Settings)\\)([A-Za-z0-9._-]+)/dg,
    group: 1,
    validate: (v) => !/^(?:shared|public|default|guest|runner|root|admin|user|username|me|you|\$user|%username%)$/i.test(v),
  },

  // --- Street addresses (US/UK/EU-style "123 Main Street, Springfield, IL 62704") ---
  {
    name: 'street-address',
    type: 'ADDRESS',
    pattern: new RegExp(
      String.raw`\b\d{1,5}[A-Za-z]?\s+(?:[A-Z][a-zA-Z'.-]+\s+){1,4}` +
        STREET_SUFFIX +
        String.raw`\b\.?(?:,?\s+(?:Apt|Apartment|Suite|Ste|Unit|Fl|Floor|#)\.?\s*[\w-]+)?` +
        String.raw`(?:,\s*[A-Z][a-zA-Z]+(?:\s[A-Z][a-zA-Z]+){0,2})?(?:,?\s*[A-Z]{2})?(?:\s+\d{5}(?:-\d{4})?)?`,
      'dg',
    ),
  },
  {
    name: 'phone',
    type: 'PHONE',
    pattern: /(?<![\w.+/-])(?:\+\d{1,3}[\s.-]?)?(?:\(\d{1,4}\)[\s.-]?)?\d{2,4}(?:[\s.-]?\d{2,4}){1,4}(?![\w.-]*\d)/dg,
    validate: (v, text, start) => {
      const d = digitsOnly(v);
      if (d.length < 7 || d.length > 15) return false;
      if (/^\d{4}-\d{2}-\d{2}$/.test(v) || /^\d{1,2}[./-]\d{1,2}[./-]\d{2,4}$/.test(v)) return false; // dates
      if (/^(\d)\1+$/.test(d)) return false;
      const strongShape = v.startsWith('+') || /^\(\d+\)/.test(v) || /^\d{3}[\s.-]\d{3}[\s.-]\d{4}$/.test(v);
      if (strongShape && d.length >= 9) return true;
      if (hasContext(text, start, PHONE_CONTEXT)) return true;
      return d.length >= 10 && /[\s.-]/.test(v);
    },
  },
];

/** Run every pattern recognizer over `text`. Overlaps are resolved later by `resolveSpans`. */
export function detectRules(text: string): Span[] {
  const spans: Span[] = [];
  for (const r of RECOGNIZERS) {
    r.pattern.lastIndex = 0;
    for (const m of text.matchAll(r.pattern)) {
      const g = r.group ?? 0;
      const value = m[g];
      const indices = m.indices?.[g];
      if (!value || !indices) continue;
      const [start, end] = indices;
      if (r.validate && !r.validate(value, text, start, end)) continue;
      spans.push({ start, end, type: r.type, text: value, source: 'rule', score: 1 });
    }
  }
  return spans;
}
