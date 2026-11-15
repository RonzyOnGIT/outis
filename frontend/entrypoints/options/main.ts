import '@/lib/page.css';
import './style.css';
import {
  anonymize,
  ENTITY_LABELS,
  ENTITY_TYPES,
  FIT_LABELS,
  NER_MODEL,
  findPlaceholders,
  neutralizeLight,
  probeDevice,
  rateModels,
  restore,
  Vault,
  type DeviceProbe,
  type EntityType,
  type ModelFit,
} from '@nobody/engine';
import { h } from '@/lib/dom';
import { engine, newRequestId, onProgress } from '@/lib/messages';
import { clearVault, forgetEverything, loadSettings, loadVault, saveSettings, saveVault, type Memory, type Settings, type StyleMode } from '@/lib/settings';

const app = document.getElementById('app')!;
let settings: Settings;
let probe: DeviceProbe;
let fits: ModelFit[];
let cached: Record<string, boolean> = {};
const speeds: Record<string, string> = {};
let busyModel: string | null = null;
let busyProgress = { pct: 0, text: 'Starting…' };
let selectedTier: string;

const EXAMPLE = `Hi! My name is Sarah Connor and I'm a project manager at Cyberdyne Systems in Los Angeles.
My manager Miles Dyson asked me to send the Q3 report to the client by Friday, but it's not finished yet lol 😅
Can u help me write a polite email to Miles explaining the delay? You can reach me at sarah.connor@cyberdyne.com or +1 213 555 0147.
My employee ID: CYB-77812, and the build log says: Error in /Users/sconnor/reports/q3.xlsx`;

async function main() {
  settings = await loadSettings();
  selectedTier = settings.styleTier;
  app.replaceChildren(h('div', { class: 'loading muted', text: 'Checking your device…' }));
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
}

// ---------------------------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------------------------

function section(num: string, title: string, sub: string, ...body: Node[]) {
  return h(
    'section',
    { class: 'card' },
    h('div', { class: 'card-head' }, h('span', { class: 'num', text: num }), h('div', {}, h('h2', { text: title }), h('p', { class: 'muted small', text: sub }))),
    ...body,
  );
}

const nerBox = h('div', { class: 'ner' });
const modelsBox = h('div', { class: 'models' });

function render() {
  app.replaceChildren(
    h(
      'header',
      { class: 'top' },
      h('div', { class: 'logo' }),
      h('div', {}, h('h1', { text: 'Nobody' }), h('p', { class: 'muted', text: 'Hides your personal info and writing style before you paste. Everything runs on this device.' })),
    ),
    section('1', 'Your device', 'Nobody picks models that fit your computer. Nothing about it is sent anywhere.', deviceView()),
    section('2', 'Name detector', 'Finds names, companies and places. Small, runs on the processor, downloaded once.', nerBox),
    section(
      '3',
      'Writing-style model',
      'Rewrites your text so services can’t recognise how you write. Pick speed or quality — you can change it any time.',
      modelsBox,
    ),
    section('4', 'What to hide', 'Your own details are the most likely to leak — add them here so they are always caught.', hideView()),
    section('5', 'When you paste or type', 'Nobody checks pasted and typed text on these sites, and stops a message from being sent while it still contains personal info.', pasteView()),
    section('6', 'Try it', 'A safe playground — paste anything, nothing leaves this page.', playground()),
    h(
      'footer',
      { class: 'done' },
      h('button', {
        class: 'btn primary',
        text: 'Done — start protecting',
        on: {
          click: async () => {
            await saveSettings({ setupDone: true });
            window.close();
          },
        },
      }),
      h('span', { class: 'muted small', text: 'Settings save automatically.' }),
    ),
  );
  renderModels();
}

