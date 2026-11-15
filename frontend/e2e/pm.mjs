// Real ProseMirror editor (like ChatGPT/Claude): Enter sends, Shift+Enter = newline.
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const EXT = process.env.EXT ?? new URL('../dist/chrome-mv3', import.meta.url).pathname;
const OUT = process.argv[2] ?? '.';
const bundle = readFileSync(new URL('./' + (process.env.BUNDLE ?? 'pm-bundle.js'), import.meta.url));
const html = `<!doctype html><html><head><meta charset="utf-8"><title>pm chat</title>
<style>.ProseMirror{border:1px solid #ccc;min-height:60px;padding:8px;white-space:pre-wrap} .ProseMirror p{margin:0}</style></head>
<body style="font:15px system-ui;padding:24px;max-width:760px"><h3 style="margin-top:50px">Chat</h3><div id="editor"></div>
<h3>Sent</h3><ol id="sent"></ol><script src="/pm.js"></script></body></html>`;
const server = http.createServer((q, r) => {
  if (q.url === '/pm.js') { r.writeHead(200, { 'content-type': 'text/javascript' }); return r.end(bundle); }
  r.writeHead(200, { 'content-type': 'text/html' }); r.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(OUT, 'profile-')), {
  channel: 'chromium', headless: true, viewport: { width: 1000, height: 700 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const log = (...a) => console.log('[pm]', ...a);
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.waitForSelector('text=✓ Ready', { timeout: 240000 });
await opt.evaluate(async () => {
  const s = (await chrome.storage.local.get('settings')).settings ?? {};
  await chrome.storage.local.set({ settings: { ...s, sites: { ...(s.sites ?? {}), '127.0.0.1': true }, defaultStyle: 'off', autoMode: false } });
});
// Treat 127.0.0.1 like a chat site (Enter sends) for this test.
const page = await ctx.newPage();
await page.addInitScript(() => { window.__nobodyEnterSends = true; });
await page.goto(url + '?' + (process.env.FOCUS_END ? 'focusEnd=1&' : '') + (process.env.BEFOREINPUT ? 'beforeinput=1' : ''));
const sent = () => page.locator('#sent li').allInnerTexts();
const text = () => page.evaluate(() => window.pmText());
const panel = () => page.evaluate(() => Boolean(document.getElementById('nobody-root')));

// 1. lowercase name, pause, Enter → held → Enter (replace) → editor must contain ONLY the clean text
await page.click('#prompt-textarea');
await page.keyboard.type('please email john smith at john.smith@acme.com about it', { delay: 10 });
await page.waitForTimeout(1200);
log('1 underline count:', await page.evaluate(() => CSS.highlights.get('nobody-typed')?.size ?? 0));
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
log('1 held:', (await sent()).length === 0, '| panel:', await panel());
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
log('1 editor after replace:', JSON.stringify(await text()));
await page.screenshot({ path: join(OUT, 'pm-after-replace.png') });
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
log('1 sent:', await sent());

// 2. type and press Enter immediately (no pause)
await page.keyboard.type('ask sarah connor to call me', { delay: 3 });
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
log('2 held without pause:', await panel(), '| sent count:', (await sent()).length);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
log('2 editor kept after cancel:', JSON.stringify(await text()));

// 3. clean message + immediate Enter → sent once, editor emptied
await page.evaluate(() => { const sel = getSelection(); sel.selectAllChildren(document.getElementById('prompt-textarea')); });
await page.keyboard.press('Backspace');
await page.keyboard.type('what is a good name for a cat', { delay: 3 });
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
log('3 clean sent:', (await sent()).at(-1), '| editor:', JSON.stringify(await text()));

// 4. Shift+Enter is never intercepted
await page.keyboard.type('line one', { delay: 3 });
await page.keyboard.press('Shift+Enter');
await page.keyboard.type('line two', { delay: 3 });
log('4 multiline:', JSON.stringify(await text()));
await page.evaluate(() => { getSelection().selectAllChildren(document.getElementById('prompt-textarea')); });
await page.keyboard.press('Backspace');

// 5. right after page load: type + Enter immediately
const page2 = await ctx.newPage();
await page2.addInitScript(() => { window.__nobodyEnterSends = true; });
await page2.goto(url);
await page2.click('#prompt-textarea');
await page2.keyboard.type('email bob jones now', { delay: 3 });
await page2.keyboard.press('Enter');
await page2.waitForTimeout(1500);
log('5 fresh page held:', await page2.evaluate(() => Boolean(document.getElementById('nobody-root'))), '| sent:', await page2.locator('#sent li').allInnerTexts());

// 6. paste into ProseMirror
await page.bringToFront();
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
await page.click('#prompt-textarea');
await page.evaluate(() => navigator.clipboard.writeText('my manager miles dyson wants the report, email miles@cyberdyne.com'));
await page.keyboard.press('ControlOrMeta+V');
await page.waitForTimeout(1500);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
log('6 pasted into PM:', JSON.stringify(await text()));

await ctx.close(); server.close();
