import { detectRules } from '../detect/rules.js';
import { detectDictionary, resolveSpans } from '../detect/resolve.js';
import type { RewriteResult } from '../style/rewrite.js';
import { neutralizeWithModel } from '../style/neutral.js';
import type { NeutralizeMode } from '../style/neutralizer.js';
import type { DetectOptions, Span } from '../types.js';
import { LocalLlm } from './llm.js';
import { NerDetector, type DownloadProgress, type NerConfig } from './ner.js';

export interface AnalyzeResult {
  spans: Span[];
  /** False if the name detector is unavailable — only patterns + dictionary were used. */
  nerUsed: boolean;
  ms: number;
}

/**
 * Everything model-related in one place. One instance per browser
 * (the extension keeps it in an offscreen document).
 */
export class NobodyEngine {
  readonly llm = new LocalLlm();
  private ner: NerDetector | null = null;
  private nerLoading: Promise<NerDetector | null> | null = null;
  nerError: string | null = null;

  constructor(private nerConfig: NerConfig = {}) {}

  get nerReady(): boolean {
    return this.ner !== null;
  }

  /** Load (downloading on first run) the name detector. Safe to call repeatedly. */
  async initNer(onProgress?: (p: DownloadProgress) => void): Promise<boolean> {
    if (this.ner) return true;
    this.nerLoading ??= NerDetector.create({ ...this.nerConfig, onProgress: onProgress ?? this.nerConfig.onProgress })
      .then((d) => {
        this.ner = d;
        this.nerError = null;
        return d;
      })
      .catch((e: unknown) => {
        this.nerError = e instanceof Error ? e.message : String(e);
        this.nerLoading = null;
        return null;
      });
    return (await this.nerLoading) !== null;
  }

  async analyze(text: string, opts: DetectOptions = {}): Promise<AnalyzeResult> {
    const t0 = performance.now();
    const candidates: Span[] = [...detectRules(text), ...detectDictionary(text, opts.alwaysHide)];
    const nerUsed = await this.initNer();
    if (nerUsed && this.ner) candidates.push(...(await this.ner.detect(text)));
    const spans = resolveSpans(text, candidates, opts);
    return { spans, nerUsed, ms: Math.round(performance.now() - t0) };
  }

  /**
   * Neutralize the writing style of an anonymized text with the given WebLLM model (loads it if needed):
   * the Outis neutralizer — plain everyday voice, checked sentence by sentence, rules fallback.
   */
  async rewrite(
    anonymized: string,
    modelId: string,
    onProgress?: (p: DownloadProgress) => void,
    opts: { mode?: NeutralizeMode } = {},
  ): Promise<RewriteResult> {
    await this.llm.load(modelId, onProgress);
    return neutralizeWithModel(anonymized, this.llm.generate, {
      mode: opts.mode ?? 'all',
      onProgress: (done, total) => onProgress?.({ progress: 100, text: `Rewriting · ${Math.min(done, total)} of ${total} sentences` }),
      extraCheck: async (original, candidate) => {
        if (!this.ner) return [];
        const invented = (await this.ner.detect(candidate)).filter((s) => s.type === 'PERSON' && s.score >= 0.8 && !original.includes(s.text));
        return invented.length ? [`do not add names (${invented.map((s) => s.text).join(', ')})`] : [];
      },
    });
  }
}
