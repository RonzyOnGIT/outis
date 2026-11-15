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

  browser.commands.onCommand.addListener((command, tab) => {
    if (command === 'scrub-field' && tab?.id != null) {
      browser.tabs.sendMessage(tab.id, { type: 'scrubField' }).catch(() => {});
    }
  });
});

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
