import { unzipSync } from 'fflate';
import { DOCUMENT_FORMATS, DOCUMENT_LIMITS, DocumentError, type DocumentBlock, type DocumentFormat, type ExtractedDocument } from './types';
import { extractRtf } from './rtf';

const OFFICE_NOTE = 'Text only: layout, images, charts, comments, speaker notes, embedded objects, macros and document metadata are omitted.';
const elements = (node: Document | Element, name: string): Element[] => [...node.getElementsByTagNameNS('*', name)];
const attr = (el: Element, name: string) => [...el.attributes].find((a) => a.localName === name)?.value ?? '';

/** Browser text decoding is strict: never send binary or silently replace undecodable bytes. */
export function decodeText(bytes: Uint8Array): string {
  const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? 'utf-16le' : bytes[0] === 0xfe && bytes[1] === 0xff ? 'utf-16be' : 'utf-8';
  let text: string;
  try { text = new TextDecoder(encoding, { fatal: true }).decode(bytes); }
  catch { throw new DocumentError('encoding'); }
  if (/[\u0000-\u0008\u000b\u000e-\u001f\u007f]/.test(text)) throw new DocumentError('encoding');
  return text.replace(/\r\n?/g, '\n');
}

function xml(bytes: Uint8Array | undefined): Document {
  if (!bytes) throw new DocumentError('unreadable');
  const text = decodeText(bytes);
  if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new DocumentError('unreadable');
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (elements(doc, 'parsererror').length) throw new DocumentError('unreadable');
  return doc;
}

/** Only text-bearing parts are unpacked. Preflight *all* entries before allocating inflated data. */
function officeParts(bytes: Uint8Array): Record<string, Uint8Array> {
  let size = 0;
  let count = 0;
  const names = new Set<string>();
  unzipSync(bytes, { filter: (entry) => {
    size += entry.originalSize;
    if (++count > DOCUMENT_LIMITS.archiveEntries || size > DOCUMENT_LIMITS.archiveBytes || !Number.isSafeInteger(size)) throw new DocumentError('size');
    if (names.has(entry.name) || entry.name.split('/').includes('..')) throw new DocumentError('unreadable');
    names.add(entry.name);
    return false;
  } });
  return unzipSync(bytes, { filter: ({ name }) => /^(?:word\/(?:document|header\d+|footer\d+|footnotes|endnotes)\.xml|xl\/(?:workbook\.xml|_rels\/workbook\.xml\.rels|sharedStrings\.xml|worksheets\/sheet\d+\.xml)|ppt\/(?:presentation\.xml|_rels\/presentation\.xml\.rels|slides\/slide\d+\.xml)|content\.xml|META-INF\/manifest\.xml)$/.test(name) });
}

function excluded(el: Element): boolean {
  for (let p: Element | null = el; p; p = p.parentElement) {
    if (['del', 'moveFrom', 'annotation', 'tracked-changes'].includes(p.localName)) return true;
    if (p.localName === 'r' && elements(p, 'vanish').some((v) => !['false', '0', 'off'].includes(attr(v, 'val')))) return true;
  }
  return false;
}

function paragraphs(doc: Document | Element): DocumentBlock[] {
  return elements(doc, 'p').filter((p) => !excluded(p)).map((p) => {
    const walk = (el: Element): string => {
      if (excluded(el) || (el !== p && el.localName === 'p')) return '';
      if (el.localName === 't') return el.textContent ?? '';
      if (el.localName === 'tab') return '\t';
      if (['br', 'cr'].includes(el.localName)) return '\n';
      return [...el.children].map(walk).join('');
    };
    return { text: walk(p), prose: !p.closest('tbl, tc') && !hasAncestor(p, 'tc') };
  });
}

function hasAncestor(el: Element, name: string): boolean {
  for (let p = el.parentElement; p; p = p.parentElement) if (p.localName === name) return true;
  return false;
}

function relationship(parts: Record<string, Uint8Array>, relFile: string, base: string, id: string): string {
  const rel = elements(xml(parts[relFile]), 'Relationship').find((r) => attr(r, 'Id') === id);
  if (!rel || attr(rel, 'TargetMode') === 'External') throw new DocumentError('unreadable');
  const target = attr(rel, 'Target');
  // OPC targets may be package-absolute. Never resolve against the network or filesystem.
  const path = target.startsWith('/') ? target.slice(1) : base + target;
  if (path.split('/').includes('..') || !parts[path]) throw new DocumentError('unreadable');
  return path;
}

