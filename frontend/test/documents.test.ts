import { describe, expect, it } from 'vitest';
import { detectDictionary, detectRules, resolveSpans, Vault } from '@nobody/engine';
import { bytesToBase64, base64ToBytes, DOCUMENT_LIMITS, DocumentError, documentFormat, validateFiles, type ExtractedDocument } from '../lib/documents/types';
import { documentChunks, sanitizeDocument, type DocumentServices } from '../lib/documents/sanitize';
import { extractRtf } from '../lib/documents/rtf';

const document = (text: string, prose = true): ExtractedDocument => ({ format: 'txt', blocks: [{ text, prose }], notes: [] });
const services = (extra: Partial<DocumentServices> = {}): DocumentServices => ({
  analyze: async (text) => ({ spans: resolveSpans(text, detectRules(text)), nerUsed: true }),
  check: () => {}, progress: () => {}, ...extra,
});
const bytes = (text: string) => new TextEncoder().encode(text);

describe('document boundaries and limits', () => {
  it('recognizes common document extensions case-insensitively, never by a fake MIME alone', () => {
    expect(documentFormat('private.report.DOCX')).toBe('docx');
    for (const name of ['private.doc', 'macro.docm', 'photo.png', 'archive.zip', 'report.pdf.exe']) expect(() => documentFormat(name)).toThrow(DocumentError);
  });
  it('validates the whole selection and bounds file counts and bytes', () => {
    expect(() => validateFiles([{ name: 'a.txt', size: 1 }, { name: 'b.doc', size: 1 }])).toThrow();
    expect(() => validateFiles([{ name: 'a.txt', size: DOCUMENT_LIMITS.fileBytes + 1 }])).toThrow();
    expect(() => validateFiles(Array.from({ length: 9 }, () => ({ name: 'a.txt', size: 1 })))).toThrow();
    expect(() => validateFiles(Array.from({ length: 3 }, () => ({ name: 'a.txt', size: DOCUMENT_LIMITS.fileBytes })))).toThrow();
    expect(() => validateFiles([{ name: 'empty.txt', size: 0 }])).toThrow();
  });
  it('round-trips Unicode and binary bytes through Chrome JSON messaging', () => {
    const input = new Uint8Array([...bytes('Résumé 世界'), 0, 255, 128]);
    expect(base64ToBytes(bytesToBase64(input))).toEqual(input);
  });
  it('chunks without losing whitespace or splitting long secrets', () => {
    const token = 'sk-' + 'a'.repeat(6000);
    const text = `Before\n${token}\nAfter  next`;
    const chunks = documentChunks({ text, prose: true }, 20);
    expect(chunks.map((c) => c.text).join('')).toBe(text);
    expect(chunks.some((c) => c.text.includes(token))).toBe(true);
  });
});

