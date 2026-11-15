import type { EntityType } from '@nobody/engine';
import { describeEditor, diag } from '@/lib/diag';
import { FONT_FILES, THEME_VARS, WEAVE_CSS } from '@/lib/brand';

export { h } from '@/lib/dom';

export function typeGroup(t: EntityType): 'who' | 'where' | 'contact' | 'secret' {
  switch (t) {
    case 'PERSON':
    case 'ORG':
    case 'USER':
      return 'who';
    case 'LOCATION':
    case 'ADDRESS':
    case 'IP':
      return 'where';
    case 'EMAIL':
    case 'PHONE':
    case 'URL':
      return 'contact';
    default:
      return 'secret';
  }
}

/** A closed shadow root: page scripts cannot read what we render (e.g. the original text). */
export function createShadowHost(id: string, css: string): { host: HTMLElement; root: ShadowRoot } {
  ensureFonts();
  document.getElementById(id)?.remove();
  const host = document.createElement('div');
  host.id = id;
  const root = host.attachShadow({ mode: 'closed' });
  // Constructed stylesheet: not subject to the page's Content-Security-Policy (a <style> tag can be
  // blocked by sites without 'unsafe-inline'). Falls back to <style> where unsupported.
  try {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    root.adoptedStyleSheets = [sheet];
  } catch {
    const style = document.createElement('style');
    style.textContent = css;
    root.append(style);
  }
  showShadowHost(host);
  return { host, root };
}

/**
 * Page styles can target the shadow HOST (including [popover]) even though its contents are private.
 * An open popover is not necessarily visible. Give it a real viewport-sized box, explicitly undo
 * visibility/content-visibility rules, and keep the transparent wrapper out of pointer hit testing.
 * Individual UI surfaces opt back into pointer events inside the shadow root.
 */
export function showShadowHost(host: HTMLElement): void {
  const styles: Record<string, string> = {
    position: 'fixed', inset: '0', width: '100vw', height: '100vh',
    'min-width': '0', 'min-height': '0', 'max-width': 'none', 'max-height': 'none',
    margin: '0', padding: '0', border: '0', display: 'block', visibility: 'visible', opacity: '1',
    'content-visibility': 'visible', contain: 'none', overflow: 'visible',
    'pointer-events': 'none', 'z-index': '2147483647', background: 'transparent',
    transform: 'none', filter: 'none', 'clip-path': 'none', clip: 'auto',
    animation: 'none', transition: 'none',
  };
  for (const [name, value] of Object.entries(styles)) {
    if (host.style.getPropertyValue(name) !== value || host.style.getPropertyPriority(name) !== 'important') host.style.setProperty(name, value, 'important');
  }
  host.hidden = false;
  host.inert = false;
  if (!host.isConnected) document.documentElement.append(host);
  // Put it in the browser's top layer (Popover API): drawn above everything on the page, whatever
  // the site's own z-index, overflow or modal dialogs do. Falls back to a max z-index.
  try {
    if (host.getAttribute('popover') !== 'manual') host.setAttribute('popover', 'manual');
    if (!host.matches(':popover-open')) host.showPopover();
  } catch {
    host.removeAttribute('popover');
  }
}

/**
 * Outis typefaces for the in-page UI. Fonts declared inside a shadow root are ignored, so they are
 * added to the document's font set once, from bytes the background reads from the extension
 * package (no web-accessible files, no network, and no page CSP involved). Latin subsets only;
 * other scripts use the system fallback fonts.
 */
let fontsRequested = false;
function ensureFonts(): void {
  if (fontsRequested || typeof FontFace === 'undefined') return;
  fontsRequested = true;
  void (async () => {
    try {
      const files = FONT_FILES.filter((f) => f.latin);
      const data = (await browser.runtime.sendMessage({ type: 'fonts', files: files.map((f) => f.file) })) as Record<string, string> | null;
      for (const f of files) {
        const b64 = data?.[f.file];
        if (!b64) continue;
        const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        const face = new FontFace(f.family, bytes, { weight: String(f.weight), unicodeRange: f.range, display: 'swap' });
        document.fonts.add(await face.load());
      }
    } catch {
      // The fallback stacks (Georgia, system UI, monospace) keep everything readable.
    }
  })();
}

