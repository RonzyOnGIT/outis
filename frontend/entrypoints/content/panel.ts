import {
  anonymize,
  ENTITY_LABELS,
  findPlaceholders,
  neutralizeLight,
  type RewriteResult,
  type Span,
  type Vault,
} from '@nobody/engine';
import type { StyleMode } from '@/lib/settings';
import { BASE_CSS, createShadowHost, h, reportVisibility } from './ui';
import { CHECK, chipName, CLOSED_EYE, CROSS, icon, weave } from '@/lib/brand';

export interface PanelInit {
  original: string;
  spans: Span[];
  /** Snapshot of the site's vault — previews use clones, nothing is saved here. */
  vault: Vault;
  style: StyleMode;
  ai: { available: boolean; modelName: string };
  nerUsed: boolean;
  rewrite: (anonymized: string, onProgress: (text: string) => void) => Promise<RewriteResult>;
  /** "paste": text from the clipboard. "field": text already typed into the box. */
  mode?: 'paste' | 'field';
  /** Shown under the title, e.g. why the panel opened. */
  note?: string;
  /** Real values are shown back in answers (restore mode is not off). */
  restoreHint?: boolean;
  /** Called whenever the panel's state changes (drives the top status bar). */
  onState?: (s: PanelState) => void;
}

export interface PanelState {
  /** AI rewrite still running. */
  busy: boolean;
  /** AI rewrite finished and passed the checks. */
  ready: boolean;
  /** AI rewrite fell back to Light in places. */
  warn: boolean;
  /** User pressed Enter while busy — the panel is hidden and will finish when ready. */
  queued: boolean;
  style: StyleMode;
  progressText: string;
}

const LABELS = {
  paste: { primary: 'Paste disguised', waiting: 'Will paste when rewritten…', secondary: 'Cancel', exposed: 'Paste original', exposedTip: 'Paste exactly what you copied, with your real details' },
  field: { primary: 'Replace with disguised text', waiting: 'Will replace when rewritten…', secondary: 'Keep editing', exposed: 'Allow as typed', exposedTip: 'Leave the box as it is; your real details can be sent' },
};

export type PanelResult =
  | { action: 'clean'; text: string; spans: Span[] }
  | { action: 'original' }
  | { action: 'cancel' };

/** Values that read best in monospace (as in the Outis style sheet). */
const MONO_TYPES = new Set(['EMAIL', 'PHONE', 'CARD', 'IBAN', 'IP', 'URL', 'SECRET', 'ID', 'USER', 'DATE']);

