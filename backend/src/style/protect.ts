/**
 * Split text into prose (safe to restyle) and protected parts (code, logs, stack traces)
 * that must stay byte-for-byte identical — bug reports depend on exact error text.
 */
export interface Segment {
  text: string;
  protected: boolean;
}

export const CODE_LINE =
  /^(?:\s{4,}|\t)|^\s*(?:at\s+\S+\s*\(|at\s+[\w$.<>]+:\d|File ".*", line \d+|Traceback \(most recent call last\)|\$ |> |#include|import |from \S+ import|def |class |function |const |let |var |public |private |return\b|[}\])];?\s*$)|^\s*[\w.$]+(?:Error|Exception)\b|^\s*\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}|[;{]\s*$/;

export function splitProtected(text: string): Segment[] {
  const segments: Segment[] = [];
  const push = (t: string, isProtected: boolean) => {
    if (!t) return;
    const last = segments[segments.length - 1];
    if (last && last.protected === isProtected) last.text += t;
    else segments.push({ text: t, protected: isProtected });
  };

  // 1) Fenced code blocks.
  const fence = /```[\s\S]*?(?:```|$)/g;
  let cursor = 0;
  for (const m of text.matchAll(fence)) {
    splitLines(text.slice(cursor, m.index), push);
    push(m[0], true);
    cursor = m.index! + m[0].length;
  }
  splitLines(text.slice(cursor), push);
  return segments;
}

function splitLines(chunk: string, push: (t: string, p: boolean) => void) {
  if (!chunk) return;
  const lines = chunk.split(/(?<=\n)/);
  for (const line of lines) {
    if (CODE_LINE.test(line.replace(/\n$/, ''))) {
      push(line, true);
      continue;
    }
    // 2) Inline code spans inside prose.
    let c = 0;
    for (const m of line.matchAll(/`[^`\n]+`/g)) {
      push(line.slice(c, m.index), false);
      push(m[0], true);
      c = m.index! + m[0].length;
    }
    push(line.slice(c), false);
  }
}

/** True if the segment has real words worth rewriting (not just whitespace/punctuation). */
export function hasProse(text: string): boolean {
  return /\p{L}{2,}/u.test(text.replace(/\[[A-Z]+_\d+\]/g, ''));
}
