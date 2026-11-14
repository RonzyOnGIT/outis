import { CreateMLCEngine, hasModelInCache, deleteModelAllInfoInCache, type MLCEngine } from '@mlc-ai/web-llm';
import type { ChatMessage, Generate } from '../style/rewrite.js';
import type { DownloadProgress } from './ner.js';

export interface SpeedTest {
  tokensPerSecond: number;
  /** Rough time to rewrite a typical 120-word chat prompt. */
  typicalPromptSeconds: number;
}

/**
 * Local LLM via WebLLM (WebGPU). Weights are downloaded once from Hugging Face
 * into the browser's Cache Storage and reused offline afterwards.
 */
export class LocalLlm {
  private engine: MLCEngine | null = null;
  private loadedId: string | null = null;
  private loading: Promise<void> | null = null;

  get modelId(): string | null {
    return this.loadedId;
  }

  static isDownloaded(modelId: string): Promise<boolean> {
    return hasModelInCache(modelId);
  }

  static deleteDownload(modelId: string): Promise<void> {
    return deleteModelAllInfoInCache(modelId);
  }

  async load(modelId: string, onProgress?: (p: DownloadProgress) => void): Promise<void> {
    if (this.loadedId === modelId && this.engine) return;
    if (this.loading) await this.loading;
    if (this.loadedId === modelId && this.engine) return;
    this.loading = (async () => {
      await this.unload();
      this.engine = await CreateMLCEngine(modelId, {
        initProgressCallback: (r) => onProgress?.({ progress: Math.round(r.progress * 100), text: r.text }),
      });
      this.loadedId = modelId;
    })();
    try {
      await this.loading;
    } finally {
      this.loading = null;
    }
  }

  async unload(): Promise<void> {
    const e = this.engine;
    this.engine = null;
    this.loadedId = null;
    if (e) await e.unload();
  }

  readonly generate: Generate = async (messages: ChatMessage[], opts) => {
    if (!this.engine) throw new Error('Model not loaded');
    const reply = await this.engine.chat.completions.create({
      messages,
      temperature: opts.temperature,
      max_tokens: opts.maxTokens,
      // Qwen3 models "think" by default; we want a direct answer.
      extra_body: { enable_thinking: false },
    } as Parameters<MLCEngine['chat']['completions']['create']>[0]);
    const choice = (reply as { choices: Array<{ message: { content: string | null } }> }).choices[0];
    return choice?.message.content ?? '';
  };

  /** Short generation to measure real speed on this device. */
  async speedTest(): Promise<SpeedTest> {
    if (!this.engine) throw new Error('Model not loaded');
    const t0 = performance.now();
    const reply = (await this.engine.chat.completions.create({
      messages: [{ role: 'user', content: 'Write three short sentences about the weather.' }],
      temperature: 0.7,
      max_tokens: 96,
      extra_body: { enable_thinking: false },
    } as Parameters<MLCEngine['chat']['completions']['create']>[0])) as {
      usage?: { completion_tokens?: number; extra?: { decode_tokens_per_s?: number } };
    };
    const seconds = (performance.now() - t0) / 1000;
    const tps = reply.usage?.extra?.decode_tokens_per_s ?? (reply.usage?.completion_tokens ?? 96) / seconds;
    // ~160 output tokens for a 120-word prompt, plus prompt processing overhead.
    return { tokensPerSecond: Math.round(tps * 10) / 10, typicalPromptSeconds: Math.round((160 / tps + 0.8) * 10) / 10 };
  }
}