const CSS =
  BASE_CSS +
  `
.nb.drawer { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); background: var(--ivory); border-left: 1px solid var(--line);
  box-shadow: -18px 0 44px rgba(31,35,51,.12); display: flex; flex-direction: column; animation: slide .16s ease-out; }
@keyframes slide { from { opacity: 0; transform: translateX(16px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { .nb.drawer { animation: none; } }
.head { display: flex; align-items: flex-start; gap: 12px; padding: 22px 20px 14px; }
.head .eye-icon { width: 30px; height: 30px; margin-top: 2px; }
.title { font: 500 23px/1.15 var(--serif); }
.sub { color: var(--quiet); font-size: 13px; margin-top: 2px; }
.x { margin-left: auto; border: 0; background: transparent; color: var(--quiet); width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; padding: 0; flex: none; }
.x:hover { background: var(--track); color: var(--ink); }
.x svg { width: 14px; height: 14px; }
.body { overflow: auto; padding: 0 20px 12px; flex: 1 1 auto; min-height: 0; }
.label { display: flex; justify-content: space-between; align-items: baseline; gap: 12px; font-weight: 600; font-size: 13.5px; margin: 16px 0 8px; }
.label .hint { font-weight: 400; color: var(--quiet); font-size: 12.5px; }
.items { display: flex; flex-direction: column; }
.item { display: grid; grid-template-columns: auto 1fr auto; gap: 12px; align-items: center; padding: 10px 0; border-bottom: 1px solid var(--line); cursor: pointer; }
.item:last-child { border-bottom: 0; }
.item input { width: 17px; height: 17px; margin: 0; accent-color: var(--ink); cursor: pointer; }
.value { font-weight: 500; overflow-wrap: anywhere; }
.value.mono { font: 500 13px/1.4 var(--mono); }
.kind { color: var(--quiet); font-size: 12px; }
.tick { color: var(--quiet); font-size: 12.5px; white-space: nowrap; }
.voice { display: flex; flex-direction: column; gap: 8px; }
.seg { display: flex; background: var(--track); border-radius: 10px; padding: 3px; gap: 2px; }
.seg button { flex: 1; border: 0; background: transparent; color: var(--quiet); padding: 6px 8px; border-radius: 8px; font-size: 12.5px; font-weight: 500; }
.seg button.on { background: var(--paper); color: var(--ink); font-weight: 600; box-shadow: 0 1px 3px rgba(31,35,51,.12); }
.seg button:disabled { opacity: .45; cursor: not-allowed; }
.note { color: var(--quiet); font-size: 12.5px; display: flex; gap: 8px; align-items: center; }
.preview { white-space: pre-wrap; word-break: break-word; max-height: 240px; overflow: auto; padding: 12px 14px; background: var(--paper);
  border: 1px solid var(--line); border-radius: 12px; font-size: 13.5px; line-height: 1.85; }
.checks { list-style: none; margin: 10px 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--quiet); }
.checks li { display: flex; gap: 8px; align-items: center; }
.checks svg { width: 14px; height: 14px; color: var(--bronze); flex: none; }
.notice { background: var(--notice); border: 1px solid var(--notice-line); border-radius: 10px; padding: 9px 12px; font-size: 12.5px; margin-top: 12px; }
.foot { flex: none; padding: 14px 20px 18px; border-top: 1px solid var(--line); display: flex; flex-direction: column; gap: 10px; }
.buttons { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.buttons .primary { flex: 1; padding: 12px 14px; }
.buttons .primary.pulse { animation: pulse 1.2s ease-out 2; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(138,90,38,.45); } 100% { box-shadow: 0 0 0 10px rgba(138,90,38,0); } }
.buttons .btn:not(.primary):not(.text) { padding: 12px 14px; }
.fine { color: var(--quiet); font-size: 12px; display: flex; justify-content: space-between; gap: 10px; align-items: baseline; }
.fine .btn.text { white-space: nowrap; padding: 0; }
kbd { font: 11px var(--mono); opacity: .75; margin-left: 6px; }
.loading { padding: 4px 20px; display: flex; flex-direction: column; gap: 10px; color: var(--quiet); }
`;

export class ReviewPanel {
  private host: HTMLElement;
  private root: ShadowRoot;
  private card: HTMLElement;
  private resolve: ((r: PanelResult) => void) | null = null;
  private keyHandler = (e: KeyboardEvent) => this.onKey(e);

  // review state
  private init!: PanelInit;
  private enabled: boolean[] = [];
  private style: StyleMode = 'light';
  private rewriteCache = new Map<string, RewriteResult>();
  private rewriting: string | null = null;
  private progressText = '';
  private preview = '';
  /** "TYPE:value" → placeholder it becomes in the current preview. */
  private placeholders = new Map<string, string>();
  private status: { text: string; warn?: boolean; busy?: boolean; ready?: boolean } = { text: '' };
  private rewriteStarted = 0;
  /** User already pressed Enter while the AI rewrite was running — finish as soon as it's ready. */
  private queued = false;
  private ticker: ReturnType<typeof setInterval> | undefined;

  /** `_anchor`: the text box being checked (the panel is a side panel, so it is not positioned against it). */
  constructor(_anchor: HTMLElement) {
    ({ host: this.host, root: this.root } = createShadowHost('nobody-root', CSS));
    this.card = h('div', { class: 'nb drawer', attrs: { role: 'dialog', 'aria-label': 'Outis: before you send' } });
    this.root.append(this.card);
    // Keep focus (and the cursor) in the page's text box: clicking the panel must not blur it,
    // or chat apps re-run their own focus logic and move the cursor. Enter/Esc work via onKey.
    this.card.addEventListener('mousedown', (e) => {
      if (!(e.target instanceof HTMLInputElement)) e.preventDefault();
    });
    window.addEventListener('keydown', this.keyHandler, true);
  }

