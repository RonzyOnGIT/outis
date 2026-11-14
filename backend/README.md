# @nobody/engine (`backend/`)

The local privacy engine behind Nobody. It runs in the browser (offscreen document, worker) or in Node, with no server.

1. **Detect.** Presidio-style pattern rules with checksums and context words find emails, phones, cards (Luhn), IBANs (mod-97), IPs, secrets/API keys, IDs, birth dates, street addresses and usernames in file paths. A local NER model (`Xenova/bert-base-NER`, int8, 109 MB, WebAssembly on the CPU) finds people, organisations and places. The user's always-hide / never-hide lists are applied on top. Overlaps are resolved by rank, and repeated mentions are propagated.
2. **Pseudonymize.** A `Vault` maps values to stable placeholders (`[PERSON_1]`, `[EMAIL_1]` …). "John", "John Smith" and "Smith" share a placeholder. `restore()` puts real values back into AI answers, including the variants models echo (`\[PERSON_1\]`, `PERSON_1`, `[Person 1]`).
3. **Hide writing style.**
   - **Light**: rule-based cleanup of punctuation, emoji, slang, typos, British/US spelling and casing. Instant.
   - **AI rewrite**: a local LLM through WebLLM on WebGPU. Only prose is rewritten; code, logs and stack traces stay byte-for-byte.
   - Every rewrite is checked: placeholders kept, numbers kept, same point of view, no invented personal data or names. It retries once, then falls back to Light.
4. **Model picker.** `probeDevice()` and `rateModels()` estimate which model fits the device.

## Entry points

```ts
import { detectRules, resolveSpans, anonymize, restore, Vault, normalizeStyle } from '@nobody/engine'; // pure, tiny
import { NobodyEngine, configureOnnxWasm } from '@nobody/engine/runtime'; // models (Transformers.js + WebLLM)

const engine = new NobodyEngine();
const { spans } = await engine.analyze(text, { alwaysHide: [{ value: 'Alexey Kazakov', type: 'PERSON' }] });
const { text: safe } = anonymize(text, spans, vault);
const result = await engine.rewrite(safe, 'Qwen3.5-4B-q4f16_1-MLC');
```

## Develop

```bash
# from the repo root (npm workspaces)
npm install
npm test          # unit tests (no models)
npm run test:ner  # downloads the real NER model and runs it in Node
npm run build     # backend → backend/dist, then the extension
```

| Model | Download | GPU memory | Role |
|---|---|---|---|
| bert-base-NER int8 | 109 MB | none (CPU) | names / orgs / places |
| Qwen3.5 2B q4 | 1.1 GB | ~2.2 GB | Fast rewrite |
| Qwen3.5 4B q4 | 2.4 GB | ~3.9 GB | Balanced rewrite |
| Qwen3 8B q4 | 4.6 GB | ~5.7 GB | Quality rewrite |