describe('shared local document privacy pipeline', () => {
  it('shares placeholders with chat and subsequent attachments', async () => {
    const vault = new Vault();
    expect(vault.assign('EMAIL', 'alice@example.com')).toBe('[EMAIL_1]');
    const a = await sanitizeDocument(document('Email alice@example.com and bob@example.com'), vault, { style: 'off' }, services());
    const b = await sanitizeDocument(document('bob@example.com'), vault, { style: 'off' }, services());
    expect(a.text).toBe('Email [EMAIL_1] and [EMAIL_2]');
    expect(b.text).toBe('[EMAIL_2]');
  });
  it('keeps structured values and punctuation intact when AI style is selected', async () => {
    let calls = 0;
    const input = '{"email":"alice@example.com","amount":2.25,"note":"Honestly!!"}';
    const result = await sanitizeDocument(document(input, false), new Vault(), { style: 'ai' }, services({ rewrite: async () => { calls++; return { text: 'wrong', rewritten: true }; } }));
    expect(calls).toBe(0);
    expect(result.text).toBe(input.replace('alice@example.com', '[EMAIL_1]'));
  });
  it('applies category switches and the never-hide list', async () => {
    const input = 'alice@example.com';
    expect((await sanitizeDocument(document(input), new Vault(), { style: 'off', policy: { EMAIL: false } }, services())).text).toBe(input);
    expect((await sanitizeDocument(document(input), new Vault(), { style: 'off', neverHide: [input] }, services())).text).toBe(input);
  });
  it('finds a name straddling chunks and uses one placeholder across blocks', async () => {
    const name = 'Martha\n\nJohnson';
    const input: ExtractedDocument = { format: 'docx', notes: [], blocks: [{ text: 'Hello Martha', prose: true }, { text: 'Johnson, welcome.', prose: true }] };
    const result = await sanitizeDocument(input, new Vault(), { style: 'off', alwaysHide: [{ value: name, type: 'PERSON' }] }, services());
    expect(result.text).toBe('Hello [PERSON_1], welcome.');
    const boundary = 'x '.repeat(1997) + 'Martha Johnson arrives.';
    const seen: string[] = [];
    const r = await sanitizeDocument(document(boundary), new Vault(), { style: 'off' }, services({ analyze: async (text) => {
      seen.push(text);
      return { spans: detectDictionary(text, [{ value: 'Martha Johnson', type: 'PERSON' }]), nerUsed: true };
    } }));
    expect(seen.some((s) => s.includes('Martha Johnson'))).toBe(true);
    expect(r.text).not.toMatch(/Martha|Johnson/);
  });
  it('batches many short paragraphs without losing their text', async () => {
    const input: ExtractedDocument = { format: 'docx', notes: [], blocks: Array.from({ length: 300 }, (_, i) => ({ text: `Paragraph ${i} is ordinary text.`, prose: true })) };
    let calls = 0;
    const result = await sanitizeDocument(input, new Vault(), { style: 'off' }, services({ analyze: async () => { calls++; return { spans: [], nerUsed: true }; } }));
    expect(calls).toBeLessThan(5);
    expect(result.text).toBe(input.blocks.map(b => b.text).join('\n\n'));
  });
  it('warns about degraded name detection and AI fallback without exposing the original', async () => {
    const result = await sanitizeDocument(document('Honestly, email alice@example.com!!'), new Vault(), { style: 'ai' }, services({
      analyze: async (text) => ({ spans: detectRules(text), nerUsed: false }),
      rewrite: async () => { throw new Error('offline'); },
    }));
    expect(result.text).toContain('[EMAIL_1]');
    expect(result.text).not.toContain('alice@example.com');
    expect(result.notes.join(' ')).toMatch(/Name detection.*Light style/);
  });
  it('discards work after cancellation and leaves the caller’s vault untouched', async () => {
    const vault = new Vault();
    let cancelled = false;
    await expect(sanitizeDocument(document('alice@example.com'), vault.clone(), { style: 'off' }, services({
      analyze: async (text) => { cancelled = true; return { spans: detectRules(text), nerUsed: true }; },
      check: () => { if (cancelled) throw new DocumentError('cancelled'); },
    }))).rejects.toThrow('cancelled');
    expect(vault.size).toBe(0);
  });
  it('refuses oversized extracted text before model work', async () => {
    await expect(sanitizeDocument(document('a'.repeat(DOCUMENT_LIMITS.textChars + 1)), new Vault(), { style: 'off' }, services())).rejects.toThrow('limit');
  });
});

describe('RTF text extraction', () => {
  it('joins formatted runs, decodes escapes and skips private destinations and hidden text', () => {
    const rtf = String.raw`{\rtf1\ansi\ansicpg1252{\info{\author Secret Author}}Email {\b alice}@example.com\par Caf\'e9 \u233? {\v Hidden Name}{\*\custom secret}{\pict 414243}Done}`;
    expect(extractRtf(bytes(rtf))).toBe('Email alice@example.com\nCafé é Done');
  });
  it('reads field results without copying field instructions or binary objects', () => {
    const rtf = String.raw`{\rtf1{\field{\*\fldinst HYPERLINK "https://secret.example"}{\fldrslt Public label}}{\object\bin3 abc}End}`;
    expect(extractRtf(bytes(rtf))).toBe('Public labelEnd');
  });
  it('rejects truncated groups, malformed escapes and unsupported code pages', () => {
    for (const rtf of [String.raw`{\rtf1 broken`, String.raw`{\rtf1 \'XX}`, String.raw`{\rtf1\ansicpg932 text}`, 'not RTF']) expect(() => extractRtf(bytes(rtf))).toThrow(DocumentError);
  });
});
