import '@/lib/page.css';
import './style.css';
import {
  anonymize,
  findPlaceholders,
  NER_MODEL,
  neutralizeLight,
  probeDevice,
  rateModels,
  restore,
  Vault,
  type DeviceProbe,
  type EntityType,
  type ModelFit,
  type VaultData,
} from '@nobody/engine';
import { h } from '@/lib/dom';
import { chipName, CROSS, icon, installPageTheme, LOGO } from '@/lib/brand';
import { engine, newRequestId, onProgress } from '@/lib/messages';
import { forgetEverything, loadSettings, loadVault, saveSettings, saveVault, type Memory, type Settings, type StyleMode } from '@/lib/settings';

installPageTheme();
const app = document.getElementById('app')!;
let settings: Settings;
let probe: DeviceProbe;
let fits: ModelFit[];
let cached: Record<string, boolean> = {};
const speeds: Record<string, { text: string; bad?: boolean }> = {};
let busyModel: string | null = null;
let busyProgress = { pct: 0, text: 'Starting…' };
let selectedTier: string;
let ner: { state: 'loading' | 'ready' | 'failed'; pct: number; text: string } = { state: 'loading', pct: 0, text: 'Preparing…' };

const EXAMPLE = `hey!! so my manager Jenna Okafor wants the Q3 report by friday but its not done lol. can u help me write her an email? reach me at marcus.bell@example.com or (469) 555-0182`;

const VOICES: Array<[StyleMode, string, string]> = [
  ['off', 'Keep mine', 'Your wording stays as written. Only personal details are replaced.'],
  ['light', 'Light', 'Light rules remove the strongest habits (punctuation, fillers, slang, shorthand) instantly, without changing facts.'],
  ['ai', 'Full rewrite', 'A plain, everyday voice that everyone using Outis shares, written by the model on this computer and checked sentence by sentence.'],
];

const FIT_TEXT: Record<ModelFit['fit'], string> = {
  recommended: 'Recommended for this computer.',
  good: 'Should run well here.',
  heavy: 'May be slow on this computer.',
  'too-big': 'Probably too big for this computer.',
  unsupported: 'Needs in-browser AI (WebGPU), which this browser does not offer.',
};

async function main() {
  settings = await loadSettings();
  selectedTier = settings.styleTier;
  app.replaceChildren(h('div', { class: 'loading quiet', text: 'Checking this computer…' }));
  probe = await probeDevice();
  fits = rateModels(probe);
  render();
  void refreshCached();
  void prepareNer();
}

