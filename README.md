# Outis · Nobody

> *Outis* (Οὖτις) — "Nobody", the name Odysseus gave the Cyclops.

**Nobody** is a browser extension that hides who you are before you send text to an AI chat:

- **Personal info → consistent placeholders.** Names, companies, places, emails, phones, cards, IBANs, IDs, secrets/API keys and usernames in file paths become `[PERSON_1]`, `[EMAIL_1]` …, and the same person keeps the same placeholder across messages.
- **Writing style → neutral.** Light mode cleans up punctuation, slang, typos and emoji instantly. AI mode rewrites the text with a local LLM so services can't fingerprint how you write.
- **Pasted and typed text.** Pastes are reviewed before the site sees them. Typed text is underlined live, and sending is held until you review it.
- **Answers stay readable.** Hover a placeholder in the AI's answer to see the real value. Only you see it.
- **100% local.** Models run in the browser (WebAssembly + WebGPU). No server, no account, nothing leaves the device.

```
outis/
├── backend/    @nobody/engine — detection, placeholders, style rewrite, model catalog (TypeScript library)
└── frontend/   Chrome/Edge extension (WXT, Manifest V3) — paste/typing guard, review panel, setup, popup
```

## Quick start

```bash
npm install
npm run build
```

Load `frontend/dist/chrome-mv3` via `chrome://extensions` → Developer mode → **Load unpacked**. The setup page opens automatically.

| Command | |
|---|---|
| `npm run build` | build engine + extension |
| `npm run dev` | extension with hot reload |
| `npm test` | engine unit tests |
| `npm run test:ner` | real name-detector test in Node (downloads 109 MB) |
| `npm run typecheck` | both packages |

## Model size and installation

| Concern | How it's handled now |
|---|---|
| Models use too much space | Light mode needs **no model**. Name detection is 109 MB. Rewrite models are optional, picked per device: 1.1 GB (Fast), 2.4 GB (Balanced), 4.6 GB (Quality). The extension itself is ~34 MB. The idle rewrite model is unloaded from GPU memory after 10 min, and *Remove* deletes it from disk. |
| Users have to install models | No separate install: the setup page downloads models inside the browser with a progress bar, once, and caches them. No Python, no Ollama, no admin rights. |

Ideas to go further: ship a smaller name model (DistilBERT ≈ 65 MB), default to Light and offer AI rewrite only on demand, or use Chrome's built-in Gemini Nano where available (zero download for us).

Details: [backend/README.md](backend/README.md) · [frontend/README.md](frontend/README.md)
