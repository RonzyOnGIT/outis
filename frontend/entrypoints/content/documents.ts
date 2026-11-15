import { detectDictionary, detectRules, resolveSpans, Vault } from '@nobody/engine';
import { engine, newRequestId, onProgress } from '@/lib/messages';
import { diag } from '@/lib/diag';
import type { Settings } from '@/lib/settings';
import { bytesToBase64, DOCUMENT_LIMITS, DocumentError, documentFormat, validateFiles } from '@/lib/documents/types';
import { sanitizeDocument, type DocumentServices } from '@/lib/documents/sanitize';
import { documentModels, waitForDocument } from '@/lib/documents/wait';
import { DocumentPanel, type DocumentPreview } from './document-panel';
import { TopBar } from './topbar';

interface Snapshot { settings: Settings; vault: Vault; revision: number; }
interface DocumentGuardOptions {
  enabled: () => boolean;
  alive: () => boolean;
  ready: Promise<void>;
  busy: () => boolean;
  setBusy: (busy: boolean) => void;
  snapshot: () => Snapshot;
  revision: () => number;
  commit: (vault: Vault, snapshot: Snapshot) => Promise<void>;
  analyze: DocumentServices['analyze'];
}

type Destination = { kind: 'input'; target: HTMLInputElement } | { kind: 'drop' | 'paste'; target: Element };
const stop = (e: Event) => { e.preventDefault(); e.stopImmediatePropagation(); };

/** Registered before the text listeners at document_start. Originals never enter replayed events. */
export class DocumentGuard {
  private replay = new WeakSet<Event>();
  private heldInputs = new WeakSet<HTMLInputElement>();
  private active: { controller: AbortController; panel: DocumentPanel } | null = null;
  private nextName = 1;
  private bar = new TopBar();

  constructor(private readonly options: DocumentGuardOptions) {
    window.addEventListener('input', this.input, true);
    window.addEventListener('change', this.input, true);
    window.addEventListener('drop', this.drop, true);
    window.addEventListener('paste', this.paste, true);
    // Prevent the browser navigating to a dropped document before we can inspect it.
    window.addEventListener('dragover', (e) => {
      if (options.enabled() && e.dataTransfer?.types.includes('Files')) e.preventDefault();
    }, true);
    window.addEventListener('keydown', (e) => { if (this.active) this.active.panel.key(e); }, true);
    window.addEventListener('submit', (e) => { if (this.active) stop(e); }, true);
    window.addEventListener('click', (e) => {
      if (!this.active || e.composedPath().includes(this.active.panel.host)) return;
      const target = (e.composedPath()[0] as Element)?.closest?.('button, [role="button"], input[type="submit"]');
      if (target && (target.getAttribute('type') === 'submit' || /send|submit/i.test([target.getAttribute('aria-label'), target.getAttribute('data-testid'), target.textContent].join(' ')))) stop(e);
    }, true);
  }

  cancel(): void {
    this.active?.controller.abort();
    this.active?.panel.close();
  }

  private input = (e: Event): void => {
    if (this.replay.has(e) || !this.options.enabled()) return;
    const target = e.composedPath()[0];
    if (!(target instanceof HTMLInputElement) || target.type !== 'file') return;
    const files = [...(target.files ?? [])];
    if (!files.length) {
      if (this.heldInputs.has(target)) stop(e);
      return;
    }
    stop(e);
    // Clear synchronously, before *any* page input/change listener or form submission can see it.
    target.value = '';
    this.heldInputs.add(target);
    void this.process(files, { kind: 'input', target });
  };

  private drop = (e: DragEvent): void => {
    if (this.replay.has(e) || !this.options.enabled() || !e.dataTransfer?.types.includes('Files')) return;
    stop(e);
    const target = e.composedPath()[0];
    const files = [...e.dataTransfer.files];
    if (!(target instanceof Element) || !files.length) {
      this.bar.show('warn', 'Attachment blocked', 'Folders and empty file drops are not supported. Select individual documents.');
      return;
    }
    void this.process(files, { kind: 'drop', target });
  };

