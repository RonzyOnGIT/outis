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

/**
 * Rich editors (ProseMirror on ChatGPT/Claude, Gmail…) keep their own copy of the selection and
 * only pick up DOM selection changes on the async "selectionchange" event. Wait for it before
 * pasting, or the editor pastes at its old cursor position (e.g. after the original text).
 */
function selectionSettled(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      document.removeEventListener('selectionchange', finish);
      setTimeout(resolve, 0); // let the editor's own selectionchange handler run first
    };
    document.addEventListener('selectionchange', finish);
    setTimeout(finish, 60);
  });
}

function selectRange(range: Range | null): Selection | null {
  const sel = window.getSelection();
  if (sel && range) {
    sel.removeAllRanges();
    sel.addRange(range);
  }
  return sel;
}

const squash = (s: string) => s.replace(/\s+/g, ' ').trim();

export async function insertText(ctx: InsertionContext, text: string): Promise<void> {
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

  const replacingAll = ctx.range !== null && rangeCoversElement(ctx.range, ctx.el);
  const sel = selectRange(ctx.range);
  await selectionSettled();

  // Rich editors handle paste events best (they keep their own document model in sync).
  const data = new DataTransfer();
  data.setData('text/plain', text);
  const event = new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true });
  const target = (sel?.anchorNode instanceof Element ? sel.anchorNode : sel?.anchorNode?.parentElement) ?? ctx.el;
  (ctx.el.contains(target) ? target : ctx.el).dispatchEvent(event);
  if (!event.defaultPrevented) document.execCommand('insertText', false, text);

  // Safety net for whole-box replacement: if the editor still kept the old text, select
  // everything again and overwrite it, so the original can never be sent alongside.
  if (replacingAll) {
    await new Promise((r) => setTimeout(r, 30));
    if (squash(ctx.el.innerText ?? '') !== squash(text)) {
      ctx.el.focus();
      const all = document.createRange();
      all.selectNodeContents(ctx.el);
      selectRange(all);
      await selectionSettled();
      document.execCommand('insertText', false, text);
    }
  }
}

function rangeCoversElement(range: Range, el: HTMLElement): boolean {
  const all = document.createRange();
  all.selectNodeContents(el);
  return range.compareBoundaryPoints(Range.START_TO_START, all) <= 0 && range.compareBoundaryPoints(Range.END_TO_END, all) >= 0;
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
