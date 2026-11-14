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
  let el = target instanceof Node ? (target instanceof Element ? target : target.parentElement) : null;
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

export function readAll(ctx: InsertionContext): string {
  return ctx.kind === 'input' ? ctx.el.value : (ctx.el.innerText ?? '');
}

/** Make the context cover the whole field (for "anonymize this box"). */
export function selectAll(ctx: InsertionContext): InsertionContext {
  if (ctx.kind === 'input') return { ...ctx, start: 0, end: ctx.el.value.length };
  const range = document.createRange();
  range.selectNodeContents(ctx.el);
  return { ...ctx, range };
}

export function insertText(ctx: InsertionContext, text: string): void {
  ctx.el.focus();
  if (ctx.kind === 'input') {
    const el = ctx.el;
    el.setSelectionRange(ctx.start, ctx.end);
    // execCommand keeps the native undo stack and fires the input events frameworks listen for.
    if (document.execCommand('insertText', false, text)) return;
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
    const next = el.value.slice(0, ctx.start) + text + el.value.slice(ctx.end);
    setter ? setter.call(el, next) : (el.value = next);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return;
  }

  const sel = window.getSelection();
  if (sel && ctx.range) {
    sel.removeAllRanges();
    sel.addRange(ctx.range);
  }
  // Rich editors handle paste events best (they keep their own document model in sync).
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  const target = (sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement) ?? ctx.el;
  (ctx.el.contains(target) ? target : ctx.el).dispatchEvent(event);
  if (!event.defaultPrevented) document.execCommand('insertText', false, text);
}

/** Put focus back where the user was (after cancelling the panel). */
export function refocus(ctx: InsertionContext): void {
  ctx.el.focus();
  if (ctx.kind === 'input') ctx.el.setSelectionRange(ctx.start, ctx.end);
  else if (ctx.range) {
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(ctx.range);
  }
}
