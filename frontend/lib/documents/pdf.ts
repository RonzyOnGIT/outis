import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { DOCUMENT_LIMITS, DocumentError, type DocumentBlock } from './types';
import { layoutPage, pageItems, taggedCells, type PdfContentItem, type PdfStructNode } from './pdf-layout';

// Packaged extension resource, never a CDN or a worker created by the visited website.
GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export async function extractPdf(data: Uint8Array): Promise<DocumentBlock[]> {
  const task = getDocument({
    data: new Uint8Array(data),
    cMapUrl: new URL('pdf-assets/cmaps/', browser.runtime.getURL('/offscreen.html')).href,
    cMapPacked: true,
    standardFontDataUrl: new URL('pdf-assets/standard_fonts/', browser.runtime.getURL('/offscreen.html')).href,
    useWorkerFetch: false,
    disableFontFace: true,
    useSystemFonts: false,
    stopAtErrors: true,
    verbosity: 0,
  });
  // Do not wait for a password callback; encrypted files must stay blocked.
  task.onPassword = () => { void task.destroy(); };
  const timer = setTimeout(() => void task.destroy(), 30_000);
  try {
    const doc = await task.promise;
    if (doc.numPages > DOCUMENT_LIMITS.pdfPages) throw new DocumentError('size');
    const blocks: DocumentBlock[] = [];
    let length = 0;
    for (let n = 1; n <= doc.numPages; n++) {
      const page = await doc.getPage(n);
      // Marked content and the structure tree let a tagged PDF name its own table cells.
      const content = await page.getTextContent({ includeMarkedContent: true });
      const tree = await page.getStructTree().catch(() => null);
      const viewport = page.getViewport({ scale: 1 }).transform;
      const pageBlocks = layoutPage(pageItems(content.items as PdfContentItem[], viewport, taggedCells(tree as PdfStructNode | null)));
      // Include visible form values; annotation authors, comments and link targets are omitted.
      const fields: string[] = [];
      for (const a of await page.getAnnotations({ intent: 'display' })) {
        if (a.subtype === 'Widget' && a.fieldValue != null) {
          const values = Array.isArray(a.fieldValue) ? a.fieldValue : [a.fieldValue];
          fields.push(...values.filter((v: unknown): v is string => typeof v === 'string'));
        }
      }
      if (fields.join('').trim()) pageBlocks.push({ text: fields.join('\n'), prose: true });
      // Reject the whole file when a page cannot be read, including mixed scanned/text PDFs.
      if (!pageBlocks.length) throw new DocumentError('empty');
      length += pageBlocks.reduce((n, b) => n + b.text.length + 2, 0);
      if (length > DOCUMENT_LIMITS.textChars) throw new DocumentError('size');
      blocks.push({ text: `Page ${n}`, prose: false }, ...pageBlocks);
      page.cleanup();
    }
    return blocks;
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}