function deviceView() {
  const yes = (b: boolean, ok = 'Yes', no = 'No') => h('span', { class: `badge ${b ? 'ok' : 'warn'}`, text: b ? ok : no });
  const gpuName = probe.description || [probe.vendor, probe.architecture].filter(Boolean).join(' ') || 'Unknown';
  const cls = { apple: 'Apple Silicon (shared memory)', discrete: 'Dedicated graphics', integrated: 'Integrated graphics', none: 'No usable GPU' }[probe.gpuClass];
  return h(
    'div',
    { class: 'device' },
    h('div', {}, h('div', { class: 'muted small', text: 'Graphics' }), h('div', { text: probe.webgpu ? `${gpuName}` : 'Not available' }), h('div', { class: 'muted small', text: cls })),
    h('div', {}, h('div', { class: 'muted small', text: 'WebGPU (AI in the browser)' }), yes(probe.webgpu, 'Available', 'Not available')),
    h('div', {}, h('div', { class: 'muted small', text: 'Fast half-precision' }), yes(probe.shaderF16, 'Supported', 'No — uses bigger build')),
    h('div', {}, h('div', { class: 'muted small', text: 'Memory · CPU' }), h('div', { text: `${probe.ramGB ? (probe.ramGB >= 8 ? '8 GB or more' : `${probe.ramGB} GB`) : 'Unknown'} · ${probe.cores ?? '?'} cores` })),
  );
}

// ---------------------------------------------------------------------------------------------
// Name detector
// ---------------------------------------------------------------------------------------------

async function prepareNer() {
  const bar = h('div');
  const label = h('span', { class: 'small', text: 'Preparing…' });
  nerBox.replaceChildren(h('div', { class: 'row' }, label), h('div', { class: 'bar' }, bar));
  const requestId = newRequestId();
  const off = onProgress(requestId, (p) => {
    bar.style.width = `${p.progress}%`;
    label.textContent = p.text;
  });
  try {
    await engine.initNer(requestId);
    nerBox.replaceChildren(
      h('div', { class: 'row' }, h('span', { class: 'badge ok', text: '✓ Ready' }), h('span', { class: 'muted small', text: `${NER_MODEL.name} · ${NER_MODEL.downloadMB} MB · English names, organisations, places — any capitalisation` })),
    );
  } catch (e) {
    nerBox.replaceChildren(
      h('div', { class: 'row' }, h('span', { class: 'badge bad', text: 'Failed' }), h('span', { class: 'small', text: String(e) })),
      h('button', { class: 'btn sm', text: 'Retry', on: { click: () => void prepareNer() } }),
    );
  } finally {
    off();
  }
}

// ---------------------------------------------------------------------------------------------
// Model picker
// ---------------------------------------------------------------------------------------------

function dots(n: number) {
  return h('span', { class: 'dots', attrs: { 'aria-label': `${n} of 5` } }, ...[1, 2, 3, 4, 5].map((i) => h('i', { class: i <= n ? 'on' : '' })));
}

function fitBadge(f: ModelFit) {
  const cls = { recommended: 'info', good: 'ok', heavy: 'warn', 'too-big': 'bad', unsupported: 'bad' }[f.fit];
  return h('span', { class: `badge ${cls}`, text: (f.fit === 'recommended' ? '★ ' : '') + FIT_LABELS[f.fit] });
}

