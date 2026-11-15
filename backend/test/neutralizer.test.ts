// Port of outis-neutralizer/tests/neutralizer.test.js (simulated models — no download needed),
// plus Nobody-specific tests for the wrapper (code, links, logs).
import { describe, expect, it } from 'vitest';
import { checkNeutralSentence as check, createNeutralizer, neutralizeLight, neutralizeWithModel, type Generate } from '../src/index.js';

/** The sample prompt after Nobody's placeholders. */
const HIDDEN =
  "So, I need help writing an appeal letter to my insurance — they denied my claim again. Honestly, I'm exhausted. My name is [PERSON_1], DOB [DATE_1], and my member ID is [ID_1]. I live at [ADDRESS_1]. Phone is [PHONE_1], email is [EMAIL_1]. The claim was for my MRI on [DATE_2] at [ORG_1] — $2,340. They said it wasn't \"medically necessary.\" It was. My doctor, Dr. [PERSON_2], ordered it after three months of back pain and numbness in my left leg. She suspects a herniated disc at L4-L5. I also take gabapentin 300mg twice a day for the nerve pain. I work at [ORG_2] as a warehouse supervisor — I've already missed six shifts because of this. HR asked for my SSN for the leave paperwork, it's [ID_2], if that matters for the letter. Can you make it firm but polite? I don't want to sound desperate. Just clear. Deadline to appeal is [DATE_3].";

/** A fake model: answers each numbered sentence with `rewrite(sentence)`. */
function model(rewrite: (s: string, last: string) => string, log: string[] = []): Generate {
  return async (messages) => {
    const last = messages[messages.length - 1]!.content;
    log.push(last);
    const lines = [...last.matchAll(/^(\d+)\. (.+)$/gm)];
    return lines.map(([, n, s]) => `${n}. ${rewrite(s!, last)}`).join('\n');
  };
}

/** The mistakes the first Nobody rewrite made, as a model that makes them every time. */
const SLOPPY: Record<string, string> = {
  'I need help writing an appeal letter': 'I require assistance drafting an appeal letter to my insurance provider, who denied my claim a second time, and I am extremely exhausted.',
  'ordered it after three months': 'My physician, Dr. [PERSON_2], prescribed treatment following three months of back pain and numbness in my left leg.',
  'She suspects a herniated disc': 'Her assessment indicates a herniated disc at L4-L5.',
  'Can you make it firm but polite': 'Please draft a response that is firm yet polite.',
  'I work at [ORG_2]': 'I currently hold the position of warehouse supervisor at [ORG_2], having missed six shifts.',
};
const sloppy = (s: string) => {
  for (const [k, v] of Object.entries(SLOPPY)) if (s.includes(k)) return v;
  return s;
};