async function refreshCached() {
  const ids = fits.map((f) => f.webllmId).filter((x): x is string => Boolean(x));
  try {
    cached = await engine.cached(ids);
  } catch {
    cached = {};
  }
  renderModels();
  renderStatus();
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

const statusLine = h('div', { class: 'status' });
const modelsBox = h('div', { class: 'models' });
const aboutBox = h('details', { class: 'about' });
const voiceBox = h('section', { class: 'section' });
const sendBox = h('section', { class: 'section' });
const memoryBox = h('section', { class: 'section' });

function section(title: string, intro: string | null, ...body: Array<Node | null>): HTMLElement {
  return h('section', { class: 'section' }, h('h2', { text: title }), intro ? h('p', { class: 'intro quiet', text: intro }) : null, ...body);
}

function render() {
  app.replaceChildren(
    h('header', { class: 'top' },
      h('div', {},
        h('div', { class: 'brand' }, icon(LOGO), h('span', { class: 'wordmark', text: 'OUTIS' })),
        h('p', { class: 'quiet lead', text: 'Hides your personal details and the way you write before a message leaves the page. Everything happens on this computer.' })),
      statusLine),
    h('div', { class: 'layout' },
      h('div', { class: 'main' },
        section('What to hide', 'Your own details leak most often. Add them once and they are always caught, however they are written.', hideView()),
        voiceBox, sendBox, sitesView(), memoryBox,
        section('Model and this computer', 'The rewrite runs here, never on a server. Pick speed or quality. If a model can’t run, Light rules take over automatically.', modelsBox, aboutBox),
        h('footer', { class: 'done' },
          h('span', { class: 'quiet small', text: 'Settings save automatically.' }),
          h('button', { class: 'btn primary', text: 'Done', on: { click: async () => { await saveSettings({ setupDone: true }); window.close(); } } }))),
      h('aside', { class: 'side' }, playground())),
  );
  renderVoice();
  renderSend();
  void renderMemory();
  renderModels();
  renderStatus();
}

function renderStatus() {
  const sites = Object.values(settings.sites).filter(Boolean).length;
  const model = fits?.find((f) => f.model.tier === settings.styleTier);
  const name = model ? model.model.name.split(' · ')[0] : '';
  const ready = settings.styleTier === 'light' ? 'Light rules ready.' : settings.webllmId && cached[settings.webllmId] ? `${name} model ready.` : `${name} model not downloaded yet.`;
  const nerText = ner.state === 'ready' ? '' : ner.state === 'failed' ? ' Name detector unavailable.' : ` Name detector ${ner.pct ? `downloading, ${ner.pct}%` : 'loading'}.`;
  const bad = ner.state === 'failed' || (settings.styleTier !== 'light' && !(settings.webllmId && cached[settings.webllmId]));
  statusLine.replaceChildren(h('span', { class: `dot${bad ? ' bad' : ''}` }),
    `${settings.allSites ? 'Protecting every website' : `Protecting ${sites} ${sites === 1 ? 'site' : 'sites'}`}. ${ready}${nerText}`);
}

// ---------------------------------------------------------------------------------------------
// What to hide
// ---------------------------------------------------------------------------------------------

/** Editable list of words as removable tags, with an add field. */
function tagList(label: string, values: string[], placeholder: string, onChange: (values: string[]) => void): HTMLElement {
  const list = h('div', { class: 'tags' });
  const input = h('input', { class: 'add', attrs: { placeholder, spellcheck: 'false', 'aria-label': `${label}: add` } });
  const draw = () => {
    list.replaceChildren(...values.map((value, i) => h('span', { class: 'tag' }, value,
      h('button', { class: 'x', title: `Remove ${value}`, attrs: { 'aria-label': `Remove ${value}` }, on: { click: () => {
        values = values.filter((_, k) => k !== i);
        onChange(values);
        draw();
      } } }, icon(CROSS)))));
    list.append(input);
  };
  const add = () => {
    const fresh = input.value.split(/[\n,;]/).map((v) => v.trim()).filter((v) => v && !values.some((x) => x.toLowerCase() === v.toLowerCase()));
    input.value = '';
    if (!fresh.length) return;
    values = [...values, ...fresh];
    onChange(values);
    draw();
    input.focus();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); add(); }
    else if (e.key === 'Backspace' && !input.value && values.length) {
      values = values.slice(0, -1);
      onChange(values);
      draw();
      input.focus();
    }
  });
  input.addEventListener('blur', add);
  draw();
  return h('div', { class: 'field' }, h('div', { class: 'label', text: label }), list);
}

const GROUPS: Array<[string, EntityType[], string?]> = [
  ['Names', ['PERSON']],
  ['Workplaces and organizations', ['ORG']],
  ['Addresses and places', ['ADDRESS', 'LOCATION']],
  ['Emails and phone numbers', ['EMAIL', 'PHONE']],
  ['Card and bank numbers', ['CARD', 'IBAN']],
  ['ID numbers and usernames', ['ID', 'USER']],
  ['Passwords, keys and tokens', ['SECRET']],
  ['IP addresses', ['IP']],
  ['Personal dates', ['DATE'], 'Birth, medical and expiry dates. Deadlines stay.'],
  ['Every link', ['URL'], 'Links with personal details inside are always hidden.'],
];

function hideView(): HTMLElement {
  const people = settings.alwaysHide.filter((e) => e.type === 'PERSON').map((e) => e.value);
  const words = settings.alwaysHide.filter((e) => e.type !== 'PERSON').map((e) => e.value);
  const save = async () => {
    settings = await saveSettings({ alwaysHide: [...people.map((value) => ({ value, type: 'PERSON' as const })), ...words.map((value) => ({ value, type: 'ORG' as const }))] });
  };
  const checks = h('div', { class: 'checks' });
  for (const [label, types, hint] of GROUPS) {
    const box = h('input', { attrs: { type: 'checkbox' } });
    const on = types.filter((t) => settings.policy[t]).length;
    box.checked = on === types.length;
    box.indeterminate = on > 0 && on < types.length;
    box.addEventListener('change', async () => {
      settings = await saveSettings({ policy: { ...settings.policy, ...Object.fromEntries(types.map((t) => [t, box.checked])) } });
    });
    checks.append(h('label', { class: 'check' }, box, h('span', {}, label, hint ? h('span', { class: 'quiet small block', text: hint }) : null)));
  }
  return h('div', { class: 'hide' },
    tagList('People', people, 'Add a name, a family member, a colleague', (v) => { people.splice(0, people.length, ...v); void save(); }),
    tagList('Places, companies and projects', words, 'Add a word', (v) => { words.splice(0, words.length, ...v); void save(); }),
    tagList('Never hide', [...settings.neverHide], 'Add a word to always keep', async (v) => { settings = await saveSettings({ neverHide: v }); }),
    h('fieldset', { class: 'auto' }, h('legend', { text: 'Find automatically' }), checks,
      h('p', { class: 'quiet small', text: 'Context counts: birth, medical and expiry dates are hidden while deadlines stay; a company or city you merely mention stays, your employer or home does not. Your lists above override these checks.' })),
  );
}

