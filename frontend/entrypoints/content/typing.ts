import type { Span } from '@nobody/engine';
import { readField, type FieldText } from './fieldtext';
import { captureContext, type InsertionContext } from './insert';
import { BASE_CSS, createShadowHost, h } from './ui';
import { CLOSED_EYE, icon } from '@/lib/brand';
import { describeEditor, diag } from '@/lib/diag';

/**
 * Watches what you type (like a spell checker, fully on-device):
 *  - underlines personal info in rich editors and shows a small badge next to the box;
 *  - stops the message from being sent (Enter on AI chats, Ctrl/⌘+Enter, Send buttons)
 *    while personal info is still in the box, and opens the review panel instead.
 */
export interface TypingGuardDeps {
  enabled(): boolean;
  /** True on sites where plain Enter sends the message. */
  enterSends(): boolean;
  isBusy(): boolean;
  analyze(text: string): Promise<Span[]>;
  /** True if the text should be restyled before sending even without personal info. */
  wantsRestyle(text: string): boolean;
  /** Instant, synchronous check (patterns + dictionary + names already seen). */
  quickCheck(text: string, knownNames: string[]): Span[];
  review(ctx: InsertionContext, text: string, spans: Span[], why: 'badge' | 'send'): Promise<'replaced' | 'kept' | 'cancelled'>;
}

const DEBOUNCE_MS = 300;
const SEND_CHECK_TIMEOUT_MS = 1500;
const HIGHLIGHT = 'nobody-typed';

const BADGE_CSS =
  BASE_CSS +
  `.badge { position: fixed; display: inline-flex; align-items: center; gap: 7px; padding: 5px 12px 5px 9px; border-radius: 16px;
     background: #F6EFE4; color: var(--ink); border: 1px solid #E4D3BA; box-shadow: 0 4px 14px rgba(31,35,51,.12);
     font-size: 12.5px; font-weight: 600; cursor: pointer; animation: in .12s ease-out; white-space: nowrap; }
   .badge:hover, .badge:focus-visible { border-color: var(--bronze); outline: none; }
   .badge .eye-icon { width: 18px; height: 18px; }
   @keyframes in { from { opacity: 0; transform: translateY(3px); } }`;

export class TypingGuard {
  private ctx: InsertionContext | null = null;
  private last: { text: string; spans: Span[] } | null = null;
  private approved: string | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private seq = 0;
  private badge: { host: HTMLElement; el: HTMLElement } | null = null;

  constructor(private deps: TypingGuardDeps) {
    window.addEventListener('input', (e) => this.onInput(e), true);
    window.addEventListener('focusin', (e) => this.onInput(e), true);
    // Editors that insert text themselves (cancelling the native edit) never fire "input" —
    // re-check after key presses too, so the underline and the Enter check stay up to date.
    window.addEventListener('keyup', (e) => {
      if (e.key !== 'Enter') this.onInput(e);
    }, true);
    window.addEventListener('keydown', (e) => this.onKeyDown(e), true);
    window.addEventListener('click', (e) => this.onClick(e), true);
    window.addEventListener('scroll', () => this.placeBadge(), true);
    window.addEventListener('resize', () => this.placeBadge());
    injectStyle();
  }

  /** Nobody just put this (already safe) text in the box — let the next Enter through instantly. */
  noteClean(ctx: InsertionContext, text: string): void {
    this.ctx = ctx;
    this.last = { text, spans: [] };
    this.paint([], null);
  }

  /** Clear all UI (e.g. when the site gets disabled). */
  reset(): void {
    clearTimeout(this.timer);
    this.seq++;
    this.last = null;
    this.paint([], null);
  }

