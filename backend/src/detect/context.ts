import type { Span } from '../types.js';

/** Local context only: a private fact in one sentence must not taint an unrelated sentence. */
export function nearbyContext(text: string, start: number, end: number): { before: string; after: string; clause: string } {
  let before = text.slice(Math.max(0, start - 240), start);
  let after = text.slice(end, end + 160);
  // A full stop between sentences, but not D.O.B., Dr., Jan., or a decimal/date separator.
  const boundaries = /[;!?\n]|\.(?=\s+\S)/g;
  let cut = 0;
  for (const m of before.matchAll(boundaries)) {
    if (m[0] === '.' && /(?:\b(?:dr|mr|mrs|ms|st|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)|d\.o\.b)$/i.test(before.slice(0, m.index))) continue;
    cut = m.index! + 1;
  }
  const afterLineBreak = before[cut - 1] === '\n';
  const preceding = before.slice(0, cut).trimEnd();
  before = before.slice(cut);
  // Form labels are often on their own line/paragraph after PDF/DOCX extraction.
  const previousLine = preceding.split(/[\n;!?]/).pop() ?? '';
  if (afterLineBreak && !before.trim() && !/\d/.test(previousLine) && (/[:=]$/.test(previousLine) || dateField(previousLine) !== undefined)) before = previousLine + '\n' + before;
  after = after.split(/[;!?\n]|\.(?=\s+\S)/)[0]!;
  return { before, after, clause: before + text.slice(start, end) + after };
}

