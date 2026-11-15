import { describeEditor, diag } from '@/lib/diag';

/**
 * Putting text into whatever editor the page uses: plain <textarea>/<input>,
 * or rich contenteditable editors (ProseMirror on ChatGPT/Claude, Gmail compose, …).
 */

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', '']);

export type InsertionContext =
  | { kind: 'input'; el: HTMLInputElement | HTMLTextAreaElement; start: number; end: number }
  | { kind: 'editable'; el: HTMLElement; range: Range | null };

function deepActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  while (a?.shadowRoot?.activeElement) a = a.shadowRoot.activeElement;
  return a;
}

/** Find the editable element an event (or the current focus) belongs to. */
export function captureContext(target: EventTarget | null = deepActiveElement()): InsertionContext | null {
  const el = target instanceof Node ? (target instanceof Element ? target : target.parentElement) : null;
  if (!el) return null;

  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has(el.type))) {
    if (el.readOnly || el.disabled) return null;
    return { kind: 'input', el, start: el.selectionStart ?? el.value.length, end: el.selectionEnd ?? el.value.length };
  }
  if (el instanceof HTMLElement && el.isContentEditable) {
    let host: HTMLElement = el;
    while (host.parentElement?.isContentEditable) host = host.parentElement;
    const sel = window.getSelection();
    const range = sel && sel.rangeCount > 0 ? sel.getRangeAt(0).cloneRange() : null;
    return { kind: 'editable', el: host, range };
  }
  return null;
}

/**
 * Chat apps sometimes re-render their input box. If ours is gone from the page,
 * find the current one (same id, or whatever editable box has focus now).
 */
export function liveContext(ctx: InsertionContext): InsertionContext {
  if (ctx.el.isConnected) return ctx;
  const byId = ctx.el.id ? document.getElementById(ctx.el.id) : null;
  const fresh = (byId && captureContext(byId)) || captureContext();
  return fresh ?? ctx;
}

function isFocused(el: HTMLElement): boolean {
  const a = deepActiveElement();
  return a === el || (a !== null && el.contains(a));
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

function readText(ctx: InsertionContext): string {
  return ctx.kind === 'input' ? ctx.el.value : (ctx.el.innerText ?? '');
}

/** Replace the input's value in a way React/Vue-controlled inputs notice. */
function setInputValue(el: HTMLInputElement | HTMLTextAreaElement, value: string): void {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
  setter ? setter.call(el, value) : (el.value = value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Wait until the browser has fired "selectionchange" and the editor has handled it. */
function selectionSettled(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener('selectionchange', finish);
      setTimeout(resolve, 0);
    };
    document.addEventListener('selectionchange', finish);
    setTimeout(finish, 80);
  });
}

function selectAllDom(el: HTMLElement): void {
  const all = document.createRange();
  all.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(all);
}

/** Ask the editor itself to select everything (⌘A / Ctrl+A) — updates its internal selection too. */
function editorSelectAll(el: HTMLElement): void {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform);
  const init: KeyboardEventInit = { key: 'a', code: 'KeyA', bubbles: true, cancelable: true, metaKey: mac, ctrlKey: !mac };
  const down = new KeyboardEvent('keydown', init);
  Object.defineProperty(down, 'keyCode', { get: () => 65 });
  Object.defineProperty(down, 'which', { get: () => 65 });
  el.dispatchEvent(down);
  // Plain contenteditable has no JS handler for it — select through the DOM as well.
  if (!down.defaultPrevented) selectAllDom(el);
}

function pasteInto(el: HTMLElement, text: string): void {
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  if (!event.defaultPrevented) document.execCommand('insertText', false, text);
}

/**
 * Replace everything in the box with `text`, and make sure nothing of the original is left.
 *
 * Editors differ: some read the DOM selection, some insert at their own internal cursor, and chat
 * apps may move that cursor to the end. So we try several ways, each of which replaces *all*
 * content (a failed attempt can't leave anything behind), and verify after each one.
 */