  private onInput(e: Event): void {
    if (!e.isTrusted || !this.deps.enabled()) return;
    const ctx = captureContext(e.composedPath()[0] ?? e.target);
    if (!ctx) return;
    if (this.ctx?.el !== ctx.el) {
      this.reset();
      this.approved = null;
    }
    this.ctx = ctx;
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.analyzeNow(), e.type === 'focusin' ? 50 : DEBOUNCE_MS);
  }

  private async analyzeNow(): Promise<{ text: string; spans: Span[] } | null> {
    const ctx = this.ctx;
    if (!ctx || !ctx.el.isConnected) return null;
    const seq = ++this.seq;
    const field = readField(ctx);
    if (field.text.trim().length < 3) {
      this.last = { text: field.text, spans: [] };
      this.paint([], field);
      return this.last;
    }
    let spans: Span[];
    try {
      spans = await this.deps.analyze(field.text);
    } catch {
      spans = this.deps.quickCheck(field.text, this.knownNames());
    }
    if (seq !== this.seq) return null; // user kept typing; a newer check will follow
    this.last = { text: field.text, spans };
    this.paint(field.text === this.approved ? [] : spans, field);
    return this.last;
  }

  private knownNames(): string[] {
    return (this.last?.spans ?? []).filter((s) => s.source === 'ner' || s.type === 'PERSON').map((s) => s.text);
  }

  // --- Send guard --------------------------------------------------------------------------

  private onKeyDown(e: KeyboardEvent): void {
    if (e.key !== 'Enter' || !e.isTrusted || e.isComposing || e.shiftKey || this.deps.isBusy() || !this.deps.enabled()) return;
    const ctx = captureContext(e.composedPath()[0] ?? e.target);
    if (!ctx) return;
    // Ctrl/⌘+Enter sends almost everywhere; plain Enter only on chat sites (elsewhere it's a newline).
    const modifierSend = e.ctrlKey || e.metaKey;
    const isMultiline = ctx.kind === 'editable' || ctx.el instanceof HTMLTextAreaElement;
    if (!modifierSend && !(this.deps.enterSends() && isMultiline)) return;
    this.ctx = ctx;
    this.guard(e, () => resendKey(ctx.el, e));
  }

  private onClick(e: MouseEvent): void {
    if (!e.isTrusted || !this.deps.enabled() || !this.ctx?.el.isConnected) return;
    const button = (e.composedPath()[0] as Element | undefined)?.closest?.('button, [role="button"], input[type="submit"]') as HTMLElement | null;
    if (!button || !isSendButton(button, this.ctx.el)) return;
    if (this.deps.isBusy()) {
      // A review is open — the box still holds the original text, so nothing may be sent now.
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    this.guard(e, () => button.click());
  }

  /**
   * Decide synchronously whether to stop this send. If our last check is up to date we know the
   * answer; otherwise we stop it, check (≈20–50 ms), and re-send ourselves when the text is clean.
   */
  private guard(e: Event, resend: () => void): void {
    const ctx = this.ctx!;
    const field = readField(ctx);
    if (!field.text.trim() || field.text === this.approved) return;

    const known = this.last && this.last.text === field.text ? this.last.spans : null;
    const restyle = this.deps.wantsRestyle(field.text);
    if (known && known.length === 0 && !restyle) return; // checked and clean — let it go

    e.preventDefault();
    e.stopImmediatePropagation();
    diag('send-held', { trigger: e.type, known: known !== null, items: known?.length ?? null, chars: field.text.length, editor: describeEditor(ctx.el) });

    void (async () => {
      let spans = known;
      if (!spans) {
        clearTimeout(this.timer);
        const result = await Promise.race([this.analyzeNow(), sleep(SEND_CHECK_TIMEOUT_MS).then(() => null)]);
        spans = result?.text === field.text ? result.spans : this.deps.quickCheck(field.text, this.knownNames());
      }
      if (!spans.length && !restyle) {
        resend();
        return;
      }
      this.hideBadge(); // the review panel takes over
      const outcome = await this.deps.review(ctx, field.text, spans, 'send');
      this.afterReview(outcome, field.text);
    })();
  }

  // --- UI ------------------------------------------------------------------------------------

  private paint(spans: Span[], field: FieldText | null): void {
    // Underline findings inside rich editors (CSS Custom Highlight API — the editor's DOM is untouched).
    const css = globalThis.CSS as any;
    const HighlightCtor = (globalThis as any).Highlight;
    if (css?.highlights && HighlightCtor) {
      const ranges = field ? spans.map((s) => field.rangeFor(s.start, s.end)).filter((r): r is Range => r !== null) : [];
      if (ranges.length) css.highlights.set(HIGHLIGHT, new HighlightCtor(...ranges));
      else css.highlights.delete(HIGHLIGHT);
    }

    if (!spans.length || !this.ctx) {
      this.badge?.host.remove();
      this.badge = null;
      return;
    }
    if (!this.badge) {
      const { host, root } = createShadowHost('nobody-badge', BADGE_CSS);
      const el = h('div', {
        class: 'nb badge',
        attrs: { role: 'button', tabindex: '0' },
        on: { mousedown: (ev) => ev.preventDefault(), click: () => void this.openFromBadge() },
      });
      root.append(el);
      this.badge = { host, el };
    }
    const n = spans.length;
    this.badge.el.replaceChildren(icon(CLOSED_EYE, 'eye-icon'), `${n} to hide`);
    this.badge.el.setAttribute('aria-label', `${n} personal ${n === 1 ? 'detail' : 'details'} to hide. Review them`);
    this.badge.el.title = 'Outis found personal details in this box. Click to review them; nothing has left this page.';
    this.placeBadge();
  }

  private placeBadge(): void {
    if (!this.badge || !this.ctx?.el.isConnected) return;
    const r = this.ctx.el.getBoundingClientRect();
    const w = this.badge.el.offsetWidth || 150;
    const above = r.top > 44;
    this.badge.el.style.left = `${Math.max(8, Math.min(r.right - w, innerWidth - w - 8))}px`;
    this.badge.el.style.top = `${above ? r.top - 32 : Math.min(r.bottom + 6, innerHeight - 34)}px`;
  }

  private async openFromBadge(): Promise<void> {
    if (!this.ctx || this.deps.isBusy()) return;
    const field = readField(this.ctx);
    const spans = this.last?.text === field.text ? this.last.spans : (await this.analyzeNow())?.spans ?? [];
    if (!spans.length) return;
    this.hideBadge();
    this.afterReview(await this.deps.review(this.ctx, field.text, spans, 'badge'), field.text);
  }

  private hideBadge(): void {
    this.badge?.host.remove();
    this.badge = null;
  }

  private afterReview(outcome: 'replaced' | 'kept' | 'cancelled', text: string): void {
    if (outcome === 'kept') {
      this.approved = text; // this exact text may now be sent
      this.paint([], null);
    } else if (outcome === 'cancelled' && this.last) {
      this.paint(this.last.spans, this.ctx ? readField(this.ctx) : null);
    } else if (outcome === 'replaced') {
      this.paint([], null);
      clearTimeout(this.timer);
      this.timer = setTimeout(() => void this.analyzeNow(), DEBOUNCE_MS);
    }
  }
}

