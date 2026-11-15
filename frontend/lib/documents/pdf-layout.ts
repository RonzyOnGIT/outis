import type { DocumentBlock } from './types';

/**
 * Turns the positioned text of one PDF page into blocks: running text in the order the file
 * stores it, and tables as tab-separated rows. A PDF has no table objects, only text at
 * coordinates, so a table is recognised in one of two ways:
 *  - the file names its cells itself (structure tags written by Word, Google Docs, LibreOffice
 *    and browsers), or
 *  - lines of text share the same column gaps and the file stores them row by row.
 * Anything that does not clearly look like a table keeps the plain reading-order export.
 */
export interface PdfTextItem {
  str: string;
  /** Left end of the baseline. `y` grows down the page. */
  x: number;
  y: number;
  width: number;
  /** Font height. */
  height: number;
  /** PDF.js saw a line break after this item. */
  eol: boolean;
  /** Not horizontal (a rotated label): kept in the running text, never a table cell. */
  rotated?: boolean;
  /** Table cell named by the file's structure tags: [table, row, cell]. */
  cell?: readonly [number, number, number];
}

/** The parts of PDF.js text content and structure trees that are read here. */
export type PdfContentItem = { str: string; transform: number[]; width: number; hasEOL: boolean } | { type: string; id?: string };
export interface PdfStructNode { role?: string; type?: string; id?: string; children?: PdfStructNode[]; }
type Cell = readonly [number, number, number];

/** Table cells in a page's structure tree: marked-content id → [table, row, cell]. */
export function taggedCells(tree: PdfStructNode | null | undefined): Map<string, Cell> {
  const cells = new Map<string, Cell>();
  let tables = 0;
  // Everything inside a cell belongs to it, including a table nested in it.
  const mark = (node: PdfStructNode, cell: Cell, depth: number) => {
    for (const child of node.children ?? []) {
      if (child.children) {
        if (depth < 100) mark(child, cell, depth + 1);
      } else if (child.type === 'content' && child.id) cells.set(child.id, cell);
    }
  };
  // Rows may sit inside THead / TBody / TFoot.
  const rows = (node: PdfStructNode, table: number, count: { rows: number }, depth: number) => {
    for (const child of node.children ?? []) {
      if (!child.children) continue;
      if (child.role === 'TR') {
        let cell = 0;
        for (const c of child.children) if (c.children && (c.role === 'TD' || c.role === 'TH')) mark(c, [table, count.rows, cell++], 0);
        count.rows++;
      } else if (depth < 20) rows(child, table, count, depth + 1);
    }
  };
  const visit = (node: PdfStructNode, depth: number) => {
    if (!node.children || depth > 100) return;
    if (node.role === 'Table') rows(node, tables++, { rows: 0 }, 0);
    else for (const child of node.children) visit(child, depth + 1);
  };
  if (tree) visit(tree, 0);
  return cells;
}

/** PDF.js text content (with marked content) in page coordinates that grow rightwards and down. */
export function pageItems(content: readonly PdfContentItem[], viewport: readonly number[], cells: Map<string, Cell> = new Map()): PdfTextItem[] {
  const [va = 1, vb = 0, vc = 0, vd = 1, ve = 0, vf = 0] = viewport;
  const items: PdfTextItem[] = [];
  const open: Array<string | undefined> = [];
  for (const item of content) {
    if (!('str' in item)) {
      if (item.type === 'endMarkedContent') open.pop();
      else open.push(item.id);
      continue;
    }
    const [a = 1, b = 0, c = 0, d = 1, e = 0, f = 0] = item.transform;
    let cell: Cell | undefined;
    for (let i = open.length - 1; i >= 0 && !cell; i--) cell = open[i] ? cells.get(open[i]!) : undefined;
    items.push({
      str: item.str,
      x: va * e + vc * f + ve,
      y: vb * e + vd * f + vf,
      width: item.width,
      height: Math.hypot(va * c + vc * d, vb * c + vd * d),
      eol: item.hasEOL,
      rotated: Math.abs(Math.atan2(vb * a + vd * b, va * a + vc * b)) > 0.05,
      ...(cell ? { cell } : {}),
    });
  }
  return items;
}

