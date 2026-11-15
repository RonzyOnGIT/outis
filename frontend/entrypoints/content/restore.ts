import { ENTITY_LABELS, findPlaceholders, type Vault, type VaultEntry } from '@nobody/engine';
import { BASE_CSS, createShadowHost, h } from './ui';
import { CLOSED_EYE, icon } from '@/lib/brand';

/**
 * Lets you read AI answers with real values — only on your screen.
 *
 *  - "hover"   (default, safest): placeholders are tinted; hovering shows the real value in a
 *              tooltip inside our closed shadow root. The page DOM never contains real values,
 *              so session-replay/analytics scripts on the site can't pick them up.
 *  - "replace" (opt-in): the placeholder text is swapped for the real value in the page.
 *              Nicer to read, but scripts on the site could read it back.
 *
 * Only text nodes' data is touched (never nodes added/removed), and editors are skipped.
 */
export type RestoreMode = 'off' | 'hover' | 'replace';

const SKIP_SELECTOR = 'textarea, input, script, style, noscript, [contenteditable=""], [contenteditable="true"], #nobody-root, #nobody-tip';
const QUICK_TEST = /[A-Z]_\d/i;
const HL_PLACEHOLDER = 'nobody-placeholder';
const HL_RESTORED = 'nobody-restored';

interface Mark {
  node: Text;
  start: number;
  end: number;
  /** Text expected at [start, end) — used to drop stale marks after the page re-renders. */
  expect: string;
  entry: VaultEntry;
}

const TIP_CSS =
  BASE_CSS +
  `.tip { position: fixed; pointer-events: none; background: var(--ink); color: var(--paper); border-radius: 10px; padding: 9px 12px;
     max-width: 340px; display: flex; gap: 9px; align-items: center; box-shadow: 0 10px 28px rgba(31,35,51,.28); font-size: 13.5px; }
   .tip .eye-icon { width: 18px; height: 18px; color: #D9B27C; }
   .v { font-weight: 600; word-break: break-word; }
   .m { color: #C9CAD2; }`;

export class PageRestorer {
  private observer: MutationObserver | null = null;
  private scheduled = false;
  private marks: Mark[] = [];
  private mode: RestoreMode = 'off';
  private tip: { host: HTMLElement; box: HTMLElement } | null = null;
  private moveQueued = false;
  private lastPointer = { x: 0, y: 0 };
  private onMove = (e: MouseEvent) => {
    this.lastPointer = { x: e.clientX, y: e.clientY };
    if (this.moveQueued) return;
    this.moveQueued = true;
    requestAnimationFrame(() => {
      this.moveQueued = false;
      this.updateTip();
    });
  };

  constructor(private getVault: () => Vault | null) {}

  setMode(mode: RestoreMode): void {
    if (mode === this.mode && (mode === 'off' || this.observer)) return;
    this.stop();
    this.mode = mode;
    if (mode !== 'off') this.start();
  }

  refresh(): void {
    this.schedule();
  }

  private start(): void {
    if (!document.body) {
      document.addEventListener('DOMContentLoaded', () => this.start(), { once: true });
      return;
    }
    injectHighlightStyle();
    this.observer = new MutationObserver(() => this.schedule());
    this.observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    if (this.mode === 'hover') document.addEventListener('mousemove', this.onMove, { passive: true });
    this.schedule();
  }