  /** Close as cancelled (e.g. the user went back to typing). */
  dismiss(): void {
    if (this.resolve) this.finish({ action: 'cancel' });
  }

  showLoading(message: string): void {
    this.card.replaceChildren(this.header('Before you send', 'Nothing has left this page yet.'),
      h('div', { class: 'loading' }, h('span', { text: message }), icon(weave(true))));
  }

  private header(title: string, sub: string): HTMLElement {
    return h('div', { class: 'head' }, icon(CLOSED_EYE, 'eye-icon'),
      h('div', {}, h('div', { class: 'title', text: title }), h('div', { class: 'sub', text: sub })),
      h('button', { class: 'x', title: 'Close (Esc)', attrs: { 'aria-label': 'Close' }, on: { click: () => this.finish({ action: 'cancel' }) } }, icon(CROSS)));
  }

  review(init: PanelInit): Promise<PanelResult> {
    this.init = init;
    this.enabled = init.spans.map(() => true);
    this.style = init.style === 'ai' && !init.ai.available ? 'light' : init.style;
    this.render();
    reportVisibility('panel', this.host, this.card);
    return new Promise((r) => (this.resolve = r));
  }

  close(): void {
    clearInterval(this.ticker);
    window.removeEventListener('keydown', this.keyHandler, true);
    this.host.remove();
  }

  private finish(result: PanelResult): void {
    const r = this.resolve;
    this.resolve = null;
    this.close();
    r?.(result);
  }

  private activeSpans(): Span[] {
    return this.init.spans.filter((_, i) => this.enabled[i]);
  }

  /** Recompute what will be pasted; kicks off an AI rewrite when needed. */
  private compute(): void {
    const result = anonymize(this.init.original, this.activeSpans(), this.init.vault.clone());
    const anon = result.text;
    this.placeholders = new Map(result.replacements.map((r) => [`${r.span.type}:${r.span.text}`, r.placeholder]));
    this.status = { text: '' };
    if (this.style === 'off') {
      this.preview = anon;
      this.status = { text: 'Your wording stays as written. Only personal details are replaced.' };
    } else if (this.style === 'light') {
      this.preview = neutralizeLight(anon);
      this.status = { text: 'Light rules removed the strongest habits: punctuation, fillers, slang and shorthand.' };
    } else {
      const cached = this.rewriteCache.get(anon);
      if (cached) {
        this.preview = cached.text;
        this.status = cached.rewritten
          ? { text: `Rewritten on this device by ${this.init.ai.modelName} in ${(cached.ms / 1000).toFixed(1)} s.`, ready: true }
          : { text: 'Some sentences failed the meaning check, so they use Light rules.', warn: true };
      } else {
        // Don't make the user wait: show the Light version now, swap in the rewrite when it's ready.
        this.preview = neutralizeLight(anon);
        const secs = this.rewriteStarted ? Math.round((Date.now() - this.rewriteStarted) / 1000) : 0;
        const what = this.progressText || `Rewriting on this device with ${this.init.ai.modelName}`;
        this.status = { text: `${what} · ${secs}s. Light rules shown until then.`, busy: true };
        if (this.rewriting !== anon) this.startRewrite(anon);
      }
    }
  }

