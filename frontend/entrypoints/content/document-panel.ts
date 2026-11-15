import { ENTITY_TYPES } from '@nobody/engine';
import { BASE_CSS, createShadowHost, h, reportVisibility, showShadowHost } from './ui';
import { findComposer, placeWindow } from './anchor';
import type { CleanDocument, DocumentPart } from '@/lib/documents/sanitize';

export interface DocumentPreview extends CleanDocument { originalName: string; name: string; }
export type DocumentChoice = 'attach' | 'download' | 'cancel';

const CSS = BASE_CSS + `
.win { position: fixed; display: flex; flex-direction: column; overflow: hidden; background: var(--bg); color: var(--fg);
  border: 1px solid var(--line); border-radius: 14px; box-shadow: var(--shadow); animation: rise .16s ease-out; }
@keyframes rise { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: none; } }
.win:focus { outline: none; }
.head { display: flex; align-items: center; gap: 10px; padding: 12px 10px 10px 14px; flex: none; }
.logo { width: 26px; height: 26px; border-radius: 8px; background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; font-weight: 700; font-size: 13px; flex: none; }
.titles { flex: 1; min-width: 0; }
h2 { margin: 0; font-size: 14px; font-weight: 650; }
.body { display: contents; }
.sub { color: var(--muted); font-size: 12px; margin-top: 1px; }
.icon { border: 0; background: transparent; color: var(--muted); border-radius: 8px; width: 30px; height: 30px; padding: 0; font-size: 18px; line-height: 1; flex: none; }
.icon:hover { background: var(--soft); color: var(--fg); }
.work { padding: 2px 14px 4px; flex: none; }
.status { margin: 0 0 8px; color: var(--muted); }
progress { display: block; width: 100%; height: 6px; accent-color: var(--accent); }
.tabs { display: flex; gap: 4px; padding: 0 12px 6px; overflow-x: auto; flex: none; scrollbar-width: thin; }
.tab { border: 1px solid transparent; background: transparent; color: var(--muted); padding: 5px 10px; font-size: 12px; white-space: nowrap; max-width: 300px; overflow: hidden; text-overflow: ellipsis; }
.tab[aria-selected="true"] { background: var(--soft); border-color: var(--line); color: var(--fg); font-weight: 600; }
.compare { flex: 1 1 auto; min-height: 90px; overflow: auto; display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); grid-auto-rows: max-content; align-content: start;
  margin: 0 12px; border: 1px solid var(--line); border-radius: 10px; overscroll-behavior: contain; scrollbar-width: thin; }
.compare:focus-visible { outline: 3px solid var(--accent); outline-offset: 1px; }
.col { position: sticky; top: 0; z-index: 1; background: var(--bg); padding: 7px 12px; border-bottom: 1px solid var(--line);
  font-size: 11.5px; color: var(--muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.col b { color: var(--fg); font-weight: 650; }
.side { padding: 8px 12px; min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: 12.5px; line-height: 1.6; border-bottom: 1px solid var(--line); }
.orig { border-right: 1px solid var(--line); }
.data { font: 11.5px/1.5 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }
.divider { grid-column: 1 / -1; padding: 3px 12px; font-size: 11px; font-weight: 600; color: var(--muted); background: var(--soft); border-bottom: 1px solid var(--line); }
.scrollx { overflow-x: auto; scrollbar-width: thin; }
.side table { border-collapse: collapse; white-space: normal; }
.side td { border: 1px solid var(--line); padding: 2px 6px; vertical-align: top; overflow-wrap: break-word; }
mark { border-radius: 3px; padding: 0 1px; color: inherit; }
mark.hid { background: var(--secret); color: var(--secret-fg); }
mark.ph { background: var(--ph); color: var(--ph-fg); font-weight: 600; white-space: nowrap; }
mark.now { outline: 2px solid var(--accent); outline-offset: 1px; }
.warn { margin: 8px 12px 0; padding: 8px 10px; border-radius: 8px; background: var(--contact); color: var(--contact-fg); font-size: 12px; flex: none; }
.notes { margin: 8px 12px 0; color: var(--muted); font-size: 12px; flex: 0 1 auto; min-height: 0; overflow: auto; }
.notes summary { cursor: pointer; width: fit-content; }
.notes ul { margin: 6px 0 0; padding-left: 18px; max-height: 84px; overflow: auto; }
.notes li { margin: 3px 0; }
.foot { display: flex; align-items: center; gap: 8px; padding: 10px 12px 12px 14px; flex: none; flex-wrap: wrap; }
.grow { flex: 1; min-width: 0; }
.nav { display: flex; align-items: center; gap: 4px; color: var(--muted); font-size: 12px; white-space: nowrap; }
.nav button { width: 28px; height: 28px; padding: 0; }
button { border-radius: 8px; border: 1px solid var(--line); padding: 7px 12px; background: var(--bg); color: var(--fg); }
button:hover:not(:disabled) { background: var(--soft); }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-fg); font-weight: 600; }
button.primary:hover:not(:disabled) { background: var(--accent); filter: brightness(1.1); }
button:disabled { opacity: .5; cursor: default; }
button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
@media (prefers-reduced-motion: reduce) { .win { animation: none; } }
`;

