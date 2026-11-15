import '@/lib/page.css';
import './style.css';
import { getRewriteModel, type VaultData } from '@nobody/engine';
import { h } from '@/lib/dom';
import { CHECK, CLOSED_EYE, icon, installPageTheme, LOGO, OPEN_EYE, SLIDERS } from '@/lib/brand';
import { clearDiag, readDiag } from '@/lib/diag';
import { engine } from '@/lib/messages';
import { clearVault, isSiteEnabled, loadSettings, loadVault, saveSettings, type Settings, type StyleMode } from '@/lib/settings';

installPageTheme();
const app = document.getElementById('app')!;

const VOICES: Array<[StyleMode, string, string]> = [
  ['off', 'Keep mine', 'Your wording stays as written. Only personal details are replaced.'],
  ['light', 'Light', 'Light rules remove the strongest habits: punctuation, fillers, slang and shorthand.'],
  ['ai', 'Full rewrite', 'A plain, everyday voice, checked sentence by sentence so no fact changes.'],
];

async function currentHost(): Promise<string | null> {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  try {
    const url = new URL(tab?.url ?? '');
    return url.protocol.startsWith('http') ? url.hostname : null;
  } catch {
    return null;
  }
}

/** Distinct details given a placeholder on this site (the vault keeps counters even when values are forgotten). */
const hiddenCount = (data: VaultData | null) => Object.values(data?.counters ?? {}).reduce((n, c) => n + (c ?? 0), 0);

function toggle(title: string, hint: string, checked: boolean, onChange: (v: boolean) => void, disabled = false): HTMLElement {
  const input = h('input', { attrs: { type: 'checkbox', 'aria-label': title } });
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  return h('div', { class: 'toggle' }, h('div', {}, h('strong', { text: title }), h('div', { class: 'quiet', text: hint })), h('label', { class: 'switch' }, input, h('span')));
}

const code = (text: string) => h('code', { text });