interface Piece extends PdfTextItem { index: number; }
interface Box { x0: number; x1: number; }
/** Neighbouring pieces on one line without a column-sized gap: one line of one cell. */
interface Segment extends Box { pieces: Piece[]; first: number; last: number; }
/** `first`/`last` are positions in the file's own text order. */
interface Line { y: number; height: number; segments: Segment[]; first: number; last: number; }
interface Table { first: number; last: number; taken: Set<number>; text: string; }

/** A longer cell means page layout built with a table, not data (same limit as DOCX tables). */
const CELL_CHARS = 1200;
const LIST_MARKER = /^(?:[•◦▪■□●○‣⁃·*–—-]|\(?(?:\d{1,3}|[a-z]|[ivxlcdm]{1,6})[.)])$/i;

const overlap = (a: Box, b: Box) => Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0);
const sameLine = (a: Piece, b: Piece) => Math.abs(a.y - b.y) <= 0.5 * Math.min(a.height, b.height);
const median = (values: number[]) => [...values].sort((a, b) => a - b)[values.length >> 1] ?? 0;

/** Set directly against each other on one line: one word in two fonts ("Bold"), not two words. */
function touching(a: Piece, b: Piece): boolean {
  if (a.rotated || b.rotated || !sameLine(a, b)) return false;
  const height = Math.min(a.height, b.height);
  const gap = b.x - (a.x + a.width);
  return gap > -0.3 * height && gap < 0.1 * height;
}

/** Text of one table cell in the file's order; line breaks inside the cell become spaces. */
function cellText(pieces: Piece[]): string {
  let text = '';
  let last: Piece | undefined;
  for (const piece of [...pieces].sort((a, b) => a.index - b.index)) {
    const str = piece.str.replace(/\s+/g, ' ');
    if (!str.trim()) {
      if (text && !text.endsWith(' ')) text += ' ';
      continue;
    }
    // A link, a hyphenated word or a date ("1984-" / "05-12") that wraps inside the cell
    // continues without a space.
    const wrapped = last && !sameLine(last, piece) && (text.endsWith('/') || (/[\p{L}\p{N}]-$/u.test(text) && /^[\p{Ll}\p{N}]/u.test(str)));
    if (text && !text.endsWith(' ') && !str.startsWith(' ') && last && !touching(last, piece) && !wrapped) text += ' ';
    text += str;
    last = piece;
  }
  return text.replace(/\s+/g, ' ').trim();
}

function lineOf(y: number, segments: Segment[]): Line {
  return {
    y,
    height: Math.max(...segments.flatMap((s) => s.pieces.map((p) => p.height))),
    segments,
    first: Math.min(...segments.map((s) => s.first)),
    last: Math.max(...segments.map((s) => s.last)),
  };
}

/** Group pieces by baseline, then cut each line where PDF.js reported a gap wider than a space. */
function visualLines(pieces: Piece[]): Line[] {
  const lines: Line[] = [];
  let current: Piece[] = [];
  const close = () => {
    if (!current.length) return;
    const y = current[0]!.y;
    const segments: Segment[] = [];
    for (const piece of current.sort((a, b) => a.x - b.x)) {
      const segment = segments[segments.length - 1];
      const end = piece.x + piece.width;
      if (segment && piece.x - segment.x1 <= 0.55 * piece.height) {
        segment.pieces.push(piece);
        segment.x1 = Math.max(segment.x1, end);
        segment.first = Math.min(segment.first, piece.index);
        segment.last = Math.max(segment.last, piece.index);
      } else segments.push({ x0: piece.x, x1: end, pieces: [piece], first: piece.index, last: piece.index });
    }
    lines.push(lineOf(y, segments));
    current = [];
  };
  for (const piece of [...pieces].sort((a, b) => a.y - b.y)) {
    if (current.length && piece.y - current[0]!.y > 0.5 * Math.min(piece.height, current[0]!.height)) close();
    current.push(piece);
  }
  close();
  return lines;
}

