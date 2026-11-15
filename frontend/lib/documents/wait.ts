import { DocumentError } from './types';

/** Bound a local-engine wait. Late results are ignored and listeners/timers are always released. */
export function waitForDocument<T>(task: () => Promise<T>, ms: number, signals: AbortSignal[] = []): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      for (const signal of signals) signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(new DocumentError('cancelled'));
    const timer = setTimeout(() => finish(new DocumentError('timeout')), Math.max(0, ms));
    for (const signal of signals) signal.addEventListener('abort', abort, { once: true });
    if (signals.some((s) => s.aborted)) { abort(); return; }
    if (ms <= 0) { finish(new DocumentError('timeout')); return; }
    Promise.resolve().then(() => settled ? undefined : task()).then(
      (value) => { if (!settled) finish(null, value as T); },
      (error) => finish(error),
    );
  });
}

export const DOCUMENT_MODEL_WAIT = { detectPart: 15_000, detectBatch: 30_000, rewritePart: 45_000, rewriteBatch: 90_000 };

/** One circuit per selection: a stalled model is not retried for every remaining chunk/file. */
export function documentModels<T extends { nerUsed: boolean }, R>(options: {
  analyze: (text: string) => Promise<T>;
  fallback: (text: string) => T;
  rewrite: (text: string, signal: AbortSignal) => Promise<R>;
  signal: AbortSignal;
  skipRewrite: AbortSignal;
}) {
  let detectorUnavailable = false;
  let rewriteUnavailable = false;
  let detectMs = 0;
  let rewriteMs = 0;
  return {
    async analyze(text: string): Promise<T> {
      if (options.signal.aborted) throw new DocumentError('cancelled');
      if (detectorUnavailable) return options.fallback(text);
      const start = Date.now();
      try {
        const result = await waitForDocument(() => options.analyze(text), Math.min(DOCUMENT_MODEL_WAIT.detectPart, DOCUMENT_MODEL_WAIT.detectBatch - detectMs), [options.signal]);
        detectorUnavailable = !result.nerUsed;
        return result;
      } catch (e) {
        if (options.signal.aborted) throw e;
        detectorUnavailable = true;
        return options.fallback(text);
      } finally { detectMs += Date.now() - start; }
    },
    async rewrite(text: string): Promise<R> {
      if (options.signal.aborted || options.skipRewrite.aborted) throw new DocumentError('cancelled');
      if (rewriteUnavailable) throw new DocumentError('timeout');
      const start = Date.now();
      const attempt = new AbortController();
      try {
        return await waitForDocument(() => options.rewrite(text, attempt.signal), Math.min(DOCUMENT_MODEL_WAIT.rewritePart, DOCUMENT_MODEL_WAIT.rewriteBatch - rewriteMs), [options.signal, options.skipRewrite]);
      } catch (e) {
        rewriteUnavailable = true;
        throw e;
      } finally { attempt.abort(); rewriteMs += Date.now() - start; }
    },
  };
}
