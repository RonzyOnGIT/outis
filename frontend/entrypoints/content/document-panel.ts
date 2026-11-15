import { BASE_CSS, createShadowHost, h, reportVisibility, showShadowHost } from './ui';
import type { CleanDocument } from '@/lib/documents/sanitize';

export interface DocumentPreview extends CleanDocument { originalName: string; name: string; }
export type DocumentChoice = 'attach' | 'download' | 'cancel';

const CSS = BASE_CSS + `
.overlay { position: fixed; inset: 0; background: #0006; display: grid; place-items: center; padding: 20px; }
.panel { width: min(740px, 100%); max-height: calc(100vh - 40px); display: flex; flex-direction: column; overflow: hidden; background: var(--bg); padding: 24px; border-radius: 16px; box-shadow: var(--shadow); }
.panel > h2, .panel > p, .panel > progress, .actions { flex-shrink: 0; }
h2 { margin: 0 0 10px; font-size: 20px; } p { margin: 8px 0; } .muted { color: var(--muted); }
.files { display: grid; gap: 16px; margin: 16px 0; min-height: 0; overflow: auto; } article { min-width: 0; } h3 { font-size: 14px; overflow-wrap: anywhere; }
pre { white-space: pre-wrap; overflow-wrap: anywhere; background: var(--soft); padding: 12px; max-height: 240px; overflow: auto; border-radius: 8px; font: 12px/1.55 ui-monospace, monospace; }
.notes { padding-left: 20px; } .notes li { margin: 6px 0; } .actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 16px; }
button { border-radius: 8px; border: 1px solid var(--line); padding: 9px 14px; background: var(--bg); color: var(--fg); }
button.primary { background: var(--accent); color: var(--accent-fg); } button:disabled { opacity: .5; cursor: default; }
button:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; } progress { width: 100%; accent-color: var(--accent); }
`;

export class DocumentPanel {
  readonly host: HTMLElement;
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly status: HTMLElement;
  private readonly progress: HTMLProgressElement;
  private readonly files: HTMLElement;
  private readonly actions: HTMLElement;
  private choose: ((choice: DocumentChoice) => void) | null = null;
  private previousFocus = document.activeElement as HTMLElement | null;
  private readonly startedAt = Date.now();
  private stage = 'Reading files on this device…';
  private readonly heartbeat: ReturnType<typeof setInterval>;
  private closed = false;
  private reviewing = false;
  private skipRewrite: HTMLButtonElement | null = null;

  constructor(private readonly cancel: () => void) {
    ({ host: this.host, root: this.root } = createShadowHost('nobody-documents', CSS));
    this.status = h('p', { class: 'muted', text: 'Reading files on this device…', attrs: { role: 'status', 'aria-live': 'polite' } });
    this.progress = h('progress', { attrs: { max: '1', 'aria-label': 'Document progress' } });
    this.files = h('div', { class: 'files' });
    this.actions = h('div', { class: 'actions' }, this.cancelButton());
    this.panel = h('section', { class: 'nb panel', attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'doc-title', tabindex: '-1' } },
      h('h2', { text: 'Review cleaned attachments', attrs: { id: 'doc-title' } }),
      h('p', { text: 'Nobody is holding the originals. Only cleaned text copies will be attached after you review them.' }),
      this.status, this.progress, this.files, this.actions);
    this.root.append(h('div', { class: 'overlay' }, this.panel));
    this.actions.querySelector('button')?.focus();
    reportVisibility('documents', this.host, this.panel);
    this.heartbeat = setInterval(() => {
      if (this.closed) return;
      // Recover after a page re-render, a closed popover or a changed host style. Never replace
      // another content-script instance's panel after an extension reload.
      const current = document.getElementById(this.host.id);
      if (current && current !== this.host) { this.cancel(); return; }
      showShadowHost(this.host);
      if (!this.reviewing) this.renderStatus();
    }, 1000);
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
    this.status.textContent = this.stage + (seconds >= 3 ? ` · ${seconds}s elapsed` : '');
  }

  setProgress(fraction: number): void { this.progress.value = Math.max(0, Math.min(1, fraction)); }

  allowLightStyle(skip: () => void): void {
    this.skipRewrite = h('button', { text: 'Use Light style now', title: 'Keep hiding personal info; finish without waiting for AI rewriting', on: { click: () => {
      skip();
      this.skipRewrite!.disabled = true;
      this.skipRewrite!.textContent = 'Using Light style';
    } } });
    this.actions.prepend(this.skipRewrite);
  }

  /** Trap keyboard focus and keep page Enter shortcuts away from the pending attachment. */
  key(e: KeyboardEvent): void {
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); this.cancel(); return; }
    if (e.key === 'Enter') {
      e.stopImmediatePropagation();
      if (!(this.root.activeElement instanceof HTMLButtonElement)) e.preventDefault();
    }
    if (e.key === 'Tab') {
      const buttons = [...this.panel.querySelectorAll<HTMLElement>('button:not(:disabled), pre[tabindex]')];
      const current = buttons.indexOf(this.root.activeElement as HTMLElement);
      e.preventDefault();
      e.stopImmediatePropagation();
      (buttons[(current + (e.shiftKey ? -1 : 1) + buttons.length) % buttons.length] as HTMLElement)?.focus();
    }
  }

  review(previews: DocumentPreview[], attachable: boolean): Promise<DocumentChoice> {
    this.reviewing = true;
    showShadowHost(this.host);
    this.progress.hidden = true;
    this.status.textContent = 'Review the full text below. Detection can miss information; check names, numbers and reading order before attaching.';
    const notes = [...new Set(previews.flatMap((p) => p.notes))];
    this.files.replaceChildren(
      ...previews.map((p) => h('article', {},
        h('h3', { text: `${p.originalName} → ${p.name}` }),
        h('p', { class: 'muted', text: `${p.findings} personal items replaced · UTF-8 text copy` }),
        h('pre', { text: p.text, attrs: { tabindex: '0', 'aria-label': `Preview of ${p.name}` } }))),
      h('ul', { class: 'notes' }, ...notes.map((note) => h('li', { text: note }))),
      ...(!attachable ? [h('p', { text: 'The upload control changed. Download the cleaned copies, then select those files on this site.' })] : []),
    );
    return new Promise((resolve) => {
      this.choose = resolve;
      const attach = h('button', { class: 'primary', text: 'Attach cleaned copies', on: { click: () => resolve('attach') } });
      attach.disabled = !attachable;
      this.actions.replaceChildren(attach,
        h('button', { text: 'Download cleaned copies', on: { click: () => resolve('download') } }), this.cancelButton());
      this.panel.scrollTop = 0;
      this.panel.focus({ preventScroll: true });
      reportVisibility('documents-review', this.host, this.panel);
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    this.choose?.('cancel');
    this.choose = null;
    this.host.remove();
    if (this.previousFocus?.isConnected) this.previousFocus.focus();
  }
}