const isRow = (line: Line) => line.segments.length > 1;
const gaps = (line: Line): Box[] => line.segments.slice(1).map((s, i) => ({ x0: line.segments[i]!.x1, x1: s.x0 }));
/** Two rows of one table share at least one column gap. */
const aligned = (a: Line, b: Line) => gaps(a).some((ga) => gaps(b).some((gb) => overlap(ga, gb) >= 0.7 * Math.max(a.height, b.height)));
/** The segment lies across two or more cells of `row`. */
const crosses = (segment: Segment, row: Line, slack: number) => row.segments.filter((s) => overlap(segment, s) > slack).length > 1;

/** Vertical strips that no segment enters, with text on both sides in at least two rows. */
function columnGaps(lines: Line[], ignored: Set<Segment>, min: number): Box[] {
  const used = (l: Line) => l.segments.filter((s) => !ignored.has(s));
  const found: Box[] = [];
  let edge = -Infinity;
  for (const s of lines.flatMap(used).sort((a, b) => a.x0 - b.x0)) {
    if (edge > -Infinity && s.x0 - edge >= min) found.push({ x0: edge, x1: s.x0 });
    edge = Math.max(edge, s.x1);
  }
  return found.filter((g) => lines.filter((l) => used(l).some((s) => s.x1 <= g.x0 + 0.01) && used(l).some((s) => s.x0 >= g.x1 - 0.01)).length >= 2);
}

/** Strips entered by at most `tolerance` rows, between places where more rows have text. */
function sparseStrips(rows: Line[], tolerance: number): Box[] {
  const edges = rows
    .flatMap((l) => l.segments.flatMap((s) => [{ x: s.x0, step: 1 }, { x: s.x1, step: -1 }]))
    .sort((a, b) => a.x - b.x || a.step - b.step);
  const strips: Box[] = [];
  let count = 0;
  let start: number | undefined;
  for (const edge of edges) {
    const before = count;
    count += edge.step;
    if (before > tolerance && count <= tolerance) start = edge.x;
    else if (before <= tolerance && count > tolerance && start !== undefined) {
      strips.push({ x0: start, x1: edge.x });
      start = undefined;
    }
  }
  return strips;
}

function tableOf(cells: string[][], pieces: Piece[]): Table {
  const indexes = pieces.map((p) => p.index);
  return {
    first: Math.min(...indexes),
    last: Math.max(...indexes),
    taken: new Set(indexes),
    text: cells.map((row) => row.join('\t')).join('\n'),
  };
}

/**
 * Tables among lines that follow each other down the page. `order` lists the file positions of
 * all text on the page, to tell a row from text that only happens to sit beside it.
 */
function findTables(lines: Line[], order: number[], depth = 0): Table[] {
  const tables: Table[] = [];
  let run: Line[] = [];
  let anchor: Line | undefined; // the last line of the run with several segments
  // Single-segment lines just above: a heading cell that wraps starts higher than its row.
  let loose: Line[] = [];
  let previous: Line | undefined;
  const close = () => {
    tables.push(...tablesIn(run, order, depth));
    run = [];
    anchor = undefined;
    loose = [];
  };
  for (const line of lines) {
    if (previous && line.y - previous.y > 4 * Math.max(line.height, previous.height)) close();
    previous = line;
    if (isRow(line)) {
      // The cells of one row may sit on different baselines (vertically centred), so compare
      // with every row so far, not only the nearest.
      if (anchor && !run.some((l) => isRow(l) && aligned(l, line))) close();
      if (!anchor) run = loose;
      run.push(line);
      anchor = line;
    } else if (!anchor) loose = [...loose.slice(-3), line];
    else if (crosses(line.segments[0]!, anchor, 0.25 * line.height)) close();
    else run.push(line);
  }
  close();
  return tables;
}