async function render() {
  const settings = await loadSettings();
  const host = await currentHost();
  const enabled = host ? isSiteEnabled(settings, host) : false;
  await browser.runtime.sendMessage({ type: 'hello' }).catch(() => {});
  const vaultData = host ? await loadVault(host, settings.memory) : null;
  const model = getRewriteModel(settings.styleTier);
  const [modelName = model.name] = model.name.split(' · ');
  const aiOk = settings.styleTier !== 'light' && Boolean(settings.webllmId);
  const others = Object.entries(settings.sites).filter(([site, on]) => on && site !== host).map(([site]) => site);

  const update = async (patch: Partial<Settings>) => {
    await saveSettings(patch);
    void render();
  };
  const openSettings = () => void browser.runtime.openOptionsPage();

  // --- The site's state: unseen (protected) or seen (exposed) ---
  let hero: HTMLElement;
  if (!host) {
    hero = h('section', { class: 'card hero' },
      h('div', { class: 'hero-row' }, h('div', { class: 'eye unseen' }, icon(CLOSED_EYE)),
        h('div', {}, h('h1', { text: 'Nothing to protect here' }), h('p', { class: 'quiet', text: 'Outis works on websites. Open a chat or a form to protect it.' }))));
  } else if (enabled) {
    const siteSwitch = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Protect this site' } });
    siteSwitch.checked = true;
    siteSwitch.disabled = settings.allSites;
    siteSwitch.addEventListener('change', () => void update({ sites: { ...settings.sites, [host]: siteSwitch.checked } }));
    hero = h('section', { class: 'card hero' },
      h('div', { class: 'hero-row' }, h('div', { class: 'eye unseen' }, icon(CLOSED_EYE)),
        h('div', {}, h('h1', { text: 'You pass unseen here' }),
          h('p', { class: 'quiet' }, settings.defaultStyle === 'off' ? 'Names and numbers are hidden before anything leaves ' : 'Names, numbers and your writing style are hidden before anything leaves ', code(host), '.'))),
      h('div', { class: 'hero-foot' },
        h('div', {}, h('strong', { text: 'Protect this site' }), settings.allSites ? h('div', { class: 'quiet small', text: 'Every website is protected. Change this in Settings.' }) : null),
        h('label', { class: 'switch' }, siteSwitch, h('span'))));
  } else {
    hero = h('section', { class: 'card hero' },
      h('div', { class: 'hero-row' }, h('div', { class: 'eye seen' }, icon(OPEN_EYE)),
        h('div', {}, h('h1', { text: 'This site can see you' }),
          h('p', { class: 'quiet' }, 'Outis is off on ', code(host), '. Anything you paste here is sent exactly as typed.'))),
      h('button', { class: 'btn primary wide', text: `Protect ${host}`, on: { click: () => void update({ sites: { ...settings.sites, [host]: true } }) } }));
  }

  const footer = h('footer', { class: 'foot' });
  const renderFooter = (state: 'light' | 'selected' | 'ready' | 'missing') => {
    const text = {
      light: 'Rewrites run on this device with Light rules.',
      selected: `Rewrites run on this device. ${modelName} model selected.`,
      ready: `Rewrites run on this device. ${modelName} model ready.`,
      missing: `${modelName} model not downloaded yet. Light rules are covering.`,
    }[state];
    footer.replaceChildren(h('span', { class: `dot${state === 'missing' ? ' bad' : ''}` }), h('span', { class: 'grow', text }),
      h('button', { class: 'btn text', text: 'Settings', on: { click: openSettings } }));
  };
  renderFooter(aiOk ? 'selected' : 'light');
  if (aiOk) {
    // Whether the chosen model is on this device; say plainly when Light rules cover for it.
    void engine.cached([settings.webllmId!]).then((c) => renderFooter(c[settings.webllmId!] ? 'ready' : 'missing')).catch(() => {});
  }

  const body: Array<HTMLElement | null> = [hero];
  if (host && enabled) {
    const hidden = hiddenCount(vaultData);
    const remembered = vaultData?.entries.length ?? 0;
    body.push(
      h('div', { class: 'stats' },
        h('div', {}, h('div', { class: 'num', text: String(hidden) }), h('div', { class: 'quiet', text: settings.memory === 'device' ? 'details hidden on this site' : 'details hidden this session' })),
        h('div', {}, h('div', { class: 'num', text: settings.allSites ? 'All' : String(Object.values(settings.sites).filter(Boolean).length) }), h('div', { class: 'quiet', text: settings.allSites ? 'websites protected' : 'sites protected' }))),
      remembered
        ? h('div', { class: 'strip' }, icon(CHECK, 'tick'),
            h('span', { class: 'grow', text: `${remembered} remembered ${settings.memory === 'device' ? 'on this device' : 'in memory only'}, so a placeholder means the same detail in every message.` }),
            h('button', { class: 'btn text remove', text: 'Forget now', on: { click: async () => { await clearVault(host); void render(); } } }))
        : null,
    );
    const seg = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': 'Writing voice' } });
    for (const [mode, label] of VOICES) {
      const b = h('button', { class: settings.defaultStyle === mode ? 'on' : '', text: label, attrs: { role: 'radio', 'aria-checked': String(settings.defaultStyle === mode) }, on: { click: () => void update({ defaultStyle: mode }) } });
      if (mode === 'ai' && !aiOk) {
        b.disabled = true;
        b.title = 'Pick a model in Settings first';
      }
      seg.append(b);
    }
    body.push(
      h('section', { class: 'voice' }, h('h2', { text: 'Writing voice' }), seg, h('p', { class: 'quiet', text: VOICES.find(([m]) => m === settings.defaultStyle)?.[2] ?? '' })),
      h('section', { class: 'toggles' },
        toggle('Check as I type', 'Underlines details before you send', settings.guardTyping, (v) => void update({ guardTyping: v })),
        toggle('One-press send', settings.autoSend ? 'Enter disguises first, then sends' : 'Enter disguises your text in place', settings.autoMode, (v) => void update({ autoMode: v })),
        toggle('Check attachments', 'Files become cleaned text copies you review first', settings.guardDocuments, (v) => void update({ guardDocuments: v }))),
    );
  } else if (host) {
    body.push(
      h('p', { class: 'hint quiet' }, 'Just one message? Click into any text box and press ', h('kbd', { text: 'Alt' }), ' ', h('kbd', { text: 'Shift' }), ' ', h('kbd', { text: 'N' }), ' to check it.'),
      others.length
        ? h('div', { class: 'strip' }, icon(CLOSED_EYE, 'lash'),
            h('span', { text: `You pass unseen on ${others.length} other ${others.length === 1 ? 'site' : 'sites'}, including ${others.slice(0, 2).join(' and ')}.` }))
        : null,
    );
  }

  app.replaceChildren(
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, icon(LOGO), h('span', { class: 'wordmark', text: 'OUTIS' })),
      h('button', { class: 'icon-btn', title: 'Settings', attrs: { 'aria-label': 'Settings' }, on: { click: openSettings } }, icon(SLIDERS))),
    ...body.filter((el): el is HTMLElement => el !== null),
    footer,
    h('details', { class: 'diag' },
      h('summary', { class: 'quiet small', text: 'Diagnostics' }),
      h('div', { class: 'diag-row' },
        h('span', { class: 'quiet small', text: `Build ${__NOBODY_BUILD__}` }),
        h('button', { class: 'btn sm', text: 'Copy diagnostics', title: 'Steps, editor type and text lengths only, never your text', on: { click: async (e) => {
          const entries = await readDiag();
          const lines = [`Outis build ${__NOBODY_BUILD__} · ${navigator.userAgent}`, ...entries.map((d) => JSON.stringify(d))];
          await navigator.clipboard.writeText(lines.join('\n'));
          (e.target as HTMLButtonElement).textContent = `Copied ${entries.length} lines`;
        } } }),
        h('button', { class: 'btn sm', text: 'Clear', on: { click: async (e) => { await clearDiag(); (e.target as HTMLButtonElement).textContent = 'Cleared'; } } }))),
  );
}

void render();
