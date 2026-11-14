import { DEFAULT_POLICY, type CategoryPolicy, type DictionaryEntry, type StyleTier, type VaultData } from '@nobody/engine';

export type StyleMode = 'off' | 'light' | 'ai';

/**
 * How long the real-value ⇄ placeholder mapping is kept.
 * - none:    forgotten right after replacing (only placeholder counters are kept, so numbers don't collide)
 * - session: kept in memory only (chrome.storage.session — never written to disk), gone when the browser closes
 * - device:  saved on this device until you press "Forget"
 */
export type Memory = 'none' | 'session' | 'device';

export interface Settings {
  setupDone: boolean;
  /** Which rewrite model the user picked ("light" = no AI). */
  styleTier: StyleTier;
  /** Exact WebLLM build for this device (f16 or f32 variant). */
  webllmId: string | null;
  /** Default style mode in the review panel. */
  defaultStyle: StyleMode;
  policy: CategoryPolicy;
  alwaysHide: DictionaryEntry[];
  neverHide: string[];
  sites: Record<string, boolean>;
  allSites: boolean;
  /** Pastes shorter than this are let through untouched. */
  minPasteChars: number;
  /** How placeholders in AI answers are shown back to you (see content/restore.ts). */
  restoreMode: 'off' | 'hover' | 'replace';
  /** Check text while typing and stop sending while personal info is in the box. */
  guardTyping: boolean;
  memory: Memory;
}

/** Sites where Enter sends the message (elsewhere Enter is a newline and is never intercepted). */
export const ENTER_SENDS_SITES = new Set([
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'gemini.google.com',
  'copilot.microsoft.com',
  'www.perplexity.ai',
  'chat.deepseek.com',
  'chat.mistral.ai',
]);

/** AI chat sites — where Nobody is on by default. More sites can be added in settings. */
export const DEFAULT_SITES = [
  'chatgpt.com',
  'chat.openai.com',
  'claude.ai',
  'gemini.google.com',
  'copilot.microsoft.com',
  'www.perplexity.ai',
  'chat.deepseek.com',
  'chat.mistral.ai',
];

export const DEFAULT_NEVER_HIDE = [
  'ChatGPT', 'OpenAI', 'Claude', 'Anthropic', 'Gemini', 'Copilot', 'Google', 'Microsoft', 'Apple', 'Amazon',
  'GitHub', 'GitLab', 'Jira', 'Slack', 'Zoom', 'Teams', 'Excel', 'Word', 'PowerPoint', 'Outlook', 'Gmail',
  'Python', 'JavaScript', 'TypeScript', 'Java', 'React', 'Node', 'Linux', 'Windows', 'macOS', 'iOS', 'Android',
  'AWS', 'Azure', 'Docker', 'Kubernetes', 'Chrome', 'Firefox', 'Safari', 'iPhone', 'SQL', 'API',
];

export const DEFAULT_SETTINGS: Settings = {
  setupDone: false,
  styleTier: 'light',
  webllmId: null,
  defaultStyle: 'light',
  policy: { ...DEFAULT_POLICY },
  alwaysHide: [],
  neverHide: DEFAULT_NEVER_HIDE,
  sites: Object.fromEntries(DEFAULT_SITES.map((s) => [s, true])),
  allSites: false,
  minPasteChars: 12,
  restoreMode: 'hover',
  guardTyping: true,
  memory: 'session',
};

const KEY = 'settings';

export async function loadSettings(): Promise<Settings> {
  const raw = (await browser.storage.local.get(KEY))[KEY] as Partial<Settings> | undefined;
  return { ...DEFAULT_SETTINGS, ...raw, policy: { ...DEFAULT_SETTINGS.policy, ...raw?.policy } };
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  const next = { ...(await loadSettings()), ...patch };
  await browser.storage.local.set({ [KEY]: next });
  return next;
}

export function onSettingsChanged(cb: (s: Settings) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[KEY]) void loadSettings().then(cb);
  });
}

export function isSiteEnabled(s: Settings, host: string): boolean {
  return s.allSites || s.sites[host] === true;
}

// --- Placeholder vaults: one per website, so [PERSON_1] stays consistent across a site's chats. ---

const VAULT_PREFIX = 'vault:';
const vaultKey = (scope: string) => `${VAULT_PREFIX}${scope}`;
const areaFor = (memory: Memory) => (memory === 'device' ? browser.storage.local : browser.storage.session);

export async function loadVault(scope: string, memory: Memory): Promise<VaultData | null> {
  try {
    return ((await areaFor(memory).get(vaultKey(scope)))[vaultKey(scope)] as VaultData | undefined) ?? null;
  } catch {
    return null; // session storage not yet opened to content scripts — start empty
  }
}

export async function saveVault(scope: string, data: VaultData, memory: Memory): Promise<void> {
  // "Forget right away": keep only the counters (no real values) so new placeholders don't reuse numbers.
  const toSave: VaultData = memory === 'none' ? { ...data, entries: [] } : data;
  try {
    await areaFor(memory).set({ [vaultKey(scope)]: toSave });
  } catch (e) {
    console.warn('[Nobody] could not save placeholder memory', e);
  }
}

export async function clearVault(scope: string): Promise<void> {
  await Promise.allSettled([browser.storage.local.remove(vaultKey(scope)), browser.storage.session.remove(vaultKey(scope))]);
}

/** Delete every mapping saved on disk (used when memory is not "device"). */
export async function purgeDeviceVaults(): Promise<void> {
  const all = await browser.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(VAULT_PREFIX));
  if (keys.length) await browser.storage.local.remove(keys);
}

/** Forget everything everywhere (popup / settings button). */
export async function forgetEverything(): Promise<void> {
  await purgeDeviceVaults();
  const all = await browser.storage.session.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(VAULT_PREFIX));
  if (keys.length) await browser.storage.session.remove(keys);
}

export function onVaultChanged(scope: string, cb: (v: VaultData | null) => void): void {
  browser.storage.onChanged.addListener((changes, area) => {
    const c = changes[vaultKey(scope)];
    if ((area === 'local' || area === 'session') && c) cb((c.newValue as VaultData | undefined) ?? null);
  });
}
