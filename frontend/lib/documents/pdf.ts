import { getDocument, GlobalWorkerOptions } from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { DOCUMENT_LIMITS, DocumentError, type DocumentBlock } from './types';

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
      const content = await page.getTextContent();
      let text = '';
      for (const item of content.items) {
        if (!('str' in item)) continue;
        if (text && !/\s$/.test(text) && item.str && !/^\s/.test(item.str)) text += ' ';
        text += item.str;
        if (item.hasEOL) text += '\n';
      }
      // Include visible form values; annotation authors, comments and link targets are omitted.
      for (const a of await page.getAnnotations({ intent: 'display' })) {
        if (a.subtype === 'Widget' && a.fieldValue != null) {
          const values = Array.isArray(a.fieldValue) ? a.fieldValue : [a.fieldValue];
          text += '\n' + values.filter((v: unknown) => typeof v === 'string').join('\n');
        }
      }
      // Reject the whole file when a page cannot be read, including mixed scanned/text PDFs.
      if (!text.trim()) throw new DocumentError('empty');
      length += text.length;
      if (length > DOCUMENT_LIMITS.textChars) throw new DocumentError('size');
      blocks.push({ text: `Page ${n}`, prose: false }, { text: text.trim(), prose: true });
      page.cleanup();
    }
    return blocks;
  } finally {
    clearTimeout(timer);
    await task.destroy();
  }
}
