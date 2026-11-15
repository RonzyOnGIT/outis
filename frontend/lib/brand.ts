/**
 * Outis look: quiet ivory — ink for words, bronze for protection, oxblood only when something is
 * exposed. One source for the extension pages (popup, settings) and the in-page UI.
 */

/** Colour tokens (CSS custom properties) from the Outis style sheet. */
export const THEME_VARS = `
  --ink: #1F2333; --ivory: #F7F4EE; --paper: #FFFDF8; --line: #E0D8CA; --quiet: #5C6170;
  --bronze: #8A5A26; --seal: #F2E8D9; --oxblood: #8E3326;
  --track: #EBE3D5; --seen: #F6E3DE; --notice: #FBEFE2; --notice-line: #EDD6BA;
  --shadow: 0 18px 44px rgba(31,35,51,.16), 0 2px 6px rgba(31,35,51,.06);
  --serif: "Outis Serif", Newsreader, Georgia, "Times New Roman", serif;
  --sans: "Outis Sans", "IBM Plex Sans", system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  --mono: "Outis Mono", "IBM Plex Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;
`;

// --- Typefaces (SIL Open Font License, files and licences in public/fonts) ---------------------

const LATIN = 'U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD';
const LATIN_EXT = 'U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF';
const CYRILLIC = 'U+0301,U+0400-045F,U+0490-0491,U+04B0-04B1,U+2116';

export interface FontFile { family: string; weight: number; file: string; range: string; latin: boolean; }

function faces(family: string, name: string, weights: number[], subsets: Array<[string, string]>): FontFile[] {
  return weights.flatMap((weight) => subsets.map(([subset, range]) => ({
    family, weight, file: `${name}-${subset}-${weight}-normal.woff2`, range, latin: subset === 'latin',
  })));
}

export const FONT_FILES: FontFile[] = [
  ...faces('Outis Serif', 'newsreader', [500], [['latin', LATIN], ['latin-ext', LATIN_EXT]]),
  ...faces('Outis Sans', 'ibm-plex-sans', [400, 500, 600], [['latin', LATIN], ['latin-ext', LATIN_EXT], ['cyrillic', CYRILLIC]]),
  ...faces('Outis Mono', 'ibm-plex-mono', [400, 500], [['latin', LATIN], ['latin-ext', LATIN_EXT], ['cyrillic', CYRILLIC]]),
];

/** Extension pages: tokens and @font-face rules for every subset. */
export function installPageTheme(): void {
  const style = document.createElement('style');
  style.textContent = `:root { ${THEME_VARS} }\n` + FONT_FILES.map((f) =>
    `@font-face { font-family: "${f.family}"; font-weight: ${f.weight}; font-style: normal; font-display: swap; src: url("/fonts/${f.file}") format("woff2"); unicode-range: ${f.range}; }`).join('\n');
  document.head.prepend(style);
}

// --- Marks ----------------------------------------------------------------------------------------
// Built with createElementNS, never innerHTML: some sites enforce Trusted Types.

export interface Icon { viewBox: string; attrs?: Record<string, string>; parts: Array<[string, Record<string, string>]>; }

const outline = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

/** The Outis eye: navy outline, bronze iris (the supplied logo). */
export const LOGO: Icon = { viewBox: '0 0 48 48', parts: [
  ['path', { d: 'M5.5 24C10.6 16.9 16.9 13 24 13s13.4 3.9 18.5 11C37.4 31.1 31.1 35 24 35S10.6 31.1 5.5 24Z', fill: 'none', stroke: '#13233A', 'stroke-width': '2.6', 'stroke-linejoin': 'round' }],
  ['circle', { cx: '24', cy: '24', r: '6.4', fill: 'none', stroke: '#A96C32', 'stroke-width': '2.6' }],
] };

/** Unseen: a closed eye with lashes (protected). */
export const CLOSED_EYE: Icon = { viewBox: '0 0 32 32', attrs: { ...outline, 'stroke-width': '2' }, parts: [
  ['path', { d: 'M5 13.5c3 4 6.7 6 11 6s8-2 11-6' }],
  ['path', { d: 'M8.6 17.6 6.8 20.6M13.3 19.3l-.8 3.3M18.7 19.3l.8 3.3M23.4 17.6l1.8 3' }],
] };

