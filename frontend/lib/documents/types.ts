/** Limits apply before decoding, decompressing or sending data to the local engine. */
export const DOCUMENT_LIMITS = {
  fileBytes: 10 * 1024 * 1024,
  batchBytes: 25 * 1024 * 1024,
  files: 8,
  textChars: 200_000,
  archiveBytes: 32 * 1024 * 1024,
  archiveEntries: 2048,
  pdfPages: 100,
} as const;

export const DOCUMENT_FORMATS = ['txt', 'md', 'log', 'csv', 'tsv', 'json', 'pdf', 'docx', 'xlsx', 'pptx', 'odt', 'ods', 'odp', 'rtf'] as const;
export type DocumentFormat = typeof DOCUMENT_FORMATS[number];

export interface DocumentBlock {
  text: string;
  /** Tables, CSV, JSON and logs must not be rewritten as prose. */
  prose: boolean;
}

export interface ExtractedDocument {
  format: DocumentFormat;
  blocks: DocumentBlock[];
  notes: string[];
}

export const DOCUMENT_ERRORS = {
  unsupported: 'This format is not supported. Save it as TXT, PDF, DOCX, XLSX, PPTX, ODT, ODS, ODP or RTF first. Legacy DOC/XLS/PPT, images and archives are blocked.',
  size: 'The attachment exceeds a limit: 10 MB per file, 25 MB per selection, 8 files, 200,000 text characters, 100 PDF pages or 32 MB of expanded Office content.',
  unreadable: 'This file is damaged, encrypted or cannot be read completely. Export an unencrypted text copy and try again.',
  empty: 'No readable text was found. Scanned pages and images need OCR before they can be cleaned.',
  encoding: 'This text encoding is not supported. Save the file as UTF-8 or UTF-16 and try again.',
  cancelled: 'Attachment cancelled. No original file was released.',
  changed: 'Settings or placeholder memory changed. Select the files again so the preview uses the current settings.',
  unavailable: 'The local document engine is unavailable. Reload this page and try again.',
  timeout: 'The local document reader did not finish in time. Nothing was attached. Reload the extension and this page, then try again.',
} as const;
export type DocumentErrorCode = keyof typeof DOCUMENT_ERRORS;

export class DocumentError extends Error {
  constructor(readonly code: DocumentErrorCode) { super(DOCUMENT_ERRORS[code]); }
}

export function documentFormat(name: string): DocumentFormat {
  const ext = name.split('.').pop()?.toLowerCase();
  if (!DOCUMENT_FORMATS.includes(ext as DocumentFormat)) throw new DocumentError('unsupported');
  return ext as DocumentFormat;
}

export function validateFiles(files: readonly { name: string; size: number }[]): void {
  if (!files.length || files.length > DOCUMENT_LIMITS.files || files.reduce((n, f) => n + f.size, 0) > DOCUMENT_LIMITS.batchBytes) throw new DocumentError('size');
  for (const file of files) {
    documentFormat(file.name);
    if (file.size > DOCUMENT_LIMITS.fileBytes) throw new DocumentError('size');
    if (!file.size) throw new DocumentError('empty');
  }
}

export function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  if (value.length > Math.ceil(DOCUMENT_LIMITS.fileBytes / 3) * 4) throw new DocumentError('size');
  const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
  if (bytes.length > DOCUMENT_LIMITS.fileBytes) throw new DocumentError('size');
  return bytes;
}
