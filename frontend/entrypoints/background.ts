import { loadSettings, onSettingsChanged, purgeDeviceVaults } from '@/lib/settings';

/**
 * Background service worker: tiny router.
 * - opens the setup page on install
 * - creates the offscreen document that hosts the models
 * - forwards model progress events to the tab that asked
 * - routes the keyboard shortcut to the active tab
 * - enforces the "memory" setting (nothing on disk unless the user chose "device")
 */

let sessionAccess: Promise<void> = Promise.resolve();

async function enforceMemory() {
  const s = await loadSettings();
  if (s.memory !== 'device') await purgeDeviceVaults();
}

export default defineBackground(() => {
  // Content scripts may use chrome.storage.session (RAM-only, never on disk) for placeholder memory.
  sessionAccess = browser.storage.session
    .setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' as Browser.storage.AccessLevel })
    .catch(() => {});
  void enforceMemory();
  onSettingsChanged(() => void enforceMemory());

  browser.runtime.onInstalled.addListener(({ reason }) => {
    if (reason === 'install') void browser.runtime.openOptionsPage();
    // Chrome doesn't add content scripts to tabs that are already open, and an update cuts the old
    // ones off. Inject the fresh script into every open web page so protection continues without
    // the user reloading tabs (the disconnected old copy switches itself off).
    void injectIntoOpenTabs();
  });

  browser.runtime.onMessage.addListener((msg: any, _sender, sendResponse) => {
    if (msg?.type === 'hello') {
      sessionAccess.then(() => sendResponse(true));
      return true;
    }
    if (msg?.type === 'ensureOffscreen') {
      ensureOffscreen().then(
        () => sendResponse(true),
        (e) => sendResponse({ error: String(e) }),
      );
      return true;
    }
    if (msg?.type === 'progress' && typeof msg.tabId === 'number') {
      browser.tabs.sendMessage(msg.tabId, msg).catch(() => {});
    }
    if (msg?.type === 'openOptions') void browser.runtime.openOptionsPage();
    return undefined;
  });

  // Editor edits through the page's own API. A dedicated port, so no other extension page can
  // answer in its place (one-off messages go to every extension page).
  browser.runtime.onConnect.addListener((port) => {
    if (port.name !== 'nobody-edit') return;
    port.onMessage.addListener((msg: any) => {
      const tabId = port.sender?.tab?.id;
      if (tabId == null) return port.postMessage({ ok: false, why: 'no tab' });
      browser.scripting
        .executeScript({
          target: { tabId, frameIds: [port.sender?.frameId ?? 0] },
          world: 'MAIN',
          func: mainWorldEdit,
          args: [msg.marker, msg.action, msg.text ?? ''],
        })
        .then(
          (res) => port.postMessage(res?.[0]?.result ?? { ok: false, why: 'no result' }),
          (e) => port.postMessage({ ok: false, why: String(e).slice(0, 200) }),
        );
    });
  });

  browser.commands.onCommand.addListener((command, tab) => {
    if (command === 'scrub-field' && tab?.id != null) {
      browser.tabs.sendMessage(tab.id, { type: 'scrubField' }).catch(() => {});
    }
  });
});

/**
 * Runs INSIDE the page (main world), where the chat app's own editor object lives. Rich editors
 * keep their own document model; changing it through their API is the only way that can't
 * end up appending. Supports Tiptap (Claude and many others): the editor is on `element.editor`.
 * Must be self-contained — it is serialized and executed in the page.
 */
function mainWorldEdit(marker: string, action: 'replace' | 'clear' | 'insert', text: string) {
  const el = document.querySelector(`[data-nobody-target="${marker}"]`) as (HTMLElement & { editor?: any }) | null;
  if (!el) return { ok: false, why: 'element not found' };
  let ed: any = null;
  for (let n: any = el; n && !ed; n = n.parentElement) if (n.editor?.commands) ed = n.editor;
  if (!ed) return { ok: false, why: 'no editor API' };
  const lines = String(text).split('\n');
  const paragraphs = lines.map((l) => ({ type: 'paragraph', content: l ? [{ type: 'text', text: l }] : [] }));
  try {
    if (action === 'replace') ed.commands.setContent({ type: 'doc', content: paragraphs }, { emitUpdate: true });
    else if (action === 'clear') ed.commands.clearContent(true);
    else if (text) ed.commands.insertContent(lines.length > 1 ? paragraphs : { type: 'text', text });
    ed.commands.focus('end');
    return { ok: true, method: 'tiptap', chars: String(ed.getText?.() ?? '').length };
  } catch (e) {
    return { ok: false, why: String(e).slice(0, 200) };
  }
}

async function injectIntoOpenTabs(): Promise<void> {
  const files = (browser.runtime.getManifest().content_scripts ?? []).flatMap((c) => c.js ?? []);
  if (!files.length) return;
  const tabs = await browser.tabs.query({});
  await Promise.allSettled(
    tabs
      .filter((t) => t.id != null && /^https?:/.test(t.url ?? 'https:'))
      .map((t) => browser.scripting.executeScript({ target: { tabId: t.id! }, files: files as never })),
  );
}

let creating: Promise<void> | null = null;

async function ensureOffscreen(): Promise<void> {
  const url = browser.runtime.getURL('/offscreen.html');
  const contexts = await browser.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as Browser.runtime.ContextType],
    documentUrls: [url],
  });
  if (contexts.length > 0) return;
  creating ??= browser.offscreen
    .createDocument({
      url,
      reasons: ['WORKERS' as Browser.offscreen.Reason],
      justification: 'Runs the local name-detection and rewrite models so no text ever leaves the device.',
    })
    .finally(() => {
      creating = null;
    });
  await creating;
}
