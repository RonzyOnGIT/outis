import {
  anonymize,
  detectDictionary,
  detectKnownValues,
  detectRules,
  getRewriteModel,
  neutralizeLight,
  resolveSpans,
  Vault,
  type DetectOptions,
  type Span,
} from '@nobody/engine';
import { engine, newRequestId, onProgress } from '@/lib/messages';
import {
  DEFAULT_SETTINGS,
  ENTER_SENDS_SITES,
  isSiteEnabled,
  loadSettings,
  loadVault,
  onSettingsChanged,
  onVaultChanged,
  saveVault,
  type Settings,
} from '@/lib/settings';
import { readField } from './fieldtext';
import { captureContext, clearBox, insertText, liveContext, readBox, refocus, replaceAll, type InsertionContext } from './insert';
import { ReviewPanel, toast, type PanelState } from './panel';
import { progressFrom, TopBar } from './topbar';
import { describeEditor, diag } from '@/lib/diag';
import { PageRestorer } from './restore';
import { resendKey, TypingGuard } from './typing';
import { DocumentGuard } from './documents';
import { DocumentError } from '@/lib/documents/types';

type Outcome = 'replaced' | 'kept' | 'cancelled';

/** Messages shorter than this (in words) get the Light cleanup instead of an AI rewrite. */
const AI_MIN_WORDS = 12;

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    const site = location.hostname;

    // After the extension is updated or reloaded, this copy of the script is cut off from it
    // (browser.runtime disappears). A fresh copy is injected into the tab; this one must then do
    // nothing at all, so the two never both react to the same paste or Enter.
    const instance = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    let documents: DocumentGuard | undefined;
    document.documentElement.setAttribute('data-nobody-instance', instance);
    diag('script-start', { build: __NOBODY_BUILD__, instance, readyState: document.readyState });
    let retired = false;
    const alive = (): boolean => {
      if (retired) return false;
      let connected = false;
      try {
        connected = Boolean(browser.runtime?.id);
      } catch {
        connected = false;
      }
      const newest = document.documentElement.getAttribute('data-nobody-instance') === instance;
      if (!connected || !newest) {
        retired = true;
        if (connected) diag('script-retired', { instance, reason: 'newer copy took over' });
        try {
          restorer.setMode('off');
          typing.reset();
          bar.hide();
          documents?.cancel();
        } catch {
          /* not initialised yet — nothing to clean up */
        }
        // Cut off and no fresh copy took over (e.g. it couldn't be injected): say so, don't fail silently.
        if (newest && isSiteEnabled(settings, site)) {
          setTimeout(() => {
            if (document.documentElement.getAttribute('data-nobody-instance') !== instance) return; // a new copy arrived
            new TopBar().show('warn', 'Outis was updated. Reload this page to stay protected', 'Press ⌘R / Ctrl+R. Until then, text here is not checked.');
          }, 1500);
        }
      }
      return !retired;
    };
    // Listeners below are registered synchronously at document_start, so they run before any page
    // script. Until the saved settings arrive (a few ms) we work with the defaults (AI chat sites on).
    let settings: Settings = DEFAULT_SETTINGS;
    let vault = new Vault();
    let busy = false;
    let revision = 0;
    const bar = new TopBar();
    /** The last safe text Nobody put into the box — sent as is on the next Enter. */
    let lastPutIn = '';

    const enabledHere = () => alive() && isSiteEnabled(settings, site);

    const restorer = new PageRestorer(() => (enabledHere() ? vault : null));
    const applyRestoreMode = () => restorer.setMode(enabledHere() ? settings.restoreMode : 'off');

    const ready = (async () => {
      settings = await loadSettings();
      // Ask the background to open RAM-only session storage to us before reading placeholder memory.
      await browser.runtime.sendMessage({ type: 'hello' }).catch(() => {});
      vault = new Vault(await loadVault(site, settings.memory));
      applyRestoreMode();
      // Warm up the name detector so the first check (and the first Enter) is instant.
      if (enabledHere()) void engine.initNer().catch(() => {});
    })();

    onSettingsChanged(async (s) => {
      revision++;
      const memoryChanged = s.memory !== settings.memory;
      settings = s;
      if (memoryChanged) vault = new Vault(await loadVault(site, settings.memory));
      applyRestoreMode();
      if (!enabledHere() || !settings.guardTyping) typing.reset();
    });
    onVaultChanged(site, (data) => {
      revision++;
      vault = new Vault(data);
      restorer.refresh();
    });

    const detectOptions = (): DetectOptions => ({
      policy: settings.policy,
      alwaysHide: settings.alwaysHide,
      neverHide: settings.neverHide,
    });

    /** Instant pattern + dictionary check that never leaves the content script. */
    function quickCheck(text: string, knownNames: string[] = []): Span[] {
      const known = knownNames.map((value) => ({ value, type: 'PERSON' as const }));
      return resolveSpans(text, [...detectRules(text), ...detectDictionary(text, settings.alwaysHide), ...detectKnownValues(text, known)], detectOptions());
    }

    /** Name detection runs in the engine; if it is unavailable we still catch patterns locally. */
    async function detect(text: string, timeoutMs = 30_000): Promise<{ spans: Span[]; nerUsed: boolean }> {
      try {
        return await withTimeout(engine.analyze(text, detectOptions()), timeoutMs);
      } catch (e) {
        console.warn('[Nobody] engine unavailable, using pattern detection only:', e);
        return { spans: quickCheck(text), nerUsed: false };
      }
    }

    documents = new DocumentGuard({
      enabled: () => enabledHere() && settings.guardDocuments,
      alive,
      ready,
      busy: () => busy,
      setBusy: (value) => { busy = value; },
      snapshot: () => ({ settings, vault: vault.clone(), revision }),
      revision: () => revision,
      // Documents have one bounded model budget per selection and a visible fallback warning.
      analyze: (text) => engine.analyze(text, detectOptions()),
      commit: async (next, snapshot) => {
        if (revision !== snapshot.revision || !enabledHere()) throw new DocumentError('changed');
        const data = next.toJSON();
        vault = new Vault(settings.memory === 'none' ? { ...data, entries: [] } : data);
        await saveVault(site, data, settings.memory);
        restorer.refresh();
      },
    });

    /** Top bar mirrors the panel: loading while rewriting, green when the safe text is ready. */
    function showPanelState(s: PanelState, mode: 'paste' | 'field'): void {
      const verb = mode === 'field' ? 'replace' : 'paste';
      if (s.busy) {
        const step = s.progressText || 'Starting the local AI model';
        bar.show(
          'loading',
          s.queued ? `Rewriting on this device. Your text will be ${verb}d when ready` : 'Rewriting your message on this device…',
          s.queued ? `${step} · Esc to cancel` : step,
          progressFrom(s.progressText),
        );
      } else if (s.warn) {
        bar.show('warn', 'Ready. Some sentences use Light rules', `They failed the meaning check. Press Enter to ${verb}.`);
      } else if (s.ready) {
        bar.show('ready', 'Rewritten and checked', `Press Enter to ${verb} it`);
      } else {
        bar.show('ready', 'Disguised text is ready', `Personal details hidden${s.style === 'light' ? ', habits removed' : ''}. Press Enter to ${verb}.`);
      }
    }

    /**
     * Show the review panel.
     *  paste mode — `text` came from the clipboard and gets inserted at the caret.
     *  field mode — `text` is what's already in the box; the whole box gets replaced.
     */
    async function review(
      text: string,
      ctx: InsertionContext,
      opts: { mode: 'paste' | 'field'; spans?: Span[]; note?: string } = { mode: 'paste' },
    ): Promise<Outcome> {
      busy = true;
      const panel = new ReviewPanel(ctx.el);
      // Field mode: if the user goes back to typing, the review is out of date — close it.
      const onTyping = (e: Event) => {
        if (opts.mode === 'field' && e.isTrusted && e.target instanceof Node && ctx.el.contains(e.target)) panel.dismiss();
      };
      window.addEventListener('input', onTyping, true);
      bar.show('loading', 'Checking your message…', 'Looking for personal details on this device');
      diag('review-start', { mode: opts.mode, chars: text.length, editor: describeEditor(ctx.el), kind: ctx.kind, aiDefault: settings.defaultStyle });
      const slow = setTimeout(() => panel.showLoading('Loading the name detector (first run only)…'), 1200);
      panel.showLoading('Checking for personal details…');
      try {
        const { spans, nerUsed } = opts.spans ? { spans: opts.spans, nerUsed: true } : await detect(text);
        clearTimeout(slow);

        if (!spans.length && settings.defaultStyle !== 'ai') {
          bar.hide();
          panel.close();
          if (opts.mode === 'paste') await insertText(ctx, text);
          else refocus(ctx);
          toast('No personal details found');
          return 'kept';
        }

        // Preview and commit must use the same vault state so placeholders match exactly.
        const snapshot = vault;
        const model = getRewriteModel(settings.styleTier);
        const aiAvailable = settings.styleTier !== 'light' && Boolean(settings.webllmId);
        const result = await panel.review({
          original: text,
          spans,
          vault: snapshot,
          style: settings.defaultStyle,
          ai: { available: aiAvailable, modelName: model.name.replace(/^\w+ · /, '') },
          nerUsed,
          mode: opts.mode,
          note: opts.note,
          restoreHint: settings.restoreMode !== 'off',
          onState: (s: PanelState) => showPanelState(s, opts.mode),
          rewrite: async (anonymized, report) => {
            const requestId = newRequestId();
            const off = onProgress(requestId, (p) =>
              report(p.text.startsWith('Rewriting') ? p.text : p.progress < 100 ? `Loading model… ${p.progress}%` : 'Rewriting'),
            );
            try {
              return await engine.rewrite(anonymized, settings.webllmId!, requestId, settings.aiCoverage);
            } finally {
              off();
            }
          },
        });
        window.removeEventListener('input', onTyping, true);

        diag('review-result', { action: result.action, chars: result.action === 'clean' ? result.text.length : null });
        if (result.action === 'clean') {
          // Remember placeholders (per the memory setting) so later messages and answers stay consistent.
          anonymize(text, result.spans, snapshot);
          await saveVault(site, snapshot.toJSON(), settings.memory);
          let ok = true;
          if (opts.mode === 'field') ok = await replaceAll(ctx, result.text);
          else await insertText(ctx, result.text);
          if (ok) {
            bar.show('ready', 'Disguised text is in the box', opts.mode === 'field' ? 'Press Enter to send' : 'Review it and send when ready', undefined, 4000);
          } else {
            const copied = await navigator.clipboard.writeText(result.text).then(() => true, () => false);
            bar.show(
              'warn',
              'Couldn’t replace the text automatically',
              copied ? 'The disguised text is on your clipboard: click the box, press ⌘A / Ctrl+A, then paste.' : 'Please try again, or use Alt+Shift+N.',
            );
          }
          return 'replaced';
        }
        bar.hide();
        if (result.action === 'original') {
          if (opts.mode === 'paste') await insertText(ctx, text);
          else refocus(ctx);
          return 'kept';
        }
        refocus(ctx);
        return 'cancelled';
      } catch (e) {
        clearTimeout(slow);
        bar.hide();
        panel.close();
        console.error('[Nobody]', e);
        toast('Outis hit an error. Nothing was changed.');
        refocus(ctx);
        return 'cancelled';
      } finally {
        window.removeEventListener('input', onTyping, true);
        busy = false;
      }
    }

    /**
     * Automatic mode (one Enter): take the text out of the box right away, make it safe in the
     * background, and put the safe version into the (now empty) box when it's ready.
     *   field — text typed in the box (Enter / Send was pressed)
     *   paste — text from the clipboard (nothing was inserted yet)
     * Esc while working puts the original back (field) or cancels the paste.
     */
    async function autoFix(text: string, ctx: InsertionContext, mode: 'paste' | 'field', known?: Span[]): Promise<Outcome> {
      busy = true;
      let cancelled = false;
      /** Enter pressed while working = "send it as soon as the safe text is in". */
      let sendQueued = false;
      const t0 = Date.now();
      const working = mode === 'field' ? 'Your text is out of the box until the safe version is ready · Esc to undo' : 'It will be pasted when ready · Esc to cancel';
      const onKey = (e: KeyboardEvent) => {
        if (!e.isTrusted) return;
        if (e.key === 'Escape' && !cancelled) {
          e.preventDefault();
          e.stopImmediatePropagation();
          cancelled = true;
        } else if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          // Nothing safe to send yet — remember it and send once the safe text is in the box.
          e.preventDefault();
          e.stopImmediatePropagation();
          if (mode === 'field' && !sendQueued) {
            sendQueued = true;
            diag('auto-send-queued', {});
            bar.show('loading', 'Disguising your message…', 'Will send as soon as it’s ready · Esc to undo');
          }
        }
      };
      window.addEventListener('keydown', onKey, true);
      bar.show('loading', 'Disguising your message…', working);
      diag('auto-start', { mode, chars: text.length, style: settings.defaultStyle, editor: describeEditor(ctx.el) });

      const restoreOriginal = async () => {
        if (mode === 'field') await replaceAll(ctx, text);
        bar.show('ready', mode === 'field' ? 'Undone — your original text is back' : 'Paste cancelled', undefined, undefined, 2500);
        diag('auto-cancelled', { mode });
      };

      try {
        // 1. Get the original out of the box immediately, so it can't be sent by accident.
        if (mode === 'field') await clearBox(ctx);

        // 2. Find personal info (instant if the typing check already did it).
        const spans = known ?? (await detect(text)).spans;
        if (cancelled) return (await restoreOriginal(), 'cancelled');
        if (!spans.length && (settings.defaultStyle === 'off' || (settings.defaultStyle === 'light' && neutralizeLight(text) === text))) {
          // Nothing to hide or restyle: put it back as it was.
          if (mode === 'field') await replaceAll(ctx, text);
          else await insertText(ctx, text);
          bar.show('ready', 'No personal details found', undefined, undefined, 2000);
          return 'kept';
        }

        // 3. Make it safe: placeholders, then the chosen writing style.
        const snapshot = vault;
        const anon = anonymize(text, spans, snapshot.clone()).text;
        let safe = settings.defaultStyle === 'off' ? anon : neutralizeLight(anon);
        let partial = false;
        const aiAvailable = settings.styleTier !== 'light' && Boolean(settings.webllmId);
        // Short messages carry little style fingerprint, and small models are most likely to change
        // their meaning — they get the Light cleanup instead of an AI rewrite.
        const longEnough = (anon.match(/\p{L}+/gu) ?? []).length >= AI_MIN_WORDS;
        if (settings.defaultStyle === 'ai' && aiAvailable && (longEnough || spans.length > 0)) {
          const requestId = newRequestId();
          const off = onProgress(requestId, (p) => {
            if (cancelled) return;
            const step = p.text.startsWith('Rewriting') ? p.text : p.progress < 100 ? `Loading the AI model… ${p.progress}%` : 'Rewriting';
            const after = sendQueued ? 'Will send as soon as it’s ready · Esc to undo' : working;
            bar.show('loading', 'Rewriting your message…', `${step} · ${after}`, progressFrom(step));
          });
          try {
            const r = await engine.rewrite(anon, settings.webllmId!, requestId, settings.aiCoverage);
            safe = r.text;
            partial = !r.rewritten;
          } catch (e) {
            partial = true;
            diag('auto-rewrite-error', { error: String(e).slice(0, 120) });
          } finally {
            off();
          }
        }
        if (cancelled) return (await restoreOriginal(), 'cancelled');

        // 4. Remember placeholders, then put the safe text in.
        anonymize(text, spans, snapshot);
        await saveVault(site, snapshot.toJSON(), settings.memory);
        let ok = true;
        let final = safe;
        if (mode === 'field') {
          // Keep anything the user typed meanwhile — unless it is the original (box couldn't be cleared).
          const left = readField(liveContext(ctx)).text.trim();
          const leftIsOriginal = left.length > 0 && text.includes(left.slice(0, Math.min(40, left.length)));
          if (left && !leftIsOriginal) final = `${safe} ${left}`;
          ok = await replaceAll(ctx, final);
        } else {
          // Some sites also insert the pasted text themselves (their own clipboard handling). If the
          // original made it into the box, swap it for the safe text instead of adding next to it.
          const sq = (s: string) => s.replace(/\s+/g, ' ').trim();
          const box = sq(readBox(ctx));
          const orig = sq(text);
          const at = orig ? box.indexOf(orig.slice(0, Math.min(60, orig.length))) : -1;
          diag('paste-box-before', { boxChars: box.length, originalInBox: at >= 0 });
          if (at >= 0) {
            final = `${box.slice(0, at)} ${safe} ${box.slice(at + orig.length)}`.trim();
            ok = await replaceAll(ctx, final);
          } else {
            await insertText(ctx, safe);
          }
        }
        typing.noteClean(liveContext(ctx), final);
        lastPutIn = readField(liveContext(ctx)).text;
        diag('auto-done', { mode, ok, partial, ms: Date.now() - t0, chars: final.length });

        if (!ok) {
          const copied = await navigator.clipboard.writeText(final).then(() => true, () => false);
          bar.show('warn', 'Couldn’t put the disguised text in the box', copied ? 'It is on your clipboard: click the box, press ⌘A / Ctrl+A, then paste.' : 'Please try again.');
          return 'replaced';
        }
        if ((settings.autoSend || sendQueued) && mode === 'field') {
          bar.show('ready', 'Disguised. Sending', partial ? 'Some sentences use Light rules' : undefined, undefined, 3000);
          await new Promise((r) => setTimeout(r, 150));
          resendKey(liveContext(ctx).el, { ctrlKey: false, metaKey: false, altKey: false });
        } else {
          bar.show(
            partial ? 'warn' : 'ready',
            partial ? 'Ready. Some sentences use Light rules (they failed the meaning check)' : 'Disguised text is in the box',
            mode === 'field' ? 'Check it, then press Enter to send' : 'Check it before sending',
            undefined,
            6000,
            mode === 'field'
              ? {
                  label: 'Undo',
                  run: () => {
                    diag('auto-undo', {});
                    void replaceAll(ctx, text).then(() => typing.reset());
                  },
                }
              : undefined,
          );
        }
        return 'replaced';
      } catch (e) {
        console.error('[Nobody]', e);
        diag('auto-error', { error: String(e).slice(0, 160) });
        await restoreOriginal().catch(() => {});
        bar.show('warn', 'Outis hit an error. Your original text is back.', 'Nothing was sent.');
        return 'cancelled';
      } finally {
        window.removeEventListener('keydown', onKey, true);
        busy = false;
      }
    }

    // Load the AI rewrite model into memory as soon as the user clicks into a chat box,
    // so the rewrite is ready (or nearly) by the time they press Enter.
    let warmedAt = 0;
    window.addEventListener(
      'focusin',
      (e) => {
        if (!e.isTrusted || !enabledHere() || settings.defaultStyle !== 'ai' || !settings.webllmId) return;
        if (Date.now() - warmedAt < 5 * 60_000 || !captureContext(e.composedPath()[0] ?? e.target)) return;
        warmedAt = Date.now();
        void engine.loadLlm(settings.webllmId).catch(() => {});
      },
      true,
    );

    // --- 1. Pasted text. Capture phase on window at document_start: we see the paste before the page. ---
    window.addEventListener(
      'paste',
      (e: ClipboardEvent) => {
        if (!e.isTrusted || busy || !enabledHere()) return;
        const ctx = captureContext(e.composedPath()[0] ?? e.target);
        if (!ctx) return;
        const text = e.clipboardData?.getData('text/plain') ?? '';
        if (text.trim().length < settings.minPasteChars) return;
        e.preventDefault();
        e.stopImmediatePropagation();
        if (settings.autoMode) void autoFix(text, ctx, 'paste');
        else void review(text, ctx);
      },
      true,
    );

    // --- 2. Typed text: live underline + badge, and a guard on send. ---
    const typing = new TypingGuard({
      enabled: () => enabledHere() && settings.guardTyping,
      // AI chats (built-in list or sites you added) send on Enter; elsewhere Enter is a newline.
      enterSends: () => ENTER_SENDS_SITES.has(site) || settings.sites[site] === true,
      isBusy: () => busy,
      analyze: async (text) => (await detect(text, 5_000)).spans,
      quickCheck,
      // In automatic mode every message is restyled before sending (that's the writing-style
      // fingerprint), not only messages with personal info. Very short messages are left alone.
      wantsRestyle: (text) => {
        if (!settings.autoMode || settings.defaultStyle === 'off' || !text.trim()) return false;
        if (lastPutIn && text.trim() === lastPutIn.trim()) return false; // Outis's own output, send as is
        if (settings.defaultStyle === 'light') return neutralizeLight(text) !== text;
        // Short messages without personal info say little about how you write — send them untouched.
        const words = (text.match(/\p{L}+/gu) ?? []).length;
        if (words < AI_MIN_WORDS) return false;
        const aiAvailable = settings.styleTier !== 'light' && Boolean(settings.webllmId);
        return aiAvailable || neutralizeLight(text) !== text;
      },
      review: (ctx, text, spans, why) =>
        // Automatic mode handles Enter/Send in one step; the badge always opens the review panel.
        why === 'send' && settings.autoMode
          ? autoFix(text, ctx, 'field', spans)
          : review(text, ctx, {
              mode: 'field',
              spans,
              note: why === 'send' ? 'Not sent yet — this message contains personal info' : undefined,
            }),
    });

    // --- 3. Keyboard shortcut (Alt+Shift+N): review whatever is in the focused box right now. ---
    browser.runtime.onMessage.addListener((msg: any) => {
      if (msg?.type !== 'scrubField' || busy) return undefined;
      const ctx = captureContext();
      if (!ctx) {
        toast('Click into a text box first, then press Alt+Shift+N');
        return undefined;
      }
      const text = readField(ctx).text;
      if (!text.trim()) {
        toast('This text box is empty');
        return undefined;
      }
      void review(text, ctx, { mode: 'field' });
      return undefined;
    });
  },
});

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    p.then(
      (v) => (clearTimeout(t), resolve(v)),
      (e) => (clearTimeout(t), reject(e)),
    );
  });
}