function isSendButton(button: HTMLElement, field: HTMLElement): boolean {
  const label = [button.getAttribute('aria-label'), button.getAttribute('data-testid'), button.getAttribute('data-tooltip'), button.title, button.textContent]
    .filter(Boolean)
    .join(' ')
    .trim();
  if (/\bsend\b|send-button|submit/i.test(label)) return true;
  // A submit button of the form that contains the box (GitHub "Comment", Jira, support forms…).
  const form = (button as HTMLButtonElement).form ?? button.closest('form');
  return (button.getAttribute('type') === 'submit' || button instanceof HTMLInputElement) && Boolean(form?.contains(field));
}

/** Re-send the original Enter keystroke after a clean check (our listener ignores untrusted events). */
export function resendKey(target: HTMLElement, original: Pick<KeyboardEvent, 'ctrlKey' | 'metaKey' | 'altKey'>): void {
  target.focus();
  const ev = new KeyboardEvent('keydown', {
    key: 'Enter',
    code: 'Enter',
    bubbles: true,
    cancelable: true,
    ctrlKey: original.ctrlKey,
    metaKey: original.metaKey,
    altKey: original.altKey,
  });
  // Some apps still read the legacy keyCode/which fields.
  Object.defineProperty(ev, 'keyCode', { get: () => 13 });
  Object.defineProperty(ev, 'which', { get: () => 13 });
  target.dispatchEvent(ev);
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function injectStyle(): void {
  if (document.getElementById('nobody-typed-style')) return;
  const style = document.createElement('style');
  style.id = 'nobody-typed-style';
  // Detected text: seal background, dotted bronze underline (Outis style sheet).
  style.textContent = `::highlight(${HIGHLIGHT}) { background-color: rgba(242, 232, 217, 0.9); text-decoration: underline dotted #8A5A26; text-decoration-thickness: 1.5px; }`;
  (document.head ?? document.documentElement).appendChild(style);
}