function renderModels() {
  if (!fits) return;
  modelsBox.replaceChildren(
    ...fits.map((f) => {
      const tier = f.model.tier;
      const id = f.webllmId;
      const isActive = settings.styleTier === tier && (tier === 'light' || settings.webllmId === id);
      const isSelected = selectedTier === tier;
      const downloaded = tier === 'light' || (id ? cached[id] : false);
      const disabled = f.fit === 'unsupported';

      const meta =
        tier === 'light'
          ? 'No download · no GPU needed'
          : `${f.model.downloadGB} GB download · ~${(f.vramMB / 1024).toFixed(1)} GB graphics memory`;

      const actions = h('div', { class: 'actions' });
      if (busyModel === id && id) {
        const progressBar = h('div');
        progressBar.style.width = `${busyProgress.pct}%`;
        actions.append(h('div', { class: 'progress' }, h('span', { class: 'small muted', text: busyProgress.text }), h('div', { class: 'bar' }, progressBar)));
      } else if (isSelected && !disabled) {
        if (tier === 'light') {
          if (!isActive) actions.append(h('button', { class: 'btn primary sm', text: 'Use Light mode', on: { click: () => void activate(f) } }));
        } else if (!downloaded) {
          actions.append(
            h('button', { class: 'btn primary sm', text: `Download ${f.model.downloadGB} GB & test`, on: { click: () => void download(f) } }),
          );
        } else {
          if (!isActive) actions.append(h('button', { class: 'btn primary sm', text: 'Use this model', on: { click: () => void activate(f) } }));
          actions.append(
            h('button', { class: 'btn sm', text: 'Test speed', on: { click: () => void download(f) } }),
            h('button', { class: 'btn sm danger', text: 'Remove', on: { click: () => void removeModel(f) } }),
          );
        }
      }

      const card = h(
        'div',
        {
          class: `model${isSelected ? ' selected' : ''}${disabled ? ' disabled' : ''}`,
          attrs: { role: 'radio', 'aria-checked': String(isSelected), tabindex: '0' },
          on: {
            click: (e) => {
              if (disabled || (e.target as HTMLElement).closest('button')) return;
              selectedTier = tier;
              renderModels();
            },
          },
        },
        h(
          'div',
          { class: 'model-top' },
          h('span', { class: 'radio' }),
          h('strong', { text: f.model.name }),
          isActive ? h('span', { class: 'badge ok', text: 'In use' }) : null,
          downloaded && tier !== 'light' ? h('span', { class: 'badge info', text: 'Downloaded' }) : null,
          h('span', { class: 'spacer' }),
          fitBadge(f),
        ),
        h('p', { class: 'small', text: f.model.blurb }),
        h(
          'div',
          { class: 'model-meta small muted' },
          h('span', {}, 'Quality ', dots(f.model.quality)),
          h('span', {}, 'Speed ', dots(f.model.speed)),
          h('span', { text: meta }),
        ),
        id && speeds[id] ? h('div', { class: 'speed small', text: speeds[id] }) : null,
        actions,
      );
      return card;
    }),
    h('p', { class: 'muted small', text: 'Browsers can’t see exact graphics memory, so fit labels are estimates. “Test speed” measures the real thing.' }),
  );
}

async function download(f: ModelFit) {
  if (!f.webllmId || busyModel) return;
  busyModel = f.webllmId;
  busyProgress = { pct: 0, text: 'Starting…' };
  renderModels();
  const requestId = newRequestId();
  const off = onProgress(requestId, (p) => {
    busyProgress = { pct: p.progress, text: p.text.length > 90 ? `${p.text.slice(0, 90)}…` : p.text };
    // Update in place (the card may have been re-rendered meanwhile).
    const bar = modelsBox.querySelector<HTMLElement>('.progress .bar > div');
    const label = modelsBox.querySelector<HTMLElement>('.progress > span');
    if (bar) bar.style.width = `${busyProgress.pct}%`;
    if (label) label.textContent = busyProgress.text;
  });
  try {
    const speed = await engine.prepare(f.webllmId, requestId);
    speeds[f.webllmId] = `⚡ ${speed.tokensPerSecond} tokens/s on this device · a typical prompt rewrites in ~${speed.typicalPromptSeconds} s`;
    cached[f.webllmId] = true;
    busyModel = null;
    await activate(f);
  } catch (e) {
    busyModel = null;
    speeds[f.webllmId] = `✗ Could not run this model here: ${e instanceof Error ? e.message : String(e)}`;
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
  renderPasteDefaults();
}

async function removeModel(f: ModelFit) {
  if (!f.webllmId) return;
  await engine.remove(f.webllmId);
  cached[f.webllmId] = false;
  delete speeds[f.webllmId];
  if (settings.webllmId === f.webllmId) settings = await saveSettings({ styleTier: 'light', webllmId: null, defaultStyle: 'light' });
  renderModels();
  renderPasteDefaults();
}

// ---------------------------------------------------------------------------------------------
// What to hide
// ---------------------------------------------------------------------------------------------

function debounce<T extends unknown[]>(fn: (...a: T) => void, ms = 400) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: T) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...a), ms);
  };
}

