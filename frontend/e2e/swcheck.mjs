import { chromium } from 'playwright';
import { mkdtempSync } from 'node:fs';
const EXT = process.env.EXT ?? new URL('../dist/chrome-mv3', import.meta.url).pathname;
for (const [label, dir] of [['reused profile', new URL('./llm-profile', import.meta.url).pathname], ['fresh profile', mkdtempSync(new URL('./p-', import.meta.url).pathname)]]) {
  const ctx = await chromium.launchPersistentContext(dir, { channel: 'chromium', headless: true, args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`] });
  let [sw] = ctx.serviceWorkers(); if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const info = await sw.evaluate(async () => ({
    version: chrome.runtime.getManifest().version,
    onConnectListeners: chrome.runtime.onConnect.hasListeners(),
    script: (await (await fetch(location.href)).text()).includes('nobody-edit'),
  }));
  console.log(label, JSON.stringify(info));
  await ctx.close();
}