  private startRewrite(anon: string): void {
    this.rewriting = anon;
    this.progressText = '';
    this.rewriteStarted = Date.now();
    clearInterval(this.ticker);
    this.ticker = setInterval(() => this.rewriting === anon && this.resolve && this.render(), 1000);
    this.init
      .rewrite(anon, (text) => {
        if (this.rewriting !== anon) return;
        this.progressText = text;
        this.render();
      })
      .then((res) => {
        this.rewriteCache.set(anon, res);
      })
      .catch((e: unknown) => {
        this.rewriteCache.set(anon, { text: neutralizeLight(anon), rewritten: false, problems: [String(e)], ms: 0 });
      })
      .finally(() => {
        if (this.rewriting === anon) {
          this.rewriting = null;
          clearInterval(this.ticker);
        }
        if (!this.resolve) return;
        this.render();
        if (this.queued && this.style === 'ai' && !this.status.busy) {
          this.queued = false;
          this.finishClean();
        }
      });
  }

  private render(): void {
    this.compute();
    this.init.onState?.({
      busy: Boolean(this.status.busy),
      ready: Boolean(this.status.ready),
      warn: Boolean(this.status.warn),
      queued: this.queued,
      style: this.style,
      progressText: this.progressText,
    });
    const { spans, ai, nerUsed } = this.init;
    const busy = Boolean(this.status.busy);
    const labels = LABELS[this.init.mode ?? 'paste'];

    // --- Each detected detail once, with the placeholder it becomes (repeats share a checkbox) ---
    const groups = new Map<string, number[]>();
    spans.forEach((s, i) => {
      const key = `${s.type}:${s.text}`;
      groups.set(key, [...(groups.get(key) ?? []), i]);
    });
    const items = h('div', { class: 'items' });
    for (const [key, indexes] of groups) {
      const s = spans[indexes[0]!]!;
      const on = indexes.every((i) => this.enabled[i]);
      const box = h('input', { attrs: { type: 'checkbox', 'aria-label': `Hide ${s.text}` } });
      box.checked = on;
      box.addEventListener('change', () => {
        for (const i of indexes) this.enabled[i] = box.checked;
        this.render();
      });
      const placeholder = this.placeholders.get(key);
      items.append(h('label', { class: 'item' }, box,
        h('div', {}, h('div', { class: `value${MONO_TYPES.has(s.type) ? ' mono' : ''}`, text: s.text }),
          h('div', { class: 'kind', text: ENTITY_LABELS[s.type] + (indexes.length > 1 ? ` · ${indexes.length} times` : '') })),
        on && placeholder ? h('span', { class: 'chip', text: chipName(placeholder), title: `Sent as ${placeholder}` }) : h('span', { class: 'tick', text: 'Tick to hide' })));
    }

    // --- What the site receives, placeholders drawn as chips ---
    const prev = h('div', { class: 'preview', attrs: { 'aria-label': 'What the AI will see' } });
    let cursor = 0;
    for (const m of findPlaceholders(this.preview)) {
      prev.append(this.preview.slice(cursor, m.start), h('span', { class: 'chip', text: chipName(m.placeholder), title: `Sent as ${m.placeholder}` }));
      cursor = m.end;
    }
    prev.append(this.preview.slice(cursor));

    const seg = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': 'Writing voice' } });
    const modes: Array<[StyleMode, string, string]> = [
      ['off', 'Keep mine', 'Keep your wording, only hide personal details'],
      ['light', 'Light', 'Instant rules: punctuation, fillers, slang, shorthand'],
      ['ai', 'Full rewrite', ai.available ? `Rewrite with ${ai.modelName}, on this device` : 'Pick a model in Outis settings to enable'],
    ];
    for (const [mode, label, tip] of modes) {
      const b = h('button', {
        class: this.style === mode ? 'on' : '',
        text: label,
        title: tip,
        attrs: { role: 'radio', 'aria-checked': String(this.style === mode) },
        on: { click: () => { this.style = mode; this.queued = false; this.render(); } },
      });
      if (mode === 'ai' && !ai.available) b.disabled = true;
      seg.append(b);
    }

    // Proof, not claims: only checks that actually ran for this text.
    const hiddenCount = this.activeSpans().length;
    const proof: string[] = [];
    if (hiddenCount) proof.push(`${hiddenCount} personal ${hiddenCount === 1 ? 'detail' : 'details'} replaced on this device`);
    if (this.style === 'off') proof.push('Your wording kept as written');
    if (this.style === 'light' || busy) proof.push('Light rules never change facts or numbers');
    if (this.style === 'ai' && this.status.ready) proof.push('Every number and placeholder kept', 'Meaning checked sentence by sentence');
    const checks = h('ul', { class: 'checks' }, ...proof.map((text) => h('li', {}, icon(CHECK), text)));

    const primary = h('button', { class: 'btn primary', on: { click: () => this.pasteClean() } },
      this.queued ? labels.waiting : labels.primary, this.queued ? null : h('kbd', { text: '↵' }));
    if (this.queued) primary.disabled = true;
    if (this.status.ready) primary.classList.add('pulse');
    // While the rewrite runs, offer a way to skip it.
    const skip = busy ? h('button', { class: 'btn', text: 'Use Light rules now', title: 'Finish now with the Light version', on: { click: () => this.finishClean() } }) : null;

    this.card.replaceChildren(
      this.header('Before you send', this.init.note ?? 'Nothing has left this page yet.'),
      h('div', { class: 'body' },
        spans.length
          ? h('div', {}, h('div', { class: 'label' }, 'Hidden from the AI', h('span', { class: 'hint', text: 'Untick to keep a detail' })), items)
          : h('div', { class: 'label', text: 'No personal details found' }),
        nerUsed ? null : h('div', { class: 'notice', text: 'Name detection is still loading, so only patterns and your lists were checked. Look over names yourself.' }),
        h('div', { class: 'voice' },
          h('div', { class: 'label' }, 'Writing voice'),
          seg,
          this.style === 'off' ? null : icon(weave(busy)),
          h('div', { class: 'note' }, this.status.text)),
        this.status.warn ? h('div', { class: 'notice', text: 'Those sentences keep your meaning with Light rules instead of the model’s version.' }) : null,
        h('div', { class: 'label', text: 'What the AI will see' }),
        prev,
        checks),
      h('div', { class: 'foot' },
        h('div', { class: 'buttons' }, primary, skip ?? h('button', { class: 'btn', text: labels.secondary, on: { click: () => this.finish({ action: 'cancel' }) } })),
        h('div', { class: 'fine' },
          h('span', { text: this.init.restoreHint ? 'Your real details come back in the reply, on your screen only.' : 'Placeholders stay in the reply.' }),
          h('button', { class: 'btn text exposed', text: labels.exposed, title: labels.exposedTip, on: { click: () => this.finish({ action: 'original' }) } }))),
    );
  }