const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

function hideView() {
  const names = h('textarea', { attrs: { rows: '3', placeholder: 'Your name\nFamily members\nColleagues', spellcheck: 'false' } });
  names.value = settings.alwaysHide.filter((e) => e.type === 'PERSON').map((e) => e.value).join('\n');
  const words = h('textarea', { attrs: { rows: '3', placeholder: 'Your company\nProject code names\nYour street or town', spellcheck: 'false' } });
  words.value = settings.alwaysHide.filter((e) => e.type !== 'PERSON').map((e) => e.value).join('\n');
  const never = h('textarea', { attrs: { rows: '3', spellcheck: 'false' } });
  never.value = settings.neverHide.join('\n');

  const saveLists = debounce(async () => {
    settings = await saveSettings({
      alwaysHide: [...lines(names.value).map((value) => ({ value, type: 'PERSON' as const })), ...lines(words.value).map((value) => ({ value, type: 'ORG' as const }))],
      neverHide: lines(never.value),
    });
  });
  for (const t of [names, words, never]) t.addEventListener('input', saveLists);

  const cats = h('div', { class: 'cats' });
  for (const type of ENTITY_TYPES) {
    const box = h('input', { attrs: { type: 'checkbox' } });
    box.checked = settings.policy[type];
    box.addEventListener('change', async () => {
      settings = await saveSettings({ policy: { ...settings.policy, [type]: box.checked } });
    });
    cats.append(h('label', { class: 'cat' }, box, ENTITY_LABELS[type as EntityType]));
  }

  return h(
    'div',
    { class: 'hide' },
    h('p', { text: 'Context matters: birth dates, medical dates and credential expiry dates are hidden. Ordinary deadlines and public company or place references stay visible. Personal links such as your employer or home stay protected. Review the results; your lists below override these context checks.' }),
    h('div', { class: 'grid3' },
      h('label', {}, h('span', { class: 'lbl', text: 'Always hide — people' }), names),
      h('label', {}, h('span', { class: 'lbl', text: 'Always hide — other words' }), words),
      h('label', {}, h('span', { class: 'lbl', text: 'Never hide' }), never),
    ),
    h('div', { class: 'lbl', text: 'Categories' }),
    cats,
  );
}

// ---------------------------------------------------------------------------------------------
// Paste behaviour
// ---------------------------------------------------------------------------------------------

const pasteDefaultsBox = h('div');