const PLACEHOLDER = new RegExp(`\\[(?:${ENTITY_TYPES.join('|')})_\\d+\\]`, 'g');
/** Page, slide and sheet labels added by extraction: shown as dividers, not as text. */
const MARKER = /^(?:(?:Page|Slide) \d+|Sheet: .{1,80})$/;

type Range = [number, number];

/** Append text[from, to) to `el`, wrapping the parts inside `ranges` in <mark>. */
function fill(el: Element, text: string, from: number, to: number, ranges: Range[], kind: 'hid' | 'ph', pair: (k: number) => string | null): void {
  let cursor = from;
  for (const [k, [start, end]] of ranges.entries()) {
    const a = Math.max(start, cursor);
    const b = Math.min(end, to);
    if (b <= a) continue;
    if (a > cursor) el.append(text.slice(cursor, a));
    const id = pair(k);
    el.append(h('mark', { class: kind, text: text.slice(a, b), ...(id ? { attrs: { 'data-pair': id } } : {}) }));
    cursor = b;
  }
  if (cursor < to) el.append(text.slice(cursor, to));
}

/** One column of one row: running text, or a table when every line has the same cells. */
function side(text: string, [from, to]: Range, ranges: Range[], kind: 'hid' | 'ph', structured: boolean, pair: (k: number) => string | null): HTMLElement {
  const el = h('div', { class: `side ${kind === 'hid' ? 'orig' : 'clean'}${structured ? ' data' : ''}` });
  const lines = text.slice(from, to).split('\n');
  const cells = lines.map((l) => l.split('\t').length);
  if (structured && cells[0]! > 1 && cells.every((n) => n === cells[0])) {
    const table = h('table');
    let offset = from;
    for (const line of lines) {
      const row = h('tr');
      let start = offset;
      for (const cell of line.split('\t')) {
        const td = h('td');
        fill(td, text, start, start + cell.length, ranges, kind, pair);
        row.append(td);
        start += cell.length + 1;
      }
      table.append(row);
      offset += line.length + 1;
    }
    el.append(h('div', { class: 'scrollx' }, table));
  } else fill(el, text, from, to, ranges, kind, pair);
  return el;
}

/** Paragraph ranges, so both sides line up paragraph by paragraph when they keep the same ones. */
function paragraphs(text: string): Range[] {
  const out: Range[] = [];
  let start = 0;
  for (const m of text.matchAll(/\n{2,}/g)) {
    out.push([start, m.index!]);
    start = m.index! + m[0].length;
  }
  out.push([start, text.length]);
  return out;
}

