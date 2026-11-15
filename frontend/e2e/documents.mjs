// Built-extension regression tests. New browser profile; network models deliberately unavailable.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { zipSync, strToU8 } from 'fflate';

const EXT = process.env.EXT ?? new URL('../dist/chrome-mv3', import.meta.url).pathname;
const zip = (entries) => Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([name, value]) => [name, strToU8(value)]))));
const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const EMAIL = 'alice@example.com';
const docx = zip({
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body><w:p><w:r><w:t>Alice Example: alice@</w:t></w:r><w:r><w:t>example.com</w:t></w:r></w:p><w:p><w:del><w:r><w:delText>DELETED SECRET</w:delText></w:r></w:del><w:r><w:rPr><w:vanish/></w:rPr><w:t>HIDDEN SECRET</w:t></w:r></w:p></w:body></w:document>`,
  'word/header1.xml': `<w:hdr xmlns:w="${W}"><w:p><w:r><w:t>Header ${EMAIL}</w:t></w:r></w:p></w:hdr>`,
  'docProps/core.xml': '<metadata>METADATA SECRET</metadata>',
  'word/comments.xml': '<comments>COMMENT SECRET</comments>',
  'word/media/image1.png': 'IMAGE SECRET',
});
const xlsx = zip({
  'xl/workbook.xml': `<workbook xmlns:r="${R}"><sheets><sheet name="Contacts" sheetId="1" r:id="r1"/><sheet name="Hidden" state="hidden" r:id="r2"/></sheets></workbook>`,
  'xl/_rels/workbook.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>`,
  'xl/sharedStrings.xml': '<sst><si><r><t>alice@</t></r><r><t>example.com</t></r></si></sst>',
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><f>1+1</f><v>2</v></c></row><row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>HIDDEN SECRET</t></is></c></row><row r="3"><c r="A3" t="inlineStr"><is><t>Bob</t></is></c><c r="B3" t="inlineStr"><is><t>Row 3</t></is></c></row></sheetData></worksheet>',
});
const pptx = zip({
  'ppt/presentation.xml': `<p:presentation xmlns:p="urn:slides" xmlns:r="${R}"><p:sldIdLst><p:sldId id="5" r:id="r2"/><p:sldId id="6" r:id="r1"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>`,
  'ppt/slides/slide1.xml': `<slide xmlns:a="${A}"><a:p><a:r><a:t>Second slide</a:t></a:r></a:p></slide>`,
  'ppt/slides/slide2.xml': `<slide xmlns:a="${A}"><a:p><a:r><a:t>First slide ${EMAIL}</a:t></a:r></a:p></slide>`,
  'ppt/notesSlides/notesSlide1.xml': '<notes>NOTES SECRET</notes>',
});
const odf = (body) => zip({ 'content.xml': `<office:document-content xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:table="urn:oasis:names:tc:opendocument:xmlns:table:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0"><office:body>${body}</office:body></office:document-content>` });
const odt = odf(`<office:text><text:p>Alice<text:s/>Example ${EMAIL}</text:p><office:annotation><text:p>COMMENT SECRET</text:p></office:annotation></office:text>`);
const ods = odf(`<office:spreadsheet><table:table table:name="Contacts"><table:table-row><table:table-cell><text:p>${EMAIL}</text:p></table:table-cell><table:table-cell table:number-columns-repeated="2"><text:p>2</text:p></table:table-cell></table:table-row></table:table></office:spreadsheet>`);
const odp = odf(`<office:presentation><draw:page><text:p>${EMAIL}</text:p></draw:page></office:presentation>`);
const wp = (text) => `<w:p><w:r><w:t>${text}</w:t></w:r></w:p>`;
const wc = (...paragraphs) => `<w:tc>${paragraphs.join('')}</w:tc>`;
const docxTable = zip({
  'word/document.xml': `<w:document xmlns:w="${W}"><w:body>${wp('Before table')}<w:tbl>` +
    `<w:tr>${wc(wp('Name'))}${wc(wp('Email'))}${wc(wp('Date of birth'))}</w:tr>` +
    `<w:tr>${wc(wp('Alice'), wp('Example'))}${wc('<w:p><w:r><w:t>alice@</w:t></w:r><w:r><w:t>example.com</w:t></w:r></w:p>')}${wc(wp('1991-03-14'))}</w:tr>` +
    `<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr>${wp('Merged note')}</w:tc>${wc(wp('2026-11-30'))}</w:tr>` +
    `</w:tbl>${wp('After table')}</w:body></w:document>`,
});
const ac = (text) => `<a:tc><a:txBody><a:p><a:r><a:t>${text}</a:t></a:r></a:p></a:txBody></a:tc>`;
const pptxTable = zip({
  'ppt/presentation.xml': `<p:presentation xmlns:p="urn:slides" xmlns:r="${R}"><p:sldIdLst><p:sldId id="5" r:id="r1"/></p:sldIdLst></p:presentation>`,
  'ppt/_rels/presentation.xml.rels': `<Relationships xmlns="${REL}"><Relationship Id="r1" Target="slides/slide1.xml"/></Relationships>`,
  'ppt/slides/slide1.xml': `<slide xmlns:a="${A}"><a:p><a:r><a:t>Contacts</a:t></a:r></a:p><a:tbl><a:tr>${ac('Name')}${ac('Email')}</a:tr><a:tr>${ac('Alice Example')}${ac(EMAIL)}</a:tr></a:tbl></slide>`,
});
const tc = (text) => `<table:table-cell><text:p>${text}</text:p></table:table-cell>`;
const odtTable = odf(`<office:text><text:p>Contacts</text:p><table:table><table:table-row>${tc('Name')}${tc('Email')}</table:table-row><table:table-row>${tc('Alice Example')}${tc(EMAIL)}</table:table-row></table:table></office:text>`);
const PDF_TABLE = ['Tenant list', 'Name\tEmail\tDate of birth\tLease end', `Alice Example\t${EMAIL}\t1991-03-14\t2026-11-30`, 'Bob Stone\tbob@example.org\t1985-07-01\t2027-01-31', 'End of list.'].join('\n');

