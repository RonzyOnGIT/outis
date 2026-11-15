/**
 * Where Nobody's document window goes: directly above the page's message box (the chat or search
 * input), so it reads as part of what is about to be sent. Pages with the box near the top get the
 * window below it; pages without a usable box get it centred.
 */
const EDITABLE = 'textarea, input[type="text"], input[type="search"], input:not([type]), [contenteditable]:not([contenteditable="false"]), [role="textbox"]';
const MARGIN = 12;
const GAP = 10;

function deepActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

function usable(el: HTMLElement): boolean {
  if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && (el.disabled || el.readOnly)) return false;
  const r = el.getBoundingClientRect();
  if (r.width < 120 || r.height < 14 || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) return false;
  const style = getComputedStyle(el);
  return style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0;
}

/** Depth of the deepest element that contains both. */
function sharedDepth(a: Node, b: Node): number {
  const chain = new Set<Node>();
  for (let n: Node | null = a; n; n = n.parentNode) chain.add(n);
  for (let n: Node | null = b; n; n = n.parentNode) {
    if (!chain.has(n)) continue;
    let depth = 0;
    for (let m: Node | null = n; m; m = m.parentNode) depth++;
    return depth;
  }
  return 0;
}

/**
 * The message box an upload belongs to. `near` is where the files came from: a file input (usually
 * inside the composer's form), a drop zone or the box a file was pasted into.
 */
export function findComposer(near?: Element | null): HTMLElement | null {
  const found = new Set<HTMLElement>();
  for (const el of document.querySelectorAll<HTMLElement>(EDITABLE)) {
    let box = el;
    while (box.parentElement?.isContentEditable) box = box.parentElement;
    if (usable(box)) found.add(box);
  }
  const active = deepActiveElement();
  const score = (el: HTMLElement): number[] => [
    near ? (el.contains(near) ? 2 : near.contains(el) ? 1 : 0) : 0,
    near ? sharedDepth(el, near) : 0,
    active && el.contains(active) ? 1 : 0,
    // Chat composers sit at the bottom of the window.
    el.getBoundingClientRect().bottom,
  ];
  let best: HTMLElement | null = null;
  let bestScore: number[] = [];
  for (const el of found) {
    const s = score(el);
    const i = s.findIndex((v, k) => v !== bestScore[k]);
    if (!best || (i >= 0 && s[i]! > bestScore[i]!)) {
      best = el;
      bestScore = s;
    }
  }
  return best;
}

/** The visible box around an editor: its rounded container with the attach and send buttons. */
export function composerBox(el: HTMLElement): DOMRect {
  let box = el.getBoundingClientRect();
  let node = el.parentElement;
  for (let i = 0; i < 6 && node && node !== document.body && node !== document.documentElement; i++, node = node.parentElement) {
    const r = node.getBoundingClientRect();
    if (r.height > Math.max(box.height + 140, 260) || r.width > box.width + 240 || r.height === 0) break;
    box = r;
  }
  return box;
}

export interface Placement {
  left: number;
  width: number;
  /** Distance from the top of the viewport, or from the bottom when the window sits above the box. */
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/** Fit a window of up to `wanted` pixels tall against the message box (see findComposer). */
export function placeWindow(composer: HTMLElement | null, wanted: number): Placement {
  const vw = document.documentElement.clientWidth || innerWidth;
  const vh = innerHeight;
  const box = composer ? composerBox(composer) : null;
  const width = Math.min(vw - 2 * MARGIN, Math.max(560, Math.min(980, box?.width ?? 760)));
  const centre = box ? box.left + box.width / 2 : vw / 2;
  const left = Math.max(MARGIN, Math.min(centre - width / 2, vw - width - MARGIN));
  const enough = Math.min(wanted, 300);
  if (box) {
    const above = box.top - GAP - MARGIN;
    const below = vh - box.bottom - GAP - MARGIN;
    if (above >= enough) return { left, width, bottom: vh - box.top + GAP, maxHeight: Math.min(wanted, above) };
    if (below >= enough) return { left, width, top: box.bottom + GAP, maxHeight: Math.min(wanted, below) };
  }
  const maxHeight = Math.min(wanted, vh - 2 * MARGIN);
  return { left, width, top: Math.max(MARGIN, (vh - maxHeight) / 2), maxHeight };
}