/** The grid cells for one part: original on the left, cleaned copy on the right, row by row. */
function partRows(part: DocumentPart, index: number): HTMLElement[] {
  if (part.original === part.cleaned && !part.hidden.length && MARKER.test(part.original.trim())) return [h('div', { class: 'divider', text: part.original.trim() })];
  const hidden = [...part.hidden].sort((a, b) => a[0] - b[0]);
  const placeholders = [...part.cleaned.matchAll(PLACEHOLDER)].map((m): Range => [m.index!, m.index! + m[0].length]);
  // Pair each hidden value with its placeholder when the cleaned text kept them in order.
  const pair = (k: number) => (hidden.length === placeholders.length ? `${index}:${k}` : null);
  const left = paragraphs(part.original);
  const right = paragraphs(part.cleaned);
  const rows: Array<[Range, Range]> = !part.structured && left.length > 1 && left.length === right.length
    ? left.map((l, i) => [l, right[i]!])
    : [[[0, part.original.length], [0, part.cleaned.length]]];
  return rows.flatMap(([l, r]) => [
    side(part.original, l, hidden, 'hid', part.structured, pair),
    side(part.cleaned, r, placeholders, 'ph', part.structured, pair),
  ]);
}

/**
 * The document window, shown just above the page's message box: progress while files are read
 * and cleaned, then the original text next to the cleaned copy. Both sides sit in one scrolling
 * grid, so they always scroll together and each part stays level with its cleaned version.
 * Lives in a closed shadow root: the page cannot read the original text shown here.
 */
export class DocumentPanel {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly title: HTMLElement;
  private readonly subtitle: HTMLElement;
  private readonly content: HTMLElement;
  private readonly status: HTMLElement;
  private readonly progress: HTMLProgressElement;
  private readonly actions: HTMLElement;
  private readonly compare: HTMLElement;
  private readonly counter: HTMLElement;
  private composer: HTMLElement | null;
  private choose: ((choice: DocumentChoice) => void) | null = null;
  private previousFocus = document.activeElement as HTMLElement | null;
  private readonly startedAt = Date.now();
  private stage = 'Reading files on this device…';
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closed = false;
  private reviewing = false;
  private skipRewrite: HTMLButtonElement | null = null;
  private marks: HTMLElement[] = [];
  private current = -1;
  private frame = 0;