function extractDocx(parts: Record<string, Uint8Array>): DocumentBlock[] {
  const doc = xml(parts['word/document.xml']);
  if (!elements(doc, 'body').length) throw new DocumentError('unreadable');
  const extra = Object.keys(parts).filter((p) => /^word\/(?:header\d+|footer\d+|footnotes|endnotes)\.xml$/.test(p)).sort();
  return [doc, ...extra.map((p) => xml(parts[p]))].flatMap(paragraphs);
}

function extractXlsx(parts: Record<string, Uint8Array>): DocumentBlock[] {
  const workbook = xml(parts['xl/workbook.xml']);
  const strings = parts['xl/sharedStrings.xml'] ? elements(xml(parts['xl/sharedStrings.xml']), 'si').map((si) => elements(si, 't').filter((t) => !hasAncestor(t, 'rPh')).map((t) => t.textContent ?? '').join('')) : [];
  const blocks: DocumentBlock[] = [];
  for (const sheet of elements(workbook, 'sheet')) {
    if (attr(sheet, 'state') && attr(sheet, 'state') !== 'visible') continue;
    const path = relationship(parts, 'xl/_rels/workbook.xml.rels', 'xl/', attr(sheet, 'id'));
    const doc = xml(parts[path]);
    blocks.push({ text: `Sheet: ${attr(sheet, 'name')}`, prose: false });
    for (const row of elements(doc, 'row')) {
      if (['1', 'true'].includes(attr(row, 'hidden'))) continue;
      const cells: string[] = [];
      for (const cell of elements(row, 'c')) {
        const ref = attr(cell, 'r');
        if (!/^[A-Z]{1,3}[1-9]\d*$/.test(ref)) throw new DocumentError('unreadable');
        const column = ref.match(/^[A-Z]+/)![0];
        const index = [...column].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0) - 1;
        if (index > 16383 || index < cells.length) throw new DocumentError('unreadable');
        while (cells.length < index) cells.push('');
        const type = attr(cell, 't');
        const value = elements(cell, 'v')[0]?.textContent ?? '';
        let text = value;
        if (type === 's') {
          if (!/^\d+$/.test(value) || strings[Number(value)] === undefined) throw new DocumentError('unreadable');
          text = strings[Number(value)];
        } else if (type === 'inlineStr') text = elements(cell, 't').map((t) => t.textContent ?? '').join('');
        else if (type === 'b') text = value === '1' ? 'TRUE' : 'FALSE';
        // Formula code is never exported. Missing cached values cannot be silently dropped.
        if (elements(cell, 'f').length && !elements(cell, 'v').length) throw new DocumentError('unreadable');
        cells.push(text.includes('\t') || text.includes('\n') || text.includes('"') ? `"${text.replaceAll('"', '""')}"` : text);
      }
      blocks.push({ text: cells.join('\t'), prose: false });
    }
  }
  return blocks;
}

function extractPptx(parts: Record<string, Uint8Array>): DocumentBlock[] {
  const doc = xml(parts['ppt/presentation.xml']);
  return elements(doc, 'sldId').flatMap((slide, i) => {
    const id = [...slide.attributes].find((a) => a.localName === 'id' && a.namespaceURI)?.value;
    const path = relationship(parts, 'ppt/_rels/presentation.xml.rels', 'ppt/', id ?? '');
    return [{ text: `Slide ${i + 1}`, prose: false }, ...paragraphs(xml(parts[path]))];
  });
}

function odfText(el: Element): string {
  if (excluded(el) || ['binary-data', 'script', 'event-listeners'].includes(el.localName)) return '';
  if (el.localName === 's') {
    const count = Number(attr(el, 'c') || 1);
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new DocumentError('size');
    return ' '.repeat(count);
  }
  if (el.localName === 'tab') return '\t';
  if (el.localName === 'line-break') return '\n';
  return [...el.childNodes].map((n) => n.nodeType === Node.TEXT_NODE ? n.textContent ?? '' : n instanceof Element ? odfText(n) : '').join('');
}

