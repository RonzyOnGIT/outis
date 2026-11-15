import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
const EXT = process.env.EXT ?? new URL('../dist/chrome-mv3', import.meta.url).pathname;
const PROFILE = new URL('./llm-profile', import.meta.url).pathname;
mkdirSync(PROFILE, { recursive: true });
const ctx = await chromium.launchPersistentContext(PROFILE, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--enable-unsafe-webgpu'] });
let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
const opt = await ctx.newPage();
await opt.goto(`chrome-extension://${new URL(sw.url()).host}/options.html`).catch(() => {});
await opt.waitForSelector('text=✓ Ready', { timeout: 240000 });
const call = (msg) => opt.evaluate(async (m) => { await chrome.runtime.sendMessage({ type: 'ensureOffscreen' }); return chrome.runtime.sendMessage({ target: 'offscreen', ...m }); }, msg);
const model = process.env.MODEL ?? 'Qwen3.5-2B-q4f16_1-MLC';
let t = Date.now();
const prep = await call({ type: 'llm.prepare', modelId: model });
console.log(`model ${model} ready in ${((Date.now() - t) / 1000).toFixed(0)} s (${prep?.data?.tokensPerSecond} tok/s)`);
const HIDDEN = "So, I need help writing an appeal letter to my insurance — they denied my claim again. Honestly, I'm exhausted. My name is [PERSON_1], DOB [DATE_1], and my member ID is [ID_1]. I live at [ADDRESS_1]. Phone is [PHONE_1], email is [EMAIL_1]. The claim was for my MRI on [DATE_2] at [ORG_1] — $2,340. They said it wasn't \"medically necessary.\" It was. My doctor, Dr. [PERSON_2], ordered it after three months of back pain and numbness in my left leg. She suspects a herniated disc at L4-L5. I also take gabapentin 300mg twice a day for the nerve pain. I work at [ORG_2] as a warehouse supervisor — I've already missed six shifts because of this. HR asked for my SSN for the leave paperwork, it's [ID_2], if that matters for the letter. Can you make it firm but polite? I don't want to sound desperate. Just clear. Deadline to appeal is [DATE_3].";
for (const mode of ['all', 'auto']) {
  t = Date.now();
  const r = await call({ type: 'rewrite', text: HIDDEN, modelId: model, mode });
  console.log(`\n=== mode ${mode}: ${((Date.now() - t) / 1000).toFixed(1)} s, all model sentences passed: ${r.data.rewritten}`);
  console.log(r.data.text);
  if (r.data.problems?.length) console.log('rejected because:', r.data.problems.slice(0, 6).join(' | '));
}
await ctx.close();