function tablesIn(lines: Line[], order: number[], depth: number): Table[] {
  const rowLines = lines.filter(isRow);
  if (rowLines.length < 2) return [];
  // Text beside or below the rows (a page column, a caption) is stored outside their span in
  // the file. A lone line outside that span still belongs when it sits among the rows and is
  // stored right next to them (a cell merged down two rows), or directly continues the last row.
  let from = Math.min(...rowLines.map((l) => l.first));
  let to = Math.max(...rowLines.map((l) => l.last));
  const left = Math.min(...rowLines.map((l) => l.segments[0]!.x0));
  const right = Math.max(...rowLines.flatMap((l) => l.segments.map((s) => s.x1)));
  const top = lines.findIndex(isRow);
  const kept = new Set(lines.filter((l) => isRow(l) || (l.first > from && l.last < to)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const [i, line] of lines.entries()) {
      const s = line.segments[0]!;
      if (kept.has(line) || i < top || s.x0 < left - 1 || s.x1 > right + 1) continue;
      if (order.some((k) => (k > line.last && k < from) || (k > to && k < line.first))) continue;
      kept.add(line);
      from = Math.min(from, line.first);
      to = Math.max(to, line.last);
      grew = true;
    }
  }
  const run = lines.filter((l) => kept.has(l));
  const height = median(run.flatMap((l) => l.segments.flatMap((s) => s.pieces.map((p) => p.height))));
  const slack = 0.25 * height;
  const without = (i: number) => [...tablesIn(run.slice(0, i), order, depth), ...tablesIn(run.slice(i + 1), order, depth)];

  // A line lying across several cells of the row above or below is a caption, heading or
  // paragraph, not a row: the table ends there.
  for (const [i, line] of run.entries()) {
    const near = [run.slice(0, i).findLast(isRow), run.slice(i + 1).find(isRow)];
    if (near.some((row) => row && line.segments.every((s) => crosses(s, row, slack)))) return without(i);
  }

  // Two lines alone must be separated clearly; more rows confirm narrower gaps.
  const min = (rowLines.length > 2 ? 0.7 : 1.5) * height;
  // A cell merged across columns (a two-level heading, a subtotal label) must not hide the
  // column gaps under it, as long as such cells are the exception: text that crosses several
  // cells of another row, or that reaches into a strip nearly every other row keeps clear.
  const ignored = new Set<Segment>();
  const tolerance = rowLines.length >> 2;
  const crossing = rowLines.flatMap((row) => row.segments.filter((s) => rowLines.some((other) => other !== row && crosses(s, other, slack))));
  if (rowLines.filter((r) => r.segments.some((s) => crossing.includes(s))).length <= Math.max(1, tolerance)) for (const s of crossing) ignored.add(s);
  if (tolerance) {
    for (const strip of sparseStrips(rowLines, tolerance)) {
      if (strip.x1 - strip.x0 < min) continue;
      for (const s of rowLines.flatMap((l) => l.segments)) {
        // Text wholly inside the strip is a thinly filled column of its own, not a merged cell.
        if (overlap(s, strip) > slack && (s.x0 < strip.x0 - 0.01 || s.x1 > strip.x1 + 0.01)) ignored.add(s);
      }
    }
  }
  const fromRows = columnGaps(rowLines, ignored, min);
  for (const [i, line] of run.entries()) {
    const s = line.segments[0]!;
    // A lone segment may reach into a gap (a longer wrapped line), but not close it.
    if (!isRow(line) && fromRows.some((g) => overlap(s, g) > slack && Math.max(s.x0 - g.x0, g.x1 - s.x1) < min)) return without(i);
  }
  const gapsBetween = columnGaps(run, ignored, min);
  if (!gapsBetween.length) return [];
  /** The first column a segment lies in; a merged cell belongs to the column it starts in. */
  const column = (s: Box): number => {
    for (let k = 0; k <= gapsBetween.length; k++) {
      const x0 = k ? gapsBetween[k - 1]!.x1 : -Infinity;
      const x1 = k < gapsBetween.length ? gapsBetween[k]!.x0 : Infinity;
      if (Math.min(s.x1, x1) - Math.max(s.x0, x0) > 0.01) return k;
    }
    return gapsBetween.filter((g) => (g.x0 + g.x1) / 2 < s.x0).length;
  };
  const startsRow = (line: Line) => line.segments.some((s) => column(s) === 0);

  // 1. A file stores a table row by row (and a row cell by cell, so the lines of a wrapped or
  //    vertically centred cell are interleaved): a row ends where all text below comes later.
  const groups: Line[][] = [[]];
  let seen = -Infinity;
  for (const [i, line] of run.entries()) {
    groups[groups.length - 1]!.push(line);
    seen = Math.max(seen, line.last);
    const rest = run.slice(i + 1);
    if (rest.length && seen < Math.min(...rest.map((l) => l.first))) groups.push([]);
  }
  // 2. Lines with no first-column text that sit closer to the line above than rows sit to each
  //    other continue the cells above them (a last column that wraps).
  const above = (group: Line[]) => run[run.indexOf(group[0]!) - 1];
  const pitch = Math.min(...groups.slice(1).filter((g) => g.some(startsRow)).map((g) => g[0]!.y - above(g)!.y));
  const rows: Line[][] = [];
  for (const group of groups) {
    const upper = above(group);
    const continues = rows.length && upper && Number.isFinite(pitch) && !group.some(startsRow) && group[0]!.y - upper.y <= 0.85 * pitch &&
      group[0]!.segments.every((s) => upper.segments.some((u) => column(u) === column(s)));
    if (continues) rows[rows.length - 1]!.push(...group);
    else rows.push([...group]);
  }

  // Lone lines after the last real row are the text below the table.
  while (rows.length && !rows[rows.length - 1]!.some(isRow)) rows.pop();
  // A lone line as wide as most of the table is a sentence between two aligned lines (a résumé
  // entry and its description), not a cell.
  const wide = rows.find((row) => !row.some(isRow) && row.some((l) => l.segments[0]!.x1 - l.segments[0]!.x0 > 0.6 * (right - left)));
  if (wide) return without(run.indexOf(wide[0]!));

  const piecesOf = (row: Line[]) => row.flatMap((l) => l.segments.flatMap((s) => s.pieces));
  // Each row must be one unbroken stretch of the file: other text in between means these lines
  // only look aligned.
  const unbroken = (row: Line[]) => {
    const first = Math.min(...row.map((l) => l.first));
    const last = Math.max(...row.map((l) => l.last));
    return order.filter((i) => i >= first && i <= last).length === piecesOf(row).length;
  };
  if (rows.length >= 2 && rows.every(unbroken)) {
    const cells = rows.map((row) => {
      const byColumn: Piece[][] = Array.from({ length: gapsBetween.length + 1 }, () => []);
      for (const line of row) for (const s of line.segments) byColumn[column(s)]!.push(...s.pieces);
      return byColumn.map(cellText);
    });
    // "1." / "•" in a narrow first column is a list; it reads better as running text.
    if (gapsBetween.length === 1 && cells.every((c) => !c[0] || LIST_MARKER.test(c[0])) && cells.some((c) => c[0])) return [];
    // Mostly one-cell rows are text with a few right-aligned dates or page numbers (a résumé).
    if (cells.filter((c) => c.filter(Boolean).length > 1).length * 2 <= cells.length) return [];
    return [tableOf(cells, rows.flatMap(piecesOf))];
  }

  // Not stored row by row. If one side of a gap is stored entirely before the other, these are
  // page columns (or text next to a table): look for tables inside each side.
  if (depth >= 3) return [];
  for (const gap of [...gapsBetween].sort((a, b) => b.x1 - b.x0 - (a.x1 - a.x0))) {
    const middle = (gap.x0 + gap.x1) / 2;
    const side = (keep: (s: Segment) => boolean) => run.flatMap((l) => {
      const segments = l.segments.filter(keep);
      return segments.length ? [lineOf(l.y, segments)] : [];
    });
    const left = side((s) => s.x1 <= middle);
    const right = side((s) => s.x0 >= middle);
    const count = (ls: Line[]) => ls.reduce((n, l) => n + l.segments.length, 0);
    if (!left.length || !right.length || count(left) + count(right) !== count(run)) continue;
    const span = (ls: Line[]) => [Math.min(...ls.map((l) => l.first)), Math.max(...ls.map((l) => l.last))] as const;
    const [leftFirst, leftLast] = span(left);
    const [rightFirst, rightLast] = span(right);
    if (leftLast < rightFirst || rightLast < leftFirst) return [...findTables(left, order, depth + 1), ...findTables(right, order, depth + 1)];
  }
  return [];
}

