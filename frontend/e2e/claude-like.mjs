import { chromium } from 'playwright';
import http from 'node:http';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
const EXT = process.env.EXT ?? new URL('../dist/chrome-mv3', import.meta.url).pathname;
const OUT = process.argv[2] ?? '.';
const PROFILE = new URL('./llm-profile', import.meta.url).pathname;
const bundle = readFileSync(new URL('./tt-bundle.js', import.meta.url));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>claude-like</title>
<style>.ProseMirror{border:1px solid #ccc;min-height:60px;padding:8px;white-space:pre-wrap} .ProseMirror p{margin:0}</style></head>
<body style="font:15px system-ui;padding:24px;max-width:760px"><h3 style="margin-top:300px">Chat</h3><div id="editor"></div>
<h3>Sent</h3><ol id="sent"></ol><script src="/b.js"></script></body></html>`;
const server = http.createServer((q, r) => {
  if (q.url.startsWith('/b.js')) { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(bundle); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(html);
});
await new Promise((r) => server.listen(18767, '127.0.0.1', r));
const url = `http://127.0.0.1:18767/?focusEnd=1&siteinsert=1`;
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium', headless: true, viewport: { width: 1000, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu'],
});
const log = (...a) => console.log('[claude-like]', ...a);
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`).catch(() => opt.goto(`chrome-extension://${extId}/options.html`));
await opt.waitForSelector('text=✓ Ready', { timeout: 240000 });
await opt.evaluate(async () => {
  const s = (await chrome.storage.local.get('settings')).settings ?? {};
  await chrome.storage.local.set({ settings: { ...s, sites: { ...(s.sites ?? {}), '127.0.0.1': true }, defaultStyle: 'light', autoMode: true, autoSend: false } });
  await chrome.storage.session.remove('nobody:diag');
});
const page = await ctx.newPage();
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: 'http://127.0.0.1:18767' });
await page.goto(url);
const box = () => page.evaluate(() => window.pmText());
await page.click('#prompt-textarea');

// Paste: the site ALSO inserts the original itself.
const ORIGINAL = 'Hi, I am Daniel Reyes, member ID BCX-4471-0923, please help me appeal the denied claim from September 22.';
await page.evaluate((t) => navigator.clipboard.writeText(t), ORIGINAL);
await page.keyboard.press('ControlOrMeta+V');
await page.waitForTimeout(3000);
log('paste → box:', JSON.stringify(await box()));

// Typed + Enter (automatic mode): replace through the editor API.
await page.keyboard.press('ControlOrMeta+A'); await page.keyboard.press('Backspace');
await page.keyboard.type('please email john smith at john.smith@acme.com about the contract today', { delay: 3 });
await page.waitForTimeout(600);
await page.keyboard.press('Enter');
await page.waitForTimeout(2500);
log('typed → box:', JSON.stringify(await box()));
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
log('sent:', await page.locator('#sent li').allInnerTexts());
const diagLines = await opt.evaluate(async () => (await chrome.storage.session.get('nobody:diag'))['nobody:diag'] ?? []);
for (const d of diagLines) if (/editor-api|replace-|clear-|paste-box|visible/.test(d.step)) log('diag', JSON.stringify(d));
await ctx.close(); server.close();
