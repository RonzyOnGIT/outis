import { createRequire } from 'node:module';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { defineConfig } from 'wxt';

/** Absolute path of ONNX Runtime's wasm (a dependency of @nobody/engine), so it can be bundled locally. */
function ortWasmPath(): string {
  const engineDir = dirname(realpathSync(createRequire(import.meta.url).resolve('@nobody/engine/package.json')));
  for (let dir = engineDir; dirname(dir) !== dir; dir = dirname(dir)) {
    const file = join(dir, 'node_modules', 'onnxruntime-web', 'dist', 'ort-wasm-simd-threaded.asyncify.wasm');
    if (existsSync(file)) return file;
  }
  throw new Error('onnxruntime-web not found — run npm install in nobody-engine');
}

export default defineConfig({
  // Visible folder (macOS hides ".output" in the Load-unpacked picker).
  outDir: 'dist',
  manifest: {
    name: 'Nobody',
    description:
      'Hides names, emails, addresses, IDs and your writing style before you paste into AI chats, email or bug trackers. 100% local.',
    // scripting: put Nobody into tabs that were already open when it was installed/updated.
    permissions: ['storage', 'unlimitedStorage', 'offscreen', 'scripting'],
    // Model weights are fetched once from Hugging Face; everything else is bundled.
    host_permissions: ['https://huggingface.co/*', 'https://*.hf.co/*', 'https://raw.githubusercontent.com/*'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    action: { default_title: 'Nobody' },
    commands: {
      'scrub-field': {
        suggested_key: { default: 'Alt+Shift+N' },
        description: 'Anonymize the text in the focused input box',
      },
    },
  },
  vite: () => ({
    resolve: { alias: [{ find: /^virtual-ort-wasm(?=\?|$)/, replacement: ortWasmPath() }] },
    build: { target: 'es2022', chunkSizeWarningLimit: 8000 },
    worker: { format: 'es' },
  }),
});