function renderPasteDefaults() {
  const aiOk = settings.styleTier !== 'light' && Boolean(settings.webllmId);
  const seg = h('div', { class: 'seg' });
  for (const [mode, label] of [['off', 'Off'], ['light', 'Light'], ['ai', 'AI rewrite']] as Array<[StyleMode, string]>) {
    const b = h('button', {
      class: settings.defaultStyle === mode ? 'on' : '',
      text: label,
      on: {
        click: async () => {
          settings = await saveSettings({ defaultStyle: mode });
          renderPasteDefaults();
        },
      },
    });
    if (mode === 'ai' && !aiOk) {
      b.disabled = true;
      b.title = 'Download a writing-style model first (step 3)';
    }
    seg.append(b);
  }

  const coverageSel = h('select');
  for (const [v, label] of [['all', 'Every sentence (most neutral)'], ['auto', 'Only where needed (faster)']]) {
    const o = h('option', { text: label, attrs: { value: v } });
    if (settings.aiCoverage === v) o.selected = true;
    coverageSel.append(o);
  }
  coverageSel.addEventListener('change', async () => {
    settings = await saveSettings({ aiCoverage: coverageSel.value as Settings['aiCoverage'] });
  });

  const restoreSel = h('select');
  for (const [v, label] of [
    ['hover', 'Hover to see real values (safest)'],
    ['replace', 'Show real values in the page'],
    ['off', 'Off'],
  ]) {
    const o = h('option', { text: label, attrs: { value: v } });
    if (settings.restoreMode === v) o.selected = true;
    restoreSel.append(o);
  }
  restoreSel.addEventListener('change', async () => {
    settings = await saveSettings({ restoreMode: restoreSel.value as Settings['restoreMode'] });
    renderPasteDefaults();
  });

  const mkSwitch = (label: string, checked: boolean, onChange: (v: boolean) => void) => {
    const input = h('input', { attrs: { type: 'checkbox', 'aria-label': label } });
    input.checked = checked;
    input.addEventListener('change', () => onChange(input.checked));
    return h('label', { class: 'switch' }, input, h('span'));
  };
  const autoSwitch = mkSwitch('Automatic mode', settings.autoMode, async (v) => {
    settings = await saveSettings({ autoMode: v });
    renderPasteDefaults();
  });
  const autoSendSwitch = mkSwitch('Send automatically', settings.autoSend, async (v) => {
    settings = await saveSettings({ autoSend: v });
  });
  const documentSwitch = mkSwitch('Protect document attachments', settings.guardDocuments, async (v) => {
    settings = await saveSettings({ guardDocuments: v });
  });

  const typingSwitch = h('input', { attrs: { type: 'checkbox', 'aria-label': 'Check what I type' } });
  typingSwitch.checked = settings.guardTyping;
  typingSwitch.addEventListener('change', async () => {
    settings = await saveSettings({ guardTyping: typingSwitch.checked });
  });

  const memorySel = h('select');
  const MEMORY: Array<[Memory, string]> = [
    ['session', 'Until I close the browser (memory only)'],
    ['none', 'Forget right after replacing'],
    ['device', 'Remember on this device'],
  ];
  for (const [v, label] of MEMORY) {
    const o = h('option', { text: label, attrs: { value: v } });
    if (settings.memory === v) o.selected = true;
    memorySel.append(o);
  }
  memorySel.addEventListener('change', async () => {
    settings = await saveSettings({ memory: memorySel.value as Memory });
    renderPasteDefaults();
  });
  const memoryHelp: Record<Memory, string> = {
    session:
      'Real values are kept in memory only — never written to disk — so [PERSON_1] stays the same across messages and you can hover answers. Gone when the browser closes.',
    none: 'Real values are deleted as soon as the text is replaced. Nothing to restore in answers, and the same person may get a new placeholder in your next message.',
    device: 'Kept on this computer until you press Forget. Most convenient, least private.',
  };

  pasteDefaultsBox.replaceChildren(
    h('div', { class: 'setting' },
      h('div', {}, h('strong', { text: 'Protect document attachments' }),
        h('p', { class: 'muted small', text: 'Review cleaned TXT copies before upload, drop or file paste. Supports PDF, DOCX, XLSX, PPTX, ODT/ODS/ODP, RTF, TXT, Markdown, CSV, TSV, JSON and logs. Originals, images and unsupported formats are held back. Layout and embedded content are omitted. Up to 10 MB per file; 8 files / 25 MB per selection.' })),
      documentSwitch),
    h(
      'div',
      { class: 'setting' },
      h(
        'div',
        {},
        h('strong', { text: 'Automatic mode (one Enter)' }),
        h('p', {
          class: 'muted small',
          text: settings.autoMode
            ? 'Press Enter: your text leaves the box at once, and the safe, restyled version is put back when ready. Esc undoes. The badge still opens the full review.'
            : 'Off: a review panel shows what will be hidden and asks before replacing.',
        }),
      ),
      autoSwitch,
    ),
    settings.autoMode
      ? h(
          'div',
          { class: 'setting' },
          h('div', {}, h('strong', { text: 'Send automatically when ready' }), h('p', { class: 'muted small', text: 'Skip the final Enter. Off lets you glance at the safe text first.' })),
          autoSendSwitch,
        )
      : '',
    h(
      'div',
      { class: 'setting' },
      h(
        'div',
        {},
        h('strong', { text: 'Check what I type' }),
        h('p', {
          class: 'muted small',
          text: 'Underlines personal info as you type and stops Enter / Send until you review it. Shortcut Alt+Shift+N checks any box on demand.',
        }),
      ),
      h('label', { class: 'switch' }, typingSwitch, h('span')),
    ),
    h('div', { class: 'setting' }, h('div', {}, h('strong', { text: 'Default writing style' }), h('p', { class: 'muted small', text: 'Light: rules only, instant. AI rewrite: plain everyday voice by the local model, checked sentence by sentence.' })), seg),
    h(
      'div',
      { class: 'setting' },
      h('div', {}, h('strong', { text: 'AI rewrite covers' }), h('p', { class: 'muted small', text: 'Every sentence is the most neutral. “Only where needed” sends just the sentences the rules can’t finish — much faster.' })),
      coverageSel,
    ),
    h(
      'div',
      { class: 'setting' },
      h('div', {}, h('strong', { text: 'Memory of real values' }), h('p', { class: 'muted small', text: memoryHelp[settings.memory] })),
      h(
        'div',
        { class: 'row' },
        memorySel,
        h('button', {
          class: 'btn sm',
          text: 'Forget now',
          on: {
            click: async (e) => {
              await forgetEverything();
              (e.target as HTMLButtonElement).textContent = 'Forgotten ✓';
            },
          },
        }),
      ),
    ),
    h(
      'div',
      { class: 'setting' },
      h(
        'div',
        {},
        h('strong', { text: 'Reading AI answers' }),
        h('p', {
          class: 'muted small',
          text:
            settings.restoreMode === 'replace'
              ? '⚠ Real values are written into the page. Scripts on that site (analytics, session replay) could read them.'
              : 'Placeholders like [PERSON_1] in answers are tinted; hover to see the real value. The site never sees it.',
        }),
      ),
      restoreSel,
    ),
  );
}

