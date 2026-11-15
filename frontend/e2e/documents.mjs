// Built-extension regression tests. New browser profile; network models deliberately unavailable.
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
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
  'xl/worksheets/sheet1.xml': '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><f>1+1</f><v>2</v></c></row><row r="2" hidden="1"><c r="A2" t="inlineStr"><is><t>HIDDEN SECRET</t></is></c></row></sheetData></worksheet>',
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

function pdf(pages) {
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const refs = [];
  for (const text of pages) {
    const pageId = objects.length;
    refs.push(`${pageId} 0 R`);
    const content = text ? `BT /F1 12 Tf 50 750 Td (${text.replace(/[\\()]/g, '\\$&')}) Tj ET` : '';
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
    if (format === 'xlsx') assert.ok(text.includes(`${EMAIL}\t\t2`));
  }
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
  async function button(label) { return all((await tree()).root).find(n => n.nodeName === 'BUTTON' && nodeText(n) === label); }
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
  const ready = () => until(() => button('Attach cleaned copies'), 'document preview');
  async function panelVisible() {
    const node = all((await tree()).root).find(n => n.nodeName === 'SECTION' && n.attributes?.includes('dialog'));
    if (!node) return false;
    const { object } = await cdp.send('DOM.resolveNode', { nodeId: node.nodeId });
    const result = await cdp.send('Runtime.callFunctionOn', { objectId: object.objectId, returnByValue: true,
      functionDeclaration: 'function(){const r=this.getBoundingClientRect(),s=getComputedStyle(this),h=getComputedStyle(this.getRootNode().host);return r.width>0&&r.height>0&&s.visibility==="visible"&&h.visibility==="visible"&&Number(h.opacity)>0}' });
    return result.result.value;
  }
  const selection = (name, buffer) => page.locator('#files').setInputFiles({ name, mimeType: 'application/octet-stream', buffer });
  await page.locator('#files').setInputFiles([{ name: 'Alice Example.docx', mimeType: 'application/octet-stream', buffer: docx }, { name: 'alice@example.com.pdf', mimeType: 'application/pdf', buffer: pdf([EMAIL]) }]);
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
  await click('Attach cleaned copies');
  await until(() => uploads.length === 1, 'clean upload');
  const first = uploads[0].files;
  assert.equal(first.length, 2);
  for (const f of first) {
    assert.match(f.name, /^attachment-\d+\.txt$/);
    assert.equal(f.type, 'text/plain'); assert.equal(f.modified, 0);
    assert.ok(f.text.includes('[EMAIL_1]'), JSON.stringify(f)); assert.doesNotMatch(f.text, /Alice|alice@example|SECRET/);
  }
  assert.ok(first[0].text.includes('[PERSON_1]'));
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
    }, { kind, email: EMAIL });
    await ready();
    const before = uploads.length;
    await click('Attach cleaned copies'); await until(() => uploads.length > before, kind);
    assert.equal(uploads.at(-1).kind, kind); assert.equal(uploads.at(-1).files[0].text, '[EMAIL_1]');
  }
  await selection('stale.txt', Buffer.from(EMAIL)); await ready();
  await options.evaluate(async () => { const { settings } = await chrome.storage.local.get('settings'); await chrome.storage.local.set({ settings: { ...settings, defaultStyle: 'light' } }); });
  await page.waitForTimeout(100); await click('Attach cleaned copies');
  await page.waitForSelector('#nobody-documents', { state: 'detached' }); assert.equal(uploads.length, 3);

  await selection('rerender.txt', Buffer.from(EMAIL)); await ready();
  await page.locator('#files').evaluate(el => el.remove());
  await click('Attach cleaned copies');
  await until(async () => { const n = await button('Attach cleaned copies'); return n?.attributes?.includes('disabled'); }, 'download fallback');
  const downloaded = page.waitForEvent('download');
  await click('Download cleaned copies');
  assert.match((await downloaded).suggestedFilename(), /^attachment-\d+\.txt$/);
  assert.equal(uploads.length, 3);

  const diagnostics = await options.evaluate(async () => JSON.stringify((await chrome.storage.session.get('nobody:diag'))['nobody:diag']));
  assert.doesNotMatch(diagnostics, /Alice|alice@example|cancel@example|private\.txt|rerender\.txt/);
  assert.deepEqual(errors, []);
  assert.ok(diagnostics.includes('documents-review-ready'));
  assert.ok(diagnostics.includes('documents-extracted'));
  console.log('PASS: visible/recoverable review under conflicting CSS, real mouse actions, original input events held, batch upload, shared placeholders, cancellation, all-or-nothing failure, drop, file paste, settings invalidation, download fallback, closed preview and private diagnostics');
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  rmSync(profile, { recursive: true, force: true });
}
