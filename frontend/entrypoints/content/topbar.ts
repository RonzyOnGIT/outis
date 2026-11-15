import { BASE_CSS, createShadowHost, h, reportVisibility } from './ui';
import { diag } from '@/lib/diag';
import { CHECK, CLOSED_EYE, CROSS, icon as svgIcon } from '@/lib/brand';

/**
 * A slim status bar pinned to the top of the page:
 *   loading (bronze progress) → ready (bronze check) / warn (notice colours).
 * Lives in a closed shadow root, so the page can't read it.
 */
export type BarState = 'loading' | 'ready' | 'warn';

const CSS =
  BASE_CSS +
  `
.bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); width: min(560px, calc(100vw - 32px));
  border-radius: 14px; overflow: hidden; box-shadow: var(--shadow); animation: drop .18s ease-out;
  background: var(--paper); border: 1px solid var(--line); color: var(--ink); }
@keyframes drop { from { opacity: 0; transform: translate(-50%, -10px); } to { opacity: 1; transform: translate(-50%, 0); } }
@media (prefers-reduced-motion: reduce) { .bar { animation: none; } }
.warn { background: var(--notice); border-color: var(--notice-line); }
.row { display: flex; align-items: center; gap: 12px; padding: 11px 14px; }
.icon { width: 28px; height: 28px; flex: none; display: grid; place-items: center; border-radius: 50%; background: #EFE5D6; color: var(--bronze); }
.icon svg { width: 18px; height: 18px; }
.warn .icon { background: transparent; color: var(--ink); font: 600 16px/1 var(--sans); border: 1.5px solid var(--ink); width: 22px; height: 22px; }
.text { flex: 1; min-width: 0; }
.title { font-weight: 600; }
.sub { color: var(--quiet); font-size: 12.5px; }
.track { height: 3px; background: var(--track); }
.fill { height: 100%; background: var(--bronze); transition: width .3s ease; }
.indeterminate .fill { width: 35% !important; animation: slideFill 1.1s ease-in-out infinite; }
@keyframes slideFill { from { margin-left: -35%; } to { margin-left: 100%; } }
.act { background: var(--paper); border: 1px solid var(--line); color: var(--ink); border-radius: 8px; padding: 5px 10px; font-weight: 600; }
.act:hover { border-color: #CDBFA8; }
.x { background: transparent; border: 0; color: var(--quiet); width: 26px; height: 26px; border-radius: 7px; display: grid; place-items: center; padding: 0; }
.x:hover { background: var(--track); color: var(--ink); }
.x svg { width: 13px; height: 13px; }
`;

export class TopBar {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  private lastLogged = '';
  private lastChecked = '';

  /**
   * @param fraction 0..1 for a real progress bar, undefined for an animated "working" bar.
   * @param autoHideMs hide automatically after this long (used for "ready").
   */
  show(state: BarState, title: string, sub?: string, fraction?: number, autoHideMs?: number, action?: { label: string; run: () => void }): void {
    clearTimeout(this.hideTimer);
    if (this.lastLogged !== state + title) {
      this.lastLogged = state + title;
      diag('bar', { state, title });
    }
    if (!this.host || !this.host.isConnected) ({ host: this.host, root: this.root } = createShadowHost('nobody-topbar', CSS));
    const mark =
      state === 'warn' ? h('div', { class: 'icon', text: '!' }) : h('div', { class: 'icon' }, svgIcon(state === 'ready' ? CHECK : CLOSED_EYE));
    const fill = h('div', { class: 'fill' });
    if (fraction !== undefined) fill.style.width = `${Math.round(Math.max(0.03, Math.min(1, fraction)) * 100)}%`;
    const bar = h(
      'div',
      { class: `nb bar ${state}`, attrs: { role: 'status', 'aria-live': 'polite' } },
      h(
        'div',
        { class: 'row' },
        mark,
        h('div', { class: 'text' }, h('div', { class: 'title', text: title }), sub ? h('div', { class: 'sub', text: sub }) : null),
        action ? h('button', { class: 'act', text: action.label, on: { click: () => { this.hide(); action.run(); } } }) : null,
        h('button', { class: 'x', title: 'Hide', attrs: { 'aria-label': 'Hide' }, on: { click: () => this.hide() } }, svgIcon(CROSS)),
      ),
      state === 'loading' ? h('div', { class: `track${fraction === undefined ? ' indeterminate' : ''}` }, fill) : null,
    );
    // Clicking the bar must not take focus away from the chat box.
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    this.root!.querySelectorAll('.bar').forEach((b) => b.remove());
    this.root!.append(bar);
    if (this.lastChecked !== state) {
      this.lastChecked = state;
      reportVisibility('bar', this.host!, bar);
    }
    if (autoHideMs) this.hideTimer = setTimeout(() => this.hide(), autoHideMs);
  }

  hide(): void {
    clearTimeout(this.hideTimer);
    this.host?.remove();
    this.host = null;
    this.root = null;
  }
}

/** "Rewriting part 2 of 5" → 0.2..0.4 progress. */
export function progressFrom(text: string): number | undefined {
  const m = /(\d+) of (\d+)/i.exec(text);
  if (m) return Math.max(0.05, Number(m[1]) / Math.max(1, Number(m[2])));
  const pct = /(\d+)%/.exec(text);
  return pct ? Number(pct[1]) / 100 : undefined;
}