function pasteView() {
  renderPasteDefaults();
  const siteList = h('div', { class: 'sites' });
  const renderSites = () => {
    siteList.replaceChildren(
      ...Object.entries(settings.sites)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([site, on]) => {
          const box = h('input', { attrs: { type: 'checkbox' } });
          box.checked = on;
          box.addEventListener('change', async () => {
            settings = await saveSettings({ sites: { ...settings.sites, [site]: box.checked } });
          });
          return h('label', { class: 'cat' }, box, site);
        }),
    );
  };
  renderSites();

  const add = h('input', { attrs: { placeholder: 'Add a site, e.g. jira.mycompany.com' } });
  const addSite = async () => {
    const v = add.value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
    if (!v) return;
    settings = await saveSettings({ sites: { ...settings.sites, [v]: true } });
    add.value = '';
    renderSites();
  };
  add.addEventListener('keydown', (e) => e.key === 'Enter' && void addSite());

  const all = h('input', { attrs: { type: 'checkbox' } });
  all.checked = settings.allSites;
  all.addEventListener('change', async () => {
    settings = await saveSettings({ allSites: all.checked });
  });

  return h(
    'div',
    {},
    pasteDefaultsBox,
    h('div', { class: 'setting' }, h('div', {}, h('strong', { text: 'Protect every website' }), h('p', { class: 'muted small', text: 'Otherwise only the sites below.' })), h('label', { class: 'switch' }, all, h('span'))),
    siteList,
    h('div', { class: 'row' }, add, h('button', { class: 'btn sm', text: 'Add', on: { click: () => void addSite() } })),
  );
}

// ---------------------------------------------------------------------------------------------
// Playground
// ---------------------------------------------------------------------------------------------