// ---------------------------------------------------------------------------------------------
// Writing voice and sending
// ---------------------------------------------------------------------------------------------

function renderVoice() {
  const aiOk = settings.styleTier !== 'light' && Boolean(settings.webllmId);
  const seg = h('div', { class: 'seg', attrs: { role: 'radiogroup', 'aria-label': 'Writing voice' } });
  for (const [mode, label] of VOICES) {
    const b = h('button', { class: settings.defaultStyle === mode ? 'on' : '', text: label, attrs: { role: 'radio', 'aria-checked': String(settings.defaultStyle === mode) },
      on: { click: async () => { settings = await saveSettings({ defaultStyle: mode }); renderVoice(); renderStatus(); } } });
    if (mode === 'ai' && !aiOk) { b.disabled = true; b.title = 'Download a model below first'; }
    seg.append(b);
  }
  const radio = (value: Settings['aiCoverage'], title: string, hint: string) => {
    const input = h('input', { attrs: { type: 'radio', name: 'coverage', value } });
    input.checked = settings.aiCoverage === value;
    input.addEventListener('change', async () => { settings = await saveSettings({ aiCoverage: value }); });
    return h('label', { class: 'radio' }, input, h('span', {}, h('strong', { text: title }), h('span', { class: 'quiet small block', text: hint })));
  };
  voiceBox.replaceChildren(
    h('h2', { text: 'Your writing voice' }),
    h('p', { class: 'intro quiet', text: 'Punctuation, pet phrases and sentence rhythm can identify you even without your name. Outis rewrites them into a plain voice that everyone using it shares.' }),
    h('div', { class: 'seg-wrap' }, seg),
    h('p', { class: 'quiet small', text: VOICES.find(([m]) => m === settings.defaultStyle)![2] + (aiOk ? '' : ' Full rewrite needs a model: pick one under Model and this computer.') }),
    h('div', { class: 'label', text: 'Which sentences' }),
    h('div', { class: 'radios' },
      radio('all', 'Every sentence', 'Most neutral. A little slower.'),
      radio('auto', 'Only where the rules can’t finish', 'Much faster. Short, clean messages pass through unchanged.')),
  );
}

function switchRow(title: string, hint: string, checked: boolean, onChange: (v: boolean) => void, disabled = false): HTMLElement {
  const input = h('input', { attrs: { type: 'checkbox', 'aria-label': title } });
  input.checked = checked;
  input.disabled = disabled;
  input.addEventListener('change', () => onChange(input.checked));
  return h('div', { class: 'toggle' }, h('div', {}, h('strong', { text: title }), h('div', { class: 'quiet', text: hint })), h('label', { class: 'switch' }, input, h('span')));
}

function renderSend() {
  sendBox.replaceChildren(
    h('h2', { text: 'When you send' }),
    h('div', { class: 'toggles' },
      switchRow('Check as I type', 'Details are underlined as you write, and sending waits until you have reviewed them. Alt+Shift+N checks any box on demand.', settings.guardTyping,
        async (v) => { settings = await saveSettings({ guardTyping: v }); }),
      switchRow('One-press send', settings.autoMode ? 'Press Enter once: your text is disguised in place. Esc puts your original back.' : 'Off: a review panel shows what will be hidden and asks first.', settings.autoMode,
        async (v) => { settings = await saveSettings({ autoMode: v }); renderSend(); }),
      switchRow('Send when ready', settings.autoMode ? 'Skip the last Enter. Leave off to glance at the disguised text first.' : 'Needs One-press send.', settings.autoSend,
        async (v) => { settings = await saveSettings({ autoSend: v }); }, !settings.autoMode),
      switchRow('Check attachments', 'Files you attach become cleaned text copies you review first: PDF, Word, Excel, PowerPoint, OpenDocument, RTF and text files, up to 10 MB each. Originals are held back.', settings.guardDocuments,
        async (v) => { settings = await saveSettings({ guardDocuments: v }); })),
  );
}

