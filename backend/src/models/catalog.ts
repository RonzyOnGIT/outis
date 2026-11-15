/**
 * Local models Nobody can use. Sizes measured from the Hugging Face repos (Nov 2026);
 * VRAM numbers come from WebLLM's prebuilt config.
 */

export type StyleTier = 'light' | 'fast' | 'balanced' | 'quality';

export interface RewriteModel {
  tier: StyleTier;
  name: string;
  /** One-line pitch for the picker. */
  blurb: string;
  /** WebLLM model ids. f16 needs the WebGPU "shader-f16" feature; f32 works everywhere but uses more memory. */
  webllm?: { f16: string; f32: string };
  vramMB: { f16: number; f32: number };
  downloadGB: number;
  quality: 1 | 2 | 3 | 4 | 5;
  speed: 1 | 2 | 3 | 4 | 5;
}

export const REWRITE_MODELS: RewriteModel[] = [
  {
    tier: 'light',
    name: 'Light (no AI)',
    blurb: 'Instant rule-based cleanup: punctuation, slang, typos, emoji. Works on any computer.',
    vramMB: { f16: 0, f32: 0 },
    downloadGB: 0,
    quality: 2,
    speed: 5,
  },
  {
    tier: 'fast',
    name: 'Fast · Qwen3.5 2B',
    blurb: 'Small model for office laptops and integrated graphics. Good rewrites, quick.',
    webllm: { f16: 'Qwen3.5-2B-q4f16_1-MLC', f32: 'Qwen3.5-2B-q4f32_1-MLC' },
    vramMB: { f16: 2245, f32: 2592 },
    downloadGB: 1.1,
    quality: 3,
    speed: 4,
  },
  {
    tier: 'balanced',
    name: 'Balanced · Qwen3.5 4B',
    blurb: 'Best mix of quality and speed. Needs ~4 GB of graphics memory.',
    webllm: { f16: 'Qwen3.5-4B-q4f16_1-MLC', f32: 'Qwen3.5-4B-q4f32_1-MLC' },
    vramMB: { f16: 3868, f32: 4680 },
    downloadGB: 2.4,
    quality: 4,
    speed: 3,
  },
  {
    tier: 'quality',
    name: 'Quality · Qwen3 8B',
    blurb: 'Most natural rewrites. For dedicated GPUs or Apple Silicon with 16 GB+.',
    webllm: { f16: 'Qwen3-8B-q4f16_1-MLC', f32: 'Qwen3-8B-q4f32_1-MLC' },
    vramMB: { f16: 5696, f32: 6853 },
    downloadGB: 4.6,
    quality: 5,
    speed: 2,
  },
];

export function getRewriteModel(tier: StyleTier): RewriteModel {
  return REWRITE_MODELS.find((m) => m.tier === tier) ?? REWRITE_MODELS[0]!;
}

/**
 * Name-detection model (runs on CPU via WebAssembly, ~110 MB, English).
 * Uncased on purpose: people type "john smith" in chats; a cased model misses lowercase names.
 */
export const NER_MODEL = {
  id: 'Xenova/bert-base-NER-uncased',
  name: 'bert-base-NER (uncased)',
  dtype: 'q8' as const,
  downloadMB: 110,
};