function renderWithPlaceholders(el: HTMLElement, text: string) {
  el.replaceChildren();
  let c = 0;
  for (const m of findPlaceholders(text)) {
    el.append(text.slice(c, m.start), h('span', { class: 'ph', text: text.slice(m.start, m.end) }));
    c = m.end;
  }
  el.append(text.slice(c));
}

function playground() {
  const input = h('textarea', { attrs: { rows: '7', spellcheck: 'false', placeholder: 'Paste some text with personal info…' } });
  input.value = EXAMPLE;
  const output = h('div', { class: 'out' });
  const status = h('div', { class: 'small muted' });
  let style: StyleMode = settings.defaultStyle;
  let lastOut = '';
  let lastVault: Vault | null = null;

  const seg = h('div', { class: 'seg' });
  const renderSeg = () => {
    seg.replaceChildren();
    for (const [mode, label] of [['off', 'Off'], ['light', 'Light'], ['ai', 'AI rewrite']] as Array<[StyleMode, string]>) {
      const b = h('button', { class: style === mode ? 'on' : '', text: label, on: { click: () => ((style = mode), renderSeg()) } });
      if (mode === 'ai' && !(settings.styleTier !== 'light' && settings.webllmId)) b.disabled = true;
      seg.append(b);
    }
  };
  renderSeg();

  const run = async () => {
    status.textContent = 'Checking…';
    const text = input.value;
    const vault = new Vault(await loadVault('playground', settings.memory));
    const { spans, ms } = await engine.analyze(text, { policy: settings.policy, alwaysHide: settings.alwaysHide, neverHide: settings.neverHide });
    let out = anonymize(text, spans, vault).text;
    await saveVault('playground', vault.toJSON(), settings.memory);
    lastVault = vault; // keep real values for the restore box in this page only
    status.textContent = `Found ${spans.length} item(s) in ${ms} ms.`;
    if (style === 'light') out = neutralizeLight(out);
    if (style === 'ai' && settings.webllmId) {
      renderWithPlaceholders(output, neutralizeLight(out));
      const requestId = newRequestId();
      const off = onProgress(requestId, (p) => (status.textContent = p.progress < 100 ? `Loading model… ${p.progress}%` : 'Rewriting…'));
      status.textContent = 'Rewriting locally…';
      try {
        const r = await engine.rewrite(out, settings.webllmId, requestId, settings.aiCoverage);
        out = r.text;
        status.textContent = r.rewritten
          ? `Found ${spans.length} item(s) · rewritten in ${(r.ms / 1000).toFixed(1)} s`
          : `Found ${spans.length} item(s) · rewrite fell back to Light in places (${r.problems[0] ?? ''})`;
      } finally {
        off();
      }
    }
    lastOut = out;
    renderWithPlaceholders(output, out);
  };

  const answer = h('textarea', {
    attrs: { rows: '3', spellcheck: 'false', placeholder: 'Paste an AI answer containing placeholders like [PERSON_1] to restore real values…' },
  });
  const restored = h('div', { class: 'out' });
  answer.addEventListener('input', async () => {
    restored.textContent = restore(answer.value, lastVault ?? new Vault(await loadVault('playground', settings.memory)));
  });

  return h(
    'div',
    { class: 'play' },
    input,
    h(
      'div',
      { class: 'row' },
      h('button', { class: 'btn primary', text: 'Anonymize', on: { click: () => void run().catch((e) => (status.textContent = String(e))) } }),
      seg,
      h('button', { class: 'btn sm', text: 'Copy result', on: { click: () => void navigator.clipboard.writeText(lastOut) } }),
      h('button', {
        class: 'btn sm',
        text: 'Forget placeholders',
        on: {
          click: async () => {
            await clearVault('playground');
            lastVault = null;
            status.textContent = 'Playground placeholders cleared.';
          },
        },
      }),
    ),
    status,
    output,
    h('div', { class: 'lbl', text: 'Restore an answer' }),
    answer,
    restored,
  );
}

void main();
