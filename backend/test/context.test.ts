import { describe, expect, it } from 'vitest';
import { anonymize, detectDictionary, detectKnownValues, detectRules, resolveSpans, Vault, type DetectOptions, type EntityType, type Span } from '../src/index.js';

function clean(text: string, extra: Span[] = [], options: DetectOptions = {}): string {
  return anonymize(text, resolveSpans(text, [...detectRules(text), ...extra, ...detectDictionary(text, options.alwaysHide)], options), new Vault()).text;
}
function entity(text: string, value: string, type: EntityType, start = text.indexOf(value)): Span {
  return { start, end: start + value.length, text: value, type, score: 0.99, source: 'ner' };
}

describe('contextual dates', () => {
  it.each([
    ['DOB: 03/14/1991.', '03/14/1991'],
    ['Date of birth: 14.03.1991', '14.03.1991'],
    ['D.O.B. March 14th, 1991', 'March 14th, 1991'],
    ['I was born on 1991-03-14.', '1991-03-14'],
    ['Birth year: 1991', '1991'],
    ['My birthday is on the 14th of March.', '14th of March'],
    ['DOB\n\n1991-03-14', '1991-03-14'],
    ['1991-03-14 (DOB)', '1991-03-14'],
    ['My credit card expires 04/28.', '04/28'],
    ['Card valid thru 04/2028', '04/2028'],
    ['Card expiration: April 2028', 'April 2028'],
    ['Expiration date:\n04/28', '04/28'],
    ['Card expiry\n04/28', '04/28'],
    ['04/28 is my card expiry.', '04/28'],
    ['My passport expires on 2030-04-14.', '2030-04-14'],
    ['Passport issued 2021-02-18', '2021-02-18'],
    ['Driver license valid until 2030-04-14', '2030-04-14'],
    ['MRI on September 22 at noon', 'September 22'],
    ['Surgery date: 2026-05-20', '2026-05-20'],
    ['Date of marriage: June 12, 2021', 'June 12, 2021'],
  ])('hides a personal or credential date: %s', (input, value) => {
    expect(clean(input)).toBe(input.replace(value, '[DATE_1]'));
  });

  it.each([
    'The deadline is November 30, 2026.',
    'Invoice date: 2026-11-30. Payment due 12/15/2026.',
    'The conference is on September 22.',
    'How many days are between 2026-01-01 and 2026-02-01?',
    'The lease starts 2026-04-01 and ends 2027-03-31.',
    'My account statement is dated 2026-11-30.',
    'Milk expires 04/28. Coupon expiration: 2026-04-28.',
    'The software certificate expires 2027-05-20.',
    'The credit card payment deadline is April 28, 2028.',
    'The passport application deadline is March 14, 2028.',
    'The surgery conference is on September 22.',
    'Meeting Friday. Deadline tomorrow. Version v2.14.3 takes 1500 ms.',
  ])('keeps a useful general date/number: %s', (input) => {
    expect(clean(input)).toBe(input);
  });

  it('associates dates with their nearest context instead of the entire message', () => {
    const text = 'DOB 1991-03-14, invoice date 2026-11-30; MRI on September 22, deadline Nov 30, 2026. Meeting 03/14/1991.';
    expect(clean(text)).toBe('DOB [DATE_1], invoice date 2026-11-30; MRI on [DATE_2], deadline Nov 30, 2026. Meeting 03/14/1991.');
  });

  it.each([
    ['{"dateOfBirth":"1991-03-14","dueDate":"2026-11-30"}', '{"dateOfBirth":"[DATE_1]","dueDate":"2026-11-30"}'],
    ['{"dateOfBirth":"1991-03-14","created_at":"2026-11-30"}', '{"dateOfBirth":"[DATE_1]","created_at":"2026-11-30"}'],
    ['DOB: 1991-03-14, Updated: 2026-11-30', 'DOB: [DATE_1], Updated: 2026-11-30'],
    ['Name,DOB,Deadline\nAlice,1991-03-14,2026-11-30\nBob,1988-04-21,2027-01-02', 'Name,DOB,Deadline\nAlice,[DATE_1],2026-11-30\nBob,[DATE_2],2027-01-02'],
    ['Name\tBirth date\tInvoice date\nAlice\t1991-03-14\t2026-11-30', 'Name\tBirth date\tInvoice date\nAlice\t[DATE_1]\t2026-11-30'],
    ['DOB,Status\n1991-03-14,trial', 'DOB,Status\n[DATE_1],trial'],
    ['Deadline,DOB\n2026-11-30,1991-03-14', 'Deadline,DOB\n2026-11-30,[DATE_1]'],
    ['| DOB | Due date |\n| --- | --- |\n| 1991-03-14 | 2026-11-30 |', '| DOB | Due date |\n| --- | --- |\n| [DATE_1] | 2026-11-30 |'],
    ['"DOB","Deadline"\n"March 14, 1991","November 30, 2026"', '"DOB","Deadline"\n"[DATE_1]","November 30, 2026"'],
    ['DOB\t1991-03-14\nDeadline\t2026-11-30', 'DOB\t[DATE_1]\nDeadline\t2026-11-30'],
  ])('uses form/table field context: %s', (input, expected) => {
    expect(clean(input)).toBe(expected);
  });

  it('does not interpret impossible dates or version fragments as birth dates', () => {
    expect(clean('DOB: 2025-02-31; DOB: 31/13/2025; birth version v2.14.3')).toBe('DOB: 2025-02-31; DOB: 31/13/2025; birth version v2.14.3');
  });
});

