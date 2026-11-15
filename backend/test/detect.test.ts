import { describe, expect, it } from 'vitest';
import { detectDictionary, detectRules, resolveSpans, type Span } from '../src/index.js';

const types = (spans: Span[]) => spans.map((s) => `${s.type}:${s.text}`);

describe('pattern rules', () => {
  it('finds contact details', () => {
    const t = 'Mail me at jane.doe+work@acme-corp.co.uk or call +1 (415) 555-0132 tomorrow.';
    expect(types(detectRules(t))).toEqual(expect.arrayContaining(['EMAIL:jane.doe+work@acme-corp.co.uk', 'PHONE:+1 (415) 555-0132']));
  });

  it('validates cards with Luhn and IBANs with mod-97', () => {
    const t = 'Card 4111 1111 1111 1111, fake 4111 1111 1111 1112. IBAN DE89 3704 0044 0532 0130 00, bad DE00 3704 0044 0532 0130 00';
    const got = types(detectRules(t));
    expect(got).toContain('CARD:4111 1111 1111 1111');
    expect(got).not.toContain('CARD:4111 1111 1111 1112');
    expect(got).toContain('IBAN:DE89 3704 0044 0532 0130 00');
    expect(got.filter((g) => g.startsWith('IBAN'))).toHaveLength(1);
  });

  it('catches secrets and keeps only the secret value', () => {
    const t = [
      'export OPENAI_API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz123456',
      'aws: AKIAIOSFODNN7EXAMPLE',
      'password: "Tr0ub4dor&3x"',
      'Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U',
      'postgres://admin:hunter2pass@db.internal:5432/app',
    ].join('\n');
    const got = types(detectRules(t));
    expect(got).toContain('SECRET:sk-proj-abcdefghijklmnopqrstuvwxyz123456');
    expect(got).toContain('SECRET:AKIAIOSFODNN7EXAMPLE');
    expect(got).toContain('SECRET:Tr0ub4dor&3x');
    expect(got.some((g) => g.startsWith('SECRET:eyJhbGciOiJIUzI1NiJ9'))).toBe(true);
    expect(got).toContain('SECRET:hunter2pass');
  });

  it('finds usernames in file paths, IPs, SSNs and labelled IDs', () => {
    const t = 'Error in /Users/kazak/project/app.ts and C:\\Users\\jsmith\\AppData from 203.0.113.42. SSN 123-45-6789, employee ID: EMP-48213';
    const got = types(detectRules(t));
    expect(got).toEqual(
      expect.arrayContaining(['USER:kazak', 'USER:jsmith', 'IP:203.0.113.42', 'ID:123-45-6789', 'ID:EMP-48213']),
    );
  });

  it('treats any SSN/ITIN-shaped number as an ID, and IDs mentioned after a keyword', () => {
    const t =
      "HR asked for my SSN for the leave paperwork, it's 912-48-3365. Spaced: my social security is on file as 123 45 6789. " +
      'The claim number they gave me on the phone was 88213004. My member ID is BCX-4471-0923.';
    const got = types(detectRules(t));
    expect(got).toEqual(expect.arrayContaining(['ID:912-48-3365', 'ID:123 45 6789', 'ID:88213004', 'ID:BCX-4471-0923']));
  });

  it('does not treat ordinary numbers near keywords as IDs', () => {
    const t = 'My account was opened in 2019 and the policy covers 80% after a $2,340 deductible on 11/30.';
    expect(detectRules(t).filter((s) => s.type === 'ID')).toEqual([]);
  });

  it('finds street addresses and birth dates', () => {
    const t = 'I live at 742 Evergreen Terrace, Springfield, IL 62704. DOB: 03/14/1988.';
    const got = types(detectRules(t));
    expect(got).toContain('ADDRESS:742 Evergreen Terrace, Springfield, IL 62704');
    expect(got).toContain('DATE:03/14/1988');
  });

  it('does not flag ordinary numbers, versions, dates or times', () => {
    const t = 'Upgraded to v2.14.3 on 2024-05-01 at 10:30, took 1500 ms, version 1.2.3.4 of 3 builds; order of 12 items.';
    const got = detectRules(t).filter((s) => s.type !== 'IP');
    expect(got).toEqual([]);
  });

  it('accepts short phone numbers only with context', () => {
    expect(types(detectRules('My mobile: 555 0132 88'))).toContain('PHONE:555 0132 88');
    expect(detectRules('We shipped 555 0132 88 units').filter((s) => s.type === 'PHONE')).toEqual([]);
  });
});

