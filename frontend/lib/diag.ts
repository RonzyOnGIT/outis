/**
 * Privacy-safe diagnostics: what happened, never what was written.
 * Entries hold step names, editor info and text *lengths* only. Kept in RAM-only session storage.
 */
const KEY = 'nobody:diag';
const MAX = 120;

export type DiagEntry = { t: string; site: string; step: string } & Record<string, string | number | boolean | null>;

let queue: DiagEntry[] = [];
let flushing = false;

export function diag(step: string, data: Record<string, string | number | boolean | null | undefined> = {}): void {
  const entry: DiagEntry = { t: new Date().toISOString().slice(11, 23), site: location.hostname, step };
  for (const [k, v] of Object.entries(data)) if (v !== undefined) entry[k] = v;
  console.info('[Nobody]', step, data);
  queue.push(entry);
  void flush();
}

async function flush(): Promise<void> {
  if (flushing) return;
  flushing = true;
  try {
    while (queue.length) {
      const batch = queue;
      queue = [];
      const prev = ((await browser.storage.session.get(KEY))[KEY] as DiagEntry[] | undefined) ?? [];
      await browser.storage.session.set({ [KEY]: [...prev, ...batch].slice(-MAX) });
    }
  } catch {
    /* storage not available (e.g. extension updated) — console only */
  } finally {
    flushing = false;
  }
}

export async function readDiag(): Promise<DiagEntry[]> {
  return ((await browser.storage.session.get(KEY))[KEY] as DiagEntry[] | undefined) ?? [];
}

export async function clearDiag(): Promise<void> {
  await browser.storage.session.remove(KEY);
}

/** Describe an editor element without its content. */
export function describeEditor(el: Element | null | undefined): string {
  if (!el) return 'none';
  const cls = (el.getAttribute('class') ?? '').split(/\s+/).filter(Boolean).slice(0, 4).join('.');
  const data = [...el.attributes].map((a) => a.name).filter((n) => n.startsWith('data-')).slice(0, 4).join(',');
  return `${el.tagName.toLowerCase()}${el.id ? '#' + el.id : ''}${cls ? '.' + cls : ''} ce=${el.getAttribute('contenteditable') ?? '-'}${data ? ' [' + data + ']' : ''}`;
}
