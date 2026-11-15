import type { Span } from '../types.js';

const MONTHS = 'January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec';
const MONTH_NUMBERS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DATE = new RegExp(String.raw`(?<![\p{L}\p{N}_./-])(?:` +
  String.raw`(?:${MONTHS})\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?` +
  String.raw`|\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+(?:${MONTHS})\.?(?:,?\s+\d{4})?` +
  String.raw`|\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?` +
  String.raw`|\d{1,2}([/.-])\d{1,2}\1(?:\d{4}|\d{2})` +
  String.raw`|(?:${MONTHS})\.?\s+\d{4}|\d{4}-\d{2}` +
  String.raw`|\d{1,2}[/.-](?:\d{4}|\d{2})|(?:18|19|20)\d{2}` +
  String.raw`)(?![\p{L}\p{N}_/]|[.-]\d)`, 'dgiu');

function dayValid(year: number | undefined, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const leap = year === undefined || (year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0));
  return day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
}

function valid(value: string): boolean {
  let m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (m) return dayValid(Number(m[1]), Number(m[2]), Number(m[3]));
  m = /^(\d{1,2})([/.-])(\d{1,2})\2(\d{2}|\d{4})$/.exec(value);
  if (m) {
    const year = m[4]!.length === 2 ? 2000 + Number(m[4]) : Number(m[4]);
    return dayValid(year, Number(m[1]), Number(m[3])) || dayValid(year, Number(m[3]), Number(m[1]));
  }
  const month = MONTH_NUMBERS.findIndex((name) => value.toLowerCase().includes(name)) + 1;
  if (month) {
    const numbers = value.match(/\d+/g)!.map(Number);
    if (numbers.length === 1 && numbers[0]! > 31) return true; // Month/year expiry
    return dayValid(numbers[1], month, numbers[0]!);
  }
  m = /^(\d{4})-(\d{2})$/.exec(value);
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12;
  m = /^(\d{1,2})[/.-](\d{2}|\d{4})$/.exec(value);
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= 12;
  return /^(?:18|19|20)\d{2}$/.test(value);
}

/** Candidates include harmless dates so other number recognizers cannot relabel them as IDs. */
export function dateCandidates(text: string): Span[] {
  DATE.lastIndex = 0;
  return [...text.matchAll(DATE)].filter((m) => valid(m[0])).map((m) => {
    // Leave a sentence's final period intact, including a month abbreviation at the end.
    const value = m[0].replace(/\.$/, '');
    return { start: m.index!, end: m.index! + value.length, text: value, type: 'DATE', source: 'rule', score: 1 };
  });
}