/** Tables whose rows and cells are named by the file's own structure tags. */
function taggedTables(pieces: Piece[]): Table[] {
  const groups = new Map<number, Piece[]>();
  for (const p of pieces) {
    if (!p.cell) continue;
    const group = groups.get(p.cell[0]);
    if (group) group.push(p);
    else groups.set(p.cell[0], [p]);
  }
  const tables: Table[] = [];
  for (const members of groups.values()) {
    const byRow = new Map<number, Map<number, Piece[]>>();
    for (const p of members) {
      if (!p.str.trim()) continue;
      const row = byRow.get(p.cell![1]) ?? new Map<number, Piece[]>();
      byRow.set(p.cell![1], row.set(p.cell![2], [...(row.get(p.cell![2]) ?? []), p]));
    }
    const rows = [...byRow.entries()].sort((a, b) => a[0] - b[0]).map(([, cells]) =>
      [...cells.entries()].sort((a, b) => a[0] - b[0]).map(([index, list]) => ({
        index,
        text: cellText(members.filter((p) => p.cell![1] === list[0]!.cell![1] && p.cell![2] === index)),
        x0: Math.min(...list.map((p) => p.x)),
        x1: Math.max(...list.map((p) => p.x + p.width)),
      })));
    const width = Math.max(0, ...rows.map((r) => r[r.length - 1]!.index + 1));
    if (rows.length < 2 || width < 2 || rows.some((r) => r.some((c) => c.text.length > CELL_CHARS))) continue;
    // The tags do not say how many columns a merged cell covers: place the cells of a shorter
    // row under the columns they overlap, as measured on complete rows.
    const extent: Array<Box | undefined> = Array.from({ length: width }, () => undefined);
    for (const row of rows) {
      if (row[row.length - 1]!.index !== width - 1) continue;
      for (const c of row) extent[c.index] = { x0: Math.min(c.x0, extent[c.index]?.x0 ?? Infinity), x1: Math.max(c.x1, extent[c.index]?.x1 ?? -Infinity) };
    }
    const cells = rows.map((row) => {
      const out: string[] = Array.from({ length: width }, () => '');
      let next = 0;
      for (const c of row) {
        const start = Math.min(width - 1, Math.max(next, c.index));
        let at = start;
        for (let k = start; k < width; k++) {
          const e = extent[k];
          if (e && overlap(c, e) > 0) { at = k; break; }
        }
        out[at] = out[at] ? `${out[at]} ${c.text}` : c.text;
        next = at + 1;
      }
      return out;
    });
    tables.push(tableOf(cells, members));
  }
  return tables;
}