// ---------------------------------------------------------------------------------------------
// Sites and memory
// ---------------------------------------------------------------------------------------------

function sitesView(): HTMLElement {
  const list = h('div', { class: 'sites' });
  const draw = () => {
    list.replaceChildren(...Object.entries(settings.sites).sort(([a], [b]) => a.localeCompare(b)).map(([site, on]) => {
      const input = h('input', { attrs: { type: 'checkbox', 'aria-label': `Protect ${site}` } });
      input.checked = on;
      input.addEventListener('change', async () => { settings = await saveSettings({ sites: { ...settings.sites, [site]: input.checked } }); renderStatus(); });
      return h('div', { class: 'site' }, h('code', { text: site }), h('label', { class: 'switch' }, input, h('span')));
    }));
  };
  draw();
  const add = h('input', { class: 'text-input', attrs: { placeholder: 'Add a site, such as jira.yourcompany.com', spellcheck: 'false' } });
  const addSite = async () => {
    const v = add.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (!v) return;
    settings = await saveSettings({ sites: { ...settings.sites, [v]: true } });
    add.value = '';
    draw();
    renderStatus();
  };
  add.addEventListener('keydown', (e) => e.key === 'Enter' && void addSite());
  return section('Sites', null,
    switchRow('Protect every website', 'Otherwise only the sites below.', settings.allSites, async (v) => { settings = await saveSettings({ allSites: v }); renderStatus(); }),
    list,
    h('div', { class: 'add-row' }, add, h('button', { class: 'btn primary', text: 'Add', on: { click: () => void addSite() } })));
}

async function rememberedCount(): Promise<number> {
  let n = 0;
  for (const area of [browser.storage.session, browser.storage.local]) {
    try {
      const all = await area.get(null);
      for (const [key, value] of Object.entries(all)) if (key.startsWith('vault:') && key !== 'vault:playground') n += (value as VaultData | undefined)?.entries?.length ?? 0;
    } catch { /* storage area unavailable */ }
  }
  return n;
}

async function renderMemory() {
  const count = await rememberedCount();
  const where: Record<Memory, string> = {
    session: 'They live in memory only, so a placeholder like ',
    device: 'They are saved on this computer, so a placeholder like ',
    none: 'Real values are forgotten right after each replacement, so a placeholder like ',
  };
  const after: Record<Memory, string> = {
    session: ' means the same person across messages. They disappear when the browser closes.',
    device: ' means the same person across messages, until you forget them.',
    none: ' cannot be shown back in answers.',
  };
  const radio = (name: string, value: string, current: string, title: string, onPick: () => void) => {
    const input = h('input', { attrs: { type: 'radio', name, value } });
    input.checked = current === value;
    input.addEventListener('change', onPick);
    return h('label', { class: 'radio' }, input, h('span', { text: title }));
  };
  const forget = h('button', { class: 'btn remove', text: 'Forget now', on: { click: async () => {
    await forgetEverything();
    forget.textContent = 'Forgotten';
    void renderMemory();
  } } });
  memoryBox.replaceChildren(
    h('h2', { text: 'Memory' }),
    h('div', { class: 'card memory' },
      h('p', {}, h('strong', { text: `${count} ${count === 1 ? 'detail' : 'details'} remembered. ` }), where[settings.memory], h('span', { class: 'chip', text: 'Person 1' }), after[settings.memory]),
      forget),
    h('div', { class: 'label', text: 'Keep real details' }),
    h('div', { class: 'radios' },
      radio('memory', 'session', settings.memory, 'Until the browser closes (memory only)', async () => { settings = await saveSettings({ memory: 'session' }); void renderMemory(); }),
      radio('memory', 'none', settings.memory, 'Forget right after each replacement', async () => { settings = await saveSettings({ memory: 'none' }); void renderMemory(); }),
      radio('memory', 'device', settings.memory, 'Remember on this computer until I forget them', async () => { settings = await saveSettings({ memory: 'device' }); void renderMemory(); })),
    h('div', { class: 'label', text: 'Real details in AI answers' }),
    h('div', { class: 'radios' },
      radio('restore', 'hover', settings.restoreMode, 'Show when I hover (safest for screen sharing)', async () => { settings = await saveSettings({ restoreMode: 'hover' }); }),
      radio('restore', 'replace', settings.restoreMode, 'Always show them in the page (scripts on the site could read them)', async () => { settings = await saveSettings({ restoreMode: 'replace' }); }),
      radio('restore', 'off', settings.restoreMode, 'Never show them', async () => { settings = await saveSettings({ restoreMode: 'off' }); })),
  );
}

