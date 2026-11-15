import type { DetectOptions, RewriteResult, Span } from '@nobody/engine';
import { DOCUMENT_ERRORS, DocumentError, type DocumentErrorCode, type DocumentFormat, type ExtractedDocument } from './documents/types';

/** Requests handled by the offscreen document, where the models live. */
export type EngineRequest =
  | { type: 'document.extract'; format: DocumentFormat; base64: string }
  | { type: 'ner.init'; requestId?: string }
  | { type: 'analyze'; text: string; options: DetectOptions }
  | { type: 'rewrite'; text: string; modelId: string; requestId?: string; mode?: 'all' | 'auto' }
  | { type: 'llm.prepare'; modelId: string; requestId?: string }
  | { type: 'llm.load'; modelId: string }
  | { type: 'llm.status' }
  | { type: 'llm.cached'; modelIds: string[] }
  | { type: 'llm.delete'; modelId: string }
  | { type: 'llm.unload' };

export interface AnalyzeResponse {
  spans: Span[];
  nerUsed: boolean;
  ms: number;
}

export interface PrepareResponse {
  tokensPerSecond: number;
  typicalPromptSeconds: number;
}

export interface StatusResponse {
  nerReady: boolean;
  nerError: string | null;
  loadedModel: string | null;
}

export type EngineResponse<T> = { ok: true; data: T } | { ok: false; error: string; documentCode?: DocumentErrorCode };

export interface ProgressMessage {
  type: 'progress';
  requestId: string;
  tabId?: number;
  progress: number;
  text: string;
}

let counter = 0;
export const newRequestId = () => `${Date.now().toString(36)}-${(counter++).toString(36)}`;

/** Send a request to the model engine (creating the offscreen document on demand). */
export async function callEngine<T>(req: EngineRequest): Promise<T> {
  let lastError: unknown = null;
  // The offscreen page may still be booting right after creation — retry briefly.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await browser.runtime.sendMessage({ type: 'ensureOffscreen' });
      const res = (await browser.runtime.sendMessage({ target: 'offscreen', ...req })) as EngineResponse<T> | undefined;
      if (res) {
        if (!res.ok) {
          if (res.documentCode && res.documentCode in DOCUMENT_ERRORS) throw new DocumentError(res.documentCode);
          throw new EngineError(res.error);
        }
        return res.data;
      }
      lastError = new Error('The Outis engine did not respond');
    } catch (e) {
      if (e instanceof EngineError || e instanceof DocumentError) throw e;
      lastError = e;
    }
    await new Promise((r) => setTimeout(r, 250 * (attempt + 1)));
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** An error reported by the engine itself (not a messaging failure) — never retried. */
class EngineError extends Error {}

export const engine = {
  extractDocument: (format: DocumentFormat, base64: string) => callEngine<ExtractedDocument>({ type: 'document.extract', format, base64 }),
  analyze: (text: string, options: DetectOptions) => callEngine<AnalyzeResponse>({ type: 'analyze', text, options }),
  rewrite: (text: string, modelId: string, requestId?: string, mode?: 'all' | 'auto') =>
    callEngine<RewriteResult>({ type: 'rewrite', text, modelId, requestId, mode }),
  initNer: (requestId?: string) => callEngine<boolean>({ type: 'ner.init', requestId }),
  loadLlm: (modelId: string) => callEngine<null>({ type: 'llm.load', modelId }),
  prepare: (modelId: string, requestId?: string) => callEngine<PrepareResponse>({ type: 'llm.prepare', modelId, requestId }),
  status: () => callEngine<StatusResponse>({ type: 'llm.status' }),
  cached: (modelIds: string[]) => callEngine<Record<string, boolean>>({ type: 'llm.cached', modelIds }),
  remove: (modelId: string) => callEngine<void>({ type: 'llm.delete', modelId }),
  unload: () => callEngine<void>({ type: 'llm.unload' }),
};

/** Subscribe to progress updates for one request (works in pages and content scripts). */
export function onProgress(requestId: string, cb: (p: ProgressMessage) => void): () => void {
  const listener = (msg: unknown) => {
    const m = msg as ProgressMessage;
    if (m?.type === 'progress' && m.requestId === requestId) cb(m);
  };
  browser.runtime.onMessage.addListener(listener);
  return () => browser.runtime.onMessage.removeListener(listener);
}
