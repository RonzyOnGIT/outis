import { describe, expect, it } from 'vitest';
import { cleanModelOutput, normalizeStyle, rewriteText, splitIntoParts, splitProtected, verifyRewrite, type Generate } from '../src/index.js';

describe('light style normalizer', () => {
  it('removes common stylometric tells', () => {
    const input = 'hey [PERSON_1]!!! i think teh colour is wierd — u should check it lol 😅 thx';
    expect(normalizeStyle(input)).toBe('Hey [PERSON_1]! I think the color is weird - you should check it thanks');
  });

  it('drops filler words but keeps the sentence punctuation', () => {
    expect(normalizeStyle('report by Friday lol, can u help? lol I think so')).toBe('Report by Friday, can you help? I think so');
  });

  it('never touches URLs, file names, placeholders or code', () => {
    const input = 'see https://ex.com/i/u?x=1 and config.yaml, e.g. [EMAIL_1]\n```\nconst u = i  ;\n```\nthx';
    const out = normalizeStyle(input);
    expect(out).toContain('https://ex.com/i/u?x=1');
    expect(out).toContain('config.yaml');
    expect(out).toContain('e.g.');
    expect(out).toContain('```\nconst u = i  ;\n```');
    expect(out.endsWith('Thanks')).toBe(true);
  });

  it('protects stack traces line by line', () => {
    const segs = splitProtected('it crashed:\nTypeError: x is undefined\n    at foo (/app/a.js:1:2)\nany idea?');
    expect(segs.map((s) => s.protected)).toEqual([false, true, false]);
  });
});

describe('rewrite verification', () => {
  it('rejects dropped placeholders, changed numbers and invented data', () => {
    const orig = 'Ask [PERSON_1] to send 3 files to [EMAIL_1] by Friday.';
    expect(verifyRewrite(orig, 'Please ask [PERSON_1] to send 3 files to [EMAIL_1] by Friday.').ok).toBe(true);
    expect(verifyRewrite(orig, 'Ask them to send 3 files to [EMAIL_1] by Friday.').ok).toBe(false);
    expect(verifyRewrite(orig, 'Ask [PERSON_1] to send three files to [EMAIL_1] by Friday.').ok).toBe(false);
    expect(verifyRewrite(orig, 'Ask [PERSON_1] to send 3 files to [EMAIL_1] or bob@x.com by Friday.').ok).toBe(false);
  });

  it('rejects rewrites that change who is speaking', () => {
    const orig = 'I need [PERSON_2] to send the report. Can you help me?';
    expect(verifyRewrite(orig, '[PERSON_1] needs [PERSON_2] to send the report and asks for help.').ok).toBe(false);
    expect(verifyRewrite(orig, 'I need [PERSON_2] to send the report. Could you help me?').ok).toBe(true);
  });

  it('rejects rewrites that drop content or start answering the request', () => {
    const orig = 'So, I need help writing an appeal letter to my insurance — they denied my claim again. Honestly, I am exhausted. My name is [PERSON_1].';
    const answered = 'I am [PERSON_1] and I am writing about my claim.';
    expect(verifyRewrite(orig, answered).ok).toBe(false);
    const good = 'I need help writing an appeal letter to my insurance company, which has denied my claim again. I am very tired. My name is [PERSON_1].';
    expect(verifyRewrite(orig, good)).toEqual({ ok: true, problems: [] });
  });

  it('allows "Can you…" to become "Please…"', () => {
    expect(verifyRewrite('Can you make it firm but polite?', 'Please make it firm but polite.').ok).toBe(true);
  });

  it('strips thinking blocks and chatty prefixes', () => {
    expect(cleanModelOutput('<think>hmm</think>\nHere is the rewritten text:\n"Hello there."')).toBe('Hello there.');
  });
});

describe('splitIntoParts', () => {
  it('groups sentences into short parts without losing any text', () => {
    const text = 'One sentence here. Another one follows! A question? ' + 'Long sentence number four is a bit longer than the rest. '.repeat(8) + 'Last.';
    const parts = splitIntoParts(text, 200);
    expect(parts.join('')).toBe(text);
    expect(parts.length).toBeGreaterThan(2);
    for (const p of parts.slice(0, -1)) expect(p.length).toBeLessThanOrEqual(200 + 60);
  });
});

describe('rewriteText', () => {
  it('rewrites prose, keeps code, retries, and falls back to light style', async () => {
    const calls: number[] = [];
    const gen: Generate = async (msgs, { temperature }) => {
      calls.push(temperature);
      const text = msgs[msgs.length - 1]!.content.replace('Rewrite this text:\n\n', '');
      if (text.startsWith('pls ask')) return 'Please ask [PERSON_1] to look at the error below.';
      return 'garbage without placeholders'; // forces retry + fallback
    };
    const input = 'pls ask [PERSON_1] to look at teh error below\n```\nError: boom\n```\nthx [PERSON_2] u r great';
    const res = await rewriteText(input, gen);
    expect(res.text).toContain('Please ask [PERSON_1] to look at the error below.');
    expect(res.text).toContain('```\nError: boom\n```');
    expect(res.text).toContain('Thanks [PERSON_2]');
    expect(res.rewritten).toBe(false);
    expect(calls).toEqual([0.5, 0.5, 0.2]);
  });
});
