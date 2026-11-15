import type { EntityType } from '@nobody/engine';
import { describeEditor, diag } from '@/lib/diag';

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

export const BASE_CSS = `
:host { all: initial; }
:host > * { pointer-events: auto; }
* { box-sizing: border-box; }
.nb {
  --bg: #ffffff; --fg: #111827; --muted: #6b7280; --line: #e5e7eb; --soft: #f5f3ff; --accent: #6d28d9; --accent-fg: #fff;
  --who: #ede9fe; --who-fg: #5b21b6; --where: #ccfbf1; --where-fg: #115e59; --contact: #fef3c7; --contact-fg: #92400e;
  --secret: #ffe4e6; --secret-fg: #9f1239; --ph: #ede9fe; --ph-fg: #5b21b6; --shadow: 0 20px 50px rgba(17,24,39,.22), 0 2px 8px rgba(17,24,39,.08);
  font: 13px/1.45 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; color: var(--fg);
}
@media (prefers-color-scheme: dark) {
  .nb {
    --bg: #18181b; --fg: #f4f4f5; --muted: #a1a1aa; --line: #2e2e33; --soft: #221b33; --accent: #8b5cf6; --accent-fg: #fff;
    --who: #2e1f4d; --who-fg: #c4b5fd; --where: #12332f; --where-fg: #5eead4; --contact: #3a2a0c; --contact-fg: #fcd34d;
    --secret: #3d1520; --secret-fg: #fda4af; --ph: #2e1f4d; --ph-fg: #c4b5fd; --shadow: 0 20px 50px rgba(0,0,0,.55);
  }
}
button { font: inherit; cursor: pointer; }
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
