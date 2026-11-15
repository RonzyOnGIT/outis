import { describe, expect, it } from 'vitest';
import { layoutPage, pageItems, taggedCells, type PdfTextItem } from '../lib/documents/pdf-layout';
import { PDF_PAGES } from './fixtures/pdf-pages';

function page(name: string): PdfTextItem[] {
  return PDF_PAGES[name]!.map(([str, x, y, width, height, eol, cell]) => ({
    str, x, y, width, height, eol: eol === 1,
    ...(cell ? { cell: cell.split('.').map(Number) as [number, number, number] } : {}),
  }));
}

const tables = (name: string) => layoutPage(page(name)).filter((b) => !b.prose).map((b) => b.text);
const rows = (...lines: string[][]) => lines.map((cells) => cells.join('\t')).join('\n');

describe('PDF tables become tab-separated rows', () => {
  it('keeps each value in its row and column, with text before and after in place', () => {
    expect(layoutPage(page('simple'))).toEqual([
      { prose: true, text: 'Employee list\nThe following table lists the staff members who were present at the quarterly meeting held in\nthe main office. Please review it carefully and report any mistakes.' },
      { prose: false, text: rows(
        ['Name', 'Email', 'Phone', 'Date of birth'],
        ['Sarah Connor', 'sarah.connor@example.com', '(415) 555-0134', '1984-05-12'],
        ['John Smith', 'john.smith@example.org', '(212) 555-0199', '1979-11-02'],
        ['Maria Garcia Lopez', 'maria@example.net', '', '1990-01-30'],
      ) },
      { prose: true, text: 'Everyone listed above has signed the attendance sheet. Contact the office manager if a name is\nmissing from the list.' },
    ]);
  });

  it('joins the lines of a wrapped cell instead of mixing them with the next column', () => {
    expect(tables('wrapped')).toEqual([rows(
      ['Tenant', 'Address', 'Notes'],
      ['Sarah Connor', '1200 North Example Boulevard, Apartment 14B, Springfield, Illinois 62704, United States of America', 'Pays on time; prefers to be contacted by email in the evening after six.'],
      ['John Smith', '77 Short St', 'None'],
      ['Maria Garcia Lopez de la Vega y Fernandez', '5 Ocean Drive, Miami, FL 33139', 'Moving out in March.'],
    )]);
  });

  it('keeps vertically centred cells in their row and rejoins wrapped dates', () => {
    expect(tables('middle')).toEqual([rows(
      ['Tenant', 'Home address of the tenant as stated in the signed lease agreement', 'Notes', 'Date of birth'],
      ['Sarah Connor', '1200 North Example Boulevard, Apartment 14B, Springfield, Illinois 62704, United States of America', 'Pays on time', '1984-05-12'],
      ['John Smith', '77 Short St', 'Prefers to be contacted by email in the evening after six, never by phone.', '1979-11-02'],
    )]);
  });

  const merged = rows(
    ['Region', 'Contact details', '', 'Sales', ''],
    ['', 'Email', 'Phone', 'Q1', 'Q2'],
    ['North', 'north@example.com', '(415) 555-0134', '120', '140'],
    ['South', 'south@example.com', '(212) 555-0199', '90', '75'],
    ['Subtotal for all regions listed above', '', '', '210', '215'],
    ['East', 'east@example.com', '(305) 555-0111', '60', '80'],
    ['West', 'west@example.com', '(206) 555-0122', '70', '95'],
  );

  it('places merged headings and subtotal cells in the column where they start', () => {
    expect(tables('spans')).toEqual([merged]);
  });

  it('uses the cells a tagged PDF names itself', () => {
    expect(tables('taggedSpans')).toEqual([merged]);
    // Without usable positions only the structure tags can produce the same table.
    const tagsOnly = page('taggedSpans').map((i) => (i.cell ? i : { ...i, height: 0 }));
    expect(layoutPage(tagsOnly).filter((b) => !b.prose).map((b) => b.text)).toEqual([merged]);
  });

  it('keeps empty cells and right-aligned numbers in their columns', () => {
    expect(tables('invoice')).toEqual([rows(
      ['Item', 'Qty', 'Unit price', 'Total'],
      ['Consulting, onboarding review', '12', '$150.00', '$1,800.00'],
      ['Travel', '1', '$320.50', '$320.50'],
      ['Software licence (annual)', '3', '$99.00', '$297.00'],
      ['', '', 'Total due', '$2,417.50'],
    )]);
  });

  it('keeps form labels next to their values', () => {
    expect(tables('form')).toEqual([rows(
      ['Full name:', 'Sarah Connor'],
      ['Date of birth:', '05/12/1984'],
      ['Insurance ID:', 'XZ-4491-2231'],
      ['Phone:', '(415) 555-0134'],
    )]);
  });

  it('finds a table inside one column of a two-column page', () => {
    const blocks = layoutPage(page('sidebar'));
    expect(blocks.filter((b) => !b.prose).map((b) => b.text)).toEqual([rows(['Name', 'Role', 'Ext'], ['Sarah Connor', 'Lead', '134'], ['John Smith', 'Analyst', '199'], ['Maria Lopez', 'Designer', '111'])]);
    expect(blocks.map((b) => b.prose)).toEqual([true, false, true]);
    expect(blocks[2]!.text.startsWith('The committee reviewed the proposal in detail\n')).toBe(true);
  });
});

