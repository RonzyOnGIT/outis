import {
  AutoModelForTokenClassification,
  AutoTokenizer,
  env,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from '@huggingface/transformers';
import { chunkText, groupPredictions, type TokenPrediction } from '../detect/ner-align.js';
import { NER_MODEL } from '../models/catalog.js';
import type { Span } from '../types.js';

export interface DownloadProgress {
  /** 0..100 */
  progress: number;
  text: string;
}

export interface NerConfig {
  modelId?: string;
  dtype?: 'q8' | 'int8' | 'fp32' | 'fp16' | 'q4';
  device?: 'wasm' | 'webgpu' | 'cpu';
  onProgress?: (p: DownloadProgress) => void;
}

/**
 * Tell ONNX Runtime where its WebAssembly binary is. Browser extensions must ship it themselves
 * (remote code is not allowed), so pass the bundler-emitted URL, e.g. Vite's `?url` import.
 * Without this, Transformers.js would fetch the runtime from a CDN.
 */
export function configureOnnxWasm(paths: { wasm: string; mjs?: string }): void {
  const onnx = env.backends.onnx as { wasm?: Record<string, unknown> };
  if (!onnx.wasm) return;
  // The bundled ORT build embeds its JS loader, so only the .wasm URL is required.
  onnx.wasm.wasmPaths = paths.mjs ? { wasm: paths.wasm, mjs: paths.mjs } : { wasm: paths.wasm };
  onnx.wasm.numThreads = 1; // extension pages are not cross-origin isolated
  // Don't turn the runtime into a blob: URL — extension CSP forbids importing blobs.
  (env as { useWasmCache?: boolean }).useWasmCache = false;
}

function softmaxArgmax(row: ArrayLike<number>): [number, number] {
  let max = -Infinity;
  let arg = 0;
  for (let i = 0; i < row.length; i++) {
    if (row[i]! > max) {
      max = row[i]!;
      arg = i;
    }
  }
  let sum = 0;
  for (let i = 0; i < row.length; i++) sum += Math.exp(row[i]! - max);
  return [arg, 1 / sum];
}

/** Named-entity recognizer (people, organisations, locations) running fully locally. */
export class NerDetector {
  private constructor(
    private tokenizer: PreTrainedTokenizer,
    private model: PreTrainedModel,
    private id2label: Record<string, string>,
  ) {}

  static async create(cfg: NerConfig = {}): Promise<NerDetector> {
    const modelId = cfg.modelId ?? NER_MODEL.id;
    const files = new Map<string, { loaded: number; total: number }>();
    const progress_callback = (p: { status: string; file?: string; loaded?: number; total?: number }) => {
      if (!cfg.onProgress || !p.file) return;
      if (p.status === 'progress' && p.total) files.set(p.file, { loaded: p.loaded ?? 0, total: p.total });
      if (p.status === 'done') {
        const f = files.get(p.file);
        if (f) f.loaded = f.total;
      }
      let loaded = 0;
      let total = 0;
      for (const f of files.values()) {
        loaded += f.loaded;
        total += f.total;
      }
      if (total > 0) {
        cfg.onProgress({
          progress: Math.round((loaded / total) * 100),
          text: `Name detector: ${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`,
        });
      }
    };
    const tokenizer = await AutoTokenizer.from_pretrained(modelId, { progress_callback });
    const model = await AutoModelForTokenClassification.from_pretrained(modelId, {
      dtype: cfg.dtype ?? NER_MODEL.dtype,
      device: cfg.device ?? 'wasm',
      progress_callback,
    });
    const id2label = (model.config as unknown as { id2label: Record<string, string> }).id2label;
    cfg.onProgress?.({ progress: 100, text: 'Name detector ready' });
    return new NerDetector(tokenizer, model, id2label);
  }

  async detect(text: string): Promise<Span[]> {
    const spans: Span[] = [];
    for (const chunk of chunkText(text)) {
      if (!chunk.text.trim()) continue;
      const tokens: string[] = this.tokenizer.tokenize(chunk.text);
      const inputs = this.tokenizer(chunk.text, { truncation: true, max_length: 512 });
      const output = (await this.model(inputs)) as { logits: { dims: number[]; data: Float32Array } };
      const [, seqLen, numLabels] = output.logits.dims as [number, number, number];
      const data = output.logits.data;
      const usable = Math.min(tokens.length, seqLen - 2); // [CLS] … [SEP]
      const preds: TokenPrediction[] = [];
      for (let j = 0; j < usable; j++) {
        const row = data.subarray((j + 1) * numLabels, (j + 2) * numLabels);
        const [arg, score] = softmaxArgmax(row);
        preds.push({ token: tokens[j]!, label: this.id2label[String(arg)] ?? 'O', score });
      }
      spans.push(...groupPredictions(chunk.text, preds, chunk.offset));
    }
    return spans;
  }
}