export const BASE_CSS = `
:host { all: initial; }
:host > * { pointer-events: auto; }
* { box-sizing: border-box; }
.nb {
  ${THEME_VARS}
  /* Older names used by some surfaces. */
  --bg: var(--paper); --fg: var(--ink); --muted: var(--quiet); --soft: var(--seal); --accent: var(--ink); --accent-fg: var(--paper);
  --ph: var(--seal); --ph-fg: var(--ink);
  font: 13.5px/1.5 var(--sans); color: var(--ink); -webkit-font-smoothing: antialiased; text-align: left; letter-spacing: normal;
}
button { font: inherit; cursor: pointer; }
.serif { font-family: var(--serif); font-weight: 500; }
.btn { border: 1px solid var(--line); background: var(--paper); color: var(--ink); padding: 9px 14px; border-radius: 9px; font-weight: 600; line-height: 1.25; }
.btn:hover:not(:disabled) { border-color: #CDBFA8; }
.btn.primary { background: var(--ink); border-color: var(--ink); color: var(--paper); }
.btn.primary:hover:not(:disabled) { background: #2D3247; border-color: #2D3247; }
.btn.text { border: 0; background: none; padding: 9px 4px; color: var(--bronze); text-decoration: underline; text-underline-offset: 3px; }
.btn.text.exposed { color: var(--oxblood); }
.btn:disabled { opacity: .55; cursor: default; }
button:focus-visible { outline: 2px solid var(--bronze); outline-offset: 2px; }
.chip { display: inline-flex; align-items: center; gap: 5px; font: 500 12px/1.25 var(--mono); color: var(--ink); background: var(--seal);
  border: 1px solid #E6D5BC; border-radius: 6px; padding: 1px 6px; white-space: nowrap; vertical-align: baseline; }
.chip::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: var(--bronze); box-shadow: 0 0 0 2px #E2C9A5; flex: none; }
.eye-icon { width: 26px; height: 26px; color: var(--bronze); flex: none; }
${WEAVE_CSS}
`;

/**
 * Diagnostics: is this UI element really on screen? Records whether it is still attached,
 * its size/position, its styles, and which element is on top at its centre (covered?).
 */
export function reportVisibility(label: string, host: HTMLElement, el: HTMLElement): void {
  const measure = (when: string) => {
    // The bar replaces its contents as progress changes. Do not diagnose a detached old element.
    if (!el.isConnected) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    const hostStyle = getComputedStyle(host);
    const hostRect = host.getBoundingClientRect();
    const top = r.width && r.height ? document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20)) : null;
    let open: boolean | null = null;
    try {
      open = host.matches(':popover-open');
    } catch {
      open = null;
    }
    diag(`${label}-visible`, {
      when,
      attached: host.isConnected,
      popoverOpen: open,
      x: Math.round(r.left),
      y: Math.round(r.top),
      w: Math.round(r.width),
      h: Math.round(r.height),
      display: cs.display,
      visibility: cs.visibility,
      opacity: cs.opacity,
      hostVisibility: hostStyle.visibility,
      hostOpacity: hostStyle.opacity,
      hostContentVisibility: hostStyle.contentVisibility,
      hostW: Math.round(hostRect.width),
      hostH: Math.round(hostRect.height),
      onTop: top === host ? 'nobody' : describeEditor(top),
      viewport: `${innerWidth}x${innerHeight}`,
    });
  };
  requestAnimationFrame(() => requestAnimationFrame(() => measure('shown')));
  setTimeout(() => measure('after 1.5s'), 1500);
}