describe('Outis neutralizer (ported tests)', () => {
  it('rules alone keep every fact and remove the habits', async () => {
    const r = await createNeutralizer().neutralize(HIDDEN);
    expect(r.stats.mode).toBe('off');
    for (const must of ['appeal letter', 'again', 'ordered', 'suspects', '[ID_2]', '$2,340', 'six shifts', 'Can you make it firm but polite?']) {
      expect(r.text, `missing ${must}`).toContain(must);
    }
    expect(r.text).not.toMatch(/—|Honestly|^So,|I'm|don't/);
    // fragments joined to the sentence before must survive
    expect(r.text).toContain('I am exhausted');
    expect(r.text).toMatch(/it was\./);
  });

  it('a fallback keeps fragments that were joined to the sentence', async () => {
    const dropsFeeling = model((s) => s.replace(/, I am exhausted/, ''));
    const r = await createNeutralizer({ generate: dropsFeeling, mode: 'all' }).neutralize(HIDDEN);
    expect(r.text).toContain('again, I am exhausted.');
  });

  it('a condition must stay a condition', () => {
    const unit = { surface: 'HR asked for my SSN, it is [ID_2], if that matters for the letter.' };
    expect(check(unit, 'HR asked for my SSN, it is [ID_2], and that matters for the letter.').some((p) => p.includes('"if"'))).toBe(true);
  });

  it("a good model's rewrites are accepted", async () => {
    const good = (s: string) =>
      s
        .replace('to my insurance, they denied my claim again, I am exhausted', 'to my insurance because they denied my claim again, and I am exhausted')
        .replace('"medically necessary", it was', '"medically necessary", but it was')
        .replace('I do not want to sound desperate, just clear', 'I do not want to sound desperate, I just want it to be clear');
    const r = await createNeutralizer({ generate: model(good) }).neutralize(HIDDEN);
    expect(r.stats.model + r.stats.modelAfterRetry).toBeGreaterThanOrEqual(3);
    expect(r.stats.fellBack, JSON.stringify(r.units.filter((u) => u.problems.length))).toBe(0);
    expect(r.text).toContain('because they denied my claim again');
  });

  it('the mistakes from the earlier Nobody rewrite are all rejected', async () => {
    const r = await createNeutralizer({ generate: model(sloppy), mode: 'all' }).neutralize(HIDDEN);
    for (const bad of ['require', 'assistance', 'second time', 'extremely', 'physician', 'prescribed treatment', 'assessment', 'indicates', 'draft a response', 'currently hold the position']) {
      expect(r.text, `"${bad}" got through`).not.toContain(bad);
    }
    for (const kept of ['again', 'ordered', 'suspects', 'Can you make it firm but polite?', 'I work at [ORG_2]']) {
      expect(r.text, `lost "${kept}"`).toContain(kept);
    }
    expect(r.stats.fellBack).toBeGreaterThanOrEqual(5);
    const doc = r.units.find((u) => u.original.includes('ordered'))!;
    expect(doc.problems.some((p) => p.includes('ordered'))).toBe(true);
  });

  it('a model that answers the request instead of rewriting it is rejected', async () => {
    const answering = (s: string) =>
      s.startsWith('Can you') ? 'Dear Claims Review Team, I am writing to formally appeal the denial of my MRI claim and request reconsideration.' : s;
    const r = await createNeutralizer({ generate: model(answering), mode: 'all' }).neutralize('Can you make it firm but polite?');
    expect(r.text).toBe('Can you make it firm but polite?');
    expect(r.units[0]!.problems.some((p) => /answer|longer|question/.test(p))).toBe(true);
  });

  it('a retry with feedback can rescue a sentence', async () => {
    let calls = 0;
    const learns: Generate = async (messages) => {
      calls++;
      const last = messages[messages.length - 1]!.content;
      if (last.includes('was rejected')) return '1. My doctor, Dr. [PERSON_2], ordered it after three months of back pain and numbness in my left leg.';
      return '1. My physician, Dr. [PERSON_2], prescribed treatment following three months of back pain and numbness in my left leg.';
    };
    const r = await createNeutralizer({ generate: learns, mode: 'all' }).neutralize(
      'My doctor, Dr. [PERSON_2], ordered it after three months of back pain and numbness in my left leg.',
    );
    expect(r.units[0]!.source).toBe('model-retry');
    expect(calls).toBe(2);
  });

  it('thinking tags and extra chatter around the numbered lines are ignored', async () => {
    const thinker: Generate = async () => '<think>The user wants plain English.</think>\nHere you go:\n1. I need help writing to my landlord about the heater, which broke again.';
    const r = await createNeutralizer({ generate: thinker, mode: 'all' }).neutralize('I need help writing to my landlord about the heater, which broke again!!');
    expect(r.text).toBe('I need help writing to my landlord about the heater, which broke again.');
  });

  it('placeholders, numbers, negations and uncertainty are protected', () => {
    const unit = { surface: 'Maybe I did not pay [PERSON_1] the 40 dollars.' };
    expect(check(unit, 'I paid the 40 dollars.').length).toBeGreaterThanOrEqual(3);
    expect(check(unit, 'Maybe I did not pay [PERSON_1] 45 dollars.').some((p) => p.includes('number'))).toBe(true);
    expect(check(unit, 'Maybe I did not pay [PERSON_1] the 40 dollars.')).toEqual([]);
  });

  it('a crashing model falls back to rules without losing text', async () => {
    const broken: Generate = async () => {
      throw new Error('WebGPU device lost');
    };
    const r = await createNeutralizer({ generate: broken, mode: 'all' }).neutralize(HIDDEN);
    expect(r.text).toContain('ordered');
    expect(r.text).toContain('[ID_2]');
    expect(r.units.every((u) => u.final)).toBe(true);
  });

  it('missing lines in a batch are retried individually', async () => {
    const lazy: Generate = async (messages) => {
      const last = messages[messages.length - 1]!.content;
      const lines = [...last.matchAll(/^(\d+)\. (.+)$/gm)];
      return `1. ${lines[0]![2]}`; // drops everything after line 1 in batches
    };
    const r = await createNeutralizer({ generate: lazy, mode: 'all', batchSize: 4 }).neutralize('I need help today. My manager said no. Can you write the email?');
    expect(r.stats.fellBack).toBe(0);
  });

  it('lists and code blocks are left exactly as written', async () => {
    const text = 'Fix this please!!\n\n- step one lol\n- step two\n\n```js\nconst x = 1; // honestly\n```';
    const r = await createNeutralizer().neutralize(text);
    expect(r.text.endsWith('- step one lol\n- step two\n\n```js\nconst x = 1; // honestly\n```')).toBe(true);
  });

  it('slang, shorthand and formal words become plain words', async () => {
    const r = await createNeutralizer().neutralize(
      'tbh I think maybe it was kind of the third time?? ngl I cant deal w/ this, lmk. I require assistance regarding my residence prior to Friday.',
    );
    expect(r.text).not.toMatch(/tbh|ngl|lmk|w\/|cant|require|assistance|regarding|residence|prior to/i);
    expect(r.text).toMatch(/third time/);
    expect(r.text).toMatch(/[Mm]aybe/);
    expect(r.text).toMatch(/let me know/);
  });
});

