# Nobody

**Hide your personal info and your writing style before you send text to an AI chat.**
Nobody replaces names, emails, phone numbers, addresses, IDs and API keys with placeholders like `[PERSON_1]`, and can rewrite your text so it doesn't sound like you. Everything runs **on your computer** — no server, no account, nothing is sent anywhere.

Works in **Chrome** and **Edge** on Windows, macOS and Linux.

---

## Install (2 minutes)

1. **Download** [`nobody-extension-v0.1.0.zip`](https://github.com/RonzyOnGIT/outis/releases/latest/download/nobody-extension-v0.1.0.zip) and **unzip** it.
2. Open **`chrome://extensions`** (Edge: **`edge://extensions`**) and turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped **`nobody-extension`** folder.
4. Pin it: click the puzzle icon 🧩 in the toolbar → 📌 next to **Nobody**.

The **setup page** opens by itself.

## Setup (first time only)

1. Wait for the **name detector** to show **✓ Ready** (downloads 109 MB once).
2. Pick a **writing-style model**. Nobody marks the best one for your computer:

   | Model | Download | Good for |
   |---|---|---|
   | Light (no AI) | — | any computer, instant |
   | Fast | 1.1 GB | office laptops |
   | Balanced | 2.4 GB | most modern computers |
   | Quality | 4.6 GB | gaming GPUs, Apple Silicon 16 GB+ |

   Click the card → **Download & test**. It shows how fast it runs on your machine.
3. *(Optional)* Add your own name and company under **Always hide**.
4. Try the **playground** at the bottom, then click **Done**.

## How to use

Open **ChatGPT, Claude, Gemini, Copilot, Perplexity, DeepSeek or Mistral**.

**Paste** text → a panel shows what was found and what the site will see.
- **Enter** — paste the safe version · **Esc** — cancel
- Click a highlighted word to keep it visible
- **Writing style:** Off · Light (cleanup) · AI rewrite

**Type** a message → personal info gets a wavy underline.
- Press **Enter** to send → Nobody holds it and asks: **Replace with safe text** or **Keep my text**

**Read the answer** → placeholders like `[PERSON_1]` are tinted. **Hover** to see the real name — only you can see it.

**Shortcut:** `Alt + Shift + N` checks the text box you're in.
**Toolbar icon:** turn Nobody on/off for a site, change the style, forget remembered names.

## Privacy

- Text is checked and rewritten **inside your browser**. The AI site only receives the cleaned version.
- Models are downloaded once (from Hugging Face) and then work offline.
- Real names are kept **in memory only until you close the browser** — or choose *Forget right after replacing* in settings.

---

## For developers

```bash
npm install
npm run build      # → frontend/dist/chrome-mv3
npm test
```

`backend/` — detection, placeholders and rewrite engine ([details](backend/README.md)) · `frontend/` — the extension ([details](frontend/README.md))
