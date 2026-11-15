# Outis

**Hide your personal info and your writing style before you send text to an AI chat.**
Outis replaces names, emails, phone numbers, addresses, IDs and API keys with placeholders like `[PERSON_1]`, and can rewrite your text so it doesn't sound like you. Everything runs **on your computer** — no server, no account, nothing is sent anywhere.

Works in **Chrome** and **Edge** on Windows, macOS and Linux.

---

## Install (2 minutes)

1. **Download** [`nobody-extension-v0.1.0.zip`](https://github.com/RonzyOnGIT/outis/releases/latest/download/nobody-extension-v0.1.0.zip) and **unzip** it.
2. Open **`chrome://extensions`** (Edge: **`edge://extensions`**) and turn on **Developer mode**.
3. Click **Load unpacked** and select the unzipped **`nobody-extension`** folder.
4. Pin it: click the puzzle icon 🧩 in the toolbar → 📌 next to **Outis**.

The **setup page** opens by itself.

## Setup (first time only)

1. Wait for the **name detector** to show **✓ Ready** (downloads 110 MB once).
2. Pick a **writing-style model**. Outis marks the best one for your computer:

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
- Press **Enter** to send → Outis holds it and asks: **Replace with safe text** or **Keep my text**

**Read the answer** → placeholders like `[PERSON_1]` are tinted. **Hover** to see the real name — only you can see it.

**Links** are treated as one piece: a link stays exactly as written, or — when it contains something
personal (an email, a token, a name such as `linkedin.com/in/jane-doe`) — the whole link becomes `[URL_1]`.
Links are never half-replaced, and the writing-style step never rewrites them.

**Shortcut:** `Alt + Shift + N` checks the text box you're in.
**Toolbar icon:** turn Outis on/off for a site, change the style, forget remembered names.

## Document attachments (0.4)

On enabled sites, select, drop or paste a document file. Outis holds the original, reads it locally,
replaces detected personal info using the same placeholders as your chat, and applies your selected
writing style to prose. A review window always opens just above the message box (including in
automatic mode): the text of the original file on the left, the cleaned copy on the right. Both
sides scroll together, replaced values are highlighted, and **↑ / ↓** jump from change to change.

Choose **Attach cleaned copy**, **Download cleaned copy**, or **Cancel**. Attachments become
UTF-8 `.txt` files with generic names, such as `attachment-1.txt`. Originals on disk are unchanged.
Layout, images, charts, comments, macros and embedded objects are omitted. Tables — in Word,
PowerPoint, OpenDocument and spreadsheet files, and tables found in PDFs — become one line per row
with tab-separated cells, so every value stays under its column heading. Tables, CSV, JSON and logs
are not style-rewritten.

Supported: **TXT, PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP, RTF, Markdown, CSV, TSV, JSON and LOG**.
Encrypted/damaged files, legacy DOC/XLS/PPT, images and unsupported files are blocked; PDF pages
without extractable text require OCR first. A failed file blocks the whole selection.

Limits: **10 MB/file**, **8 files / 25 MB/selection**, **200,000 extracted characters/selection**,
**100 PDF pages/file**, **32 MB expanded Office content/file**. Review the warnings if name detection
or AI rewriting is unavailable. Detection is best effort, so check the preview before attaching.

Reload chat tabs after updating the extension. The guard covers standard file inputs, drag-and-drop
and file-paste events; it cannot remove files already uploaded or intercept cloud-drive integrations
and the File System Access picker. Some sites reject synthetic events or `.txt` files: check the site's
attachment list and use the download option if needed. See [document support details](docs/DOCUMENTS.md).

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
