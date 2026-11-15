# Document attachments

Version 0.4 adds a local, text-copy attachment workflow. Existing text-paste, typing, review and
hover-restore flows remain available.

Version 0.4.1 fixes invisible on-page UI: the shared shadow host has explicit viewport dimensions
and protected visibility styles, including `content-visibility`. Attachment panels recover if a
page removes them or closes their popover. Diagnostics include host geometry and file-processing
stages; old, detached status-bar elements are no longer measured.

## User flow

1. Enable Nobody for the site; **Protect attachments** is on by default and can be changed in the
   popup or settings. Reload existing chat tabs after installing/updating this build.
2. Select documents through a normal file input, drop them on the page, or paste clipboard files.
   Nobody stops the original event and immediately clears file-input selections.
3. The offscreen page extracts text. Pattern/dictionary/NER detection and the selected Off, Light
   or AI style run locally. AI output goes through the existing meaning and privacy checks.
4. A closed-shadow review panel displays the complete cleaned text and extraction/fallback warnings.
   Document attachments always require review; `autoSend` never approves attachments.
   While working, it shows extraction/detection/rewrite progress and elapsed time. **Use Light style
   now** skips pending AI rewriting while keeping personal-info detection and the final review.
5. Attach the reviewed copies or download them. Filenames are generated, MIME is `text/plain`,
   encoding is UTF-8, and `lastModified` is zero. Cancel/Esc releases no original file. No original
   file on disk is modified.

The same per-site vault is used by chat and documents. A whole batch uses a cloned vault and only
commits on approval. Memory modes remain session, device, or counters only. Changed settings or
vault state invalidate an unapproved preview. Document diagnostics contain counts, lengths, event
types and allowlisted error codes; no source filenames, contents or parser exception messages.

## Formats

| Input | Exported content | Notes |
|---|---|---|
| TXT, MD | Plain text | Strict UTF-8, or UTF-16 LE/BE with BOM. Prose can be rewritten. |
| CSV, TSV, JSON, LOG | Text, with detected values replaced | No style rewrite. Output is a `.txt` copy; it is not a machine-readable format conversion. |
| PDF | Text layer, page markers, string form-field values | PDF.js is bundled. Blank/unreadable pages block the whole file, including mixed text/scanned PDFs. No OCR. Multi-column reading order needs review. |
| DOCX | Paragraphs, table-cell text, headers, footers, footnotes, endnotes | Text runs are joined before detection. Deleted/hidden runs are omitted. |
| XLSX | Visible sheets and rows, shared/inline strings, cached cell values, sheet names | Tab-separated values, including empty cell positions. No formula evaluation; a formula lacking a cached value blocks the file. Dates may remain Excel serial numbers. |
| PPTX | Slide text in presentation order | Text in drawing paragraphs/tables. No speaker notes. |
| ODT, ODP | Text paragraphs and headings | OpenDocument annotations/tracked changes and presentation notes are omitted. |
| ODS | Sheet names and tab-separated cell values | Repeated rows/cells are bounded. Hidden rows are omitted. Formulas are not evaluated. |
| RTF | Text, Unicode/ANSI escapes, field results, paragraph/cell breaks | Windows code pages 1250–1258; unsupported encodings fail closed. Destinations containing metadata, objects, pictures and field instructions are omitted. |

These are text extractions, not layout-preserving sanitizers. Graphics, charts, signatures, attachments,
macros, author metadata, comments and embedded objects are not copied. Unrecognized/custom Office
parts are not interpreted. Any text retained from tables, headers or sheet names still goes through
detection. Unsupported binary DOC/XLS/PPT, macro-enabled formats, images, archives and other formats
require export to a supported format first.

## Boundaries

- No post-upload replacement: after a site receives an original, it is already disclosed.
- Standard DOM events are intercepted in the content script at `document_start`. This is not a
  network firewall against a hostile page, earlier listeners in an already-open tab, isolated iframe
  uploaders, direct file-handle APIs (`showOpenFilePicker`), or cloud-drive attachments. Reload tabs
  after updates. Previously uploaded documents cannot be made private retroactively.
- Replacement uses synthetic input/change, drop or clipboard events. Sites may reject them or
  reject `.txt`. Check the attachment list; download the cleaned copies for manual attachment when
  needed. A detached upload control offers download instead. Page acceptance is not inferred merely
  from `dispatchEvent` succeeding.
- Partial name detection is explicitly reported in the preview. Name detection remains primarily
  English. Pattern/dictionary fallback is not a guarantee that all personal information was found.
- AI model failure or rejected rewrites use Light style with a visible warning. Structured data
  never goes through prose rewriting. Detection uses overlapping, roughly 4,000-character chunks
  and a whole-document resolution pass so names at boundaries and earlier mentions are covered.
- Engine waits are bounded. Name detection gets 15 seconds per call and 30 seconds per selection;
  AI rewriting gets 45 seconds per call and 90 seconds per selection. A timed-out model is not
  retried for every later chunk. Pattern/dictionary detection or Light style completes the preview
  with the relevant warning. File reading and extraction timeouts block attachment with an error.
- Parsing/model work already running may finish after cancellation; its results are discarded and
  never attached. Source buffers live only in process memory, not extension storage.

Limits are defined in `frontend/lib/documents/types.ts`: 10 MB/file, 8 files and 25 MB/batch,
200,000 extracted characters/batch, 100 PDF pages/file, 2,048 archive entries and 32 MB expanded
archive content/file. Office ZIP sizes are checked before decompression; only text-bearing parts
are unpacked. DTD/entity XML is rejected. All new parser resources are packaged with the extension.

## Implementation and validation

- `content/documents.ts`: interception, atomic batch review, cancellation, delivery and downloads.
- `content/document-panel.ts`: full text preview in a closed shadow root with keyboard controls.
- `lib/documents/{extract,pdf,rtf}.ts`: bounded extraction in the offscreen extension page.
- `lib/documents/sanitize.ts`: shared engine/vault orchestration and bounded model calls.
- `lib/messages.ts`, `offscreen/main.ts`: typed JSON/base64 extraction requests and safe error codes.
- `wxt.config.ts`: bundled PDF worker, CMaps and standard fonts. See the upstream
  [PDF.js API](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html) and
  [fflate ZIP filter documentation](https://github.com/101arrowz/fflate/blob/master/docs/type-aliases/UnzipFileFilter.md).
- `backend/src/detect/resolve.ts`: keep a complete email/identifier when a dictionary name matches
  only a substring (for example, Alice Example inside `alice@example.com`). This also fixes chat text.

```sh
npm install
npm run build
npm run typecheck
npm test
cd frontend/e2e
npm install
npx playwright install chromium
npm run test:documents
```

Unit tests cover the shared privacy pipeline, limits, chunk boundaries, cancellation and RTF.
The browser suite loads the production extension into a fresh Chromium profile. It exercises all
14 supported formats, text encoding, metadata omission, slide order, corrupt inputs, a PDF with an
unreadable page, archive limits, input-event interception before page handlers, batches, shared
placeholders, cancellation without vault changes, drop/file-paste replay, settings invalidation,
download fallback, closed-shadow isolation and content-free diagnostics. It also applies conflicting
popover CSS, checks actual visibility, removes/re-mounts the review, and clicks controls with the
mouse rather than invoking click handlers directly. Unit tests exercise hung-model recovery,
cancellation and the Light-style escape. Model downloads are
deliberately blocked in this suite so fallback behavior is exercised without large downloads.

Real chat-site attachment adapters and real-model document runs still need manual verification.
The existing optional real-NER integration test remains separate from the default tests.