export async function replaceAll(original: InsertionContext, text: string): Promise<boolean> {
  const strategies: Array<[string, (el: HTMLElement) => Promise<void>]> = [
    ['dom-select+insert', async (el) => { selectAllDom(el); await selectionSettled(); selectAllDom(el); document.execCommand('insertText', false, text); }],
    ['editor-selectall+insert', async (el) => { editorSelectAll(el); await selectionSettled(); document.execCommand('insertText', false, text); }],
    ['editor-selectall+paste', async (el) => { editorSelectAll(el); await selectionSettled(); pasteInto(el, text); }],
    ['dom-select+paste', async (el) => { selectAllDom(el); await selectionSettled(); pasteInto(el, text); }],
  ];

  for (let attempt = 0; attempt < strategies.length; attempt++) {
    const ctx = liveContext(original);
    if (!isFocused(ctx.el)) {
      ctx.el.focus();
      await sleep(30); // let the app's own focus handling finish first
    }
    const [name, run] = strategies[attempt]!;
    if (ctx.kind === 'input') {
      ctx.el.setSelectionRange(0, ctx.el.value.length);
      if (!document.execCommand('insertText', false, text)) setInputValue(ctx.el, text);
    } else {
      await run(ctx.el);
    }
    await sleep(60);
    const now = readText(liveContext(original));
    const ok = squash(now) === squash(text);
    if (ok) {
      // Some apps re-render the box from their own saved draft a moment later. Check again in the
      // background (the user may press Enter right away) and put the safe text back if needed.
      setTimeout(() => {
        const later = readText(liveContext(original));
        if (squash(later) === squash(text) || !squash(later)) return;
        diag('replace-reverted', { method: name, boxChars: later.length, expectedChars: text.length });
        if (squash(later).includes(squash(text).slice(0, 30)) || later.length > text.length) void replaceAll(original, text);
      }, 400);
    }
    diag(ok ? 'replace-ok' : 'replace-failed', {
      method: name,
      attempt: attempt + 1,
      boxChars: now.length,
      expectedChars: text.length,
      editor: describeEditor(ctx.el),
      sameEl: ctx.el === original.el,
      focused: isFocused(ctx.el),
    });
    if (ok) return true;
  }
  console.warn('[Nobody] could not replace the text box content — copy diagnostics from the Nobody popup');
  return false;
}

/**
 * Empty the box (used by automatic mode before the safe text is ready). Each method removes
 * everything; we verify the box is really empty after each one.
 */
export async function clearBox(original: InsertionContext): Promise<boolean> {
  const methods: Array<[string, (el: HTMLElement) => Promise<void>]> = [
    ['dom-select+delete', async (el) => { selectAllDom(el); await selectionSettled(); selectAllDom(el); document.execCommand('delete'); }],
    ['editor-selectall+delete', async (el) => { editorSelectAll(el); await selectionSettled(); document.execCommand('delete'); }],
    ['dom-select+cut-text', async (el) => { selectAllDom(el); await selectionSettled(); document.execCommand('insertText', false, ''); }],
  ];
  for (let attempt = 0; attempt < methods.length; attempt++) {
    const ctx = liveContext(original);
    if (!isFocused(ctx.el)) {
      ctx.el.focus();
      await sleep(30);
    }
    const [name, run] = methods[attempt]!;
    if (ctx.kind === 'input') {
      ctx.el.setSelectionRange(0, ctx.el.value.length);
      if (!document.execCommand('delete')) setInputValue(ctx.el, '');
    } else {
      await run(ctx.el);
    }
    await sleep(50);
    const left = readText(liveContext(original)).trim();
    diag(left ? 'clear-failed' : 'clear-ok', { method: name, attempt: attempt + 1, leftChars: left.length, editor: describeEditor(ctx.el) });
    if (!left) return true;
  }
  return false;
}

/** Insert `text` at the caret (used for pastes). */
export async function insertText(original: InsertionContext, text: string): Promise<void> {
  const ctx = liveContext(original);
  const hadFocus = isFocused(ctx.el);
  if (!hadFocus) ctx.el.focus();

  if (ctx.kind === 'input') {
    ctx.el.setSelectionRange(ctx.start, ctx.end);
    // execCommand keeps the native undo stack and fires the input events frameworks listen for.
    if (document.execCommand('insertText', false, text)) return;
    setInputValue(ctx.el, ctx.el.value.slice(0, ctx.start) + text + ctx.el.value.slice(ctx.end));
    return;
  }

  // If focus never left the editor, its caret is exactly where the user pasted — leave it alone.
  // Otherwise put the caret back and give the editor a moment to notice before pasting.
  if (!hadFocus && ctx.range) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(ctx.range);
    await sleep(30);
  }
  // Rich editors handle paste events best (they keep their own document model in sync).
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  ctx.el.dispatchEvent(event);
  if (!event.defaultPrevented) document.execCommand('insertText', false, text);
}

/** Make sure the box has focus again (after cancelling the panel). Keeps the editor's own caret. */
export function refocus(original: InsertionContext): void {
  const ctx = liveContext(original);
  if (!isFocused(ctx.el)) ctx.el.focus();
}