// ---------------------------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------------------------

async function prepareNer() {
  ner = { state: 'loading', pct: 0, text: 'Preparing…' };
  renderAbout();
  const requestId = newRequestId();
  const off = onProgress(requestId, (p) => {
    ner = { state: 'loading', pct: p.progress, text: p.text };
    renderAbout();
    renderStatus();
  });
  try {
    await engine.initNer(requestId);
    ner = { state: 'ready', pct: 100, text: '' };
  } catch (e) {
    ner = { state: 'failed', pct: 0, text: e instanceof Error ? e.message : String(e) };
    aboutBox.open = true;
  } finally {
    off();
    renderAbout();
    renderStatus();
  }
}

function renderAbout() {
  if (!probe) return;
  const gpu = probe.description || [probe.vendor, probe.architecture].filter(Boolean).join(' ');
  const kind = { apple: 'Apple Silicon with shared memory', discrete: 'Dedicated graphics', integrated: 'Integrated graphics', none: 'No usable graphics processor' }[probe.gpuClass];
  const facts = [
    `${kind}${gpu ? ` (${gpu})` : ''}, ${probe.cores ?? '?'} cores${probe.ramGB ? `, ${probe.ramGB >= 8 ? '8 GB or more' : `${probe.ramGB} GB`} memory` : ''}.`,
    probe.webgpu ? `In-browser AI available${probe.shaderF16 ? '' : ' (uses the larger 32-bit builds)'}.` : 'In-browser AI (WebGPU) is not available, so only Light rules can run.',
    'Browsers can’t see exact graphics memory, so fit is estimated; Test speed measures it.',
  ];
  const nerLine = ner.state === 'ready'
    ? h('p', { text: `Name detector ready (${NER_MODEL.downloadMB} MB). It finds names, organisations and places in English, in any capitalisation.` })
    : ner.state === 'failed'
      ? h('div', { class: 'ner' }, h('p', { class: 'bad', text: 'The name detector couldn’t load. Patterns and your lists still protect you, but names may be missed.' }),
          h('p', { class: 'quiet small', text: ner.text }), h('button', { class: 'btn sm', text: 'Try again', on: { click: () => void prepareNer() } }))
      : h('div', { class: 'ner' }, h('p', { text: `Name detector: ${ner.text}` }), h('div', { class: 'bar' }, h('div', { attrs: { style: `width: ${ner.pct}%` } })));
  aboutBox.replaceChildren(h('summary', { text: 'About this computer' }), h('div', { class: 'about-body' }, ...facts.map((text) => h('p', { text })), nerLine));
}