/** Seen: an open eye (exposed). */
export const OPEN_EYE: Icon = { viewBox: '0 0 32 32', attrs: { ...outline, 'stroke-width': '2' }, parts: [
  ['path', { d: 'M4 16c3.4-4.8 7.4-7.2 12-7.2s8.6 2.4 12 7.2c-3.4 4.8-7.4 7.2-12 7.2S7.4 20.8 4 16Z' }],
  ['circle', { cx: '16', cy: '16', r: '3.6' }],
] };

export const CHECK: Icon = { viewBox: '0 0 16 16', attrs: { ...outline, 'stroke-width': '1.6' }, parts: [['path', { d: 'm3.5 8.4 2.9 2.8 6.1-6.4' }]] };

export const SLIDERS: Icon = { viewBox: '0 0 24 24', attrs: { ...outline, 'stroke-width': '1.7' }, parts: [
  ['path', { d: 'M4 8h9M18 8h2M4 16h3M12 16h8' }], ['circle', { cx: '15.5', cy: '8', r: '2.3' }], ['circle', { cx: '9.5', cy: '16', r: '2.3' }],
] };

export const CROSS: Icon = { viewBox: '0 0 16 16', attrs: { ...outline, 'stroke-width': '1.5' }, parts: [['path', { d: 'm4 4 8 8M12 4l-8 8' }]] };

/** Rewriting: two threads weave left to right (bronze over quiet grey); `busy` animates them. */
export function weave(busy: boolean): Icon {
  // Two waves in opposite phase: where one thread rises the other dips.
  const wave = (up: boolean) => {
    let d = 'M0 7';
    for (let k = 0; k < 20; k++) d += ` Q${20 * k + 10} ${(k % 2 === 0) === up ? 0 : 14} ${20 * k + 20} 7`;
    return d;
  };
  const line = { fill: 'none', 'vector-effect': 'non-scaling-stroke' };
  return { viewBox: '0 0 400 14', attrs: { class: `weave${busy ? ' busy' : ''}`, preserveAspectRatio: 'none' }, parts: [
    ['path', { ...line, d: wave(false), stroke: '#B9B6AE', 'stroke-width': '1.6' }],
    ['path', { ...line, d: wave(true), stroke: '#8A5A26', 'stroke-width': '1.8', class: 'thread' }],
  ] };
}

export function icon(spec: Icon, className = ''): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', spec.viewBox);
  svg.setAttribute('aria-hidden', 'true');
  for (const [k, v] of Object.entries(spec.attrs ?? {})) svg.setAttribute(k, v);
  if (className) svg.setAttribute('class', `${svg.getAttribute('class') ?? ''} ${className}`.trim());
  for (const [tag, attrs] of spec.parts) {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    svg.append(el);
  }
  return svg;
}

/** CSS for the weave (pages and in-page UI). */
export const WEAVE_CSS = `
.weave { display: block; width: 100%; height: 14px; overflow: visible; }
.weave .thread { stroke-dasharray: 1400; stroke-dashoffset: 0; }
.weave.busy .thread { animation: weave 1.8s linear infinite; stroke-dasharray: 60 20; }
@keyframes weave { from { stroke-dashoffset: 80; } to { stroke-dashoffset: 0; } }
@media (prefers-reduced-motion: reduce) { .weave.busy .thread { animation: none; } }
`;

/** Placeholder chip text: "[PERSON_1]" → "Person 1". */
const CHIP_NAMES: Record<string, string> = {
  PERSON: 'Person', ORG: 'Org', LOCATION: 'Place', ADDRESS: 'Address', EMAIL: 'Email', PHONE: 'Phone', CARD: 'Card',
  IBAN: 'Account', IP: 'IP', URL: 'Link', SECRET: 'Secret', ID: 'ID', DATE: 'Date', USER: 'User',
};
export function chipName(placeholder: string): string {
  const m = /^\[([A-Z]+)_(\d+)\]$/.exec(placeholder);
  return m ? `${CHIP_NAMES[m[1]!] ?? m[1]} ${m[2]}` : placeholder;
}