describe('PDF text that is not a table', () => {
  it('reads two-column prose column by column', () => {
    const blocks = layoutPage(page('columns'));
    expect(blocks).toHaveLength(1);
    const text = blocks[0]!.text;
    expect(text.startsWith('Newsletter\nOur team spent the last quarter rebuilding\nthe onboarding flow')).toBe(true);
    expect(text.indexOf('release. People who start the new flow are')).toBeLessThan(text.indexOf('more likely to finish it'));
  });

  it('leaves résumé entries, lists and footers as running text', () => {
    for (const name of ['resume', 'lists', 'hanging']) expect(tables(name), name).toEqual([]);
    expect(layoutPage(page('resume'))[0]!.text).toContain('Senior Engineer, Cyberdyne Systems 2019 – 2024\nLed the migration');
    expect(layoutPage(page('hanging'))[0]!.text).toContain('1. Collect the signed forms from every participant and check\neach signature against the list.');
  });

  it('does not split a word set in two fonts and keeps a long link whole', () => {
    const [block] = layoutPage(page('styled'));
    expect(block!.text).toContain('Visit https://example.com/docs, then Bold and x2 and reitalics. Email: sarah@example.com.');
    expect(block!.text).toContain('\nhttps://example.com/very/long/path/that/keeps/going/and/going/until/it/wraps/onto/the/next/line/of/the/page.html\n');
  });

  it('copes with empty pages, rotated text and unusable positions', () => {
    expect(layoutPage([])).toEqual([]);
    expect(layoutPage([{ str: '  ', x: 10, y: 10, width: 5, height: 12, eol: false }])).toEqual([]);
    const odd: PdfTextItem[] = [
      { str: 'CONFIDENTIAL', x: 20, y: 400, width: 90, height: 12, eol: false, rotated: true },
      { str: 'Name', x: 60, y: 100, width: 30, height: 12, eol: false },
      { str: 'Value', x: NaN, y: 100, width: 30, height: 12, eol: true },
      { str: 'Total', x: 60, y: Infinity, width: 30, height: 12, eol: false },
    ];
    expect(layoutPage(odd)).toEqual([{ prose: true, text: 'CONFIDENTIAL Name Value\nTotal' }]);
  });
});

describe('PDF.js adapters', () => {
  it('converts PDF.js positions to page coordinates and flags rotated text', () => {
    const viewport = [1, 0, 0, -1, 0, 792];
    const items = pageItems([
      { str: 'Hello', transform: [12, 0, 0, 12, 57, 700], width: 30, hasEOL: true },
      { str: 'Side', transform: [0, 12, -12, 0, 30, 400], width: 24, hasEOL: false },
    ], viewport);
    expect(items[0]).toEqual({ str: 'Hello', x: 57, y: 92, width: 30, height: 12, eol: true, rotated: false });
    expect(items[1]!.rotated).toBe(true);
  });

  it('reads table cells from the structure tree and marked content', () => {
    const tree = { role: 'Root', children: [{ role: 'Document', children: [
      { role: 'P', children: [{ type: 'content', id: 'mc0' }] },
      { role: 'Table', children: [{ role: 'TBody', children: [
        { role: 'TR', children: [{ role: 'TH', children: [{ type: 'content', id: 'mc1' }] }, { role: 'TH', children: [{ role: 'P', children: [{ type: 'content', id: 'mc2' }] }] }] },
        { role: 'TR', children: [{ role: 'TD', children: [{ type: 'content', id: 'mc3' }] }] },
      ] }] },
    ] }] };
    const cells = taggedCells(tree);
    expect([...cells.entries()]).toEqual([['mc1', [0, 0, 0]], ['mc2', [0, 0, 1]], ['mc3', [0, 1, 0]]]);
    const t = (str: string) => ({ str, transform: [12, 0, 0, 12, 0, 0], width: 10, hasEOL: false });
    const items = pageItems([
      { type: 'beginMarkedContentProps', id: 'mc0' }, t('Intro'), { type: 'endMarkedContent' },
      { type: 'beginMarkedContentProps', id: 'mc2' }, t('Email'), { type: 'beginMarkedContent' }, t('nested'), { type: 'endMarkedContent' }, { type: 'endMarkedContent' },
      t('after'),
    ], [1, 0, 0, -1, 0, 792], cells);
    expect(items.map((i) => [i.str, i.cell])).toEqual([['Intro', undefined], ['Email', [0, 0, 1]], ['nested', [0, 0, 1]], ['after', undefined]]);
    expect(taggedCells(null).size).toBe(0);
  });
});