describe('dictionary + resolution', () => {
  it('matches always-hide terms including name parts', () => {
    const t = 'Alexey wrote this; Kazakov approved. alexey kazakov signed.';
    const got = types(detectDictionary(t, [{ value: 'Alexey Kazakov', type: 'PERSON' }]));
    expect(got).toEqual(expect.arrayContaining(['PERSON:Alexey', 'PERSON:Kazakov', 'PERSON:alexey kazakov']));
  });

  it('prefers rules over NER on overlap and propagates repeated mentions', () => {
    const t = 'Jonathan Smithers (jonathan@acme.com) said Smithers will call. Jonathan Smithers agreed.';
    const ner: Span[] = [
      { start: 0, end: 17, type: 'PERSON', text: 'Jonathan Smithers', source: 'ner', score: 0.99 },
      { start: 28, end: 32, type: 'ORG', text: 'acme', source: 'ner', score: 0.7 },
    ];
    const spans = resolveSpans(t, [...detectRules(t), ...ner]);
    const got = types(spans);
    expect(got).toContain('EMAIL:jonathan@acme.com');
    expect(got).not.toContain('ORG:acme');
    expect(got.filter((g) => g === 'PERSON:Jonathan Smithers')).toHaveLength(2);
    expect(got).toContain('PERSON:Smithers');
  });

  it('never re-detects placeholders in already-cleaned text', () => {
    const t = 'Ask [PERSON_1] (or Anna) to email [EMAIL_1].';
    const cands: Span[] = [
      { start: 4, end: 12, type: 'ORG', text: 'PERSON_1', source: 'ner', score: 0.9 },
      { start: 18, end: 22, type: 'PERSON', text: 'Anna', source: 'ner', score: 0.9 },
    ];
    expect(types(resolveSpans(t, [...detectRules(t), ...cands]))).toEqual(['PERSON:Anna']);
  });

  it('ignores departments and acronyms that NER mistakes for organisations', () => {
    const t = 'HR asked me to get an MRI at Lakeside Imaging';
    const ner: Span[] = [
      { start: 0, end: 2, type: 'ORG', text: 'HR', source: 'ner', score: 0.9 },
      { start: 19, end: 22, type: 'ORG', text: 'MRI', source: 'ner', score: 0.8 },
      { start: 26, end: 42, type: 'ORG', text: 'Lakeside Imaging', source: 'ner', score: 0.95 },
    ];
    expect(types(resolveSpans(t, ner))).toEqual(['ORG:Lakeside Imaging']);
  });

  it('respects category policy, allowlist and NER threshold', () => {
    const t = 'Ask ChatGPT about Paris, see https://example.com';
    const cands: Span[] = [
      { start: 4, end: 11, type: 'ORG', text: 'ChatGPT', source: 'ner', score: 0.9 },
      { start: 18, end: 23, type: 'LOCATION', text: 'Paris', source: 'ner', score: 0.4 },
      ...detectRules(t),
    ];
    expect(resolveSpans(t, cands, { neverHide: ['chatgpt'] })).toEqual([]);
    const withLowThreshold = resolveSpans(t, cands, { neverHide: ['chatgpt'], nerThreshold: 0.3, policy: { URL: true } });
    expect(types(withLowThreshold)).toEqual(['LOCATION:Paris', 'URL:https://example.com']);
  });
});
