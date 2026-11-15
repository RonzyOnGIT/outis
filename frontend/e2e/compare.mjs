import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const EXT = process.env.EXT ?? new URL('../dist/chrome-mv3', import.meta.url).pathname;
const PROFILE = new URL('./llm-profile', import.meta.url).pathname;
mkdirSync(PROFILE, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu'],
});
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`).catch(() => {});
await opt.waitForSelector('text=✓ Ready', { timeout: 240000 });
const call = (msg) => opt.evaluate(async (m) => {
  await chrome.runtime.sendMessage({ type: 'ensureOffscreen' });
  return chrome.runtime.sendMessage({ target: 'offscreen', ...m });
}, msg);
const texts = [
  'So, I need help writing an appeal letter to my insurance — they denied my claim again. Honestly, I\'m exhausted. My name is [PERSON_1], DOB [DATE_1], and my member ID is [ID_1]. HR asked for my SSN for the leave paperwork, it\'s [ID_2], if that matters for the letter. Can you make it firm but polite? I don\'t want to sound desperate. Just clear. Deadline to appeal is [DATE_3].',
  'can you tell [PERSON_1] that the shipment from our warehouse is delayed until next monday please',
  'my coworker [PERSON_1] keeps taking credit for my work, how do i handle it without making things weird',
];
for (const model of ['Qwen3.5-2B-q4f16_1-MLC', 'Qwen3.5-4B-q4f16_1-MLC']) {
  const t0 = Date.now();
  const prep = await call({ type: 'llm.prepare', modelId: model });
  console.log(`\n=== ${model} (ready in ${((Date.now() - t0) / 1000).toFixed(0)} s, ${prep?.data?.tokensPerSecond} tok/s)`);
  for (const t of texts) {
    const t1 = Date.now();
    const r = await call({ type: 'rewrite', text: t, modelId: model });
    console.log(`  [${((Date.now() - t1) / 1000).toFixed(1)} s${r.data.rewritten ? '' : ', partly Light'}] ${r.data.text}`);
  }
}
await ctx.close();
