/**
 * Offscreen document = the local "backend". It owns the models so they are loaded
 * once per browser (not per tab) and have access to WebGPU and WebAssembly.
 */
import { configureOnnxWasm, LocalLlm, NobodyEngine, type DownloadProgress } from '@nobody/engine/runtime';
import type { EngineRequest, EngineResponse } from '@/lib/messages';
// Bundled with the extension (see the alias in wxt.config.ts) — never loaded from a CDN.
import ortWasmUrl from 'virtual-ort-wasm?url';

configureOnnxWasm({ wasm: ortWasmUrl });

const engine = new NobodyEngine();

/** Free GPU memory if the rewrite model hasn't been used for a while. */
const IDLE_UNLOAD_MS = 10 * 60_000;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
function touch() {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void engine.llm.unload(), IDLE_UNLOAD_MS);
}

function progress(requestId: string | undefined, tabId: number | undefined) {
  if (!requestId) return undefined;
  let last = -1;
  return (p: DownloadProgress) => {
    if (p.progress === last && p.progress !== 100) return;
    last = p.progress;
    browser.runtime.sendMessage({ type: 'progress', requestId, tabId, ...p }).catch(() => {});
  };
}

async function handle(req: EngineRequest, tabId?: number): Promise<unknown> {
  switch (req.type) {
    case 'ner.init':
      if (!(await engine.initNer(progress(req.requestId, tabId)))) throw new Error(engine.nerError ?? 'Name detector failed to load');
      return true;
    case 'analyze':
      return engine.analyze(req.text, req.options);
    case 'rewrite': {
      touch();
      const result = await engine.rewrite(req.text, req.modelId, progress(req.requestId, tabId));
      touch();
      return result;
    }
    case 'llm.prepare': {
      await engine.llm.load(req.modelId, progress(req.requestId, tabId));
      touch();
      return engine.llm.speedTest();
    }
    case 'llm.load':
      await engine.llm.load(req.modelId);
      touch();
      return null;
    case 'llm.status':
      return { nerReady: engine.nerReady, nerError: engine.nerError, loadedModel: engine.llm.modelId };
    case 'llm.cached': {
      const entries = await Promise.all(req.modelIds.map(async (id) => [id, await LocalLlm.isDownloaded(id)] as const));
      return Object.fromEntries(entries);
    }
    case 'llm.delete':
      if (engine.llm.modelId === req.modelId) await engine.llm.unload();
      await LocalLlm.deleteDownload(req.modelId);
      return null;
    case 'llm.unload':
      await engine.llm.unload();
      return null;
  }
}

browser.runtime.onMessage.addListener((msg: any, sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return undefined;
  handle(msg as EngineRequest, sender.tab?.id).then(
    (data) => sendResponse({ ok: true, data } satisfies EngineResponse<unknown>),
    (e: unknown) => sendResponse({ ok: false, error: e instanceof Error ? e.message : String(e) } satisfies EngineResponse<unknown>),
  );
  return true;
});

// Warm up the name detector so the first paste is fast.
void engine.initNer();
