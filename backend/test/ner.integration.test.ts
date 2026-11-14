import { describe, expect, it } from 'vitest';
import { anonymize, Vault } from '../src/index.js';
import { NobodyEngine } from '../src/runtime/index.js';

// Downloads the real ~109 MB model on first run. Run with: npm run test:ner
describe.runIf(process.env.NOBODY_NER_IT)('real NER model (Node)', () => {
  it('detects and anonymizes a realistic message', async () => {
    const engine = new NobodyEngine({ device: 'cpu' });
    const text =
      'Hi, my name is Sarah Connor and I work at Cyberdyne Systems in Los Angeles. ' +
      'My manager Miles Dyson asked me to email sarah.connor@cyberdyne.com and call +1 213 555 0147. ' +
      'Can you help me write a reply to Miles about the delayed project?';
    const { spans, nerUsed, ms } = await engine.analyze(text);
    console.log(`analyze: ${ms} ms`, spans.map((s) => `${s.type}:${s.text}(${s.source})`));
    expect(nerUsed).toBe(true);
    const out = anonymize(text, spans, new Vault()).text;
    console.log(out);
    for (const secret of ['Sarah', 'Connor', 'Cyberdyne', 'Los Angeles', 'Miles', 'Dyson', '555 0147']) {
      expect(out).not.toContain(secret);
    }
    const t1 = performance.now();
    await engine.analyze(text);
    console.log(`warm analyze: ${Math.round(performance.now() - t1)} ms`);
  }, 300_000);
});
