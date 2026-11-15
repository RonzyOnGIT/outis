// E2E: typed-text guard + memory modes.
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const EXT = process.env.EXT ?? new URL('../dist/chrome-mv3', import.meta.url).pathname;
const OUT = process.argv[2] ?? '.';
const html = `<!doctype html><html><head><meta charset="utf-8"><title>chat test</title></head>
<body style="font:15px system-ui;padding:24px;max-width:760px">
<h3 style="margin-top:60px">Chat composer</h3>
<div id="ce" contenteditable="true" style="border:1px solid #ccc;min-height:60px;padding:8px"></div>
<button id="send" aria-label="Send message">➤</button>
<h3>Sent messages</h3><ol id="sent"></ol>
<script>
  const ce = document.getElementById('ce'), sent = document.getElementById('sent');
  const send = () => { if (!ce.innerText.trim()) return; const li = document.createElement('li'); li.textContent = ce.innerText.trim(); sent.append(li); ce.innerHTML = ''; };
  ce.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); send(); } });
  document.getElementById('send').addEventListener('click', send);
</script></body></html>`;

const server = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(html); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(OUT, 'profile-')), {
  channel: 'chromium', headless: true, viewport: { width: 1000, height: 700 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const log = (...a) => console.log('[typing]', ...a);
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;

const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${extId}/options.html`);
await opt.waitForSelector('text=✓ Ready', { timeout: 240000 });
const setSettings = (patch) => opt.evaluate(async (p) => {
  const s = (await chrome.storage.local.get('settings')).settings ?? {};
  await chrome.storage.local.set({ settings: { ...s, ...p } });
}, patch);
await setSettings({ allSites: true, defaultStyle: 'off', autoMode: false });
const storage = () => opt.evaluate(async () => ({
  local: Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith('vault:')),
  session: await chrome.storage.session.get(null),
}));

const page = await ctx.newPage();
page.on('console', (m) => m.text().includes('Nobody') && log('page console:', m.text()));
await page.goto(url);
await page.waitForTimeout(800);
const sentList = () => page.locator('#sent li').allInnerTexts();
const panelOpen = () => page.evaluate(() => Boolean(document.getElementById('nobody-root')));
const ceText = () => page.locator('#ce').innerText();

// A. typing shows underline + badge
await page.click('#ce');
await page.keyboard.type('Please email John Smith at john.smith@acme.com tomorrow', { delay: 15 });
await page.waitForTimeout(1200);
log('A highlights:', await page.evaluate(() => CSS.highlights.get('nobody-typed')?.size ?? 0),
    '| badge:', await page.evaluate(() => Boolean(document.getElementById('nobody-badge'))));
await page.screenshot({ path: join(OUT, 'typing-badge.png') });

// B. Cmd+Enter is blocked → panel → Enter replaces → Cmd+Enter sends the clean text
await page.keyboard.press('ControlOrMeta+Enter');
await page.waitForTimeout(700);
log('B blocked:', (await sentList()).length === 0, '| panel open:', await panelOpen());
await page.screenshot({ path: join(OUT, 'typing-send-guard.png') });
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
log('B field after replace:', JSON.stringify(await ceText()));
await page.keyboard.press('ControlOrMeta+Enter');
await page.waitForTimeout(800);
log('B sent:', await sentList());

// C. type fast and send immediately (no pause) → still caught
await page.click('#ce');
await page.keyboard.type('Call Maria Garcia about the contract', { delay: 5 });
await page.keyboard.press('ControlOrMeta+Enter');
await page.waitForTimeout(900);
log('C caught without pause:', await panelOpen(), '| sent count:', (await sentList()).length);
// While the review is open, the page's Send button must not send the original.
await page.click('#send');
await page.waitForTimeout(300);
log('C send button blocked while panel open:', (await sentList()).length === 1);
await page.keyboard.press('Escape');
await page.waitForTimeout(400);
log('C cancel keeps text:', JSON.stringify(await ceText()), '| panel closed:', !(await panelOpen()));
await page.keyboard.press('ControlOrMeta+Enter');
await page.waitForTimeout(700);
log('C still held after cancel:', await panelOpen(), '| sent count:', (await sentList()).length);
await page.keyboard.press('Escape');
await page.waitForTimeout(300);
await page.evaluate(() => { document.getElementById('ce').innerHTML = ''; });

// D. clean text typed + immediate send → goes through (re-sent after the check)
await page.click('#ce');
await page.keyboard.type('Thanks, that works for me', { delay: 5 });
await page.keyboard.press('ControlOrMeta+Enter');
await page.waitForTimeout(900);
log('D clean sent:', (await sentList()).at(-1), '| panel:', await panelOpen());

// E. Send button with personal info → blocked
await page.click('#ce');
await page.keyboard.type('My phone is +1 415 555 0199', { delay: 5 });
await page.waitForTimeout(800);
await page.click('#send');
await page.waitForTimeout(700);
log('E button blocked:', await panelOpen(), '| sent count:', (await sentList()).length);
await page.keyboard.press('Enter'); // replace
await page.waitForTimeout(700);
await page.click('#send');
await page.waitForTimeout(700);
log('E sent after replace:', (await sentList()).at(-1));

// F. memory = session (default): nothing on disk
const st = await storage();
log('F local vault keys:', st.local, '| session vault entries:', Object.values(st.session).map((v) => v.entries.map((e) => `${e.placeholder}=${e.value}`)));

// G. memory = none: entries dropped after replacing, counters kept
await setSettings({ memory: 'none' });
await page.waitForTimeout(300);
await page.click('#ce');
await page.keyboard.type('Ask Bruce Wayne to call', { delay: 5 });
await page.keyboard.press('ControlOrMeta+Enter');
await page.waitForTimeout(900);
await page.keyboard.press('Enter');
await page.waitForTimeout(800);
log('G field:', JSON.stringify(await ceText()));
const st2 = await storage();
log('G session vault after replace:', JSON.stringify(Object.values(st2.session)));

await ctx.close(); server.close();
