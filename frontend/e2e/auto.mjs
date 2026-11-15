// Automatic mode (one Enter) on a ProseMirror / Tiptap chat box with the local AI model.
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXT = process.env.EXT ?? new URL('../dist/chrome-mv3', import.meta.url).pathname;
const OUT = process.argv[2] ?? '.';
const BUNDLE = process.env.BUNDLE ?? 'pm-bundle.js';
const PROFILE = new URL('./llm-profile', import.meta.url).pathname;
mkdirSync(PROFILE, { recursive: true });
const bundle = readFileSync(new URL('./' + BUNDLE, import.meta.url));
const message = readFileSync(new URL('./sample-prompt.txt', import.meta.url), 'utf8').trim();
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat</title>
<style>.ProseMirror{border:1px solid #ccc;min-height:60px;padding:8px;white-space:pre-wrap} .ProseMirror p{margin:0}</style></head>
<body style="font:15px system-ui;padding:24px;max-width:760px"><h3 style="margin-top:300px">Chat</h3><div id="editor"></div>
<h3>Sent</h3><ol id="sent"></ol><script src="/b.js"></script></body></html>`;
const server = http.createServer((q, r) => {
  if (q.url.startsWith('/b.js')) { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(bundle); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(html);
});
await new Promise((r) => server.listen(18766, '127.0.0.1', r));
const url = `http://127.0.0.1:18766/?focusEnd=1&beforeinput=1`;
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium', headless: true, viewport: { width: 1000, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu'],
});
const log = (...a) => console.log('[auto]', ...a);
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`).catch(() => opt.goto(`chrome-extension://${extId}/options.html`));
await opt.waitForSelector('text=✓ Ready', { timeout: 240000 });
const setS = (patch) => opt.evaluate(async (p) => {
  const s = (await chrome.storage.local.get('settings')).settings ?? {};
  await chrome.storage.local.set({ settings: { ...s, ...p, sites: { ...(s.sites ?? {}), '127.0.0.1': true } } });
}, patch);
await setS({ defaultStyle: 'ai', autoMode: true, autoSend: false });
log('settings:', JSON.stringify(await opt.evaluate(async () => { const s = (await chrome.storage.local.get('settings')).settings ?? {}; return { model: s.webllmId, style: s.defaultStyle, auto: s.autoMode }; })));

const page = await ctx.newPage();
await page.goto(url);
const box = () => page.evaluate(() => window.pmText());
const sent = () => page.locator('#sent li').allInnerTexts();
const waitBox = async (pred, ms = 60000) => { const t = Date.now(); while (Date.now() - t < ms) { const v = await box(); if (pred(v)) return v; await page.waitForTimeout(200); } return box(); };
await page.click('#prompt-textarea');

// 1. Long message: Enter → box empties at once → safe text appears → Enter sends
await page.keyboard.insertText(message);
await page.waitForTimeout(1200);
let t0 = Date.now();
await page.keyboard.press('Enter');
await page.waitForTimeout(250);
log(`1 box right after Enter (${Date.now() - t0} ms): ${JSON.stringify((await box()).slice(0, 40))}`);
await page.screenshot({ path: join(OUT, 'a1-working.png') });
const safe = await waitBox((v) => v.trim().length > 0, 90000);
log(`1 safe text in box after ${((Date.now() - t0) / 1000).toFixed(1)} s, leaks: ${JSON.stringify(['Daniel', 'Reyes', '912-48', 'Willow', 'September 22', 'Halvorsen'].filter((x) => safe.includes(x)))}`);
log('1 text:', safe.slice(0, 220) + '…');
await page.waitForTimeout(300);
await page.screenshot({ path: join(OUT, 'a1-ready.png') });
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
log('1 sent the safe text:', (await sent()).at(-1) === safe.trim());

// 2. Esc undoes
await page.keyboard.type('can you tell miles dyson that the shipment from our warehouse is delayed until next monday please', { delay: 3 });
await page.waitForTimeout(600);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
log('2 box emptied:', JSON.stringify(await box()));
await page.keyboard.press('Escape');
const back = await waitBox((v) => v.trim().length > 0, 10000);
log('2 after Esc:', JSON.stringify(back), '| sent count:', (await sent()).length);
await page.keyboard.press('ControlOrMeta+A');
await page.keyboard.press('Backspace');
await page.waitForTimeout(400);
log('2 box cleared for next step:', JSON.stringify(await box()));

// 3. Short message goes straight through
await page.keyboard.type('ok thanks', { delay: 5 });
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
log('3 short sent at once:', (await sent()).at(-1));

// 4. No personal info, but in your own style → restyled
await page.keyboard.type('hey can u explain how gradient descent works lol, i keep getting confused', { delay: 3 });
await page.waitForTimeout(400);
t0 = Date.now();
await page.keyboard.press('Enter');
const restyled = await waitBox((v) => v.trim().length > 0 && !v.includes('lol'), 60000);
log(`4 restyled after ${((Date.now() - t0) / 1000).toFixed(1)} s:`, JSON.stringify(restyled));
await page.keyboard.press('Enter'); // immediately, like a fast user
await page.waitForTimeout(900);
log('4 sent (fast Enter):', (await sent()).at(-1) === restyled.trim(), '| box:', JSON.stringify(await box()));

// 4b. Press Enter twice in a row: the 2nd Enter means "send when ready"
await page.keyboard.type('my coworker jenny lopez keeps taking credit for my work, how do i handle it', { delay: 3 });
await page.waitForTimeout(500);
await page.keyboard.press('Enter');
await page.waitForTimeout(300);
await page.keyboard.press('Enter');
await page.screenshot({ path: join(OUT, 'a4b-queued.png') });
const n4 = (await sent()).length;
for (let i = 0; i < 150 && (await sent()).length === n4; i++) await page.waitForTimeout(200);
log('4b sent automatically after 2nd Enter:', (await sent()).at(-1), '| box:', JSON.stringify(await box()));

// 5. Auto-send
await setS({ autoSend: true });
await page.waitForTimeout(300);
await page.keyboard.type('please email sarah connor the invoice today', { delay: 3 });
await page.waitForTimeout(500);
const before = (await sent()).length;
await page.keyboard.press('Enter');
for (let i = 0; i < 150 && (await sent()).length === before; i++) await page.waitForTimeout(200);
log('5 auto-sent:', (await sent()).at(-1), '| box:', JSON.stringify(await box()));
await ctx.close(); server.close();
