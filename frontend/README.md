# Nobody — browser extension (`frontend/`)

Hides names, emails, addresses, IDs, secrets **and your writing style** before you paste into ChatGPT, Claude, Gmail, GitHub and other sites. Everything runs locally in the browser; no text ever leaves the device.

## Run the demo

```bash
# from the repo root
npm install
npm run build        # builds backend (engine) then frontend (extension)
```

Then in Chrome or Edge: `chrome://extensions` → enable **Developer mode** → **Load unpacked** → pick `frontend/dist/chrome-mv3` (in the macOS picker press ⌘⇧G and paste the full path).

The setup page opens automatically:
1. It checks the device (WebGPU, GPU type, memory) and downloads the name detector (110 MB, once).
2. Pick a writing-style model — **Light** (no AI), **Fast** (Qwen3.5 2B, 1.1 GB), **Balanced** (Qwen3.5 4B, 2.4 GB) or **Quality** (Qwen3 8B, 4.6 GB). Each card says how well it fits this device; *Download & test* measures real speed.
3. Add your own name/company under *Always hide*.

Then paste text into chatgpt.com (or another AI chat: Claude, Gemini, Copilot, Perplexity, DeepSeek, Mistral — more sites can be added in settings). A review panel shows what was found, what the site will see, and lets you choose the writing style. `Enter` pastes the safe version, `Esc` cancels.

**Typed text** is checked as you type, like a spell checker:
- personal info gets a wavy underline (rich editors) and a "2 personal items · Review" badge appears by the box;
- sending is held while personal info is in the box: plain Enter on AI chat sites, Ctrl/⌘+Enter anywhere, and Send / submit buttons. The review panel then offers **Replace with safe text** or **Keep my text**;
- if you send right after typing, before the background check has run, Nobody holds the send, checks (~20–50 ms) and sends it again automatically when the text is clean.

`Alt+Shift+N` checks the focused box on demand.

**Memory of real values** (Settings → *When you paste or type*):
| Option | What is kept | Consistent placeholders / hover restore |
|---|---|---|
| Until I close the browser (default) | `chrome.storage.session`: RAM only, never written to disk | ✓ |
| Forget right after replacing | only placeholder counters, no real values | ✗ |
| Remember on this device | `chrome.storage.local` until *Forget* | ✓ |

Whenever memory is not "device", the background wipes any mapping left on disk.

`npm run dev` (repo root) starts WXT with hot reload in a fresh browser profile.

## How it works

```
web page ──paste──► content script (capture phase, before the site sees it)
                     │  review panel in a closed shadow root (the page can't read it)
                     ▼
               offscreen document = local "backend" (one per browser)
                     │  @nobody/engine: rules + NER (WASM) → placeholders → rewrite (WebGPU)
                     ▼
               clean text inserted into the page's editor
```

| Path | What it does |
|---|---|
| `entrypoints/content/` | Paste interception, typed-text guard (`typing.ts`, `fieldtext.ts`), insertion into textarea / contenteditable (ProseMirror, Gmail), review panel, hover-to-restore |
| `entrypoints/offscreen/` | Hosts the models via `@nobody/engine/runtime` |
| `entrypoints/background.ts` | Creates the offscreen doc, relays progress, keyboard shortcut |
| `entrypoints/options/` | Setup: device check, model picker with download + speed test, hide lists, sites, playground |
| `entrypoints/popup/` | Per-site toggle, style mode, forget placeholders |
| `lib/` | Settings + placeholder vault storage, messaging, DOM helper, shared CSS |

**Restoring answers.** Placeholders in AI answers are tinted; hover shows the real value in a tooltip that lives in our closed shadow root, so analytics or session-replay scripts on the site never see real values. "Show real values in the page" is an opt-in setting.

## Known limits (demo)

- Name detection is English-only (`bert-base-NER-uncased`). A multilingual model is a drop-in swap (+30 MB).
- Files and screenshots aren't handled yet.
- Plain Enter is guarded only on known chat sites (elsewhere it's a newline); other sites rely on Ctrl/⌘+Enter and Send/submit buttons. Sites with unusual send buttons may need a selector added in `isSendButton`.
- A site's own "Copy" button copies the placeholder version.
- Chrome/Edge only (needs the `offscreen` API); Firefox needs a background-page variant.
- WebLLM fetches each model's small runtime library from GitHub at first load; a store release should bundle those.