describe('Nobody wrapper', () => {
  it('keeps inline code, links, emails and file names exactly', () => {
    const t = "honestly the build fails when I run `npm run build` — see https://example.com/i/u?x=1 and config.yaml, it's broken!!";
    const out = neutralizeLight(t);
    expect(out).toContain('`npm run build`');
    expect(out).toContain('https://example.com/i/u?x=1');
    expect(out).toContain('config.yaml');
    expect(out).not.toMatch(/honestly|—|it's|!!/i);
  });

  it('never touches stack traces or log lines', () => {
    const t = "ok so it crashed again:\nTypeError: Cannot read properties of undefined (reading 'x')\n    at foo (/app/a.js:1:2)\nany idea what's wrong?";
    const out = neutralizeLight(t);
    expect(out).toContain("TypeError: Cannot read properties of undefined (reading 'x')\n    at foo (/app/a.js:1:2)\n");
    expect(out).toMatch(/^It crashed again[.:]/);
    expect(out).toMatch(/what is wrong\?$/);
  });

  it('model sentences that add personal data are rejected', async () => {
    const leaky = model((s) => s.replace('[EMAIL_1]', '[EMAIL_1] or bob@example.com'));
    const r = await neutralizeWithModel('Please send the report to [EMAIL_1] by Friday.', leaky);
    expect(r.text).not.toContain('bob@example.com');
    expect(r.rewritten).toBe(false);
  });

  it('masked code must come back unchanged from the model', async () => {
    const r = await neutralizeWithModel('Can you explain why `useEffect` runs twice in dev mode?', model((s) => s));
    expect(r.text).toBe('Can you explain why `useEffect` runs twice in dev mode?');
  });
});
