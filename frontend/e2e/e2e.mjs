// End-to-end check of the built extension in Chromium (headless, new mode).
import { chromium } from 'playwright';
import http from 'node:http';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';

const EXT = process.env.EXT ?? new URL('../dist/chrome-mv3', import.meta.url).pathname;
const OUT = process.argv[2] ?? '.';
const WITH_LLM = process.env.WITH_LLM === '1';
const HEADED = process.env.HEADED === '1';

const SAMPLE = `Hi, I'm Sarah Connor from Cyberdyne Systems in Los Angeles. My manager Miles Dyson wants the Q3 report by Friday lol, can u help me write an email to Miles? Reach me at sarah.connor@cyberdyne.com or +1 213 555 0147.`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Nobody test page</title></head>
<body style="font:15px system-ui;padding:24px;max-width:760px">
<h3>Plain textarea</h3><textarea id="ta" rows="6" style="width:100%"></textarea>
<h3>Rich editor (contenteditable)</h3><div id="ce" contenteditable="true" style="border:1px solid #ccc;min-height:70px;padding:8px"></div>
<h3>AI answer</h3><div id="answer" style="margin-top:400px">Sure! Here is a draft for [PERSON_2]: the report from [ORG_1] will be late. Contact: [EMAIL_1].</div>
</body></html>`;

const server = http.createServer((_req, res) => {
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end(html);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const ctx = await chromium.launchPersistentContext(mkdtempSync(join(OUT, 'profile-')), {
  channel: 'chromium',
  headless: !HEADED,
  viewport: { width: 1100, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu', '--enable-features=Vulkan'],
});
const log = (...a) => console.log('[e2e]', ...a);
ctx.on('console', (m) => log('console', m.type(), m.text().slice(0, 300)));

let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const extId = new URL(sw.url()).host;
log('extension id', extId);

// --- Setup page ---
const options = await ctx.newPage();
options.on('console', (m) => log('options', m.type(), m.text().slice(0, 300)));
await options.goto(`chrome-extension://${extId}/options.html`);
await options.waitForSelector('.device', { timeout: 30000 });
log('DEVICE:\n' + (await options.locator('.device').innerText()));
const t0 = Date.now();
await options.waitForSelector('text=✓ Ready', { timeout: 240000 });
log(`name detector ready after ${((Date.now() - t0) / 1000).toFixed(1)} s`);
log('MODELS:\n' + (await options.locator('.models').innerText()));
await options.screenshot({ path: join(OUT, 'options.png'), fullPage: true });

// Enable every site (the test page is on 127.0.0.1).
await options.evaluate(async () => {
  const s = (await chrome.storage.local.get('settings')).settings ?? {};
  await chrome.storage.local.set({ settings: { ...s, allSites: true, autoMode: false } });
});

// Playground
await options.click('button:has-text("Anonymize")');
await options.waitForSelector('.play .out .ph', { timeout: 30000 });
log('PLAYGROUND:\n' + (await options.locator('.play .out').first().innerText()));

if (WITH_LLM) {
  const fast = options.locator('.model', { hasText: 'Fast' });
  await fast.click();
  await fast.locator('button', { hasText: /Download|Test speed/ }).first().click();
  const t1 = Date.now();
  await options.waitForSelector('.speed', { timeout: 900000 });
  log(`LLM ready after ${((Date.now() - t1) / 1000).toFixed(0)} s:`, await options.locator('.speed').first().innerText());
}

// --- Paste into a textarea ---
const page = await ctx.newPage();
await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: url });
await page.goto(url);
await page.waitForTimeout(500);
await page.evaluate((t) => navigator.clipboard.writeText(t), SAMPLE);
await page.click('#ta');
await page.keyboard.press('ControlOrMeta+V');
await page.waitForTimeout(WITH_LLM ? 1500 : 2500);
await page.screenshot({ path: join(OUT, 'panel-textarea.png') });
if (WITH_LLM) {
  // Wait for the AI rewrite to finish (primary button re-enabled), then screenshot.
  await page.waitForTimeout(25000);
  await page.screenshot({ path: join(OUT, 'panel-ai.png') });
}
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
log('TEXTAREA VALUE:\n' + (await page.inputValue('#ta')));

// --- Paste into a contenteditable ---
await page.click('#ce');
await page.keyboard.press('ControlOrMeta+V');
await page.waitForTimeout(WITH_LLM ? 30000 : 2500);
await page.keyboard.press('Enter');
await page.waitForTimeout(600);
log('CONTENTEDITABLE:\n' + (await page.locator('#ce').innerText()));

// --- Restore on hover ---
await page.locator('#answer').scrollIntoViewIfNeeded();
await page.waitForTimeout(800);
const hl = await page.evaluate(() => (CSS.highlights?.get('nobody-placeholder')?.size ?? -1));
log('placeholder highlights on page:', hl);
const box = await page.evaluate(() => {
  const n = document.getElementById('answer').firstChild;
  const i = n.data.indexOf('[PERSON_2]');
  const r = new Range();
  r.setStart(n, i + 2);
  r.setEnd(n, i + 3);
  const b = r.getBoundingClientRect();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
});
await page.mouse.move(box.x, box.y);
await page.waitForTimeout(400);
await page.screenshot({ path: join(OUT, 'restore-hover.png') });
log('answer DOM text (must still contain placeholders):', await page.locator('#answer').innerText());

// --- Popup ---
const popup = await ctx.newPage();
await popup.setViewportSize({ width: 360, height: 420 });
await popup.goto(`chrome-extension://${extId}/popup.html`);
await popup.waitForTimeout(500);
await popup.screenshot({ path: join(OUT, 'popup.png') });

await ctx.close();
server.close();
log('done');