function renderModels() {
  if (!fits) return;
  renderAbout();
  modelsBox.replaceChildren(...fits.map((f) => {
    const tier = f.model.tier;
    const id = f.webllmId;
    const [name = f.model.name, detail = ''] = tier === 'light' ? ['Light rules'] : f.model.name.split(' · ');
    const isActive = settings.styleTier === tier && (tier === 'light' || settings.webllmId === id);
    const isSelected = selectedTier === tier;
    const downloaded = tier === 'light' || (id ? cached[id] : false);
    const disabled = f.fit === 'unsupported';
    const line = tier === 'light'
      ? 'No download. Works on any computer. Removes habits but can’t smooth sentences.'
      : `${f.model.downloadGB} GB${downloaded ? ', downloaded' : ' download'}. ${FIT_TEXT[f.fit]}${isActive ? ' In use.' : ''}`;

    const actions = h('div', { class: 'actions' });
    if (busyModel === id && id) {
      const bar = h('div');
      bar.style.width = `${busyProgress.pct}%`;
      actions.append(h('div', { class: 'progress' }, h('span', { class: 'small quiet', text: busyProgress.text }), h('div', { class: 'bar' }, bar)));
    } else if (isSelected && !disabled) {
      if (tier === 'light') {
        if (!isActive) actions.append(h('button', { class: 'btn sm', text: 'Use Light rules', on: { click: () => void activate(f) } }));
      } else if (!downloaded) {
        actions.append(h('button', { class: 'btn sm', text: `Download ${f.model.downloadGB} GB and test`, on: { click: () => void download(f) } }));
      } else {
        if (!isActive) actions.append(h('button', { class: 'btn sm', text: 'Use this model', on: { click: () => void activate(f) } }));
        actions.append(
          h('button', { class: 'btn sm', text: 'Test speed', on: { click: () => void download(f) } }),
          h('button', { class: 'btn text remove small', text: 'Remove', on: { click: () => void removeModel(f) } }));
      }
    }
    const input = h('input', { attrs: { type: 'radio', name: 'model', 'aria-label': name } });
    input.checked = isSelected;
    input.disabled = disabled;
    input.addEventListener('change', () => { selectedTier = tier; renderModels(); });
    const speed = id ? speeds[id] : undefined;
    return h('label', { class: `model${isSelected ? ' selected' : ''}${disabled ? ' disabled' : ''}` },
      input,
      h('div', { class: 'model-body' },
        h('div', {}, h('strong', { text: name }), detail ? h('span', { class: 'quiet', text: ` ${detail}` }) : null),
        h('div', { class: 'quiet small', text: line }),
        speed ? h('div', { class: `small speed${speed.bad ? ' bad' : ''}`, text: speed.text }) : null),
      actions);
  }));
}

async function download(f: ModelFit) {
  if (!f.webllmId || busyModel) return;
  busyModel = f.webllmId;
  busyProgress = { pct: 0, text: 'Starting…' };
  renderModels();
  const requestId = newRequestId();
  const off = onProgress(requestId, (p) => {
    busyProgress = { pct: p.progress, text: p.text.length > 90 ? `${p.text.slice(0, 90)}…` : p.text };
    const bar = modelsBox.querySelector<HTMLElement>('.progress .bar > div');
    const label = modelsBox.querySelector<HTMLElement>('.progress > span');
    if (bar) bar.style.width = `${busyProgress.pct}%`;
    if (label) label.textContent = busyProgress.text;
  });
  try {
    const speed = await engine.prepare(f.webllmId, requestId);
    speeds[f.webllmId] = { text: `${speed.tokensPerSecond} tokens a second on this computer. A typical message is rewritten in about ${speed.typicalPromptSeconds} s.` };
    cached[f.webllmId] = true;
    busyModel = null;
    await activate(f);
  } catch (e) {
    busyModel = null;
    speeds[f.webllmId] = { text: `This model couldn’t run here, so Light rules stay in charge. ${e instanceof Error ? e.message : String(e)}`, bad: true };
    renderModels();
  } finally {
    off();
  }
}

async function activate(f: ModelFit) {
  const patch: Partial<Settings> = { styleTier: f.model.tier, webllmId: f.webllmId ?? null };
  if (f.model.tier === 'light' && settings.defaultStyle === 'ai') patch.defaultStyle = 'light';
  if (f.model.tier !== 'light' && settings.defaultStyle !== 'off') patch.defaultStyle = 'ai';
  settings = await saveSettings(patch);
  renderModels();
  renderVoice();
  renderStatus();
}

async function removeModel(f: ModelFit) {
  if (!f.webllmId) return;
  await engine.remove(f.webllmId);
  cached[f.webllmId] = false;
  delete speeds[f.webllmId];
  if (settings.webllmId === f.webllmId) settings = await saveSettings({ styleTier: 'light', webllmId: null, defaultStyle: 'light' });
  renderModels();
  renderVoice();
  renderStatus();
}

// ---------------------------------------------------------------------------------------------
// Try it
// ---------------------------------------------------------------------------------------------

/** Text with placeholders drawn as chips ("● Person 1"). */
function withChips(el: HTMLElement, text: string) {
  el.replaceChildren();
  let c = 0;
  for (const m of findPlaceholders(text)) {
    const token = text.slice(m.start, m.end);
    el.append(text.slice(c, m.start), h('span', { class: 'chip', text: chipName(m.placeholder), title: `Sent as ${token}` }));
    c = m.end;
  }
  el.append(text.slice(c));
}

