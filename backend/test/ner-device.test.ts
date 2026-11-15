import { describe, expect, it } from 'vitest';
import { chunkText, groupPredictions, rateModels, type DeviceProbe, type TokenPrediction } from '../src/index.js';

describe('NER token alignment', () => {
  it('rebuilds character spans from WordPiece tokens', () => {
    const text = "Hi, I'm Jonathan Smithers from Acme Corp. in São Paulo!";
    const p = (token: string, label = 'O', score = 0.99): TokenPrediction => ({ token, label, score });
    const preds = [
      p('Hi'), p(','), p('I'), p("'"), p('m'),
      p('Jonathan', 'B-PER'), p('Smith', 'I-PER'), p('##ers', 'I-PER'),
      p('from'), p('A', 'B-ORG'), p('##c', 'I-ORG'), p('##me', 'I-ORG'), p('Corp', 'I-ORG'), p('.', 'I-ORG'),
      p('in'), p('São', 'B-LOC'), p('Paulo', 'I-LOC'), p('!'),
    ];
    const spans = groupPredictions(text, preds, 100);
    expect(spans.map((s) => [s.type, s.text, s.start - 100])).toEqual([
      ['PERSON', 'Jonathan Smithers', 8],
      ['ORG', 'Acme Corp.', 31],
      ['LOCATION', 'São Paulo', 45],
    ]);
  });

  it('aligns lower-cased, accent-stripped tokens from uncased models to the original text', () => {
    const text = 'email John Smithers in São Paulo';
    const p = (token: string, label = 'O'): TokenPrediction => ({ token, label, score: 0.95 });
    const spans = groupPredictions(text, [
      p('email'), p('john', 'B-PER'), p('smith', 'I-PER'), p('##ers', 'I-PER'), p('in'), p('sao', 'B-LOC'), p('paulo', 'I-LOC'),
    ]);
    expect(spans.map((s) => [s.type, s.text])).toEqual([
      ['PERSON', 'John Smithers'],
      ['LOCATION', 'São Paulo'],
    ]);
  });

  it('starts a new entity on B- and ignores MISC', () => {
    const text = 'Anna Bob use Python';
    const spans = groupPredictions(text, [
      { token: 'Anna', label: 'B-PER', score: 0.9 },
      { token: 'Bob', label: 'B-PER', score: 0.9 },
      { token: 'use', label: 'O', score: 0.9 },
      { token: 'Python', label: 'B-MISC', score: 0.9 },
    ]);
    expect(spans.map((s) => s.text)).toEqual(['Anna', 'Bob']);
  });

  it('chunks long text on sentence boundaries with correct offsets', () => {
    const text = 'Sentence one is here. '.repeat(200);
    const chunks = chunkText(text, 500);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
    for (const c of chunks) expect(text.slice(c.offset, c.offset + c.text.length)).toBe(c.text);
  });
});

describe('model picker', () => {
  const base: DeviceProbe = {
    webgpu: true, fallbackAdapter: false, shaderF16: true, vendor: '', architecture: '', description: '',
    ramGB: 8, cores: 8, maxBufferMB: 2048, budgetMB: 0, gpuClass: 'none',
  };
  const tiersBy = (p: DeviceProbe) => Object.fromEntries(rateModels(p).map((f) => [f.model.tier, f.fit]));

  it('recommends Balanced on Apple Silicon', () => {
    expect(tiersBy({ ...base, gpuClass: 'apple', budgetMB: 6500 })).toMatchObject({
      light: 'good', fast: 'good', balanced: 'recommended', quality: 'heavy',
    });
  });

  it('recommends Fast on an office PC with integrated graphics', () => {
    expect(tiersBy({ ...base, gpuClass: 'integrated', budgetMB: 3500, shaderF16: false })).toMatchObject({
      fast: 'recommended', balanced: 'too-big', quality: 'too-big',
    });
  });

  it('falls back to Light without WebGPU', () => {
    expect(tiersBy({ ...base, webgpu: false })).toMatchObject({
      light: 'recommended', fast: 'unsupported', balanced: 'unsupported', quality: 'unsupported',
    });
  });
});
