import type { EntityType, Span } from '../types.js';
import { digitsOnly, ibanValid, luhnValid, shannonEntropy } from './validators.js';
import { hasIdentifierContext, hasIdentifierField, isSensitiveDate } from './context.js';
import { dateCandidates } from './dates.js';

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
  // SSN / ITIN shape. We don't reject "invalid" ranges (9xx = ITIN, etc.) — any such number is sensitive.
  { name: 'us-ssn', type: 'ID', pattern: /(?<![\d-])\d{3}-\d{2}-\d{4}(?![\d-])/dg },
  {
    name: 'labelled-id',
    type: 'ID',
    pattern:
      /\b(?:passport|ssn|social\s+security|driver'?s?\s+licen[cs]e|licen[cs]e|employee|student|customer|member|client|patient|account|acct|policy|tax|national|personal|order|ticket|lease|contract|agreement)\s*(?:id|no\.?|number|num|#)\s*(?:is\s*)?[:=#]?\s*([A-Z0-9][A-Z0-9-]{3,24})\b/dgi,
    group: 1,
    validate: (v) => /\d/.test(v),
  },
  {
    name: 'bank-routing',
    type: 'ID',
    // A strong label spans PDF line wraps. Never require a checksum: mistyped/test IDs are private too.
    pattern: /\b(?:(?:bank|ach|aba)\s+)?(?:routing(?:[\s_-]+transit)?(?:[\s_-]*(?:number|num|no\.?|code|#))?|aba(?:[\s_-]+transit)?(?:[\s_-]*(?:number|num|no\.?|#))?|rtn)\b["']?\s*(?:is\s*)?[:=#]?\s*["']?(\d(?:[\s-]*\d){8})(?!\d)/dgi,
    group: 1,
  },
  {
    name: 'vehicle-identifier',
    type: 'ID',
    pattern: /\b(?:licen[cs]e[\s_-]*plate|number[\s_-]*plate|registration[\s_-]*plate|vehicle[\s_-]*registration|vin)(?:[\s_-]*(?:number|num|no\.?|id|#))?\b["']?\s*(?:is\s*)?[:=#]?\s*["']?([A-Z]{1,4}[ -]\d{1,4}|[A-Z]{1,3}\d{1,3}[ \t][A-Z]{1,3}|[A-Z0-9][A-Z0-9-]{0,16})\b(?![\w-])/dgi,
    group: 1,
    validate: (value, text, start, end) => {
      if (/^(?:number|renewal|registration|fee|fees|cost|costs|format|formats|design|color|colour|state|expired|expires|stolen|missing|unknown|none|pending)$/i.test(value)) return false;
      // Permit vanity plates in explicit fields and uppercase prose, without mistaking ordinary prose for one.
      return /\d/.test(value) || value === value.toUpperCase() || hasIdentifierField(text, start, end);
    },
  },
  {
    name: 'identifier-field',
    type: 'ID',
    // JSON keys / CSV-TSV headers / standalone form labels; explicit fields outrank date/quantity exceptions.
    pattern: /(?<![\p{L}\p{N}_$./-])[A-Z0-9][A-Z0-9-]{0,24}(?![\p{L}\p{N}_/-])/dgiu,
    validate: (value, text, start, end) =>
      (/\d/.test(value) || (value.length >= 2 && value === value.toUpperCase())) && hasIdentifierField(text, start, end),
  },
  { name: 'mac-address', type: 'ID', pattern: /\b(?:[0-9A-Fa-f]{2}[:-]){5}[0-9A-Fa-f]{2}\b/dg },

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
      String.raw`\b\d{1,5}[A-Za-z]?\s+(?:(?:N|S|E|W|NE|NW|SE|SW)\.?\s+)?(?:[A-Z][a-zA-Z'.-]+\s+){1,4}` +
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

const SSN_CONTEXT = /\b(?:ssn|social security|itin|tax id|tin)\b/i;

/**
 * Second pass: numbers that are only identifiable because of what's written before them
 * ("HR asked for my SSN for the leave paperwork, it's 912 48 3365"). Looks back up to 80 chars.
 */
const CONTEXTUAL: Recognizer[] = [
  {
    name: 'ssn-spaced-near-keyword',
    type: 'ID',
    pattern: /(?<!\d)(?<!\d )\d{3} \d{2} \d{4}(?! ?\d)/dg,
    validate: (_v, text, start) => SSN_CONTEXT.test(text.slice(Math.max(0, start - 80), start)),
  },
  {
    name: 'id-near-keyword',
    type: 'ID',
    pattern: /(?<![\w$.,/-])[A-Z0-9][A-Z0-9-]{4,24}(?![\w/-])/dgi,
    validate: (v, text, start, end) => {
      const digits = v.replace(/\D/g, '').length;
      if (digits < 4 || /^\d{1,2}[-/]\d{1,2}$/.test(v)) return false;
      if (/^(?:19|20)\d{2}$/.test(v)) return false; // a year
      return hasIdentifierContext(text, start, end);
    },
  },
];

function runRecognizers(text: string, recognizers: Recognizer[]): Span[] {
  const spans: Span[] = [];
  for (const r of recognizers) {
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

/** Run every pattern recognizer over `text`. Overlaps are resolved later by `resolveSpans`. */
export function detectRules(text: string): Span[] {
  const dates = dateCandidates(text);
  const first = [...runRecognizers(text, RECOGNIZERS), ...dates.filter((s) => isSensitiveDate(text, s.start, s.end))];
  // A useful calendar date near an account keyword must not come back as a contextual ID.
  const second = runRecognizers(text, CONTEXTUAL).filter((s) => ![...first, ...dates].some((f) => s.start < f.end && f.start < s.end));
  return [...first, ...second];
}
