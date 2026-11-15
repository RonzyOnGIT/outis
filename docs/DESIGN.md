# Outis design

Quiet ivory: ink for words, bronze for protection, oxblood only when something is exposed.
Tokens, fonts and marks live in `frontend/lib/brand.ts`; extension pages use them through
`lib/page.css` and `installPageTheme()`, the in-page UI through `BASE_CSS` in `content/ui.ts`.

| Token | Value | Use |
|---|---|---|
| Ink | `#1F2333` | Text, primary buttons, switches on |
| Ivory | `#F7F4EE` | Page, popup and panel background |
| Paper | `#FFFDF8` | Cards and inputs |
| Line | `#E0D8CA` | Borders and dividers |
| Quiet | `#5C6170` | Secondary text (4.5:1 on ivory) |
| Bronze | `#8A5A26` | Protection: closed eye, placeholder dots, links, progress |
| Seal | `#F2E8D9` | Placeholder chips and detected text |
| Oxblood | `#8E3326` | Exposed or removing something, never decoration |

The logo is the eye with a navy outline (`#13233A`) and a bronze iris (`#A96C32`). Toolbar icons
are drawn by `frontend/scripts/make-icons.py` (`npm run icons -w frontend`); keep its geometry in
step with `LOGO` in `brand.ts`.

## Type

- **Newsreader 500**: headings and big numbers only.
- **IBM Plex Sans 400/500/600**: everything else.
- **IBM Plex Mono 400/500**: sites, IDs, placeholders.

The fonts (SIL Open Font License, licences in `frontend/public/fonts`) are bundled and never loaded
from the network. Fonts declared inside a shadow root are ignored by browsers, so the in-page UI
asks the background for the Latin files once per tab and adds them to the document's font set from
bytes; nothing is web-accessible and the page's CSP is not involved. Other scripts fall back to
system fonts.

## Rules

- Bronze means protected; oxblood means exposed or removing. One primary button per view, in ink;
  everything else is outlined or text.
- No pill badges, gradients, glows, emoji or all-caps labels. The wordmark (`OUTIS`, tracked
  Newsreader) is the only capitals.
- Name actions by what happens: *Protect this site*, *Replace with disguised text*, *Forget now*.
  Show proof, not claims: counts, checks that actually ran, what was kept.
- Say plainly when something falls back (model missing, name detector unavailable) and what still
  protects the user.
- Placeholders are shown as chips (`● Person 1`) in previews; the exact token (`[PERSON_1]`) is in
  the chip's tooltip and in anything that is sent or attached. In AI answers they are highlighted in
  place (seal background, dotted bronze underline) because the page's DOM is never restructured.
- Rewriting is drawn as two threads weaving left to right (`weave()`), animated while busy.

## Surfaces

| Surface | File |
|---|---|
| Toolbar popup: site state, stats, writing voice, toggles, model status | `entrypoints/popup` |
| Settings: what to hide, writing voice, sending, sites, memory, model; *Try it* | `entrypoints/options` |
| *Before you send* side panel | `content/panel.ts` |
| *N to hide* chip and underlines while typing | `content/typing.ts` |
| Sealed placeholders and hover tooltip in answers | `content/restore.ts` |
| Status bar and toast | `content/topbar.ts`, `content/panel.ts` |
| Document review window | `content/document-panel.ts` |

Internal identifiers (`@nobody/engine`, element ids such as `nobody-documents`, storage keys) keep
their old names so existing settings, remembered placeholders and diagnostics carry over.
