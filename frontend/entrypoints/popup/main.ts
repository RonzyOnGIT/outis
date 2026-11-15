import '@/lib/page.css';
import './style.css';
import { getRewriteModel, Vault } from '@nobody/engine';
import { h } from '@/lib/dom';
import { clearDiag, readDiag } from '@/lib/diag';
import { clearVault, isSiteEnabled, loadSettings, loadVault, saveSettings, type Settings, type StyleMode } from '@/lib/settings';

const MEMORY_NOTE: Record<Settings['memory'], string> = {
  session: 'in memory only, cleared when the browser closes',
  none: 'forgotten right after each replacement',
  device: 'saved on this device',
};

const app = document.getElementById('app')!;

async function currentHost(): Promise<string | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url ?? '');
    return url.protocol.startsWith('http') ? url.hostname : null;
  } catch {
    return null;
  }
}

async function render() {
  const settings = await loadSettings();
  const host = await currentHost();
  const enabled = host ? isSiteEnabled(settings, host) : false;
  await browser.runtime.sendMessage({ type: 'hello' }).catch(() => {});
  const vault = host ? new Vault(await loadVault(host, settings.memory)) : null;
  const model = getRewriteModel(settings.styleTier);
  const aiOk = settings.styleTier !== 'light' && Boolean(settings.webllmId);

  const update = async (patch: Partial<Settings>) => {
    await saveSettings(patch);
    void render();
  };

  const siteSwitch = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Protect this site' } });
  siteSwitch.checked = enabled;
  siteSwitch.disabled = !host || settings.allSites;
  siteSwitch.addEventListener('change', () => {
    if (host) void update({ sites: { ...settings.sites, [host]: siteSwitch.checked } });
  });

  const typingSwitch = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Check what I type' } });
  typingSwitch.checked = settings.guardTyping;
  typingSwitch.addEventListener('change', () => void update({ guardTyping: typingSwitch.checked }));

  const seg = h('div', { class: 'seg' });
  for (const [mode, label] of [['off', 'Off'], ['light', 'Light'], ['ai', 'AI']] as Array<[StyleMode, string]>) {
    const b = h('button', { class: settings.defaultStyle === mode ? 'on' : '', text: label, on: { click: () => void update({ defaultStyle: mode }) } });
    if (mode === 'ai' && !aiOk) {
      b.disabled = true;
      b.title = 'Pick a model in settings first';
    }
    seg.append(b);
  }

  app.replaceChildren(
    h(
      'header',
      {},
      h('div', { class: 'logo' }),
      h('div', {}, h('strong', { text: 'Nobody' }), h('div', { class: 'muted small', text: 'Private paste · 100% on-device' })),
    ),
    h(
      'div',
      { class: `status ${enabled ? 'on' : 'off'}` },
      h('span', { class: 'dot' }),
      h('span', { text: host ? (enabled ? `Protecting ${host}` : `Not active on ${host}`) : 'Not available on this page' }),
      h('label', { class: 'switch' }, siteSwitch, h('span')),
    ),
    h('div', { class: 'item' }, h('span', { text: 'Writing style on paste' }), seg),
    h('div', { class: 'item' }, h('span', { text: 'Check what I type' }), h('label', { class: 'switch' }, typingSwitch, h('span'))),
    h(
      'div',
      { class: 'item' },
      h('div', {}, h('div', { text: 'Model' }), h('div', { class: 'muted small', text: model.name })),
      h('button', { class: 'btn sm', text: 'Change', on: { click: () => void browser.runtime.openOptionsPage() } }),
    ),
    host
      ? h(
          'div',
          { class: 'item' },
          h('div', {}, h('div', { text: 'Remembered placeholders' }), h('div', { class: 'muted small', text: `${vault?.size ?? 0} on this site · ${MEMORY_NOTE[settings.memory]}` })),
          h('button', {
            class: 'btn sm',
            text: 'Forget',
            on: {
              click: async () => {
                await clearVault(host);
                void render();
              },
            },
          }),
        )
      : '',
    h('button', { class: 'btn primary wide', text: 'Settings & playground', on: { click: () => void browser.runtime.openOptionsPage() } }),
    h('p', { class: 'muted small tip', text: 'Tip: press Alt+Shift+N in any text box to anonymize what you typed.' }),
    h(
      'div',
      { class: 'diag' },
      h('span', { class: 'muted small', text: `Build ${__NOBODY_BUILD__}` }),
      h('button', {
        class: 'btn sm',
        text: 'Copy diagnostics',
        title: 'Steps, editor type and text lengths only — never your text',
        on: {
          click: async (e) => {
            const entries = await readDiag();
            const lines = [`Nobody build ${__NOBODY_BUILD__} · ${navigator.userAgent}`, ...entries.map((d) => JSON.stringify(d))];
            await navigator.clipboard.writeText(lines.join('\n'));
            (e.target as HTMLButtonElement).textContent = `Copied ${entries.length} lines ✓`;
          },
        },
      }),
      h('button', { class: 'btn sm', text: 'Clear', on: { click: async (e) => { await clearDiag(); (e.target as HTMLButtonElement).textContent = 'Cleared'; } } }),
    ),
  );
}

void render();
