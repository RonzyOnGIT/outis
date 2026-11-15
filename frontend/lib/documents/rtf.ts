import { DOCUMENT_LIMITS, DocumentError } from './types';

const OMIT = new Set(['fonttbl', 'colortbl', 'stylesheet', 'info', 'userprops', 'docvar', 'revtbl', 'rsidtbl', 'protusertbl', 'latentstyles', 'pict', 'object', 'objdata', 'filetbl', 'datastore', 'themedata', 'colorschememapping', 'listtable', 'listoverridetable', 'generator', 'xmlnstbl', 'fldinst', 'annotation', 'atnauthor', 'atnid']);

/** Read the text subset of RTF. Destinations, binary payloads and field instructions are omitted. */
export function extractRtf(bytes: Uint8Array): string {
  let source = '';
  for (let i = 0; i < bytes.length; i += 8192) source += String.fromCharCode(...bytes.subarray(i, i + 8192));
  if (!/^\{\\rtf1\b/.test(source)) throw new DocumentError('unreadable');
  let state = { skip: false, hidden: false, uc: 1 };
  const stack: typeof state[] = [];
  let fallback = 0;
  let decoder = new TextDecoder('windows-1252');
  let output = '';
  const emit = (text: string, unicode = false) => {
    if (!unicode && fallback > 0) { fallback--; return; }
    if (!state.skip && !state.hidden) output += text;
    if (output.length > DOCUMENT_LIMITS.textChars) throw new DocumentError('size');
  };
  for (let i = 0; i < source.length;) {
    const c = source[i++];
    if (c === '{') {
      if (stack.length >= 128) throw new DocumentError('size');
      stack.push({ ...state });
    } else if (c === '}') {
      const parent = stack.pop();
      if (!parent) throw new DocumentError('unreadable');
      state = parent;
    } else if (c !== '\\') {
      if (!stack.length && c.trim()) throw new DocumentError('unreadable');
      if (c !== '\r' && c !== '\n') emit(decoder.decode(Uint8Array.of(c.charCodeAt(0))));
    } else {
      const token = source[i++];
      if (token === undefined) throw new DocumentError('unreadable');
      if (token === '*') { state.skip = true; continue; }
      if (['\\', '{', '}'].includes(token)) { emit(token); continue; }
      if (token === "'") {
        const hex = source.slice(i, i + 2);
        if (!/^[a-f0-9]{2}$/i.test(hex)) throw new DocumentError('unreadable');
        emit(decoder.decode(Uint8Array.of(parseInt(hex, 16))));
        i += 2;
        continue;
      }
      if (!/[a-z]/i.test(token ?? '')) {
        if (token === '~') emit(' ');
        else if (token === '_') emit('-');
        continue;
      }
      const match = /^[a-z]+(-?\d+)? ?/i.exec(source.slice(i - 1))!;
      const word = /^[a-z]+/i.exec(match[0])![0];
      const n = match[1] === undefined ? undefined : Number(match[1]);
      i += match[0].length - 1;
      if (OMIT.has(word)) state.skip = true;
      if (word === 'bin') {
        if (n === undefined || n < 0 || i + n > source.length) throw new DocumentError('unreadable');
        i += n;
      } else if (word === 'ansicpg') {
        if (n === undefined || n < 1250 || n > 1258) throw new DocumentError('encoding');
        decoder = new TextDecoder(`windows-${n}`);
      } else if (word === 'uc') {
        if (n === undefined || n < 0 || n > 16) throw new DocumentError('unreadable');
        state.uc = n;
      } else if (word === 'u') {
        if (n === undefined || n < -32768 || n > 65535) throw new DocumentError('unreadable');
        emit(String.fromCharCode(n < 0 ? n + 65536 : n), true);
        fallback = state.uc;
      } else if (word === 'v') state.hidden = n !== 0;
      else if (['par', 'line', 'row'].includes(word)) emit('\n');
      else if (['tab', 'cell'].includes(word)) emit('\t');
      else if (word === 'emdash') emit('—');
      else if (word === 'endash') emit('–');
      else if (word === 'bullet') emit('•');
      else if (['lquote', 'rquote'].includes(word)) emit("'");
      else if (['ldblquote', 'rdblquote'].includes(word)) emit('"');
    }
  }
  if (stack.length) throw new DocumentError('unreadable');
  return output;
}
