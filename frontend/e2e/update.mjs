// Extension reloaded while a chat tab stays open (like clicking ↻ in chrome://extensions).
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXT = process.env.EXT ?? new URL('../dist/chrome-mv3', import.meta.url).pathname;
const OUT = process.argv[2] ?? '.';
const bundle = readFileSync(new URL('./' + (process.env.BUNDLE ?? 'pm-bundle.js'), import.meta.url));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>pm chat</title>
<style>.ProseMirror{border:1px solid #ccc;min-height:60px;padding:8px;white-space:pre-wrap} .ProseMirror p{margin:0}</style></head>
<body style="font:15px system-ui;padding:24px;max-width:760px"><h3 style="margin-top:420px">Chat</h3><div id="editor"></div>
<h3>Sent</h3><ol id="sent"></ol><script src="/pm.js"></script></body></html>`;
const server = http.createServer((q, r) => {
  if (q.url.startsWith('/pm.js')) { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(bundle); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/?focusEnd=1&beforeinput=1`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(OUT, 'profile-')), {
  channel: 'chromium', headless: true, viewport: { width: 1000, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const log = (...a) => console.log('[upd]', ...a);
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
let opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.waitForSelector('text=✓ Ready', { timeout: 240000 });
await opt.evaluate(async () => {
  const s = (await chrome.storage.local.get('settings')).settings ?? {};
  await chrome.storage.local.set({ settings: { ...s, sites: { ...(s.sites ?? {}), '127.0.0.1': true }, defaultStyle: 'off' } });
});

const page = await ctx.newPage();
const consoleLines = [];
page.on('console', (m) => consoleLines.push(`${m.type()}: ${m.text()}`));
page.on('pageerror', (e) => consoleLines.push(`pageerror: ${e.message}`));
await page.goto(url);
await page.waitForTimeout(800);
const text = () => page.evaluate(() => window.pmText());
const panel = () => page.evaluate(() => Boolean(document.getElementById('nobody-root')));

const MODE = process.env.MODE ?? 'inject';
if (MODE === 'inject') {
  // (b) What onInstalled does after an update: inject a fresh copy into the open tab.
  const res = await opt.evaluate(async () => {
    const tabs = await chrome.tabs.query({});
    const files = chrome.runtime.getManifest().content_scripts.flatMap((c) => c.js);
    const out = [];
    for (const t of tabs) {
      if (!/^https?:/.test(t.url ?? 'https:')) continue;
      try { await chrome.scripting.executeScript({ target: { tabId: t.id }, files }); out.push('ok'); } catch (e) { out.push(String(e)); }
    }
    return out;
  });
  log('injected:', res);
} else {
  // (a) Extension goes away (update without re-injection): old copy must warn.
  await opt.evaluate(() => chrome.runtime.reload()).catch(() => {});
}
await page.waitForTimeout(2500);

await page.click('#prompt-textarea');
await page.keyboard.type('please tell john smith the report is late', { delay: 10 });
await page.waitForTimeout(2500);
log('underlines:', await page.evaluate(() => CSS.highlights.get('nobody-typed')?.size ?? 0));
await page.screenshot({ path: join(OUT, `after-${MODE}.png`) });
if (MODE === 'inject') {
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1500);
  log('held:', await panel(), '| sent:', await page.locator('#sent li').allInnerTexts());
  await page.keyboard.press('Enter');
  await page.waitForTimeout(1000);
  log('editor after replace:', JSON.stringify(await text()));
  await page.keyboard.press('Enter');
  await page.waitForTimeout(800);
  log('sent:', await page.locator('#sent li').allInnerTexts());
}
log('console:', consoleLines.filter((l) => /Nobody|error/i.test(l)));
await ctx.close(); server.close();