function extractOdf(parts: Record<string, Uint8Array>, format: DocumentFormat): DocumentBlock[] {
  if (parts['META-INF/manifest.xml'] && elements(xml(parts['META-INF/manifest.xml']), 'encryption-data').length) throw new DocumentError('unreadable');
  const doc = xml(parts['content.xml']);
  const body = elements(doc, 'body')[0];
  if (!body) throw new DocumentError('unreadable');
  if (format !== 'ods') return [...body.getElementsByTagName('*')].filter((e) => ['p', 'h'].includes(e.localName) && !excluded(e) && !hasAncestor(e, 'notes')).map((e) => ({ text: odfText(e), prose: !hasAncestor(e, 'table-cell') }));
  const blocks: DocumentBlock[] = [];
  for (const table of elements(body, 'table')) {
    blocks.push({ text: `Sheet: ${attr(table, 'name')}`, prose: false });
    for (const row of elements(table, 'table-row')) {
      if (attr(row, 'visibility') && attr(row, 'visibility') !== 'visible') continue;
      const values: string[] = [];
      for (const cell of [...row.children].filter((e) => ['table-cell', 'covered-table-cell'].includes(e.localName))) {
        const count = Number(attr(cell, 'number-columns-repeated') || 1);
        if (!Number.isInteger(count) || count < 1 || count > 16384 || values.length + count > 16384) throw new DocumentError('size');
        const text = elements(cell, 'p').map(odfText).join('\n') || attr(cell, 'string-value') || attr(cell, 'date-value') || attr(cell, 'value') || attr(cell, 'boolean-value');
        const quoted = /[\t\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
        for (let n = 0; n < count; n++) values.push(quoted);
      }
      // ODS often repeats thousands of empty trailing rows; no content is lost by omitting them.
      const line = values.join('\t');
      if (!line.trim()) continue;
      const repeats = Number(attr(row, 'number-rows-repeated') || 1);
      if (!Number.isInteger(repeats) || repeats < 1 || repeats * line.length > DOCUMENT_LIMITS.textChars) throw new DocumentError('size');
      blocks.push({ text: Array.from({ length: repeats }, () => line).join('\n'), prose: false });
    }
  }
  return blocks;
}

export async function extractDocument(bytes: Uint8Array, format: DocumentFormat): Promise<ExtractedDocument> {
  if (!DOCUMENT_FORMATS.includes(format)) throw new DocumentError('unsupported');
  if (bytes.length > DOCUMENT_LIMITS.fileBytes) throw new DocumentError('size');
  try {
    let blocks: DocumentBlock[];
    let notes: string[] = [];
    if (format === 'pdf') {
      const { extractPdf } = await import('./pdf');
      blocks = await extractPdf(bytes);
      notes = ['Text only: PDF layout, images, attachments, annotations and metadata are omitted. Check reading order in multi-column pages.'];
    } else if (['docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp'].includes(format)) {
      const parts = officeParts(bytes);
      blocks = format === 'docx' ? extractDocx(parts) : format === 'xlsx' ? extractXlsx(parts) : format === 'pptx' ? extractPptx(parts) : extractOdf(parts, format);
      notes = [OFFICE_NOTE];
      if (format === 'xlsx') notes.push('Sheets are exported as tab-separated stored values (dates may be Excel serial numbers). Formulas are not calculated. Hidden sheets and rows are omitted.');
      if (format === 'ods') notes.push('Sheets are exported as tab-separated stored values. Formulas are not calculated. Hidden rows are omitted.');
    } else if (format === 'rtf') {
      blocks = [{ text: extractRtf(bytes), prose: true }];
      notes = [OFFICE_NOTE];
    } else {
      blocks = [{ text: decodeText(bytes), prose: ['txt', 'md'].includes(format) }];
    }
    blocks = blocks.filter((b) => b.text.trim());
    if (!blocks.length) throw new DocumentError('empty');
    if (blocks.reduce((n, b) => n + b.text.length + 2, 0) > DOCUMENT_LIMITS.textChars) throw new DocumentError('size');
    return { format, blocks, notes };
  } catch (e) {
    if (e instanceof DocumentError) throw e;
    // Parser errors can contain document text or names. Only allowlisted errors leave this module.
    throw new DocumentError('unreadable');
  }
}