function playground(): HTMLElement {
  const input = h('textarea', { attrs: { rows: '6', spellcheck: 'false', placeholder: 'Paste a message…', 'aria-label': 'Your message' } });
  input.value = EXAMPLE;
  const output = h('div', { class: 'out', attrs: { 'aria-live': 'polite' } });
  const status = h('div', { class: 'quiet small' });
  const rewriteButton = h('button', { class: 'btn sm', text: 'Run the full rewrite' });
  let lastOut = '';
  let lastVault: Vault | null = null;
  let run = 0;

  const anonymized = async () => {
    const text = input.value;
    const vault = new Vault(await loadVault('playground', settings.memory));
    const { spans, ms } = await engine.analyze(text, { policy: settings.policy, alwaysHide: settings.alwaysHide, neverHide: settings.neverHide });
    const out = anonymize(text, spans, vault).text;
    await saveVault('playground', vault.toJSON(), settings.memory);
    lastVault = vault;
    return { out, spans: spans.length, ms };
  };
  const preview = async () => {
    const mine = ++run;
    status.textContent = 'Checking…';
    try {
      const { out, spans, ms } = await anonymized();
      if (mine !== run) return;
      lastOut = settings.defaultStyle === 'off' ? out : neutralizeLight(out);
      withChips(output, lastOut);
      const ai = settings.defaultStyle === 'ai' && settings.webllmId;
      status.textContent = `${spans} ${spans === 1 ? 'detail' : 'details'} hidden in ${ms} ms${ai ? '. Shown with Light rules; run the full rewrite to see the model’s version.' : '.'}`;
      rewriteButton.hidden = !ai;
    } catch (e) {
      status.textContent = `Could not check this text: ${e instanceof Error ? e.message : String(e)}`;
    }
  };
  let timer: ReturnType<typeof setTimeout> | undefined;
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => void preview(), 350); });
  rewriteButton.hidden = true;
  rewriteButton.addEventListener('click', async () => {
    if (!settings.webllmId) return;
    const mine = ++run;
    const { out } = await anonymized();
    const requestId = newRequestId();
    const off = onProgress(requestId, (p) => (status.textContent = p.progress < 100 ? `Loading the model, ${p.progress}%` : 'Rewriting on this computer…'));
    status.textContent = 'Rewriting on this computer…';
    try {
      const r = await engine.rewrite(out, settings.webllmId, requestId, settings.aiCoverage);
      if (mine !== run) return;
      lastOut = r.text;
      withChips(output, lastOut);
      status.textContent = r.rewritten ? `Rewritten in ${(r.ms / 1000).toFixed(1)} s. Numbers, placeholders and meaning checked.` : 'Some sentences failed the meaning check, so they use Light rules.';
    } catch (e) {
      status.textContent = `The model couldn’t run, so Light rules stay in charge. ${e instanceof Error ? e.message : String(e)}`;
    } finally {
      off();
    }
  });

  const answer = h('textarea', { attrs: { rows: '3', spellcheck: 'false', placeholder: 'Paste an AI answer with placeholders like [PERSON_1]…', 'aria-label': 'AI answer' } });
  const restored = h('div', { class: 'out restored' });
  answer.addEventListener('input', async () => {
    restored.textContent = restore(answer.value, lastVault ?? new Vault(await loadVault('playground', settings.memory)));
  });
  const restoreArea = h('div', { class: 'restore' }, h('div', { class: 'label', text: 'An AI answer' }), answer, restored);
  restoreArea.hidden = true;
  const copy = h('button', { class: 'btn primary', text: 'Copy result', on: { click: async () => {
    await navigator.clipboard.writeText(lastOut);
    copy.textContent = 'Copied';
    setTimeout(() => (copy.textContent = 'Copy result'), 1500);
  } } });
  void preview();

  return h('div', { class: 'card try' },
    h('h2', { text: 'Try it' }),
    h('p', { class: 'quiet small', text: 'Paste anything. Nothing leaves this page.' }),
    h('div', { class: 'label', text: 'Your message' }), input,
    h('div', { class: 'label', text: 'What the AI would see' }), output, status, rewriteButton,
    h('div', { class: 'try-actions' }, copy, h('button', { class: 'btn', text: 'Restore an answer', on: { click: () => { restoreArea.hidden = !restoreArea.hidden; if (!restoreArea.hidden) answer.focus(); } } })),
    restoreArea);
}

void main();