  constructor(private readonly cancel: () => void, private readonly near?: Element | null, files = 1) {
    ({ host: this.host, root: this.root } = createShadowHost('nobody-documents', CSS));
    this.composer = findComposer(near);
    this.title = h('h2', { text: files > 1 ? `Checking ${files} documents` : 'Checking your document', attrs: { id: 'doc-title' } });
    this.subtitle = h('div', { class: 'sub', text: files > 1
      ? 'The originals stay on this device. Nothing is attached until you approve the cleaned copies.'
      : 'The original stays on this device. Nothing is attached until you approve the cleaned copy.' });
    this.status = h('p', { class: 'status', text: this.stage, attrs: { role: 'status', 'aria-live': 'polite' } });
    this.progress = h('progress', { attrs: { max: '1', 'aria-label': 'Document progress' } });
    this.content = h('div', { class: 'body' }, h('div', { class: 'work' }, this.status, this.progress));
    this.compare = h('div', { class: 'compare', attrs: { tabindex: '0', role: 'region', 'aria-label': 'Original and cleaned text side by side' } });
    this.counter = h('span');
    this.actions = h('div', { class: 'foot' }, h('div', { class: 'grow' }), this.cancelButton());
    this.panel = h('section', { class: 'nb win', attrs: { role: 'dialog', 'aria-modal': 'false', 'aria-labelledby': 'doc-title', tabindex: '-1' } },
      h('div', { class: 'head' },
        h('div', { class: 'logo', text: 'N', attrs: { 'aria-hidden': 'true' } }),
        h('div', { class: 'titles' }, this.title, this.subtitle),
        h('button', { class: 'icon', text: '×', title: 'Cancel', attrs: { 'aria-label': 'Cancel' }, on: { click: () => this.cancel() } })),
      this.content, this.actions);
    this.root.append(this.panel);
    this.place();
    this.panel.focus({ preventScroll: true });
    reportVisibility('documents', this.host, this.panel);
    addEventListener('resize', this.onViewport, { passive: true });
    addEventListener('scroll', this.onViewport, { capture: true, passive: true });
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      // Recover after a page re-render, a closed popover or a changed host style. Never replace
      // another content-script instance's panel after an extension reload.
      const current = document.getElementById(this.host.id);
      if (current && current !== this.host) { this.cancel(); return; }
      showShadowHost(this.host);
      if (!this.composer?.isConnected) this.composer = findComposer(this.near);
      this.place();
      if (!this.reviewing) this.renderStatus();
    }, 1000);
  }

  private onViewport = (): void => {
    if (this.frame || this.closed) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.place();
    });
  };

  /** Keep the window level with the message box as the page scrolls, resizes or re-renders. */
  private place(): void {
    const at = placeWindow(this.composer?.isConnected ? this.composer : null, this.reviewing ? 640 : 260);
    const style = this.panel.style;
    style.left = `${at.left}px`;
    style.width = `${at.width}px`;
    style.maxHeight = `${at.maxHeight}px`;
    style.top = at.top === undefined ? 'auto' : `${at.top}px`;
    style.bottom = at.bottom === undefined ? 'auto' : `${at.bottom}px`;
  }

  private cancelButton() { return h('button', { text: 'Cancel', on: { click: () => this.cancel() } }); }

  update(text: string, fraction?: number): void {
    if (this.closed) return;
    this.stage = text;
    this.renderStatus();
    if (fraction === undefined) this.progress.removeAttribute('value');
    else this.progress.value = Math.max(0, Math.min(1, fraction));
  }

  private renderStatus(): void {
    const seconds = Math.floor((Date.now() - this.startedAt) / 1000);
    this.status.textContent = this.stage + (seconds >= 3 ? ` · ${seconds}s` : '');
  }

  setProgress(fraction: number): void { this.progress.value = Math.max(0, Math.min(1, fraction)); }

  allowLightStyle(skip: () => void): void {
    this.skipRewrite = h('button', { text: 'Use Light style now', title: 'Keep hiding personal info; finish without waiting for AI rewriting', on: { click: () => {
      skip();
      this.skipRewrite!.disabled = true;
      this.skipRewrite!.textContent = 'Using Light style';
    } } });
    this.actions.lastElementChild?.before(this.skipRewrite);
  }

  /** Keep page Enter shortcuts away from the held attachment; keep Tab inside the window while it has focus. */
  key(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.cancel(); return; }
    if (e.key === 'Enter') {
      e.stopImmediatePropagation();
      const active = this.root.activeElement;
      if (!(active instanceof HTMLButtonElement) && active?.localName !== 'summary') e.preventDefault();
    }
    if (e.key === 'Tab' && document.activeElement === this.host) {
      const items = [...this.panel.querySelectorAll<HTMLElement>('button:not(:disabled), [tabindex="0"], summary')].filter((el) => el.getClientRects().length);
      const current = items.indexOf(this.root.activeElement as HTMLElement);
      e.preventDefault();
      e.stopImmediatePropagation();
      items[(current + (e.shiftKey ? -1 : 1) + items.length) % items.length]?.focus();
    }
  }

  review(previews: DocumentPreview[], attachable: boolean): Promise<DocumentChoice> {
    this.reviewing = true;
    showShadowHost(this.host);
    const many = previews.length > 1;
    const hidden = previews.reduce((n, p) => n + p.findings, 0);
    this.title.textContent = many ? `Review ${previews.length} cleaned copies` : 'Review the cleaned copy';
    this.subtitle.textContent = `${hidden} personal ${hidden === 1 ? 'item' : 'items'} hidden · check names, numbers and reading order before attaching`;

    const tabs = many ? h('div', { class: 'tabs', attrs: { role: 'tablist', 'aria-label': 'Documents' } }) : null;
    const show = (i: number) => {
      for (const [k, tab] of [...(tabs?.children ?? [])].entries()) tab.setAttribute('aria-selected', String(k === i));
      this.showDocument(previews[i]!);
    };
    for (const [i, p] of previews.entries()) {
      tabs?.append(h('button', { class: 'tab', text: `${p.originalName} → ${p.name}`, title: `${p.originalName} → ${p.name}`, attrs: { role: 'tab' }, on: { click: () => show(i) } }));
    }
    const notes = [...new Set(previews.flatMap((p) => p.notes))];
    const urgent = notes.some((n) => /unavailable|Light style because/i.test(n));
    const details = notes.length ? h('details', { class: 'notes' },
      h('summary', { text: `${notes.length} ${notes.length === 1 ? 'note' : 'notes'} about ${many ? 'these copies' : 'this copy'}` }),
      h('ul', {}, ...notes.map((note) => h('li', { text: note })))) : null;
    if (details && urgent) details.open = true;
    this.content.replaceChildren(...[tabs, this.compare, details,
      !attachable && h('div', { class: 'warn', text: 'The upload control changed. Download the cleaned copies, then select those files on this site.' })]
      .filter((el): el is HTMLElement => !!el));
    show(0);

    return new Promise((resolve) => {
      this.choose = resolve;
      const label = many ? 'cleaned copies' : 'cleaned copy';
      const attach = h('button', { class: 'primary', text: `Attach ${label}`, on: { click: () => resolve('attach') } });
      attach.disabled = !attachable;
      const nav = h('div', { class: 'nav' },
        h('button', { text: '↑', title: 'Previous change', attrs: { 'aria-label': 'Previous change' }, on: { click: () => this.step(-1) } }),
        h('button', { text: '↓', title: 'Next change', attrs: { 'aria-label': 'Next change' }, on: { click: () => this.step(1) } }),
        this.counter);
      this.actions.replaceChildren(nav, h('div', { class: 'grow' }), attach,
        h('button', { text: `Download ${label}`, on: { click: () => resolve('download') } }), this.cancelButton());
      this.place();
      this.panel.focus({ preventScroll: true });
      reportVisibility('documents-review', this.host, this.panel);
    });
  }

  private showDocument(p: DocumentPreview): void {
    this.compare.replaceChildren(
      h('div', { class: 'col orig', title: 'Text read from the original file. Layout and images are not shown.' }, 'Original · ', h('b', { text: p.originalName })),
      h('div', { class: 'col', title: 'Exactly what will be attached' }, 'Cleaned · ', h('b', { text: p.name })),
      ...p.parts.flatMap(partRows));
    this.compare.scrollTop = 0;
    this.marks = [...this.compare.querySelectorAll<HTMLElement>('mark.ph')];
    this.current = -1;
    this.renderCounter();
  }

  private renderCounter(): void {
    const total = this.marks.length;
    this.counter.textContent = !total ? 'No changes' : this.current < 0 ? `${total} ${total === 1 ? 'change' : 'changes'}` : `${this.current + 1} of ${total}`;
    for (const b of this.actions.querySelectorAll<HTMLButtonElement>('.nav button')) b.disabled = !total;
  }

  /** Scroll both sides to the previous/next replaced value and outline it on both sides. */
  private step(direction: 1 | -1): void {
    if (!this.marks.length) return;
    this.current = (this.current + direction + this.marks.length) % this.marks.length;
    const mark = this.marks[this.current]!;
    for (const el of this.compare.querySelectorAll('mark.now')) el.classList.remove('now');
    const id = mark.dataset.pair;
    const both = id ? [...this.compare.querySelectorAll<HTMLElement>(`mark[data-pair="${id}"]`)] : [mark];
    for (const el of both) {
      el.classList.add('now');
      // Wide tables scroll sideways inside their own column.
      const strip = el.closest<HTMLElement>('.scrollx');
      if (strip) strip.scrollLeft = Math.max(0, el.offsetLeft - strip.clientWidth / 2);
    }
    const box = this.compare.getBoundingClientRect();
    const top = this.compare.scrollTop + mark.getBoundingClientRect().top - box.top - this.compare.clientHeight / 2;
    this.compare.scrollTo({ top: Math.max(0, top), behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    this.renderCounter();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    cancelAnimationFrame(this.frame);
    removeEventListener('resize', this.onViewport);
    removeEventListener('scroll', this.onViewport, { capture: true });
    this.choose?.('cancel');
    this.choose = null;
    this.host.remove();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
}
