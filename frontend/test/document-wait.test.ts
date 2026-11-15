import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { documentModels, DOCUMENT_MODEL_WAIT, waitForDocument } from '../lib/documents/wait';

describe('document wait recovery', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('releases timers after success and errors', async () => {
    expect(await waitForDocument(async () => 'ready', 100)).toBe('ready');
    await expect(waitForDocument(async () => { throw new Error('reader failed'); }, 100)).rejects.toThrow('reader failed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('stops waiting for an unresponsive reader and ignores its late reply', async () => {
    let reply!: (value: string) => void;
    const pending = waitForDocument(() => new Promise<string>(r => { reply = r; }), 100);
    const failure = expect(pending).rejects.toThrow('did not finish in time');
    await vi.advanceTimersByTimeAsync(100);
    await failure;
    reply('late');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not start work after cancellation', async () => {
    const abort = new AbortController(); abort.abort();
    const task = vi.fn(async () => 'unexpected');
    await expect(waitForDocument(task, 100, [abort.signal])).rejects.toThrow('cancelled');
    expect(task).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('falls back once for a stalled detector instead of waiting for every remaining part', async () => {
    const analyze = vi.fn(() => new Promise<{ nerUsed: boolean }>(() => {}));
    const fallback = vi.fn(() => ({ nerUsed: false }));
    const runner = documentModels({ analyze, fallback, rewrite: async (text) => text, signal: new AbortController().signal, skipRewrite: new AbortController().signal });
    const first = runner.analyze('first');
    await vi.advanceTimersByTimeAsync(DOCUMENT_MODEL_WAIT.detectPart);
    expect((await first).nerUsed).toBe(false);
    for (let i = 0; i < 20; i++) expect((await runner.analyze('next')).nerUsed).toBe(false);
    expect(analyze).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(21);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets Use Light style stop a pending rewrite and disconnect its progress callbacks', async () => {
    const skip = new AbortController();
    let attempt!: AbortSignal;
    const rewrite = vi.fn((_text: string, signal: AbortSignal) => { attempt = signal; return new Promise<string>(() => {}); });
    const runner = documentModels({ analyze: async (): Promise<{ nerUsed: boolean }> => ({ nerUsed: true }), fallback: () => ({ nerUsed: false }), rewrite, signal: new AbortController().signal, skipRewrite: skip.signal });
    const result = expect(runner.rewrite('anonymized text')).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(1);
    skip.abort();
    await result;
    expect(attempt.aborted).toBe(true);
    await expect(runner.rewrite('next')).rejects.toThrow('cancelled');
    expect(rewrite).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds automatic AI waiting across multiple chunks and stops retrying after a timeout', async () => {
    let attempt!: AbortSignal;
    const rewrite = vi.fn((_text: string, signal: AbortSignal) => { attempt = signal; return new Promise<string>(() => {}); });
    const runner = documentModels({ analyze: async (): Promise<{ nerUsed: boolean }> => ({ nerUsed: true }), fallback: () => ({ nerUsed: false }), rewrite, signal: new AbortController().signal, skipRewrite: new AbortController().signal });
    const result = expect(runner.rewrite('first')).rejects.toThrow('did not finish in time');
    await vi.advanceTimersByTimeAsync(DOCUMENT_MODEL_WAIT.rewritePart);
    await result;
    expect(attempt.aborted).toBe(true);
    await expect(runner.rewrite('next')).rejects.toThrow('did not finish in time');
    expect(rewrite).toHaveBeenCalledTimes(1);
  });
});
