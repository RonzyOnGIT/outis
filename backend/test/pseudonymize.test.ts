import { describe, expect, it } from 'vitest';
import { anonymize, detectRules, findPlaceholders, resolveSpans, restore, Vault, type Span } from '../src/index.js';

function person(text: string, full: string, from = 0): Span {
  const start = text.indexOf(full, from);
  return { start, end: start + full.length, type: 'PERSON', text: full, source: 'ner', score: 0.99 };
}

describe('vault + anonymize', () => {
  it('gives the same person the same placeholder across messages and name forms', () => {
    const vault = new Vault();
    const m1 = 'John Smith emailed john@acme.com about the launch.';
    const r1 = anonymize(m1, resolveSpans(m1, [...detectRules(m1), person(m1, 'John Smith')]), vault);
    expect(r1.text).toBe('[PERSON_1] emailed [EMAIL_1] about the launch.');

    const m2 = 'Later John asked Mary Jones to reply to john@acme.com.';
    const r2 = anonymize(m2, resolveSpans(m2, [...detectRules(m2), person(m2, 'John'), person(m2, 'Mary Jones')]), vault);
    expect(r2.text).toBe('Later [PERSON_1] asked [PERSON_2] to reply to [EMAIL_1].');
  });

  it('keeps distinct people with a shared first name apart', () => {
    const vault = new Vault();
    vault.assign('PERSON', 'John Smith');
    expect(vault.assign('PERSON', 'John Doe')).toBe('[PERSON_2]');
    expect(vault.assign('PERSON', 'Doe')).toBe('[PERSON_2]');
  });

  it('normalises phones/cards so formatting differences map to one placeholder', () => {
    const vault = new Vault();
    expect(vault.assign('PHONE', '+1 (415) 555-0132')).toBe('[PHONE_1]');
    expect(vault.assign('PHONE', '+1 415.555.0132')).toBe('[PHONE_1]');
  });

  it('round-trips through JSON', () => {
    const vault = new Vault();
    vault.assign('EMAIL', 'a@b.co');
    const copy = new Vault(JSON.parse(JSON.stringify(vault.toJSON())));
    expect(copy.assign('EMAIL', 'A@B.co')).toBe('[EMAIL_1]');
    expect(copy.assign('EMAIL', 'c@d.co')).toBe('[EMAIL_2]');
  });

  it('clone does not leak preview assignments into the original', () => {
    const vault = new Vault();
    vault.clone().assign('PERSON', 'Preview Person');
    expect(vault.size).toBe(0);
  });
});

describe('restore', () => {
  const vault = new Vault();
  vault.assign('PERSON', 'John Smith');
  vault.assign('EMAIL', 'john@acme.com');

  it('restores placeholders in the forms an AI echoes back', () => {
    const answer = 'Sure! Tell [PERSON_1] to email \\[EMAIL_1\\]. PERSON_1 should also cc [Person 1]. [PERSON_9] is unknown.';
    expect(restore(answer, vault)).toBe(
      'Sure! Tell John Smith to email john@acme.com. John Smith should also cc John Smith. [PERSON_9] is unknown.',
    );
  });

  it('ignores lowercase bare tokens (likely code)', () => {
    expect(findPlaceholders('const person_1 = 2', vault)).toEqual([]);
  });
});