  /** Enter / primary button: with AI rewrite still running, wait for it; otherwise finish now. */
  private pasteClean(): void {
    if (this.style === 'ai' && this.status.busy) {
      // Get out of the way: the top bar shows progress, and the text is replaced when ready.
      this.queued = true;
      this.card.style.display = 'none';
      this.render();
      return;
    }
    this.finishClean();
  }

  private finishClean(): void {
    this.finish({ action: 'clean', text: this.preview, spans: this.activeSpans() });
  }

  private onKey(e: KeyboardEvent): void {
    if (!this.resolve) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.finish({ action: 'cancel' });
    } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      e.stopImmediatePropagation();
      this.pasteClean();
    }
  }
}

/** Small transient notice in the corner. */
export function toast(message: string, ms = 2600): void {
  const { host, root } = createShadowHost(
    'nobody-toast',
    BASE_CSS +
      `.t { position: fixed; right: 20px; bottom: 20px; background: var(--paper); color: var(--ink); border: 1px solid var(--line);
        box-shadow: var(--shadow); border-radius: 12px; padding: 10px 14px; font-size: 13px; display: flex; gap: 10px; align-items: center;
        animation: in .15s ease-out; } @keyframes in { from { opacity: 0; transform: translateY(6px); } }
       .t .eye-icon { width: 20px; height: 20px; }`,
  );
  root.append(h('div', { class: 'nb t', attrs: { role: 'status' } }, icon(CLOSED_EYE, 'eye-icon'), message));
  setTimeout(() => host.remove(), ms);
}
