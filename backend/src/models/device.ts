/// <reference types="@webgpu/types" />
import { REWRITE_MODELS, type RewriteModel, type StyleTier } from './catalog.js';

export interface DeviceProbe {
  webgpu: boolean;
  /** Software rasterizer (no real GPU) — too slow for LLMs. */
  fallbackAdapter: boolean;
  shaderF16: boolean;
  vendor: string;
  architecture: string;
  description: string;
  /** navigator.deviceMemory — Chrome caps this at 8 (GB). */
  ramGB: number | null;
  cores: number | null;
  maxBufferMB: number;
  /** Our estimate of usable GPU memory for a model, in MB. */
  budgetMB: number;
  gpuClass: 'apple' | 'discrete' | 'integrated' | 'none';
}

export type Fit = 'recommended' | 'good' | 'heavy' | 'too-big' | 'unsupported';

export interface ModelFit {
  model: RewriteModel;
  fit: Fit;
  /** Which WebLLM build to use on this device. */
  webllmId?: string;
  vramMB: number;
}

export async function probeDevice(): Promise<DeviceProbe> {
  const nav = (globalThis as { navigator?: Navigator & { deviceMemory?: number } }).navigator;
  const probe: DeviceProbe = {
    webgpu: false,
    fallbackAdapter: false,
    shaderF16: false,
    vendor: '',
    architecture: '',
    description: '',
    ramGB: nav?.deviceMemory ?? null,
    cores: nav?.hardwareConcurrency ?? null,
    maxBufferMB: 0,
    budgetMB: 0,
    gpuClass: 'none',
  };
  if (!nav?.gpu) return probe;
  let adapter: GPUAdapter | null = null;
  try {
    adapter = await nav.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch {
    adapter = null;
  }
  if (!adapter) return probe;

  const info = adapter.info ?? ({} as GPUAdapterInfo);
  probe.webgpu = true;
  probe.fallbackAdapter = Boolean((info as { isFallbackAdapter?: boolean }).isFallbackAdapter);
  probe.shaderF16 = adapter.features.has('shader-f16');
  probe.vendor = info.vendor ?? '';
  probe.architecture = info.architecture ?? '';
  probe.description = info.description ?? '';
  probe.maxBufferMB = Math.round(adapter.limits.maxBufferSize / (1024 * 1024));
  probe.gpuClass = classify(probe);
  probe.budgetMB = estimateBudget(probe);
  return probe;
}

function classify(p: DeviceProbe): DeviceProbe['gpuClass'] {
  if (p.fallbackAdapter) return 'none';
  const v = `${p.vendor} ${p.architecture} ${p.description}`.toLowerCase();
  if (v.includes('apple') || v.includes('metal')) return 'apple';
  if (v.includes('nvidia') || /\b(rtx|gtx|quadro)\b/.test(v)) return 'discrete';
  if (v.includes('amd') || v.includes('ati') || v.includes('radeon')) {
    // AMD APUs (e.g. "Radeon Graphics" without a model number) are integrated.
    return /\b(rx|pro w|vega 56|vega 64)\b/.test(v) ? 'discrete' : 'integrated';
  }
  return 'integrated'; // Intel, Qualcomm, ARM Mali, unknown
}

/**
 * Browsers cannot report VRAM, so we estimate a safe budget from GPU class and system RAM.
 * The speed test after download is the real answer; this only sorts the menu.
 */
function estimateBudget(p: DeviceProbe): number {
  const ram = p.ramGB ?? 8;
  switch (p.gpuClass) {
    case 'apple':
      return ram >= 8 ? 6500 : 3500; // unified memory; deviceMemory is capped at 8
    case 'discrete':
      return 6000;
    case 'integrated':
      return ram >= 8 ? 3500 : 2000;
    default:
      return 0;
  }
}

/** Rate every model for this device and mark the best default. */
export function rateModels(p: DeviceProbe): ModelFit[] {
  const fits: ModelFit[] = REWRITE_MODELS.map((model) => {
    if (!model.webllm) return { model, fit: 'good', vramMB: 0 };
    if (!p.webgpu || p.gpuClass === 'none') return { model, fit: 'unsupported', vramMB: model.vramMB.f32 };
    const vramMB = p.shaderF16 ? model.vramMB.f16 : model.vramMB.f32;
    const webllmId = p.shaderF16 ? model.webllm.f16 : model.webllm.f32;
    let fit: Fit;
    if (vramMB <= p.budgetMB * 0.75) fit = 'good';
    else if (vramMB <= p.budgetMB) fit = 'heavy';
    else fit = 'too-big';
    return { model, fit, webllmId, vramMB };
  });
  const order: StyleTier[] = ['balanced', 'fast', 'light'];
  const best = order.map((t) => fits.find((f) => f.model.tier === t && f.fit === 'good')).find(Boolean);
  if (best) best.fit = 'recommended';
  return fits;
}

export const FIT_LABELS: Record<Fit, string> = {
  recommended: 'Recommended for this device',
  good: 'Should run well',
  heavy: 'Heavy — may be slow',
  'too-big': 'Probably too big',
  unsupported: 'Needs WebGPU',
};
