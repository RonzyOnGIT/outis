import { BASE_CSS, createShadowHost, h } from './ui';
import { diag } from '@/lib/diag';

/**
 * A slim status bar pinned to the top of the page:
 *   loading (purple, progress bar) → ready (green) / warn (amber).
 * Lives in a closed shadow root, so the page can't read it.
 */
export type BarState = 'loading' | 'ready' | 'warn';

const CSS =
  BASE_CSS +
  `
.bar { position: fixed; top: 12px; left: 50%; transform: translateX(-50%); width: min(560px, calc(100vw - 32px));
  border-radius: 12px; overflow: hidden; box-shadow: 0 10px 30px rgba(17,24,39,.22); animation: drop .18s ease-out;
  font: 13.5px/1.4 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: #fff; }
@keyframes drop { from { opacity: 0; transform: translate(-50%, -10px); } to { opacity: 1; transform: translate(-50%, 0); } }
.row { display: flex; align-items: center; gap: 10px; padding: 10px 14px; }
.loading { background: #5b21b6; }
.ready { background: #15803d; }
.warn { background: #b45309; }
.icon { width: 18px; height: 18px; flex: none; display: grid; place-items: center; font-weight: 700; }
.spin { width: 14px; height: 14px; border-radius: 50%; border: 2px solid rgba(255,255,255,.35); border-top-color: #fff; animation: spin .8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.text { flex: 1; min-width: 0; }
.title { font-weight: 650; }
.sub { opacity: .85; font-size: 12px; }
.track { height: 4px; background: rgba(255,255,255,.22); }
.fill { height: 100%; background: #fff; transition: width .3s ease; }
.indeterminate .fill { width: 35% !important; animation: slide 1.1s ease-in-out infinite; }
@keyframes slide { from { margin-left: -35%; } to { margin-left: 100%; } }
.x { background: transparent; border: 0; color: #fff; opacity: .8; font-size: 18px; line-height: 1; cursor: pointer; padding: 2px 4px; }
.x:hover { opacity: 1; }
`;

export class TopBar {
  private host: HTMLElement | null = null;
  private root: ShadowRoot | null = null;
  private hideTimer: ReturnType<typeof setTimeout> | undefined;

  private lastLogged = '';

  /**
   * @param fraction 0..1 for a real progress bar, undefined for an animated "working" bar.
   * @param autoHideMs hide automatically after this long (used for "ready").
   */
  show(state: BarState, title: string, sub?: string, fraction?: number, autoHideMs?: number): void {
    clearTimeout(this.hideTimer);
    if (this.lastLogged !== state + title) {
      this.lastLogged = state + title;
      diag('bar', { state, title });
    }
    if (!this.host || !this.host.isConnected) ({ host: this.host, root: this.root } = createShadowHost('nobody-topbar', CSS));
    const icon =
      state === 'loading' ? h('div', { class: 'icon' }, h('div', { class: 'spin' })) : h('div', { class: 'icon', text: state === 'ready' ? '✓' : '!' });
    const fill = h('div', { class: 'fill' });
    if (fraction !== undefined) fill.style.width = `${Math.round(Math.max(0.03, Math.min(1, fraction)) * 100)}%`;
    const bar = h(
      'div',
      { class: `nb bar ${state}`, attrs: { role: 'status', 'aria-live': 'polite' } },
      h(
        'div',
        { class: 'row' },
        icon,
        h('div', { class: 'text' }, h('div', { class: 'title', text: title }), sub ? h('div', { class: 'sub', text: sub }) : null),
        h('button', { class: 'x', text: '×', title: 'Hide', on: { click: () => this.hide() } }),
      ),
      state === 'loading' ? h('div', { class: `track${fraction === undefined ? ' indeterminate' : ''}` }, fill) : null,
    );
    // Clicking the bar must not take focus away from the chat box.
    bar.addEventListener('mousedown', (e) => e.preventDefault());
    this.root!.querySelectorAll('.bar').forEach((b) => b.remove());
    this.root!.append(bar);
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
  const m = /part (\d+) of (\d+)/i.exec(text);
  if (m) return (Number(m[1]) - 0.5) / Number(m[2]);
  const pct = /(\d+)%/.exec(text);
  return pct ? Number(pct[1]) / 100 : undefined;
}
