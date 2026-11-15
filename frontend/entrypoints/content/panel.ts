import {
  anonymize,
  ENTITY_LABELS,
  findPlaceholders,
  normalizeStyle,
  type RewriteResult,
  type Span,
  type Vault,
} from '@nobody/engine';
import type { StyleMode } from '@/lib/settings';
import { BASE_CSS, createShadowHost, h, typeGroup } from './ui';

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
  paste: { primary: 'Paste safely', later: 'Paste when rewritten', waiting: 'Will paste when ready…', secondary: 'Paste original', secondaryTip: 'Paste exactly what you copied' },
  field: { primary: 'Replace with safe text', later: 'Replace when rewritten', waiting: 'Will replace when ready…', secondary: 'Keep my text', secondaryTip: 'Leave the box as it is' },
};

export type PanelResult =
  | { action: 'clean'; text: string; spans: Span[] }
  | { action: 'original' }
  | { action: 'cancel' };

const CSS =
  BASE_CSS +
  `
.nb { position: fixed; width: min(500px, calc(100vw - 32px)); background: var(--bg); border: 1px solid var(--line);
  border-radius: 14px; box-shadow: var(--shadow); display: flex; flex-direction: column; overflow: hidden;
  animation: pop .14s ease-out; }
@keyframes pop { from { opacity: 0; transform: translateY(6px) scale(.98); } to { opacity: 1; transform: none; } }
.head { display: flex; align-items: center; gap: 10px; padding: 12px 14px 10px; border-bottom: 1px solid var(--line); }
.logo { width: 26px; height: 26px; border-radius: 7px; background: linear-gradient(160deg,#7c3aed,#5b21b6); position: relative; flex: none; }
.logo::before { content: ''; position: absolute; left: 5px; right: 5px; top: 9px; height: 5px; border-radius: 2px; background: #111827; }
.logo::after { content: ''; position: absolute; left: 8px; right: 8px; bottom: 4px; height: 6px; border-radius: 6px 6px 2px 2px; background: #fff; }
.title { font-weight: 650; font-size: 14px; }
.sub { color: var(--muted); font-size: 12px; }
.x { margin-left: auto; border: 0; background: transparent; color: var(--muted); font-size: 18px; line-height: 1; padding: 4px 6px; border-radius: 6px; }
.x:hover { background: var(--soft); color: var(--fg); }
.body { overflow: auto; padding: 4px 14px 2px; flex: 1 1 auto; min-height: 0; }
.controls { flex: none; padding: 0 14px; border-top: 1px solid var(--line); }
.label { display: flex; justify-content: space-between; align-items: baseline; margin: 10px 0 4px; font-size: 11px;
  font-weight: 650; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
.label .hint { text-transform: none; letter-spacing: 0; font-weight: 400; }
.text { white-space: pre-wrap; word-break: break-word; max-height: 120px; overflow: auto; padding: 8px 10px;
  border: 1px solid var(--line); border-radius: 9px; font-size: 12.5px; }
.preview { max-height: 170px; background: var(--soft); }
mark { border-radius: 4px; padding: 0 2px; cursor: pointer; color: inherit; }
mark.who { background: var(--who); color: var(--who-fg); }
mark.where { background: var(--where); color: var(--where-fg); }
mark.contact { background: var(--contact); color: var(--contact-fg); }
mark.secret { background: var(--secret); color: var(--secret-fg); }
mark.kept { background: transparent; color: inherit; text-decoration: line-through dotted; opacity: .75; }
mark:hover { outline: 1.5px solid currentColor; }
.ph { background: var(--ph); color: var(--ph-fg); border-radius: 4px; padding: 0 3px; font-weight: 600; font-size: 12px; }
.chips { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.chip { font-size: 11.5px; padding: 2px 8px; border-radius: 999px; }
.chip.who { background: var(--who); color: var(--who-fg); } .chip.where { background: var(--where); color: var(--where-fg); }
.chip.contact { background: var(--contact); color: var(--contact-fg); } .chip.secret { background: var(--secret); color: var(--secret-fg); }
.row { display: flex; align-items: center; gap: 10px; margin: 10px 0 4px; }
.seg { display: inline-flex; border: 1px solid var(--line); border-radius: 9px; padding: 2px; gap: 2px; }
.seg button { border: 0; background: transparent; color: var(--muted); padding: 5px 10px; border-radius: 7px; font-size: 12.5px; }
.seg button.on { background: var(--accent); color: var(--accent-fg); }
.seg button:disabled { opacity: .45; cursor: not-allowed; }
.status { font-size: 12px; color: var(--muted); min-height: 18px; margin: 4px 0 2px; display: flex; gap: 6px; align-items: center; }
.status.warn { color: #b45309; }
.status.ready { color: var(--accent); font-weight: 600; background: var(--soft); border-radius: 8px; padding: 6px 8px; animation: pop .2s ease-out; }
.btn.primary.pulse { animation: pulse 1.2s ease-out 2; }
@keyframes pulse { 0% { box-shadow: 0 0 0 0 rgba(124,58,237,.55); } 100% { box-shadow: 0 0 0 10px rgba(124,58,237,0); } }
.spin { width: 12px; height: 12px; border-radius: 50%; border: 2px solid var(--line); border-top-color: var(--accent); animation: spin .8s linear infinite; flex: none; }
@keyframes spin { to { transform: rotate(360deg); } }
.foot { display: flex; gap: 8px; align-items: center; padding: 8px 14px 12px; flex: none; }
.btn { border: 1px solid var(--line); background: var(--bg); color: var(--fg); padding: 7px 12px; border-radius: 9px; font-size: 13px; }
.btn:hover { background: var(--soft); }
.btn.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; margin-left: auto; }
.btn.primary:hover { filter: brightness(1.08); }
.btn.primary:disabled { opacity: .55; cursor: progress; }
.btn.link { border: 0; background: transparent; color: var(--muted); padding: 7px 4px; }
.btn.link:hover { color: var(--fg); background: transparent; text-decoration: underline; }
kbd { font: 11px ui-monospace, monospace; opacity: .8; margin-left: 6px; }
.loading { padding: 18px 16px; display: flex; gap: 10px; align-items: center; }
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
  private status: { text: string; warn?: boolean; busy?: boolean; ready?: boolean } = { text: '' };
  private rewriteStarted = 0;
  /** User already pressed Enter while the AI rewrite was running — finish as soon as it's ready. */
  private queued = false;
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(private anchor: HTMLElement) {
    ({ host: this.host, root: this.root } = createShadowHost('nobody-root', CSS));
    this.card = h('div', { class: 'nb', attrs: { role: 'dialog', 'aria-label': 'Nobody privacy check' } });
    this.root.append(this.card);
    // Keep focus (and the cursor) in the page's text box: clicking the panel must not blur it,
    // or chat apps re-run their own focus logic and move the cursor. Enter/Esc work via onKey.
    this.card.addEventListener('mousedown', (e) => e.preventDefault());
    this.position();
    window.addEventListener('keydown', this.keyHandler, true);
  }

  /** Close as cancelled (e.g. the user went back to typing). */
  dismiss(): void {
    if (this.resolve) this.finish({ action: 'cancel' });
  }

  showLoading(message: string): void {
    this.card.replaceChildren(h('div', { class: 'loading' }, h('div', { class: 'spin' }), h('span', { text: message })));
  }

  review(init: PanelInit): Promise<PanelResult> {
    this.init = init;
    this.enabled = init.spans.map(() => true);
    this.style = init.style === 'ai' && !init.ai.available ? 'light' : init.style;
    this.render();
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

  private position(): void {
    const rect = this.anchor.getBoundingClientRect();
    const width = Math.min(500, innerWidth - 32);
    const left = Math.min(Math.max(16, rect.left + rect.width / 2 - width / 2), innerWidth - width - 16);
    this.card.style.left = `${left}px`;
    const above = rect.top - 26;
    const below = innerHeight - rect.bottom - 26;
    const NEEDED = 460; // enough for both texts, the style row, the status and the buttons
    if (above >= NEEDED) {
      this.card.style.bottom = `${Math.max(16, innerHeight - rect.top + 10)}px`;
      this.card.style.maxHeight = `${above}px`;
    } else if (below >= NEEDED) {
      this.card.style.top = `${rect.bottom + 10}px`;
      this.card.style.maxHeight = `${below}px`;
    } else {
      // Not enough room next to the box: float over the page (the box is not being edited meanwhile).
      this.card.style.top = '16px';
      this.card.style.maxHeight = `${innerHeight - 32}px`;
    }
  }

  private activeSpans(): Span[] {
    return this.init.spans.filter((_, i) => this.enabled[i]);
  }

  /** Recompute what will be pasted; kicks off an AI rewrite when needed. */
  private compute(): void {
    const anon = anonymize(this.init.original, this.activeSpans(), this.init.vault.clone()).text;
    this.status = { text: '' };
    if (this.style === 'off') {
      this.preview = anon;
    } else if (this.style === 'light') {
      this.preview = normalizeStyle(anon);
      this.status = { text: 'Light style: punctuation, slang, typos and emoji normalized.' };
    } else {
      const cached = this.rewriteCache.get(anon);
      if (cached) {
        this.preview = cached.text;
        this.status = cached.rewritten
          ? { text: `✨ Rewritten text is ready (${this.init.ai.modelName}, ${(cached.ms / 1000).toFixed(1)} s)`, ready: true }
          : { text: 'AI rewrite changed the meaning in places — those parts use Light style instead.', warn: true };
      } else {
        // Don't make the user wait: show the Light version now, swap in the rewrite when it's ready.
        this.preview = normalizeStyle(anon);
        const secs = this.rewriteStarted ? Math.round((Date.now() - this.rewriteStarted) / 1000) : 0;
        const what = this.progressText || `Rewriting with ${this.init.ai.modelName}`;
        this.status = { text: `${what} · ${secs}s`, busy: true };
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
        this.rewriteCache.set(anon, { text: normalizeStyle(anon), rewritten: false, problems: [String(e)], ms: 0 });
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
    const { original, spans, ai, nerUsed } = this.init;
    const hiddenCount = this.enabled.filter(Boolean).length;
    const busy = Boolean(this.status.busy);
    const labels = LABELS[this.init.mode ?? 'paste'];

    // --- original text with clickable highlights ---
    const orig = h('div', { class: 'text' });
    let cursor = 0;
    spans.forEach((s, i) => {
      orig.append(original.slice(cursor, s.start));
      const on = this.enabled[i];
      orig.append(
        h('mark', {
          class: `${typeGroup(s.type)}${on ? '' : ' kept'}`,
          text: original.slice(s.start, s.end),
          title: `${ENTITY_LABELS[s.type]} · click to ${on ? 'keep visible' : 'hide again'}`,
          on: {
            click: () => {
              this.enabled[i] = !this.enabled[i];
              this.render();
            },
          },
        }),
      );
      cursor = s.end;
    });
    orig.append(original.slice(cursor));

    // --- preview with placeholders highlighted ---
    const prev = h('div', { class: 'text preview' });
    cursor = 0;
    for (const m of findPlaceholders(this.preview)) {
      prev.append(this.preview.slice(cursor, m.start), h('span', { class: 'ph', text: this.preview.slice(m.start, m.end) }));
      cursor = m.end;
    }
    prev.append(this.preview.slice(cursor));

    // --- type summary chips ---
    const counts = new Map<string, { n: number; group: string }>();
    spans.forEach((s, i) => {
      if (!this.enabled[i]) return;
      const label = ENTITY_LABELS[s.type];
      const c = counts.get(label) ?? { n: 0, group: typeGroup(s.type) };
      c.n++;
      counts.set(label, c);
    });
    const chips = h('div', { class: 'chips' }, ...[...counts].map(([label, c]) => h('span', { class: `chip ${c.group}`, text: `${label} × ${c.n}` })));

    const seg = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': 'Writing style' } });
    const modes: Array<[StyleMode, string, string]> = [
      ['off', 'Off', 'Keep your wording, only hide personal info'],
      ['light', 'Light', 'Instant cleanup of typos, slang, punctuation and emoji'],
      ['ai', 'AI rewrite', ai.available ? `Rewrite with ${ai.modelName}, fully on this device` : 'Pick a model in Nobody settings to enable'],
    ];
    for (const [mode, label, tip] of modes) {
      const b = h('button', {
        class: this.style === mode ? 'on' : '',
        text: label,
        title: tip,
        attrs: { role: 'radio', 'aria-checked': String(this.style === mode) },
        on: {
          click: () => {
            this.style = mode;
            this.queued = false;
            this.render();
          },
        },
      });
      if (mode === 'ai' && !ai.available) b.disabled = true;
      seg.append(b);
    }

    const primary = h(
      'button',
      { class: 'btn primary', on: { click: () => this.pasteClean() } },
      busy ? (this.queued ? labels.waiting : labels.later) : this.status.ready ? `${labels.primary} (rewritten)` : labels.primary,
      this.queued ? null : h('kbd', { text: '↵' }),
    );
    if (this.queued) primary.disabled = true;
    if (this.status.ready) primary.classList.add('pulse');
    // While the rewrite runs, offer a way to skip it.
    const skip = busy
      ? h('button', { class: 'btn', text: 'Without rewrite', title: 'Use the Light version now', on: { click: () => this.finishClean() } })
      : null;

    this.card.replaceChildren(
      h(
        'div',
        { class: 'head' },
        h('div', { class: 'logo' }),
        h(
          'div',
          {},
          h('div', { class: 'title', text: spans.length ? `Hiding ${hiddenCount} of ${spans.length} personal item${spans.length === 1 ? '' : 's'}` : 'No personal info found' }),
          h('div', {
            class: 'sub',
            text:
              this.init.note ??
              (nerUsed ? 'Checked on this device · nothing was sent anywhere' : 'Checked on this device (patterns only — name detector still loading)'),
          }),
        ),
        h('button', { class: 'x', text: '×', title: 'Cancel (Esc)', on: { click: () => this.finish({ action: 'cancel' }) } }),
      ),
      h(
        'div',
        { class: 'body' },
        spans.length ? h('div', { class: 'label' }, 'Your text', h('span', { class: 'hint', text: 'click a highlight to keep it' })) : null,
        spans.length ? orig : null,
        spans.length ? chips : null,
        h('div', { class: 'label' }, 'What the site will see'),
        prev,
      ),
      // Always visible (never scrolled away), so "rewrite is ready" can't be missed.
      h(
        'div',
        { class: 'controls' },
        h('div', { class: 'row' }, h('span', { class: 'sub', text: 'Writing style' }), seg),
        h('div', { class: `status${this.status.warn ? ' warn' : ''}${this.status.ready ? ' ready' : ''}` }, busy ? h('div', { class: 'spin' }) : null, this.status.text),
      ),
      h(
        'div',
        { class: 'foot' },
        h('button', { class: 'btn link', text: labels.secondary, title: labels.secondaryTip, on: { click: () => this.finish({ action: 'original' }) } }),
        h('button', { class: 'btn', text: 'Cancel', on: { click: () => this.finish({ action: 'cancel' }) } }),
        skip,
        primary,
      ),
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
      `.t { position: fixed; right: 20px; bottom: 20px; background: var(--bg); color: var(--fg); border: 1px solid var(--line);
        box-shadow: var(--shadow); border-radius: 999px; padding: 8px 14px; font-size: 13px; display: flex; gap: 8px; align-items: center;
        animation: in .15s ease-out; } @keyframes in { from { opacity: 0; transform: translateY(6px); } }
       .dot { width: 8px; height: 8px; border-radius: 50%; background: #7c3aed; }`,
  );
  root.append(h('div', { class: 'nb t' }, h('span', { class: 'dot' }), message));
  setTimeout(() => host.remove(), ms);
}