  private paste = (e: ClipboardEvent): void => {
    if (this.replay.has(e) || !this.options.enabled()) return;
    const files = [...(e.clipboardData?.files ?? [])];
    if (!files.length) return;
    stop(e);
    const target = e.composedPath()[0];
    if (target instanceof Element) void this.process(files, { kind: 'paste', target });
  };

  private dispatch(target: Element, e: Event): void {
    this.replay.add(e);
    target.dispatchEvent(e);
  }

  private deliver(files: File[], destination: Destination): void {
    if (!destination.target.isConnected) throw new DocumentError('unavailable');
    const data = new DataTransfer();
    for (const file of files) data.items.add(file);
    if (destination.kind === 'input') {
      destination.target.files = data.files;
      this.heldInputs.delete(destination.target);
      this.dispatch(destination.target, new Event('input', { bubbles: true, composed: true }));
      this.dispatch(destination.target, new Event('change', { bubbles: true, composed: true }));
    } else if (destination.kind === 'drop') {
      this.dispatch(destination.target, new DragEvent('drop', { bubbles: true, cancelable: true, composed: true, dataTransfer: data }));
    } else {
      this.dispatch(destination.target, new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: data }));
    }
  }

  private download(files: File[]): void {
    for (const file of files) {
      const url = URL.createObjectURL(file);
      const a = document.createElement('a');
      a.href = url;
      a.download = file.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  }

  private async process(files: File[], destination: Destination): Promise<void> {
    if (this.options.busy()) {
      this.bar.show('warn', 'New attachment held back', 'Finish or cancel the current Nobody review, then select these files again.');
      return;
    }
    this.options.setBusy(true);
    const controller = new AbortController();
    const skipRewrite = new AbortController();
    const panel = new DocumentPanel(() => controller.abort(), destination.target, files.length);
    this.active = { controller, panel };
    let snapshot: Snapshot | undefined;
    const check = () => {
      if (controller.signal.aborted || !this.options.alive()) throw new DocumentError('cancelled');
      if (!this.options.enabled() || (snapshot && this.options.revision() !== snapshot.revision)) throw new DocumentError('changed');
    };
    const cancelled = new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => {
      panel.close();
      reject(new DocumentError('cancelled'));
    }, { once: true }));
    const work = async () => {
      await waitForDocument(() => this.options.ready, 10_000, [controller.signal]);
      check();
      snapshot = this.options.snapshot();
      validateFiles(files);
      diag('documents-held', { count: files.length, bytes: files.reduce((n, f) => n + f.size, 0), via: destination.kind });
      const previews: DocumentPreview[] = [];
      const s = snapshot.settings;
      let currentFile = 1;
      let lastStage = '';
      const stage = (name: string, text: string, part?: number) => {
        check();
        panel.update(text);
        const key = `${currentFile}:${name}:${part ?? 0}`;
        if (key !== lastStage) {
          lastStage = key;
          diag('documents-stage', { stage: name, file: currentFile, part: part ?? null });
        }
      };
      if (s.defaultStyle === 'ai') panel.allowLightStyle(() => {
        skipRewrite.abort();
        diag('documents-light-selected');
      });
      const models = documentModels({
        analyze: this.options.analyze,
        fallback: (text) => ({ spans: resolveSpans(text, [...detectRules(text), ...detectDictionary(text, s.alwaysHide)], s), nerUsed: false }),
        rewrite: async (text, attempt) => {
          const requestId = newRequestId();
          stage('rewrite', `Rewriting document ${currentFile} of ${files.length}…`);
          const off = onProgress(requestId, (p) => {
            if (attempt.aborted || controller.signal.aborted || skipRewrite.signal.aborted) return;
            panel.update(`Document ${currentFile} of ${files.length} · ${p.text.startsWith('Rewriting') ? p.text : `Loading writing model · ${p.progress}%`}`);
          });
          // Unsubscribe on user cancellation/fallback, even if the underlying engine is still busy.
          attempt.addEventListener('abort', off, { once: true });
          try { return await engine.rewrite(text, s.webllmId!, requestId, s.aiCoverage); }
          finally {
            off();
            attempt.removeEventListener('abort', off);
          }
        },
        signal: controller.signal,
        skipRewrite: skipRewrite.signal,
      });
      let totalChars = 0;
      for (const [i, file] of files.entries()) {
        currentFile = i + 1;
        check();
        stage('read', `Reading document ${i + 1} of ${files.length} on this device…`);
        const bytes = new Uint8Array(await waitForDocument(() => file.arrayBuffer(), 10_000, [controller.signal]));
        check();
        stage('extract', `Extracting text from document ${i + 1} of ${files.length}…`);
        const document = await waitForDocument(() => engine.extractDocument(documentFormat(file.name), bytesToBase64(bytes)), 45_000, [controller.signal]);
        check();
        diag('documents-extracted', { file: currentFile, chars: document.blocks.reduce((n, b) => n + b.text.length, 0), blocks: document.blocks.length });
        totalChars += document.blocks.reduce((n, b) => n + b.text.length + 2, 0);
        if (totalChars > DOCUMENT_LIMITS.textChars) throw new DocumentError('size');
        const cleaned = await sanitizeDocument(document, snapshot.vault, { ...s, style: s.defaultStyle }, {
          analyze: models.analyze,
          rewrite: s.defaultStyle === 'ai' && s.webllmId ? models.rewrite : undefined,
          check,
          phase: (name, part, total) => stage(name, name === 'detect'
            ? `Checking personal info · document ${currentFile} of ${files.length} · part ${part} of ${total}`
            : `Cleaning writing style · document ${currentFile} of ${files.length}…`, part),
          progress: (done, total) => { check(); panel.setProgress((i + done / total) / files.length); },
        });
        check();
        previews.push({ ...cleaned, originalName: file.name, name: `attachment-${this.nextName + i}.txt` });
      }
      check();
      diag('documents-review-ready', { count: previews.length });
      let choice = await panel.review(previews, destination.target.isConnected);
      check();
      if (choice === 'cancel') throw new DocumentError('cancelled');
      // Commit only after approval; cancelled or failed previews do not consume placeholders.
      await this.options.commit(snapshot.vault, snapshot);
      if (controller.signal.aborted || !this.options.alive()) throw new DocumentError('cancelled');
      const cleanFiles = previews.map((p) => new File([p.text], p.name, { type: 'text/plain', lastModified: 0 }));
      this.nextName += files.length;
      if (choice === 'attach') {
        try { this.deliver(cleanFiles, destination); }
        catch {
          choice = await panel.review(previews, false);
          if (choice !== 'download' || controller.signal.aborted) throw new DocumentError('cancelled');
        }
      }
      if (choice === 'download') this.download(cleanFiles);
      diag('documents-released', { count: cleanFiles.length, chars: previews.reduce((n, p) => n + p.text.length, 0), via: choice });
      panel.close();
      this.bar.show('ready', choice === 'attach' ? 'Cleaned text copies passed to the site' : 'Cleaned text copies downloaded',
        choice === 'attach' ? 'Check the site’s attachment list before sending. If it rejects text copies, use Download cleaned copies on your next selection.' : 'Select the downloaded copies to attach them.', undefined, 9000);
    };
    try {
      await Promise.race([work(), cancelled]);
    } catch (e) {
      const code = e instanceof DocumentError ? e.code : 'unavailable';
      diag('documents-blocked', { code });
      this.bar.show('warn', code === 'cancelled' ? 'Attachments cancelled' : 'Attachments blocked', new DocumentError(code).message);
    } finally {
      // Stop late model/extraction results from creating a preview after cancellation or failure.
      controller.abort();
      skipRewrite.abort();
      panel.close();
      if (destination.kind === 'input') this.heldInputs.delete(destination.target);
      if (this.active?.controller === controller) this.active = null;
      this.options.setBusy(false);
    }
  }
}