function pdf(pages) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const refs = [];
  for (const text of pages) {
    const pageId = objects.length;
    refs.push(`${pageId} 0 R`);
    const esc = (value) => value.replace(/[\\()]/g, '\\$&');
    // Lines with tabs are table rows: each cell is drawn separately at its column, as PDF writers do.
    const content = !text ? '' : text.includes('\t')
      ? `BT /F1 12 Tf ${text.split('\n').flatMap((line, i) => line.split('\t').map((cell, k) => cell ? `1 0 0 1 ${50 + 140 * k} ${750 - 18 * i} Tm (${esc(cell)}) Tj` : '')).filter(Boolean).join('\n')} ET`
      : `BT /F1 12 Tf 50 750 Td ${text.split('\n').map((line, i) => `${i ? '0 -16 Td ' : ''}(${esc(line)}) Tj`).join('\n')} ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${pageId + 1} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${refs.join(' ')}] /Count ${pages.length} >>`;
  let output = '%PDF-1.7\n';
  const offsets = [0];
  for (let i = 1; i < objects.length; i++) { offsets.push(output.length); output += `${i} 0 obj\n${objects[i]}\nendobj\n`; }
  const xref = output.length;
  output += `xref\n0 ${objects.length}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map((n) => `${String(n).padStart(10, '0')} 00000 n \n`).join('');
  output += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(output);
}

const uploads = [];
const html = `<!doctype html><meta charset="utf-8"><title>Attachment simulator</title>
<style>body{font:16px system-ui;padding:40px}#drop{padding:80px;border:2px dashed #777}textarea{display:block;margin:20px}
/* Reproduce a popover that is open but hidden, as reported on Claude/Gemini. */
[popover]{visibility:hidden!important;opacity:0!important;content-visibility:hidden!important}
</style>
<input type="file" id="files" multiple><div id="drop" contenteditable="true">Drop / paste files here</div><textarea id="text"></textarea><button id="send">Send</button>
<script>
window.seen = []; window.sent = 0;
function capture(event) {
  const files = event.target.files || event.dataTransfer?.files || event.clipboardData?.files;
  if (!files?.length) return;
  const values = [...files];
  seen.push({kind:event.type,names:values.map(f=>f.name)});
  if(event.type==='input') return;
  event.preventDefault();
  Promise.all(values.map(async f=>({name:f.name,type:f.type,modified:f.lastModified,text:await f.text()})))
    .then(files=>fetch('/upload',{method:'POST',body:JSON.stringify({kind:event.type,files})}));
}
for(const kind of ['input','change','drop','paste']) window.addEventListener(kind,capture,true);
window.addEventListener('keydown',e=>{if(e.key==='Enter' && e.target.id==='text')sent++},true);
document.getElementById('send').onclick=()=>sent++;
</script>`;
const server = http.createServer((req, res) => {
  if (req.url === '/upload') {
    let body = ''; req.on('data', (b) => body += b); req.on('end', () => { uploads.push(JSON.parse(body)); res.end('ok'); });
  } else { res.setHeader('content-type', 'text/html'); res.end(html); }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const profile = mkdtempSync(join(tmpdir(), 'nobody-documents-'));
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    channel: 'chromium', headless: true,
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`,
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost'],
  });
  await context.route(/^https?:\/\/(?!127\.0\.0\.1)/, (route) => route.abort());
  let [sw] = context.serviceWorkers();
  if (!sw) sw = await context.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  const options = await context.newPage();
  await options.goto(`chrome-extension://${id}/popup.html`);
  await options.evaluate(async () => {
    await chrome.runtime.sendMessage({ type: 'hello' });
    await chrome.storage.local.set({ settings: { sites: { '127.0.0.1': true }, defaultStyle: 'off', guardTyping: false, alwaysHide: [{ type: 'PERSON', value: 'Alice Example' }] } });
    await chrome.runtime.sendMessage({ type: 'ensureOffscreen' });
  });
  const extract = async (format, buffer) => options.evaluate(async ({ format, base64 }) => {
    for (let n = 0; n < 40; n++) {
      const result = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'document.extract', format, base64 });
      if (result) return result;
      await new Promise(r => setTimeout(r, 100));
    }
    throw Error('Offscreen did not start');
  }, { format, base64: buffer.toString('base64') });

  for (const [format, buffer] of Object.entries({ docx, xlsx, pptx, odt, ods, odp, pdf: pdf([`Alice Example ${EMAIL}`]), rtf: Buffer.from(`{\\rtf1 Email ${EMAIL}}`), txt: Buffer.from(`Résumé ${EMAIL}`), csv: Buffer.from(`name,email\nAlice Example,${EMAIL}`), tsv: Buffer.from(`name\temail\nAlice Example\t${EMAIL}`), md: Buffer.from(`# Contact\n${EMAIL}`), log: Buffer.from(`INFO ${EMAIL}`), json: Buffer.from(JSON.stringify({ email: EMAIL })) })) {
    const result = await extract(format, buffer);
    assert.equal(result.ok, true, `${format}: ${JSON.stringify(result)}`);
    const text = result.data.blocks.map(b => b.text).join('\n');
    assert.ok(text.includes(EMAIL), `${format} reads intact email`);
    assert.doesNotMatch(text, /(?:METADATA|HIDDEN|COMMENT|IMAGE|NOTES|DELETED) SECRET/);
    if (format === 'pptx') assert.ok(text.indexOf('First slide') < text.indexOf('Second slide'));
    if (format === 'xlsx') assert.ok(text.includes(`${EMAIL}\t\t2\nBob\tRow 3`), 'one tab-separated block per sheet');
  }
  const blocks = async (format, buffer) => (await extract(format, buffer)).data.blocks;
  assert.deepEqual(await blocks('docx', docxTable), [
    { text: 'Before table', prose: true },
    { text: `Name\tEmail\tDate of birth\nAlice Example\t${EMAIL}\t1991-03-14\nMerged note\t\t2026-11-30`, prose: false },
    { text: 'After table', prose: true },
  ]);
  assert.deepEqual(await blocks('pptx', pptxTable), [{ text: 'Slide 1', prose: false }, { text: 'Contacts', prose: true }, { text: `Name\tEmail\nAlice Example\t${EMAIL}`, prose: false }]);
  assert.deepEqual(await blocks('odt', odtTable), [{ text: 'Contacts', prose: true }, { text: `Name\tEmail\nAlice Example\t${EMAIL}`, prose: false }]);
  assert.deepEqual(await blocks('pdf', pdf([PDF_TABLE])), [
    { text: 'Page 1', prose: false },
    { text: 'Tenant list', prose: true },
    { text: `Name\tEmail\tDate of birth\tLease end\nAlice Example\t${EMAIL}\t1991-03-14\t2026-11-30\nBob Stone\tbob@example.org\t1985-07-01\t2027-01-31`, prose: false },
    { text: 'End of list.', prose: true },
  ]);
  console.log('PASS: tables in DOCX, PPTX, ODT, XLSX and PDF become tab-separated rows');
  const utf16 = Buffer.concat([Buffer.from([255, 254]), Buffer.from('Résumé', 'utf16le')]);
  assert.equal((await extract('txt', utf16)).data.blocks[0].text, 'Résumé');
  for (const [format, buffer, code] of [
    ['pdf', pdf(['Readable page', '']), 'empty'], ['pdf', Buffer.from('invalid pdf'), 'unreadable'],
    ['txt', Buffer.from([0, 1, 2]), 'encoding'], ['docx', Buffer.from('not a zip'), 'unreadable'],
    ['docx', zip({ 'word/document.xml': '<w:bad' }), 'unreadable'],
    ['odt', zip({ 'content.xml': '<!DOCTYPE x [<!ENTITY t SYSTEM "https://example.com">]><x>&t;</x>' }), 'unreadable'],
    ['txt', Buffer.from(' \n'), 'empty'], ['doc', Buffer.from('legacy'), 'unsupported'],
  ]) {
    const result = await extract(format, buffer);
    assert.equal(result.ok, false);
    assert.equal(result.documentCode, code, JSON.stringify(result));
  }
  const bomb = zip({ 'word/document.xml': '<x/>' });
  const central = bomb.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  bomb.writeUInt32LE(33 * 1024 * 1024, central + 24);
  assert.equal((await extract('docx', bomb)).documentCode, 'size');
  console.log('PASS: 14 formats, metadata omission, slide order, encodings, malformed/empty/scanned files and archive limits');

  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${server.address().port}`);
  await page.waitForTimeout(300);
  const cdp = await context.newCDPSession(page);
  // CDP can inspect closed roots for testing; ordinary page JavaScript cannot.
  const tree = () => cdp.send('DOM.getDocument', { depth: -1, pierce: true });
  function all(node) { return [node, ...(node.children ?? []).flatMap(all), ...(node.shadowRoots ?? []).flatMap(all)]; }
  const nodeText = node => [node.nodeValue ?? '', ...(node.children ?? []).map(nodeText)].join('');
  const matches = (label, text) => (label instanceof RegExp ? label.test(text) : text === label);
  async function button(label) { return all((await tree()).root).find(n => n.nodeName === 'BUTTON' && matches(label, nodeText(n))); }
  const ATTACH = /^Attach cleaned cop(?:y|ies)$/;
  const DOWNLOAD = /^Download cleaned cop(?:y|ies)$/;
  async function click(label) {
    const node = await button(label); assert.ok(node, `Button: ${label}`);
    await cdp.send('DOM.scrollIntoViewIfNeeded', { nodeId: node.nodeId });
    const { model } = await cdp.send('DOM.getBoxModel', { nodeId: node.nodeId });
    await page.mouse.click((model.content[0] + model.content[4]) / 2, (model.content[1] + model.content[5]) / 2);
  }
  async function until(fn, label, timeout = 45_000) {
    const end = Date.now() + timeout;
    while (Date.now() < end) { if (await fn()) return; await page.waitForTimeout(50); }
    throw Error(`Timed out: ${label}`);
  }
  const ready = () => until(() => button(ATTACH), 'document preview');
  async function panelVisible() {
    const node = all((await tree()).root).find(n => n.nodeName === 'SECTION' && n.attributes?.includes('dialog'));
    if (!node) return false;
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: node.nodeId });
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true,
      functionDeclaration: 'function(){const r=this.getBoundingClientRect(),s=getComputedStyle(this),h=getComputedStyle(this.getRootNode().host);return r.width>0&&r.height>0&&s.visibility==="visible"&&h.visibility==="visible"&&Number(h.opacity)>0}' });
    return result.result.value;
  }
  const selection = (name, buffer) => page.locator('#files').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await page.locator('#files').setInputFiles([{ name: 'Alice Example.docx', mimeType: 'application/octet-stream', buffer: docx }, { name: 'alice@example.com.pdf', mimeType: 'application/pdf', buffer: pdf([`DOB: 1991-03-14; Deadline: 2026-11-30; Card expiry: 04/28. ${EMAIL}\nRouting\nnumber 271828184; licence plate KTR-7293; lease No. LS-2028-58312.\nRent $1450; notice 30 days; car model 2019.`]) }]);
  await ready();
  assert.equal(await panelVisible(), true, 'review must be visible despite page popover CSS');
  // Sites can remove injected nodes or close top-layer popovers during an upload re-render.
  await page.locator('#nobody-documents').evaluate(el => { el.hidePopover(); el.remove(); });
  await until(panelVisible, 'review remounts after the page removes it', 5000);
  assert.ok(all((await tree()).root).some(n => nodeText(n).includes('Name detection was unavailable')), 'fallback warning is visible');
  if (process.env.PREVIEW_PATH) await page.screenshot({ path: process.env.PREVIEW_PATH });
  assert.equal(uploads.length, 0);
  assert.deepEqual(await page.evaluate(() => seen), []);
  assert.equal(await page.locator('#files').evaluate(el => el.files.length), 0);
  assert.equal(await page.locator('#nobody-documents').evaluate(el => el.shadowRoot), null);
  assert.ok(!await page.locator('body').innerText().then(t => t.includes(EMAIL)));
  await click(ATTACH);
  await until(() => uploads.length === 1, 'clean upload');
  const first = uploads[0].files;
  assert.equal(first.length, 2);
  for (const f of first) {
    assert.match(f.name, /^attachment-\d+\.txt$/);
    assert.equal(f.type, 'text/plain'); assert.equal(f.modified, 0);
    assert.ok(f.text.includes('[EMAIL_1]'), JSON.stringify(f)); assert.doesNotMatch(f.text, /Alice|alice@example|SECRET/);
  }
  assert.ok(first[0].text.includes('[PERSON_1]'));
  assert.match(first[1].text, /DOB: \[DATE_1\]; Deadline: 2026-11-30; Card expiry: \[DATE_2\]/);
  assert.doesNotMatch(first[1].text, /1991-03-14|04\/28/);
  assert.doesNotMatch(first[1].text, /271828184|KTR-7293|LS-2028-58312/);
  assert.match(first[1].text, /number \[ID_\d+\]; licence plate \[ID_\d+\]; lease No\. \[ID_\d+\]/);
  assert.ok(first[1].text.includes('Rent $1450; notice 30 days; car model 2019.'));
  const vaultBefore = await options.evaluate(async () => (await chrome.storage.session.get('vault:127.0.0.1'))['vault:127.0.0.1']);
  await selection('cancel.txt', Buffer.from('cancel@example.com'));
  await ready(); await page.keyboard.press('Escape');
  await page.waitForSelector('#nobody-documents', { state: 'detached' });
  assert.equal(uploads.length, 1);
  assert.deepEqual(await options.evaluate(async () => (await chrome.storage.session.get('vault:127.0.0.1'))['vault:127.0.0.1']), vaultBefore);

  await page.locator('#files').setInputFiles([{ name: 'good.txt', mimeType: 'text/plain', buffer: Buffer.from(EMAIL) }, { name: 'bad.doc', mimeType: '', buffer: Buffer.from('legacy') }]);
  await until(async () => all((await tree()).root).some(n => nodeText(n).includes('Attachments blocked')), 'blocked batch');
  assert.equal(uploads.length, 1);
  assert.equal(await page.locator('#files').evaluate(el => el.files.length), 0);

  for (const kind of ['drop', 'paste']) {
    await page.evaluate(({ kind, email }) => {
      const data = new DataTransfer(); data.items.add(new File([email], 'private.txt', { type: 'text/plain' }));
      const event = kind === 'drop' ? new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: data }) : new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data });
      document.getElementById('drop').dispatchEvent(event);
    }, { kind, email: `Deadline: 1991-03-14; ${EMAIL}` });
    await ready();
    const before = uploads.length;
    await click(ATTACH); await until(() => uploads.length > before, kind);
    assert.equal(uploads.at(-1).kind, kind); assert.equal(uploads.at(-1).files[0].text, 'Deadline: 1991-03-14; [EMAIL_1]');
  }
  await selection('stale.txt', Buffer.from(EMAIL)); await ready();
  await options.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, defaultStyle: 'light' } }); });
  await page.waitForTimeout(100); await click(ATTACH);
  await page.waitForSelector('#nobody-documents', { state: 'detached' }); assert.equal(uploads.length, 3);

  await selection('rerender.txt', Buffer.from(EMAIL)); await ready();
  await page.locator('#files').evaluate(el => el.remove());
  await click(ATTACH);
  await until(async () => { const n = await button(ATTACH); return n?.attributes?.includes('disabled'); }, 'download fallback');
  const downloaded = page.waitForEvent('download');
  await click(DOWNLOAD);
  assert.match((await downloaded).suggestedFilename(), /^attachment-\d+\.txt$/);
  assert.equal(uploads.length, 3);

  // Review window: above a message box at the bottom of the page, the original next to the cleaned
  // copy in one scroller, so both sides scroll together and stay level part by part.
  async function inPanel(fn) {
    const node = all((await tree()).root).find(n => n.nodeName === 'SECTION' && n.attributes?.includes('dialog'));
    assert.ok(node, 'review window');
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: node.nodeId });
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true, functionDeclaration: fn });
    return result.result.value;
  }
  await page.evaluate(() => {
    const input = document.createElement('input'); input.type = 'file'; input.id = 'files'; document.body.append(input);
    document.getElementById('text').style.cssText = 'position:fixed;left:40px;bottom:24px;width:640px;height:56px;margin:0';
  });
  await page.waitForTimeout(100);
  const long = Array.from({ length: 160 }, (_, i) => `Line ${i + 1}: write to ${EMAIL} about the lease.`).join('\n\n');
  await selection('long notes.txt', Buffer.from(long)); await ready();
  const view = await inPanel(`function () {
    const root = this.getRootNode(), compare = root.querySelector('.compare');
    const box = this.getBoundingClientRect(), composer = document.getElementById('text').getBoundingClientRect();
    const orig = [...root.querySelectorAll('.side.orig')], clean = [...root.querySelectorAll('.side.clean')];
    const level = () => orig.length === clean.length && orig.every((el, i) => Math.abs(el.getBoundingClientRect().top - clean[i].getBoundingClientRect().top) < 1);
    const before = [orig.at(-1).getBoundingClientRect().top, clean.at(-1).getBoundingClientRect().top];
    const levelBefore = level();
    compare.scrollTop = compare.scrollHeight;
    const after = [orig.at(-1).getBoundingClientRect().top, clean.at(-1).getBoundingClientRect().top];
    return { above: box.bottom <= composer.top + 0.5 && box.top >= 0, rows: orig.length, scrollable: compare.scrollHeight > compare.clientHeight * 3,
      level: levelBefore && level(), together: after[0] < before[0] && Math.abs((before[0] - after[0]) - (before[1] - after[1])) < 1,
      original: orig[0].textContent, cleaned: clean[0].textContent, headers: [...root.querySelectorAll('.col')].map(el => el.textContent) };
  }`);
  assert.equal(view.above, true, 'window sits above the message box');
  assert.equal(view.rows, 160, 'one row per paragraph');
  assert.equal(view.scrollable, true, 'long documents scroll inside the window');
  assert.equal(view.level, true, 'each original paragraph stays level with its cleaned version');
  assert.equal(view.together, true, 'both sides scroll together');
  assert.deepEqual(view.headers, ['Original · long notes.txt', `Cleaned · ${view.headers[1].slice('Cleaned · '.length)}`]);
  assert.ok(view.original.includes(EMAIL) && !view.cleaned.includes(EMAIL) && view.cleaned.includes('[EMAIL_1]'), JSON.stringify(view));
  await page.keyboard.press('Escape');
  await page.waitForSelector('#nobody-documents', { state: 'detached' });

  const uploadsBefore = uploads.length;
  await selection('tenants.pdf', pdf([PDF_TABLE])); await ready();
  const tables = await inPanel(`function () {
    const root = this.getRootNode();
    const cells = (side) => [...root.querySelectorAll('.side.' + side + ' table tr')].map(tr => [...tr.cells].map(td => td.textContent));
    return { orig: cells('orig'), clean: cells('clean'), dividers: [...root.querySelectorAll('.divider')].map(el => el.textContent) };
  }`);
  assert.deepEqual(tables.dividers, ['Page 1']);
  assert.deepEqual(tables.orig[1], ['Alice Example', EMAIL, '1991-03-14', '2026-11-30']);
  assert.deepEqual(tables.clean[1], ['[PERSON_1]', '[EMAIL_1]', '[DATE_1]', '2026-11-30']);
  await click(ATTACH);
  await until(() => uploads.length > uploadsBefore, 'table PDF upload');
  assert.match(uploads.at(-1).files[0].text, /\nName\tEmail\tDate of birth\tLease end\n\[PERSON_1\]\t\[EMAIL_1\]\t\[DATE_1\]\t2026-11-30\nBob Stone\t\[EMAIL_\d+\]\t\[DATE_\d+\]\t2027-01-31\n/);
  await page.evaluate(() => { document.getElementById('files').remove(); document.getElementById('text').style.cssText = ''; });
  console.log('PASS: review window above the message box, side-by-side original and cleaned text scrolling together, PDF table rows kept and cleaned by column');

  // Optional local fixture: exercise a reported PDF without storing its private contents in the repo.
  // JSON: { path: "/local/file.pdf", hidden: ["identifier"], kept: ["useful detail"] }
  if (process.env.DOCUMENT_REGRESSION) {
    const fixture = JSON.parse(readFileSync(process.env.DOCUMENT_REGRESSION, 'utf8'));
    await page.keyboard.press('Escape');
    await page.waitForSelector('#nobody-documents', { state: 'detached' });
    await options.evaluate(async () => {
      const { settings } = await chrome.storage.local.get('settings');
      await chrome.storage.local.set({ settings: { ...settings, defaultStyle: 'off' } });
    });
    await page.evaluate(() => {
      const input = document.createElement('input'); input.type = 'file'; input.id = 'files'; document.body.append(input);
    });
    await page.waitForTimeout(100);
    const before = uploads.length;
    await selection('regression.pdf', readFileSync(fixture.path)); await ready();
    assert.equal(uploads.length, before, 'original reported PDF stays held');
    await click(ATTACH); await until(() => uploads.length > before, 'reported PDF clean upload');
    const normalize = value => value.replace(/\s+/g, ' ').trim();
    const cleaned = normalize(uploads.at(-1).files[0].text);
    for (const value of fixture.hidden) assert.ok(!cleaned.includes(normalize(value)), 'reported identifier must be hidden');
    for (const value of fixture.kept) assert.ok(cleaned.includes(normalize(value)), 'useful reported detail must be kept');
    console.log('PASS: supplied PDF through extraction, fallback detection, review and cleaned attachment delivery');
  }

  const diagnostics = await options.evaluate(async () => JSON.stringify((await chrome.storage.session.get('nobody:diag'))['nobody:diag']));
  assert.doesNotMatch(diagnostics, /Alice|alice@example|cancel@example|private\.txt|rerender\.txt/);
  assert.deepEqual(errors, []);
  assert.ok(diagnostics.includes('documents-review-ready'));
  assert.ok(diagnostics.includes('documents-extracted'));
  console.log('PASS: visible/recoverable review under conflicting CSS, real mouse actions, original input events held, batch upload, contextual PDF dates, wrapped routing numbers, vehicle/lease IDs, remembered values, shared placeholders, cancellation, all-or-nothing failure, drop, file paste, settings invalidation, download fallback, closed preview and private diagnostics');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
}