/** Blocks of one page: running text as prose, each table once at the place its first cell is stored. */
export function layoutPage(items: PdfTextItem[]): DocumentBlock[] {
  const pieces: Piece[] = items.map((item, index) => ({ ...item, index }));
  const tagged = taggedTables(pieces);
  const inTagged = new Set(tagged.flatMap((t) => [...t.taken]));
  const measurable = pieces.filter((p) => !inTagged.has(p.index) && p.str.trim() && !p.rotated && p.height > 0 && Number.isFinite(p.x + p.y + p.width));
  const tables = [...tagged, ...findTables(visualLines(measurable), measurable.map((p) => p.index))];
  const starts = new Map(tables.map((t) => [t.first, t]));
  const taken = new Set(tables.flatMap((t) => [...t.taken]));

  const blocks: DocumentBlock[] = [];
  let text = '';
  let last: Piece | undefined;
  const flush = () => {
    if (text.trim()) blocks.push({ text: text.trim(), prose: true });
    text = '';
    last = undefined;
  };
  for (const piece of pieces) {
    const table = starts.get(piece.index);
    if (table) {
      flush();
      blocks.push({ text: table.text, prose: false });
    }
    if (taken.has(piece.index)) continue;
    // Spacing items stored between the cells of a table belong to its layout.
    if (!piece.str.trim() && tables.some((t) => piece.index > t.first && piece.index < t.last)) continue;
    if (text && !/\s$/.test(text) && piece.str && !/^\s/.test(piece.str) && !(last && touching(last, piece))) text += ' ';
    text += piece.str;
    if (piece.str.trim()) last = piece;
    if (piece.eol) text += '\n';
  }
  flush();
  return blocks;
}