function normalLabel(value: string): string {
  return value.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]/g, ' ').replace(/["'*:]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

const BIRTH = /\b(?:d\.?o\.?b\.?|birth(?:\s*(?:date|day|year))?|date\s*of\s*birth|born)\b/i;
const BIOGRAPHICAL = /\b(?:date of (?:death|marriage)|death date|marriage date)\b/i;
const MEDICAL = /\b(?:mri|ct scan|surgery|operation|diagnos(?:is|ed)|treatment|admi(?:ssion|tted)|discharg(?:e|ed)|medical appointment|doctor'?s? appointment|patient visit|procedure date)\b/i;
const EXPIRY = /\b(?:exp(?:iry|iration)?(?:\s*date)?|expires?|expired|expiring|valid\s*(?:thru|through|until|to))\b/i;
const CREDENTIAL = /\b(?:card|passport|visa|driver'?s? licen[cs]e|identity|id card|residen(?:ce|cy) permit|work permit|credential|access token|api key)\b/i;
const NON_PERSONAL_EXPIRY = /\b(?:milk|food|yog[hu]urt|bread|coupon|promotion|promo|offer|sale|trial|warranty|product|subscription|software|ssl|tls|certificate)\b/i;
const USEFUL_DATE = /\b(?:deadline|due(?:\s*date)?|invoice|statement|report|project|meeting|conference|workshop|webinar|lecture|training|event|festival|holiday|launch|release|publication|published|lease|rent|delivery|shipment|shipping|arrival|departure|renewal reminder)\b/i;

/** True/false for a recognized field label; undefined for an ordinary cell or prose. */
function dateField(label: string): boolean | undefined {
  const value = normalLabel(label);
  if (value.length > 80) return undefined;
  if (BIRTH.test(value) || BIOGRAPHICAL.test(value)) return true;
  if (USEFUL_DATE.test(value) || NON_PERSONAL_EXPIRY.test(value)) return false;
  if (MEDICAL.test(value) || /^(?:appointment|visit|procedure|treatment|admission|discharge) date$/.test(value)) return true;
  if (EXPIRY.test(value) || (CREDENTIAL.test(value) && /\b(?:issued?|date|valid)\b/.test(value))) return true;
  return undefined;
}

interface Cell { value: string; start: number; end: number; }
/** Read a single CSV/TSV/table row without treating quoted commas as column separators. */
function rowCells(line: string, delimiter: string): Cell[] {
  const cells: Cell[] = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i <= line.length; i++) {
    if (line[i] === '"') {
      if (quoted && line[i + 1] === '"') { i++; continue; }
      quoted = !quoted;
    }
    if (i === line.length || (!quoted && line[i] === delimiter)) {
      cells.push({ value: line.slice(start, i).trim().replace(/^"|"$/g, '').replace(/""/g, '"'), start, end: i });
      start = i + 1;
    }
  }
  return cells;
}

/** Associate a value with its own JSON key, form label, or table column. */
function fieldContext(text: string, start: number, end: number, classify: (label: string) => boolean | undefined): boolean | undefined {
  const before = text.slice(Math.max(0, start - 140), start);
  const json = /["']([\w ._-]+)["']\s*:\s*["']?[^"',{}]*$/.exec(before);
  if (json) return classify(json[1]!) ?? false;
  const form = /(?:^|[\n,;])\s*([\p{L}][\p{L} ._'-]{1,65})\s*[:=]\s*$/u.exec(before);
  if (form) return classify(form[1]!) ?? false;
  // Extracted form labels may be on their own line without a colon.
  const previousLine = /(?:^|\n)([^\n]+)\n\s*$/.exec(before)?.[1];
  if (previousLine && !/[\d,\t|]/.test(previousLine)) {
    const field = classify(previousLine);
    if (field !== undefined) return field;
  }

  const lineStart = text.lastIndexOf('\n', start - 1) + 1;
  const nextNewline = text.indexOf('\n', end);
  const line = text.slice(lineStart, nextNewline < 0 ? text.length : nextNewline);
  // Do not interpret commas in prose dates as a table unless a matching header exists.
  const delimiter = line.includes('\t') ? '\t' : line.includes('|') ? '|' : line.includes(',') ? ',' : null;
  if (!delimiter) return undefined;
  const cells = rowCells(line, delimiter);
  const column = cells.findIndex((cell) => cell.start <= start - lineStart && cell.end >= end - lineStart);
  if (column < 0) return undefined;
  // Two-column key/value forms: DOB | 1991-03-14.
  const nonempty = cells.filter((c) => c.value);
  if (nonempty.length === 2 && nonempty[1] === cells[column]) {
    const label = classify(nonempty[0]!.value);
    if (label !== undefined) return label;
  }
  // A bounded header lookup handles CSV and extracted spreadsheet rows, including blank separators.
  const lines = text.slice(Math.max(0, lineStart - 12_000), lineStart).split('\n').filter((l) => l.trim()).slice(-100);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]!.includes(delimiter)) break;
    const header = rowCells(lines[i]!, delimiter);
    if (header.length !== cells.length) break;
    // A wrapped prose/data row (e.g. "$1,450 ... Union, routing") is not a column header.
    if (header.some((c) => /[$€£]|\d{4,}|^\d/.test(c.value))) continue;
    const labels = header.map((c) => classify(c.value));
    if (labels.some((v) => v !== undefined)) return labels[column] ?? false;
  }
  return undefined;
}

function lastCue(text: string, pattern: RegExp): number {
  let at = -1;
  for (const m of text.matchAll(new RegExp(pattern.source, 'gi'))) at = m.index! + m[0].length;
  return at;
}

/** Dates are identifying only when linked to a personal fact or credential. */
export function isSensitiveDate(text: string, start: number, end: number): boolean {
  const { before, after, clause } = nearbyContext(text, start, end);
  const field = fieldContext(text, start, end, dateField);
  if (field !== undefined) return field;
  const sensitive = Math.max(lastCue(before, BIRTH), lastCue(before, BIOGRAPHICAL), lastCue(before, MEDICAL));
  const useful = lastCue(before, USEFUL_DATE);
  if (sensitive >= 0 && sensitive > useful && before.length - sensitive <= 120) return true;
  // Product expiry is harmless, but an unrelated product word must not override a DOB/medical field.
  if (NON_PERSONAL_EXPIRY.test(clause) && !CREDENTIAL.test(clause) && !BIRTH.test(clause)) return false;
  const expiry = lastCue(before, EXPIRY);
  if (expiry >= 0 && expiry > useful && before.length - expiry <= 80 && (CREDENTIAL.test(clause) || /^\s*exp(?:iry|iration)?(?: date)?\s*[:=]?\s*$/i.test(before))) return true;
  if (CREDENTIAL.test(clause) && /\b(?:issued?|valid from|issue date)\b[^.;!?\n]{0,50}$/i.test(before) && useful < lastCue(before, CREDENTIAL)) return true;
  if (useful >= 0) return false;
  // Associate postfixed labels too: "1991-03-14 (DOB)" / "04/28 is my card's expiry".
  const trailingLabel = /^\s*(?:[,(–—-]\s*|(?:is|was)\s+(?:(?:my|his|her|their|the)\s+)?)([^.;!?]{0,70})/i.exec(after)?.[1];
  return trailingLabel && !/\d/.test(trailingLabel) ? dateField(trailingLabel) === true : false;
}

const PERSONAL_RELATION = new RegExp(String.raw`\b(?:` + [
  String.raw`(?:my|our|his|her|their|your)\s+(?:(?:full|current|former|previous|new|old)\s+)?(?:name|address|home|residence|hometown|birthplace|employer|company|business|office|job|workplace|school|university|bank|insurer|hospital|clinic|doctor|manager|boss|colleague|coworker|client|customer|patient|tenant|landlord|spouse|wife|husband|partner|mother|father|parent|child|son|daughter|friend|account|claim|policy)`,
  String.raw`(?:work(?:s|ed|ing)?|employed|hired|intern(?:s|ed|ing)?|stud(?:y|ies|ied)|bank(?:s|ed|ing)?|liv(?:e|es|ed|ing)|resid(?:e|es|ed|ing))\s+(?:in|at|for|with|by)`,
  String.raw`(?:i am|i'm|we are|we're)\s+(?:from|in|based in|located in|employed by)`,
  String.raw`(?:i|we|he|she|they)\s+(?:(?:recently|previously|just)\s+)?(?:joined|left|resigned from)`,
  String.raw`where\s+(?:i|we|he|she|they)\s+(?:live|lives|work|works|study|studies)`,
  String.raw`(?:hired|employs?|contacted|diagnosed|treated)\s+(?:me|us)`,
  String.raw`(?:pays?|paid)\s+(?:my|our|his|her|their)\s+salary`,
  String.raw`(?:rejected|accepted|denied|approved)\s+(?:my|our|his|her|their)\s+(?:application|claim|request|loan)`,
  String.raw`(?:employer|patient|tenant|landlord|home address|residence|employee name|customer name|full name)\s*[:=]`,
].join('|') + ')', 'i');
const PUBLIC_REFERENCE = /\b(?:weather|forecast|climate|capital|population|geography|history|historical|biography|touris[mt]|attractions|time zone|headquarters|founded|announced|news about|stock price|market cap|pricing|documentation|tutorial|compare|comparison|versus|vs\.?|difference between|tell me about|learn about|information about|explain|what (?:is|are)|who (?:is|was|are)|how (?:does|do)|when (?:did|was)|where (?:is|are)|(?:plan|planning) (?:a |my )?(?:trip|visit)|(?:things|places) to (?:do|see|visit))\b/i;
const PUBLIC_SUFFIX = /^(?:['’]s)?\s+(?:weather|forecast|climate|population|history|pricing|documentation|tutorial|versus|vs\.?|compared (?:to|with)|(?:was|is) (?:founded|the capital|headquartered))\b/i;
const PERSONAL_FIELD = /^(?:(?:current|former|previous) )?(?:employer|company|workplace|bank|insurer|school|university|hospital|clinic|doctor|manager|client|customer|patient|tenant|landlord|home address|residence|hometown|birthplace)(?: name)?$/i;
// These used to be an unconditional Never hide list. They are public only without a personal link.
const PUBLIC_PRODUCTS = new Set(('ChatGPT OpenAI Claude Anthropic Gemini Copilot Google Microsoft Apple Amazon GitHub GitLab Jira Slack Zoom Teams Excel Word PowerPoint Outlook Gmail Python JavaScript TypeScript Java React Node Linux Windows macOS iOS Android AWS Azure Docker Kubernetes Chrome Firefox Safari iPhone SQL API').toLowerCase().split(' '));

/** Explicit Always hide entries are handled by the caller and never relaxed here. */
export function isPublicReference(text: string, span: Span): boolean {
  if (!['ORG', 'LOCATION'].includes(span.type)) return false;
  if (fieldContext(text, span.start, span.end, (label) => PERSONAL_FIELD.test(normalLabel(label)) ? true : undefined)) return false;
  const { before, after, clause } = nearbyContext(text, span.start, span.end);
  if (PERSONAL_RELATION.test(clause)) return false;
  // A cue must introduce or directly describe this reference, not belong to a later question.
  return PUBLIC_REFERENCE.test(before) || PUBLIC_SUFFIX.test(after) || PUBLIC_PRODUCTS.has(span.text.trim().toLowerCase());
}

const IDENTIFIER = /\b(?:ssn|social security|itin|tax id|tin|passport|driver'?s? licen[cs]e|national id|id number|routing|iban|(?:member|policy|account|acct|patient|employee|student|customer|client|claim|case|reference|ref)\s*(?:id|number|no\.?|num|#))\b/i;
const QUANTITY = /\b(?:balance|price|cost|amount|salary|rent|deposit|budget|deductible|fee|payment|revenue|rate|quantity|count|total|duration|covers|coverage|limit|deadline|due|invoice date)\b/i;

/** Explicit identifier fields stay sensitive even when adjacent cells describe money or dates. */
const IDENTIFIER_FIELD = new RegExp('^(?:' + [
  String.raw`(?:(?:bank|ach|aba) )?routing(?: transit)?(?: number| no\.?| num| code)?`,
  String.raw`(?:aba|rtn|iban|vin|ssn)(?: number| no\.?| num)?`,
  String.raw`social security(?: number)?`,
  String.raw`(?:licen[cs]e plate|number plate|vehicle registration|registration plate|plate)(?: number| no\.?| num| id)?`,
  String.raw`(?:passport|driver'?s? licen[cs]e)(?: number| no\.?| num| id)?`,
  String.raw`(?:lease|contract|agreement|account|acct|member|policy|employee|student|customer|client|patient|order|ticket|claim|case)(?: number| no\.?| num| id)`,
].join('|') + ')$', 'i');

export function hasIdentifierField(text: string, start: number, end: number): boolean {
  return fieldContext(text, start, end, (label) => {
    const normalized = normalLabel(label).replace(/\s*\([^)]{0,40}\)\s*/g, ' ').trim();
    return IDENTIFIER_FIELD.test(normalized) ? true : undefined;
  }) === true;
}

/** Positive quantity context can release a remembered numeric ID without releasing unlabeled repeats. */
export function isUsefulQuantity(text: string, start: number, end: number): boolean {
  if (hasIdentifierField(text, start, end)) return false;
  const { before, after } = nearbyContext(text, start, end);
  return lastCue(before, QUANTITY) > lastCue(before, IDENTIFIER) ||
    /^\s*(?:(?:dollars|usd|eur|gbp|items|units|requests|packets|records|days|weeks|months|years|visits|mg|kg|km|miles|percent|ms)\b|%)/i.test(after);
}

/** A nearby account/claim keyword alone does not make a balance, price or quantity an ID. */
export function hasIdentifierContext(text: string, start: number, end: number): boolean {
  const { before } = nearbyContext(text, start, end);
  const identifying = lastCue(before, IDENTIFIER);
  if (isUsefulQuantity(text, start, end)) return false;
  return (identifying >= 0 && before.length - identifying <= 80) || /\b(?:account|acct|policy|member|claim|case|reference|ref)\s*(?:is|[:#=])?\s*$/i.test(before);
}
