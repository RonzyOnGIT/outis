import { anonymize, detectDictionary, detectKnownValues, detectRules, neutralizeLight, resolveSpans, Vault, type DetectOptions, type Span } from '@nobody/engine';
import { DOCUMENT_LIMITS, DocumentError, type DocumentBlock, type ExtractedDocument } from './types';

export interface DocumentServices {
  analyze: (text: string) => Promise<{ spans: Span[]; nerUsed: boolean }>;
  rewrite?: (text: string) => Promise<{ text: string; rewritten: boolean }>;
  check: () => void;
  progress: (done: number, total: number) => void;
  phase?: (phase: 'detect' | 'rewrite', part?: number, total?: number) => void;
}

/** One part of a document before and after cleaning, for side-by-side review. */
export interface DocumentPart {
  /** Text extracted from the original file. */
  original: string;
  /** The same part in the cleaned copy. */
  cleaned: string;
  /** Tables, sheets and other structured data: never rewritten for style. */
  structured: boolean;
  /** Ranges of `original` that were replaced by placeholders. */
  hidden: Array<[number, number]>;
}

/** `text` is the cleaned copy: its parts joined by blank lines. */
export interface CleanDocument { text: string; notes: string[]; findings: number; parts: DocumentPart[]; }

/** Bound each model call, prefer paragraph/line boundaries, and never split a token. */
export function documentChunks(block: DocumentBlock, limit = 4000): DocumentBlock[] {
  const chunks: DocumentBlock[] = [];
  let remaining = block.text;
  while (remaining.length > limit) {
    let end = remaining.lastIndexOf('\n', limit);
    if (end < limit / 2) end = remaining.lastIndexOf(' ', limit);
    // An unbroken token can contain an email/secret. Do not break it into undetectable pieces.
    if (end < 1) {
      const next = remaining.slice(limit).search(/\s/);
      end = next < 0 ? remaining.length : limit + next;
    }
    chunks.push({ text: remaining.slice(0, end), prose: block.prose });
    remaining = remaining.slice(end);
    if (remaining.startsWith('\n')) { chunks[chunks.length - 1].text += '\n'; remaining = remaining.slice(1); }
    else if (remaining.startsWith(' ')) { chunks[chunks.length - 1].text += ' '; remaining = remaining.slice(1); }
  }
  if (remaining) chunks.push({ text: remaining, prose: block.prose });
  return chunks;
}

/** Two passes: collect names throughout the document, then replace consistently everywhere. */
export async function sanitizeDocument(
  document: ExtractedDocument,
  vault: Vault,
  options: DetectOptions & { style: 'off' | 'light' | 'ai' },
  services: DocumentServices,
): Promise<CleanDocument> {
  const text = document.blocks.map((b) => b.text).join('\n\n');
  if (text.length > DOCUMENT_LIMITS.textChars) throw new DocumentError('size');
  // Global rules and dictionary catch values split between formatted runs, lines or table cells.
  const chunks = documentChunks({ text, prose: false });
  const found: Span[] = [];
  let offset = 0;
  let nerUsed = true;
  let done = 0;
  for (const chunk of chunks) {
    services.check();
    // Overlap keeps names and contextual IDs detectable at chunk and paragraph boundaries.
    const start = Math.max(0, offset - 160);
    services.phase?.('detect', done + 1, chunks.length);
    const result = await services.analyze(text.slice(start, offset + chunk.text.length + 160));
    services.check();
    nerUsed &&= result.nerUsed;
    found.push(...result.spans.map((s) => ({ ...s, start: s.start + start, end: s.end + start })));
    offset += chunk.text.length;
    services.progress(++done, chunks.length * 2);
  }
  // Apply newly discovered names to earlier blocks too; use all aliases already in the site's vault.
  const known = vault.list().flatMap((e) => e.aliases.map((value) => ({ value, type: e.type })));
  const spans = resolveSpans(text, [...found, ...detectRules(text), ...detectDictionary(text, options.alwaysHide), ...detectKnownValues(text, known)], options);
  const notes = new Set(document.notes);
  if (!nerUsed) notes.add('Name detection was unavailable for some text. Only patterns, your hide list and remembered values were checked. Review names carefully.');
  let partial = false;
  // Join blocks across a detected value, and batch short prose paragraphs for style rewriting.
  const blocks: DocumentBlock[] = [];
  offset = 0;
  for (const block of document.blocks) {
    const previous = blocks[blocks.length - 1];
    if (previous && (spans.some((s) => s.start < offset && s.end > offset - 2) ||
      (previous.prose && block.prose && previous.text.length + block.text.length + 2 <= 4000))) {
      previous.text += '\n\n' + block.text;
      previous.prose &&= block.prose;
    } else blocks.push({ ...block });
    offset += block.text.length + 2;
  }
  offset = 0;
  const parts: DocumentPart[] = [];
  for (const block of blocks) {
    const end = offset + block.text.length;
    // Replace against the complete text before selecting blocks: a detected value can span a boundary.
    const local = spans.filter((s) => s.start < end && s.end > offset).map((s) => ({ ...s, start: Math.max(0, s.start - offset), end: Math.min(block.text.length, s.end - offset), text: s.text }));
    let safe = anonymize(block.text, local, vault).text;
    if (block.prose && options.style !== 'off') {
      const rewritten: string[] = [];
      for (const chunk of documentChunks({ text: safe, prose: true })) {
        services.check();
        services.phase?.('rewrite');
        let next = neutralizeLight(chunk.text);
        if (options.style === 'ai' && services.rewrite) {
          try {
            const result = await services.rewrite(chunk.text);
            next = result.text;
            partial ||= !result.rewritten;
          } catch { partial = true; }
        } else if (options.style === 'ai') partial = true;
        services.check();
        rewritten.push(next);
      }
      safe = rewritten.join('\n');
    }
    parts.push({ original: block.text, cleaned: safe, structured: !block.prose, hidden: local.map((s) => [s.start, s.end]) });
    offset = end + 2;
    services.progress(chunks.length * (1 + end / Math.max(1, text.length)), chunks.length * 2);
  }
  if (partial) notes.add('Some text uses Light style because the AI rewrite was unavailable or did not pass its meaning checks.');
  if (document.blocks.some((b) => !b.prose) && options.style !== 'off') notes.add('Structured data and table cells keep their writing style; personal info is still replaced.');
  services.progress(1, 1);
  return { text: parts.map((p) => p.cleaned).join('\n\n'), notes: [...notes], findings: spans.length, parts };
}