  private stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    document.removeEventListener('mousemove', this.onMove);
    this.marks = [];
    this.hideTip();
    const hl = (globalThis.CSS as any)?.highlights;
    hl?.delete(HL_PLACEHOLDER);
    hl?.delete(HL_RESTORED);
  }

  private schedule(): void {
    if (this.scheduled || !this.observer) return;
    this.scheduled = true;
    setTimeout(() => {
      this.scheduled = false;
      this.pass();
    }, 120);
  }

  private textNodes(): Text[] {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const t = (n as Text).data;
        if (t.length < 3 || !QUICK_TEST.test(t)) return NodeFilter.FILTER_REJECT;
        const parent = n.parentElement;
        if (!parent || parent.isContentEditable || parent.closest(SKIP_SELECTOR)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });
    const nodes: Text[] = [];
    while (walker.nextNode()) nodes.push(walker.currentNode as Text);
    return nodes;
  }

  private pass(): void {
    const vault = this.getVault();
    if (!vault || vault.size === 0 || !document.body) return;
    // Drop marks whose text the page has re-rendered.
    this.marks = this.marks.filter((m) => m.node.isConnected && m.node.data.slice(m.start, m.end) === m.expect);
    const known = new Set(this.marks.map((m) => m.node));

    for (const node of this.textNodes()) {
      const matches = findPlaceholders(node.data, vault);
      if (!matches.length) continue;
      if (this.mode === 'hover') {
        if (known.has(node)) this.marks = this.marks.filter((m) => m.node !== node);
        for (const m of matches) {
          this.marks.push({ node, start: m.start, end: m.end, expect: node.data.slice(m.start, m.end), entry: m.entry! });
        }
      } else {
        let out = '';
        let cursor = 0;
        for (const m of matches) {
          out += node.data.slice(cursor, m.start);
          const value = m.entry!.value;
          this.marks.push({ node, start: out.length, end: out.length + value.length, expect: value, entry: m.entry! });
          out += value;
          cursor = m.end;
        }
        out += node.data.slice(cursor);
        node.data = out;
      }
    }
    this.paint();
  }

  private paint(): void {
    const css = globalThis.CSS as any;
    const HighlightCtor = (globalThis as any).Highlight;
    if (!css?.highlights || !HighlightCtor) return;
    const ranges = this.marks.map((m) => {
      const r = new Range();
      r.setStart(m.node, m.start);
      r.setEnd(m.node, m.end);
      return r;
    });
    css.highlights.set(this.mode === 'hover' ? HL_PLACEHOLDER : HL_RESTORED, new HighlightCtor(...ranges));
  }

  private updateTip(): void {
    const { x, y } = this.lastPointer;
    const hit = this.marks.find((m) => {
      if (!m.node.isConnected) return false;
      const r = new Range();
      r.setStart(m.node, m.start);
      r.setEnd(m.node, m.end);
      return [...r.getClientRects()].some((b) => x >= b.left && x <= b.right && y >= b.top && y <= b.bottom);
    });
    if (!hit) return this.hideTip();
    if (!this.tip) {
      const { host, root } = createShadowHost('nobody-tip', TIP_CSS);
      const box = h('div', { class: 'nb tip' });
      root.append(box);
      this.tip = { host, box };
    }
    this.tip.box.title = ENTITY_LABELS[hit.entry.type];
    this.tip.box.replaceChildren(
      icon(CLOSED_EYE, 'eye-icon'),
      h('span', {}, h('span', { class: 'v', text: hit.entry.value }), h('span', { class: 'm', text: '. Only you can see this.' })),
    );
    // Below the pointer, or above it when close to the bottom edge.
    const height = this.tip.box.offsetHeight || 48;
    this.tip.box.style.left = `${Math.max(8, Math.min(x + 12, innerWidth - 330))}px`;
    this.tip.box.style.top = `${y + 18 + height > innerHeight - 8 ? y - height - 12 : y + 18}px`;
  }

  private hideTip(): void {
    this.tip?.host.remove();
    this.tip = null;
  }
}

function injectHighlightStyle(): void {
  if (document.getElementById('nobody-highlight-style')) return;
  const style = document.createElement('style');
  style.id = 'nobody-highlight-style';
  style.textContent = [
    // Sealed placeholders: seal background with a dotted bronze underline (Outis style sheet).
    `::highlight(${HL_PLACEHOLDER}) { background-color: rgba(242, 232, 217, 0.95); text-decoration: underline dotted #8A5A26; }`,
    `::highlight(${HL_RESTORED}) { background-color: rgba(242, 232, 217, 0.95); }`,
  ].join('\n');
  (document.head ?? document.documentElement).appendChild(style);
}
