# Nobody (repo: outis): project report

*Context update: version 0.5.1 · branch `feat/context-aware-privacy`*

This branch adds context-sensitive date and public-reference handling for chat and document text.
See [CONTEXT.md](CONTEXT.md) for behavior, override precedence, migration and verification.
Version 0.5.1 fixes routing-label line-wrap misses, adds vehicle and lease identifier detection,
and protects complete street addresses with single-letter directions.

The original report below describes the text workflow. Version 0.4 adds attachment interception
before upload and reviewed, anonymized `.txt` copies from PDF, Office/OpenDocument, RTF and text
formats. See [DOCUMENTS.md](DOCUMENTS.md) for the implementation, limits and verification coverage.
The 0.4.1 build addresses on-page UI reported as hidden/zero-sized on Claude and Gemini and adds
visible, bounded document-processing waits. The matching regression passes locally; recheck live sites.

This report describes what is in the repository, how every part works, how to build and test it, what works today, and what is left to do. It is written so that someone new to the project can continue without any other context.

---

## 1. What Nobody is

Nobody is a **Chrome/Edge browser extension** that protects you before you send text to an AI chat (ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek, Mistral):

1. **Personal info → placeholders.** Names, organisations, places, addresses, emails, phones, card numbers, IBANs, IDs/SSNs, dates, secrets/API keys, IPs and usernames in file paths are replaced with consistent placeholders such as `[PERSON_1]`, `[EMAIL_1]`. The same person keeps the same placeholder across messages.
2. **Writing style → neutral.** The text is rewritten into one plain, everyday voice (the *Outis neutralizer*), so services cannot recognise the author by their writing habits.
3. **Answers stay readable.** Placeholders in the AI's answer can be hovered to show the real value. Only the user sees it.
4. **100 % local.** All models run inside the browser (WebAssembly + WebGPU). There is no server and no account. The only network traffic is the one-time model download from Hugging Face (and WebLLM's small model libraries from GitHub).

### Current status (honest)

| Area | Status |
|---|---|
| Detection + placeholders | Works (unit-tested; verified on real claude.ai via diagnostics) |
| Automatic mode on **claude.ai** (Tiptap editor) | **Works**: the user confirmed the safe text replaces the original |
| **ChatGPT** | Not working reliably yet: its editor has no API like Tiptap's, so the DOM fallbacks are used and the text may be appended. Needs diagnostics from a real ChatGPT attempt (§10) |
| Top status bar / review panel on real sites | **Unconfirmed**: diagnostics show the code shows the bar, but the user did not see it. v0.3.0 switched to CSP-proof styles; awaiting a `bar-visible` diagnostic (§9) |
| Style neutralizer (Outis) | Integrated; tested with simulated models and with the real Qwen3.5-2B in the browser |
| Gemini / Copilot / Perplexity / DeepSeek / Mistral | Untested on the real sites |
| Document files | Local extraction and reviewed text-copy replacement; 14 formats; tested with a Chromium upload simulator |
| Screenshots / OCR | Not supported; unreadable/scanned PDF pages are blocked |

---

## 2. Repository layout

```
outis/
├── package.json              npm workspaces: backend + frontend; build/test scripts
├── README.md                 short user-facing readme (install, use)
├── docs/PROJECT_REPORT.md    this file
├── backend/                  @nobody/engine: TypeScript library, no UI
│   ├── src/
│   │   ├── types.ts              entity types, Span, policy defaults, labels
│   │   ├── index.ts              public exports (pure parts, safe for content scripts)
│   │   ├── detect/
│   │   │   ├── rules.ts          pattern recognizers (Presidio-style) + contextual 2nd pass
│   │   │   ├── validators.ts     Luhn, IBAN mod-97, entropy
│   │   │   ├── resolve.ts        dictionary, overlap resolution, propagation, filters
│   │   │   └── ner-align.ts      WordPiece token → character span alignment, BIO grouping
│   │   ├── pseudonymize/
│   │   │   ├── vault.ts          real value ⇄ placeholder map, name aliasing
│   │   │   └── anonymize.ts      replace spans, restore placeholders, find placeholders
│   │   ├── style/
│   │   │   ├── neutralizer.ts    ★ Outis neutralizer (TS port) — the style engine
│   │   │   ├── neutral.ts        ★ Nobody wrapper: protects code/logs/links, privacy checks
│   │   │   ├── protect.ts        code/log line detection (CODE_LINE), segment splitter
│   │   │   ├── rewrite.ts        legacy rewrite pipeline + shared types (Generate, RewriteResult)
│   │   │   └── normalize.ts      legacy "Light" normalizer (no longer used by the extension)
│   │   ├── models/
│   │   │   ├── catalog.ts        rewrite models (Light/Fast/Balanced/Quality) + NER model
│   │   │   └── device.ts         WebGPU probe, VRAM budget estimate, model fit ratings
│   │   └── runtime/              model-backed parts (import only where models live)
│   │       ├── ner.ts            NerDetector (Transformers.js, ONNX/WASM), configureOnnxWasm
│   │       ├── llm.ts            LocalLlm (WebLLM / WebGPU): load, generate, speed test
│   │       └── engine.ts         NobodyEngine: analyze() + rewrite() orchestration
│   └── test/                 vitest unit tests (59 pass) + optional real-NER integration test
└── frontend/                 the extension (WXT, Manifest V3)
    ├── wxt.config.ts         manifest (permissions, CSP, commands), Vite config, build stamp
    ├── entrypoints/
    │   ├── background.ts         service worker: router, offscreen, injection, main-world edits
    │   ├── offscreen/            hidden page that hosts the models (the local "backend")
    │   ├── content/              everything that runs inside chat pages
    │   │   ├── index.ts          wiring: flows (paste, typing, automatic mode, review), settings
    │   │   ├── insert.ts         writing into editors: editor API → DOM strategies, verification
    │   │   ├── typing.ts         typed-text guard: underline, badge, Enter/Send interception
    │   │   ├── panel.ts          review panel (closed shadow root)
    │   │   ├── topbar.ts         top status bar (loading → ready/warn)
    │   │   ├── restore.ts        hover/replace real values in AI answers
    │   │   ├── fieldtext.ts      read rich-editor text + map offsets → DOM ranges
    │   │   └── ui.ts             shadow hosts (top layer, constructed CSS), visibility diagnostics
    │   ├── options/              setup & settings page (device check, model picker, playground)
    │   └── popup/                toolbar popup (per-site toggle, style, diagnostics)
    ├── lib/
    │   ├── settings.ts           settings schema/defaults, vault storage per memory mode
    │   ├── messages.ts           typed engine API (content/pages → offscreen)
    │   ├── diag.ts               privacy-safe diagnostics log
    │   ├── dom.ts                tiny DOM helper h()
    │   └── page.css              shared styles for options/popup
    ├── public/icon/              icons (generated by scripts/make-icons.py)
    └── e2e/                      Playwright browser tests + chat-box simulators (§8.2)
```

Output of a build: `frontend/dist/chrome-mv3/` (load this folder in Chrome). About 34 MB, mostly the ONNX Runtime WebAssembly binary.

---

## 3. Build, install, run

```bash
cd outis
npm install            # installs both workspaces (links @nobody/engine into the frontend)
npm run build          # backend → backend/dist, then extension → frontend/dist/chrome-mv3
npm test               # backend unit tests
npm run test:ner       # downloads the real NER model and runs it in Node (optional)
npm run typecheck      # both packages
npm run dev            # extension with hot reload in a fresh browser profile (WXT)
```

**Install in Chrome:** `chrome://extensions` → Developer mode → **Load unpacked** → `outis/frontend/dist/chrome-mv3`. The setup page opens automatically.

**After changing code:** `npm run build`, then ↻ on the Nobody card, then reload chat tabs (v0.2+ also injects the new content script into open tabs automatically).

> **Important (found during development):** a long-installed unpacked extension can keep running a **stale cached background service worker** even after files change. Always bump the version in `frontend/package.json` (and `backend/package.json`) for user-facing builds; if behaviour looks old, **Remove** the extension and **Load unpacked** again (this deletes downloaded models, so they must be downloaded again in setup). The popup shows `Build <UTC timestamp>` and the diagnostics record the build that each page runs.

---

## 4. Architecture

```
 Chat page (claude.ai, chatgpt.com, …)
 ├─ content script (isolated world; registered at document_start)
 │    • paste interception, typed-text guard, automatic mode, review panel
 │    • UI in closed shadow roots, shown in the browser top layer
 │    • pattern detection fallback, neutralizer rules (Light) run here
 │          │ runtime.sendMessage                  │ runtime.connect('nobody-edit')
 │          ▼                                       ▼
 │   offscreen document (one per browser)      background service worker
 │    • NobodyEngine                             • creates offscreen doc, relays progress
 │      – NER (Transformers.js, WASM, CPU)       • injects content script into open tabs on update
 │      – LLM (WebLLM, WebGPU)                   • runs mainWorldEdit() INSIDE the page (MAIN world)
 │      – neutralizer with model                 • memory enforcement, session-storage access
 └─ page main world ◄── mainWorldEdit(): Tiptap editor.commands.setContent / clearContent / insertContent
```

Why an **offscreen document**: MV3 service workers are short-lived and have no DOM. The offscreen page keeps the models loaded once per browser (not per tab) with WebGPU/WASM access. Offscreen pages can only use `chrome.runtime`, so settings/vault are read by the content script and passed in requests.

Why **main world**: rich editors (ProseMirror/Tiptap) keep their own document model. Changing the DOM directly or with synthetic events can leave the editor's internal selection stale, and the text gets appended. Calling the editor's own API from the page context replaces the document reliably. Extension content scripts cannot reach the page's JS objects, so the background runs a function in the `MAIN` world via `chrome.scripting.executeScript` (requires `host_permissions`).

---

## 5. Engine (`backend/`)

### 5.1 Detection pipeline (`NobodyEngine.analyze`)

1. **Pattern rules** (`detect/rules.ts`, synchronous, < 1 ms). First pass, each a regex + optional validator:
   - Secrets: private keys, AWS keys, GitHub tokens, `sk-…`/`sk-ant-…`, Slack, Google API keys, Stripe, JWT, `Bearer …`, `password: …`, passwords inside connection strings.
   - Contact: email, URL (URL hidden is **off** by default), phone (shape + context words; short numbers need context such as "phone:").
   - Financial: card numbers (Luhn), IBAN (mod-97).
   - IDs: any `NNN-NN-NNNN` (SSN/ITIN shape, including 9xx), labelled IDs ("member ID: …"), MAC addresses.
   - Dates: hide DOB/birth dates, medical dates and credential expiry/issue dates using nearby text, form labels, JSON keys and table columns. Keep ordinary deadlines, invoice dates and general calendar references; weekdays/"tomorrow" are not hidden.
   - Network: IPv4/IPv6. Usernames in file paths (`/Users/<name>/`, `C:\Users\<name>\`). Street addresses (US/UK/EU style).
   - **Second, contextual pass** (only where the first pass found nothing): numbers with ≥ 4 digits within 80 characters after keywords (SSN, member, policy, account, passport, claim, …), spaced SSNs after "SSN"/"social security".
2. **Dictionary** (`detectDictionary`): the user's *Always hide* list (people + other words); person entries also match each name part.
3. **NER** (`runtime/ner.ts`): `Xenova/bert-base-NER-uncased` (int8, ~110 MB, ONNX on CPU via WASM). **Uncased** on purpose: chat users type "john smith". Tokens are aligned back to character offsets in `ner-align.ts` with case- and accent-insensitive matching; BIO labels are grouped into PERSON / ORG / LOCATION spans. Long text is chunked at sentence boundaries.
4. **Resolution** (`detect/resolve.ts`):
   - category policy (per-type on/off) and NER confidence threshold (0.6);
   - never-hide list, plus built-in generic terms (HR, IT, MRI, CEO, PTO, …) that NER mistakes for organisations;
   - spans inside existing placeholders are ignored (already-cleaned text is never re-detected);
   - overlaps resolved by rank (dictionary > rule > NER > propagated; then by type and length);
   - **propagation**: once a value is found, its other mentions (and capitalised name parts like "Smithers") are hidden too.

### 5.2 Placeholders (`pseudonymize/`)

- `Vault` maps values to `[TYPE_N]` placeholders. Values are normalised by type (phones/cards by digits, emails lower-case). Person names alias by token subset ("John" ↔ "John Smith"; the longest form is kept as the value).
- `anonymize(text, spans, vault)` replaces spans; `restore(text, vault)` puts real values back and also understands variants an AI echoes (`\[PERSON_1\]`, `PERSON_1`, `[Person 1]`).
- Entity types: `PERSON ORG LOCATION ADDRESS EMAIL PHONE CARD IBAN IP URL SECRET ID DATE USER`.

### 5.3 Style: the Outis neutralizer (`style/neutralizer.ts`, `style/neutral.ts`)

A TypeScript port of the team's `outis-neutralizer` (originally `~/Downloads/outis-neutralizer/lib/neutralizer.js`). Goal: **one plain, everyday voice for every user** (the "crowd"), never changing facts.

1. **Surface rules** (always, instant): dashes/ellipses/`!!`/semicolons → commas and periods; parentheses folded in; shorthand expanded (`lmk`, `idk`, `w/`, `u`); fillers removed (honestly, literally, lol…); slangy intensifiers → plain ones; openers removed (So, Ok, Hey; stacked ones too); ALL CAPS lowered (acronyms kept); **contractions written out** (I'm → I am; a deliberate crowd habit); stacked hedges collapsed; formal words → everyday words (require → need, physician → doctor, regarding → about…); emoji removed.
2. **Units**: sentences (abbreviations like "Dr." don't split); fragments under 4 words are joined to the sentence before ("…It was." → one unit).
3. **Model** (optional): units go to the local model **numbered, in batches of 4**, with a system prompt and three example pairs that each show a trap (slang, formal drift, hedges, requests). Mode `all` = every sentence (most neutral, default), `auto` = only units the rules can't finish (joined/very short/very long/heavily edited), `off` = rules only.
4. **Checks per sentence** (any failure rejects it): placeholders identical; numbers identical (word numbers counted); negation kept; **conditionals (if/unless/whether) kept** (Nobody addition); question stays a question; anchor words kept (actions like ordered/denied/said/suspects, repeats like again/already, the request words); ≥ 70 % of content words kept; certainty unchanged; no added intensifiers; no new formal words; not an answer; length 0.5–1.6×. Nobody adds: no new personal data (pattern rules) and no invented names (NER).
5. **Retry once with the exact problems**, then fall back to that sentence's rules version (always factually safe). One bad sentence never affects the others.

`neutral.ts` wraps it for Nobody: code fences and code/log/stack-trace lines are never touched; inside prose, inline `code`, links, emails and file names are masked as `[CODE_n]` so neither the rules nor the model can alter them.

*Light* style in the extension = `neutralizeLight()` (rules only). *AI rewrite* = `neutralizeWithModel()` via `NobodyEngine.rewrite()`.

Legacy: `style/rewrite.ts` (`rewriteText`, `verifyRewrite`, `copiedRatio`) and `style/normalize.ts` are the earlier pipeline; still exported and unit-tested but no longer used by the extension.

### 5.4 Models and device fit (`models/`)

| Tier | Model (WebLLM id) | Download | GPU memory (f16 / f32) |
|---|---|---|---|
| Light | none (rules) | — | — |
| Fast | `Qwen3.5-2B-q4f16_1-MLC` / `-q4f32_1-MLC` | 1.1 GB | 2.2 / 2.6 GB |
| Balanced | `Qwen3.5-4B-…` | 2.4 GB | 3.9 / 4.7 GB |
| Quality | `Qwen3-8B-…` | 4.6 GB | 5.7 / 6.9 GB |
| NER | `Xenova/bert-base-NER-uncased` q8 | 110 MB | CPU |

`probeDevice()` reads WebGPU adapter info (vendor, `shader-f16`, limits) and `navigator.deviceMemory`, classifies the GPU (Apple / discrete / integrated / none) and estimates a memory budget. `rateModels()` labels each tier (recommended / good / heavy / too big / needs WebGPU). The setup page's *Download & test* measures real tokens/s.

Measured on the developer's M3 Pro: Fast ≈ 44 tok/s, Balanced ≈ 20 tok/s. Neutralizing the sample insurance prompt (≈ 200 words, 14 sentences) with Fast: ~17 s in `all` mode, ~5 s in `auto` mode.

`LocalLlm` (WebLLM) loads/unloads models, `generate()` disables Qwen "thinking" (`extra_body.enable_thinking=false`); the offscreen page unloads the model after 10 min idle. `configureOnnxWasm()` points ONNX Runtime at the bundled `.wasm` (extensions may not load code from CDNs).

---

## 6. Extension (`frontend/`)

### 6.1 Manifest (from `wxt.config.ts`)

- `permissions`: `storage`, `unlimitedStorage` (model cache), `offscreen`, `scripting`.
- `host_permissions`: `<all_urls>`. **Required** for injecting into open tabs and for main-world editor edits; without it, `executeScript` fails with "Cannot access contents of the page".
- CSP for extension pages: `script-src 'self' 'wasm-unsafe-eval'`.
- Command `scrub-field`: **Alt+Shift+N** reviews the focused text box.
- Content script: `<all_urls>`, `run_at: document_start` (inert unless the site is enabled).

### 6.2 Background (`entrypoints/background.ts`)

- On install: opens the setup page. On install/update: `injectIntoOpenTabs()` executes the content script in every open http(s) tab.
- `ensureOffscreen` creates the offscreen document (`reasons: WORKERS`).
- Relays `progress` events from the offscreen engine to the tab that asked.
- `hello`: opens `chrome.storage.session` to content scripts (RAM-only memory).
- Memory enforcement: when memory ≠ "device", deletes any placeholder mappings stored on disk.
- **Port `nobody-edit`**: receives `{marker, action, text}` from a content script and runs `mainWorldEdit()` in the page's MAIN world. It finds the editor element marked `data-nobody-target`, walks up to an element with `.editor.commands` (Tiptap), and calls `setContent` (built as a JSON doc, never parsed as HTML) / `clearContent` / `insertContent`. A dedicated port is used because one-off messages are delivered to every extension page and another page could answer first.

### 6.3 Offscreen engine (`entrypoints/offscreen/main.ts`)

Hosts one `NobodyEngine`. Request types (`lib/messages.ts`): `ner.init`, `analyze`, `rewrite` (with `mode: all|auto`), `llm.prepare` (download + load + speed test), `llm.load` (warm-up), `llm.status`, `llm.cached`, `llm.delete`, `llm.unload`. `callEngine()` retries briefly while the offscreen page boots.

### 6.4 Content script (`entrypoints/content/`)

**Instances.** Each copy marks `<html data-nobody-instance>`; a copy that is disconnected (extension reloaded) or superseded (a newer copy injected) retires itself completely so two copies never react to the same event. If a copy is cut off and no new copy arrives, an amber bar asks the user to reload the page.

**Settings** start as defaults (so listeners can register synchronously at `document_start`) and are replaced when storage loads. The name detector is warmed up when an enabled site opens. The AI model is warmed up when the user focuses a chat box (if AI style is selected).

**Flow A: automatic mode (default, `autoMode: true`)** in `index.ts → autoFix()`:
1. Trigger: Enter/Send on a typed message with personal info (or, with a style other than Off, any message of ≥ 12 words, so the writing style is neutralized too), or any paste ≥ 12 characters.
2. The original is **removed from the box immediately** (`clearBox`; for pastes nothing is inserted) and kept only in memory. Top bar: "Making your message safe…".
3. Detection (instant if the typing check already ran) → placeholders (`anonymize` on a vault clone) → style: Light (`neutralizeLight`) or AI (`engine.rewrite`, progress "Rewriting · 4 of 14 sentences").
4. The vault is committed, then the safe text is put into the now-empty box (`replaceAll`). For pastes: if the site inserted the original itself, it is swapped for the safe text instead of being appended next to it.
5. Green bar "✓ Ready" with **Undo** (6 s). Enter sends. Pressing Enter *while it works* queues "send when ready". The `autoSend` setting sends automatically.
6. **Esc** while working puts the original back. Short messages without personal info are sent untouched.

**Flow B: review panel** (`autoMode: false`, or the badge, or Alt+Shift+N), in `review()` + `panel.ts`:
- Shows "Your text" with clickable highlights (click = keep visible), type chips, "What the site will see", a style switch (Off / Light / AI rewrite) and a status line.
- With AI selected, the panel shows the Light version immediately; Enter queues "replace when rewritten" (the panel hides, the top bar shows progress); "Without rewrite" skips the AI.
- The panel never takes focus from the chat box; Enter/Esc are handled by a capture listener. While it is open, the site's Send button is blocked.

**Typed-text guard** (`typing.ts`): re-checks the box ~300 ms after typing (on `input`, `focusin` and `keyup`, since some editors never fire `input`), underlines findings with the CSS Custom Highlight API (the editor DOM is untouched) and shows a badge. On Enter (chat sites: every site in the site list; elsewhere only Ctrl/⌘+Enter) or a Send/submit button: if the last check is current and clean, it lets the event through. Otherwise it blocks it, checks (~20–50 ms) and either re-sends the key/click itself (clean) or starts Flow A/B.

**Writing into editors** (`insert.ts`):
1. **Editor API first** (main world via the background port): Tiptap → works on claude.ai.
2. DOM strategies, each replacing *everything* and verified after each: DOM select-all + `execCommand('insertText')`; the editor's own ⌘A (synthetic keydown) + insert; ⌘A + synthetic paste; DOM select + paste.
3. A background re-check 400 ms later restores the safe text if the app re-rendered its own draft.
4. If everything fails: the safe text goes to the clipboard and the bar says how to paste it.
`liveContext()` re-finds the box if the app re-rendered it.

**Restore in answers** (`restore.ts`): mode `hover` (default): placeholders in the page are tinted (CSS highlight) and hovering shows the real value in a closed-shadow tooltip, so the page DOM never contains real values (safe against analytics/session replay). Mode `replace` (opt-in) writes real values into text nodes.

**UI technique** (`ui.ts`): every Nobody UI element lives in a **closed shadow root** (page scripts can't read it), is shown in the browser **top layer** (Popover API, `popover="manual"`), and is styled with a **constructed stylesheet** (not blocked by page CSP). `reportVisibility()` logs whether it is really on screen.

### 6.5 Setup page and popup

- **Setup/options** (`entrypoints/options/`): device card; name-detector download progress; model picker with fit badges, *Download & test* (speed in tok/s), *Remove*; always-hide / never-hide lists and category switches; site list (+ "protect every website"); automatic mode, auto-send, default style, AI coverage, answer-restore mode, memory mode, "Forget now"; a **playground** (anonymize, style, restore an answer). Choosing a model sets the default style to AI.
- **Popup**: per-site toggle, style switch, "Check what I type", automatic mode, current model, remembered placeholders + Forget, **Build stamp**, **Copy diagnostics** / Clear.

### 6.6 Settings reference (`lib/settings.ts`, `chrome.storage.local` key `settings`)

| Key | Default | Meaning |
|---|---|---|
| `sites` | AI chat sites (8) | where Nobody is active; listed sites are also treated as "Enter sends" |
| `allSites` | false | protect every website |
| `autoMode` | true | one-Enter automatic mode |
| `autoSend` | false | send automatically when the safe text is ready |
| `defaultStyle` | `light` (→ `ai` when a model is chosen) | off / light / ai |
| `aiCoverage` | `all` | AI rewrites every sentence or only where needed |
| `styleTier`, `webllmId` | `light`, null | chosen model tier and exact WebLLM build |
| `guardTyping` | true | live check + send guard for typed text |
| `restoreMode` | `hover` | hover / replace / off |
| `memory` | `session` | `none` (counters only), `session` (RAM, cleared on browser close), `device` (disk) |
| `policy` | all on except URL | per-category hide switches |
| `alwaysHide`, `neverHide` | [], common product names | user lists |
| `minPasteChars` | 12 | shorter pastes are ignored |

Placeholder memory: key `vault:<hostname>` in `chrome.storage.session` (or `local` for memory = device). Diagnostics: key `nobody:diag` in `chrome.storage.session` (last 120 entries).

---

## 7. Privacy model

- Text is checked and rewritten only inside the browser; the chat site receives only the safe version.
- Real values are kept in RAM by default and never written to disk unless memory = device. "Forget now" clears everything.
- The original text in automatic mode exists only in the content script's memory until it is replaced or restored.
- All UI that shows original text is in closed shadow roots; hover-restore keeps real values out of the page DOM.
- Diagnostics contain step names, editor descriptions and **lengths only, never text**.
- Network: model weights from Hugging Face (once), WebLLM model libraries from GitHub (once). No other requests.

---

## 8. Testing

### 8.1 Unit tests (backend)

`npm test`: 59 passing, 1 skipped (real NER test, run with `npm run test:ner`).

| File | Covers |
|---|---|
| `test/detect.test.ts` | every recognizer, contextual IDs, dates, dictionary, overlaps, propagation, policy, placeholders ignored, generic acronyms |
| `test/pseudonymize.test.ts` | vault consistency, aliasing, normalisation, JSON round-trip, restore variants |
| `test/style.test.ts` | legacy normalizer/rewrite checks, sentence splitting, copied-wording measure |
| `test/neutralizer.test.ts` | the 11 ported Outis tests (simulated models, including the earlier "sloppy" outputs) + fragment fallback, conditionals, wrapper (code/links/logs masking, no new personal data) |
| `test/ner-device.test.ts` | token alignment (cased + uncased), BIO grouping, chunking, model fit ratings |
| `test/ner.integration.test.ts` | real NER model in Node (optional) |

### 8.2 Browser tests (`frontend/e2e/`)

Playwright launches Chromium with the built extension against **local chat-box simulators** (real chat sites block automated browsers with a Cloudflare check):

```bash
cd frontend/e2e && npm install && npx playwright install chromium && npm run bundles
npm run test:paste        # paste flow + hover restore (textarea + contenteditable)
npm run test:typing       # typed-text guard, send button, keep/cancel, memory modes
npm run test:prosemirror  # ChatGPT-style ProseMirror editor; add ?focusEnd/beforeinput variants via FOCUS_END=1 BEFOREINPUT=1
npm run test:tiptap       # Claude-style Tiptap editor
npm run test:auto         # automatic mode (one Enter, Esc, short messages, auto-send)
npm run test:claude-like  # Tiptap + site-side paste handling; prints diagnostics (editor-api, visibility)
node neutral-real.mjs     # neutralizer with the REAL local model (downloads Fast 2B once)
node compare.mjs          # Fast vs Balanced quality/speed
node swcheck.mjs          # detects a stale background worker in a reused profile
```

Simulators: `pm-src.js` (ProseMirror: Enter sends; `?focusEnd` moves the cursor to the end on focus; `?beforeinput` makes the editor insert at its own cursor) and `tt-src.js` (Tiptap with `editor` on the element; `?siteinsert` makes the "site" insert pasted text itself). `auto.mjs`, `neutral-real.mjs` and `compare.mjs` keep a reusable profile in `e2e/llm-profile` so models download once. **Delete it after big changes** (stale background worker).

---

## 9. Diagnostics: how to debug on a real site

Popup → **Copy diagnostics**. Each line is JSON. Important steps:

| Step | Meaning |
|---|---|
| `script-start` | which build the page runs (compare with the popup's Build stamp) |
| `send-held` | Enter/Send was intercepted (trigger, items found, editor) |
| `auto-start` / `auto-done` | automatic mode began / finished (`ok`, `partial`, `ms`) |
| `review-start` / `review-result` | review-panel flow |
| `editor-api-ok` / `editor-api-unavailable` | main-world editor API used (`method: tiptap`) or why not (`why`) |
| `clear-ok/failed`, `replace-ok/failed`, `replace-reverted` | which writing method worked, box length vs expected |
| `paste-box-before` | for pastes: did the site insert the original itself (`originalInBox`) |
| `bar`, `bar-visible`, `panel-visible` | UI shown; really on screen? (`attached`, `popoverOpen`, size, `opacity`, `onTop`) |
| `script-retired` | an older copy switched itself off |

Also check `chrome://extensions` → Nobody → **Errors** for warnings.

---

## 10. Known issues and next steps (prioritised)

1. **ChatGPT replacement.** Collect diagnostics from a ChatGPT attempt (editor description, which strategies failed). If its composer is plain ProseMirror, extend `mainWorldEdit()` to reach the ProseMirror `EditorView` (it is not exposed like Tiptap's `editor`; options: React props/fiber lookup of the component that owns the view, or a ProseMirror-specific transaction path). Test with `e2e/pm-src.js` variants.
2. **Popup visibility on real sites.** Get `bar-visible` diagnostics from claude.ai/chatgpt.com. v0.3.0 already uses the top layer and constructed stylesheets; if still invisible, check `onTop` (covered?) and `attached` (removed by the app?).
3. **Other chat sites** (Gemini uses Quill, Copilot, Perplexity, DeepSeek, Mistral): test each; add editor-API adapters where available (e.g. Quill's `__quill`).
4. **Rewrite quality/speed.** Fast 2B is quick but sometimes changes meaning; the neutralizer's checks fall back to rules. Recommend Balanced 4B for real use. Tune `EXAMPLES`, `FORMAL`, `ANCHOR_WORDS` in `neutralizer.ts` using `result.units[i].problems` (see the Outis README "Tuning").
5. **Contribute fixes back** to the original `outis-neutralizer` folder: conditional check (if/unless/whether), stacked openers, trailing colon. (The fragment-loss bug existed only in the TS port and is fixed.)
6. **Store readiness:** bundle WebLLM model libraries instead of fetching them from GitHub; Chrome Web Store listing; justify `<all_urls>`.
7. **Not supported yet:** screenshots/OCR, layout-preserving document replacement, legacy DOC/XLS/PPT and cloud-drive attachments; Firefox/Safari (no `offscreen` API; would need a background-page variant), non-English names (swap to a multilingual NER), encryption at rest for memory = device. PDF/DOCX and other document text-copy support is now documented in [DOCUMENTS.md](DOCUMENTS.md).
8. **Housekeeping:** the GitHub release `v0.1.0` zip is outdated (publish a new one or remove it); the old folders `~/Documents/Nobody/nobody-engine` and `nobody-extension` are obsolete copies.

---

## 11. Decision log (short)

| Decision | Why |
|---|---|
| Browser extension, no native app | OS-independent, no installer/admin rights, office-PC friendly |
| All models local (Transformers.js + WebLLM) | privacy; nothing leaves the device |
| Uncased NER | people type names in lowercase in chats |
| Offscreen document hosts models | one copy per browser, WebGPU/WASM available, survives SW suspension |
| Closed shadow roots + top layer + constructed CSS | page can't read our UI; UI drawn above the site; not blocked by CSP |
| Hover-restore by default | real values never enter the page DOM (session-replay safe) |
| Memory default = session (RAM only) | consistent placeholders without writing personal data to disk |
| Automatic mode default | one Enter; original leaves the box immediately; empty-box insertion avoids appending |
| Editor API in main world (Tiptap) | the only fully reliable way to replace text in rich editors |
| Outis neutralizer as style engine | plain shared voice, strict per-sentence checks, rules fallback; replaced a free-form rewrite that drifted into formal language and changed meaning |
| Version bumps per build | avoids Chrome running a stale cached background worker |
