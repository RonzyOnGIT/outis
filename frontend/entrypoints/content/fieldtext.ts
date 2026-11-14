import type { InsertionContext } from './insert';

/**
 * The text of an input box plus a way to map text offsets back to DOM ranges
 * (so we can underline findings inside rich editors without touching their DOM).
 */
export interface FieldText {
  text: string;
  /** DOM range for [start, end) — only for contenteditable editors. */
  rangeFor(start: number, end: number): Range | null;
}

const BLOCK = new Set(['P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TR', 'UL', 'OL', 'TABLE', 'SECTION', 'ARTICLE']);

function nearestBlock(node: Node, root: Element): Element {
  let el = node.parentElement;
  while (el && el !== root && !BLOCK.has(el.tagName)) el = el.parentElement;
  return el ?? root;
}

export function readField(ctx: InsertionContext): FieldText {
  if (ctx.kind === 'input') return { text: ctx.el.value, rangeFor: () => null };

  const root = ctx.el;
  const segments: Array<{ node: Text; start: number }> = [];
  let text = '';
  let lastBlock: Element | null = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (n.nodeType === Node.ELEMENT_NODE) {
      const tag = (n as Element).tagName;
      // ProseMirror adds a trailing <br> to empty paragraphs — it's not content.
      if (tag === 'BR' && !(n as Element).classList.contains('ProseMirror-trailingBreak')) text += '\n';
      continue;
    }
    const t = n as Text;
    if (!t.data) continue;
    const block = nearestBlock(t, root);
    if (lastBlock && block !== lastBlock && text && !text.endsWith('\n')) text += '\n';
    lastBlock = block;
    segments.push({ node: t, start: text.length });
    text += t.data;
  }

  const locate = (offset: number, preferEnd: boolean): [Text, number] | null => {
    for (const s of segments) {
      const end = s.start + s.node.data.length;
      if (offset >= s.start && (offset < end || (preferEnd && offset === end))) return [s.node, offset - s.start];
    }
    return null;
  };

  return {
    text,
    rangeFor(start, end) {
      const a = locate(start, false);
      const b = locate(end, true);
      if (!a || !b) return null;
      const r = new Range();
      r.setStart(a[0], a[1]);
      r.setEnd(b[0], b[1]);
      return r;
    },
  };
}
