import {
  anonymize,
  detectDictionary,
  detectRules,
  getRewriteModel,
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
import { captureContext, insertText, refocus, selectAll, type InsertionContext } from './insert';
import { ReviewPanel, toast } from './panel';
import { PageRestorer } from './restore';
import { TypingGuard } from './typing';

type Outcome = 'replaced' | 'kept' | 'cancelled';

export default defineContentScript({
  matches: ['<all_urls>'],
  runAt: 'document_start',
  main() {
    const site = location.hostname;
    // Listeners below are registered synchronously at document_start, so they run before any page
    // script. Until the saved settings arrive (a few ms) we work with the defaults (AI chat sites on).
    let settings: Settings = DEFAULT_SETTINGS;
    let vault = new Vault();
    let busy = false;

    const enabledHere = () => isSiteEnabled(settings, site);

    const restorer = new PageRestorer(() => (enabledHere() ? vault : null));
    const applyRestoreMode = () => restorer.setMode(enabledHere() ? settings.restoreMode : 'off');

    void (async () => {
      settings = await loadSettings();
      // Ask the background to open RAM-only session storage to us before reading placeholder memory.
      await browser.runtime.sendMessage({ type: 'hello' }).catch(() => {});
      vault = new Vault(await loadVault(site, settings.memory));
      applyRestoreMode();
      // Warm up the name detector so the first check (and the first Enter) is instant.
      if (enabledHere()) void engine.initNer().catch(() => {});
    })();

    onSettingsChanged(async (s) => {
      const memoryChanged = s.memory !== settings.memory;
      settings = s;
      if (memoryChanged) vault = new Vault(await loadVault(site, settings.memory));
      applyRestoreMode();
      if (!enabledHere() || !settings.guardTyping) typing.reset();
    });
    onVaultChanged(site, (data) => {
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
      const dictionary = [...settings.alwaysHide, ...knownNames.map((value) => ({ value, type: 'PERSON' as const }))];
      return resolveSpans(text, [...detectRules(text), ...detectDictionary(text, dictionary)], detectOptions());
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
      const slow = setTimeout(() => panel.showLoading('Loading the name detector (first run only)…'), 1200);
      panel.showLoading('Checking for personal info…');
      try {
        const { spans, nerUsed } = opts.spans ? { spans: opts.spans, nerUsed: true } : await detect(text);
        clearTimeout(slow);

        if (!spans.length && settings.defaultStyle !== 'ai') {
          panel.close();
          if (opts.mode === 'paste') await insertText(ctx, text);
          else refocus(ctx);
          toast('Nobody: no personal info found');
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
          rewrite: async (anonymized, report) => {
            const requestId = newRequestId();
            const off = onProgress(requestId, (p) => report(p.progress < 100 ? `Loading model… ${p.progress}%` : 'Rewriting…'));
            try {
              return await engine.rewrite(anonymized, settings.webllmId!, requestId);
            } finally {
              off();
            }
          },
        });

        if (result.action === 'clean') {
          // Remember placeholders (per the memory setting) so later messages and answers stay consistent.
          anonymize(text, result.spans, snapshot);
          await saveVault(site, snapshot.toJSON(), settings.memory);
          await insertText(opts.mode === 'field' ? selectAll(ctx) : ctx, result.text);
          return 'replaced';
        }
        if (result.action === 'original') {
          if (opts.mode === 'paste') await insertText(ctx, text);
          else refocus(ctx);
          return 'kept';
        }
        refocus(ctx);
        return 'cancelled';
      } catch (e) {
        clearTimeout(slow);
        panel.close();
        console.error('[Nobody]', e);
        toast('Nobody hit an error — nothing was changed');
        refocus(ctx);
        return 'cancelled';
      } finally {
        busy = false;
      }
    }

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
        void review(text, ctx);
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
      review: (ctx, text, spans, why) =>
        review(text, ctx, {
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