describe('public references and personal relationships', () => {
  it.each([
    ['What is the weather in Paris?', 'Paris', 'LOCATION'],
    ['Compare Microsoft and Google.', 'Microsoft', 'ORG'],
    ['Compare Microsoft and Google.', 'Google', 'ORG'],
    ['Explain the history of Acme Corporation.', 'Acme Corporation', 'ORG'],
    ['Plan a trip to Tokyo.', 'Tokyo', 'LOCATION'],
    ['Paris weather in November', 'Paris', 'LOCATION'],
    ['Acme Corporation vs Contoso', 'Acme Corporation', 'ORG'],
    ['Acme Corporation was founded in 1980.', 'Acme Corporation', 'ORG'],
    ['Use Excel to calculate the invoice total.', 'Excel', 'ORG'],
  ] as const)('keeps a public reference: %s', (input, value, type) => {
    expect(clean(input, [entity(input, value, type)])).toBe(input);
  });

  it.each([
    ['I work at Google.', 'Google', 'ORG'],
    ['My employer is Microsoft.', 'Microsoft', 'ORG'],
    ['I live in Paris. What is the weather like?', 'Paris', 'LOCATION'],
    ['My home is in Paris; compare the weather.', 'Paris', 'LOCATION'],
    ['What is the weather in Paris, where I live?', 'Paris', 'LOCATION'],
    ['Explain why my employer Google denied my leave.', 'Google', 'ORG'],
    ['Employer: Google', 'Google', 'ORG'],
    ['Employer\nGoogle', 'Google', 'ORG'],
    ['{"employer":"Google"}', 'Google', 'ORG'],
    ['Name\tEmployer\nAlice\tGoogle', 'Google', 'ORG'],
    ['My former employer was Google.', 'Google', 'ORG'],
    ['Jane works at Google.', 'Google', 'ORG'],
    ['I am employed at Microsoft.', 'Microsoft', 'ORG'],
    ['I recently joined Google.', 'Google', 'ORG'],
    ['Google pays my salary.', 'Google', 'ORG'],
    ['Explain why Google rejected my application.', 'Google', 'ORG'],
    ['My doctor is Alice Example. What is the weather in Paris?', 'Alice Example', 'PERSON'],
    ['Tell me about Alice Example.', 'Alice Example', 'PERSON'],
  ] as const)('keeps personal references protected: %s', (input, value, type) => {
    expect(clean(input, [entity(input, value, type)])).toBe(input.replace(value, `[${type}_1]`));
  });

  it('does not propagate a private location/employer over a separate public question', () => {
    const text = 'I live in Paris. What is the weather in Paris? My employer is Google. Compare Google and Microsoft.';
    expect(clean(text, [entity(text, 'Paris', 'LOCATION'), entity(text, 'Google', 'ORG')]))
      .toBe('I live in [LOCATION_1]. What is the weather in Paris? My employer is [ORG_1]. Compare Google and Microsoft.');
  });
  it('recognizes sentence boundaries in lowercase chat text', () => {
    const text = 'i live in paris. what is the weather in paris?';
    expect(clean(text, [entity(text, 'paris', 'LOCATION')])).toBe('i live in [LOCATION_1]. what is the weather in paris?');
  });

  it('does not relax direct identifiers because a sentence mentions a public topic', () => {
    const text = 'Compare Google: email alice@example.com, phone +1 (415) 555-0132, card 4111 1111 1111 1111, SSN 123-45-6789.';
    expect(clean(text)).toBe('Compare Google: email [EMAIL_1], phone [PHONE_1], card [CARD_1], SSN [ID_1].');
  });
});

describe('remembered values and explicit overrides', () => {
  it('rechecks remembered dates, public entities and numeric IDs in their current context', () => {
    const text = 'Deadline 1991-03-14. Weather in Paris. Compare Google. Account balance 88213004 dollars.';
    const known = detectKnownValues(text, [
      { value: '1991-03-14', type: 'DATE' }, { value: 'Paris', type: 'LOCATION' },
      { value: 'Google', type: 'ORG' }, { value: '88213004', type: 'ID' },
    ]);
    expect(clean(text, known)).toBe(text);
  });
  it('retains explicit Always hide overrides in otherwise public contexts', () => {
    const text = 'Deadline 2026-11-30. Weather in Paris. Compare Google.';
    expect(clean(text, [], { alwaysHide: [
      { value: '2026-11-30', type: 'DATE' }, { value: 'Paris', type: 'LOCATION' }, { value: 'Google', type: 'ORG' },
    ] })).toBe('Deadline [DATE_1]. Weather in [LOCATION_1]. Compare [ORG_1].');
  });
  it('does not release an unlabeled repeated account number merely because context is missing', () => {
    const text = 'Please use 88213004.';
    expect(clean(text, detectKnownValues(text, [{ value: '88213004', type: 'ID' }]))).toBe('Please use [ID_1].');
  });
  it('still respects Never hide and disabled categories', () => {
    const text = 'DOB: 1991-03-14';
    expect(clean(text, [], { neverHide: ['1991-03-14'] })).toBe(text);
    expect(clean(text, [], { policy: { DATE: false } })).toBe(text);
  });
  it('distinguishes IDs from balances, coverage amounts and quantities', () => {
    const text = 'Account number: 88213004, balance 12500 dollars. Policy covers 25000 visits. Claim number they gave me was 99123456.';
    expect(clean(text)).toBe('Account number: [ID_1], balance 12500 dollars. Policy covers 25000 visits. Claim number they gave me was [ID_2].');
  });
});
