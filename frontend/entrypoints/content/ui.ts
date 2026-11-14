import type { EntityType } from '@nobody/engine';

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
  host.style.cssText = 'all: initial; position: fixed; z-index: 2147483647; inset: auto;';
  const root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = css;
  root.append(style);
  document.documentElement.append(host);
  return { host, root };
}

export const BASE_CSS = `
:host { all: initial; }
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
