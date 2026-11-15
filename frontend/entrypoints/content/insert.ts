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

/**
 * Replace everything in the box with `text`.
 *
 * Selection and insertion happen synchronously in one task: rich editors (and chat apps that
 * move the cursor to the end on focus) get no chance to move the selection in between, so the
 * text can't end up appended after the original. The editor then reconciles the DOM change
 * itself. We verify the result and retry, so the original can never be sent along.
 */
export async function replaceAll(original: InsertionContext, text: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const ctx = liveContext(original);
    if (!isFocused(ctx.el)) {
      ctx.el.focus();
      await sleep(30); // let the app's own focus handling finish first
    }
    if (ctx.kind === 'input') {
      ctx.el.setSelectionRange(0, ctx.el.value.length);
      if (!document.execCommand('insertText', false, text)) setInputValue(ctx.el, text);
    } else {
      const all = document.createRange();
      all.selectNodeContents(ctx.el);
      const sel = window.getSelection();
      sel?.removeAllRanges();
      sel?.addRange(all);
      document.execCommand('insertText', false, text); // same task as the selection above
    }
    await sleep(40);
    if (squash(readText(liveContext(original))) === squash(text)) return true;
  }
  console.warn('[Nobody] could not replace the text box content');
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
