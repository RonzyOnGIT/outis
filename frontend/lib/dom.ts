/** Tiny DOM helper — no framework, keeps the content script small. Text is always set via textContent. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: { class?: string; text?: string; title?: string; attrs?: Record<string, string>; on?: Record<string, (e: Event) => void> } = {},
  ...children: Array<Node | string | null | false | undefined>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.text !== undefined) el.textContent = props.text;
  if (props.title) el.title = props.title;
  for (const [k, v] of Object.entries(props.attrs ?? {})) el.setAttribute(k, v);
  for (const [k, fn] of Object.entries(props.on ?? {})) el.addEventListener(k, fn);
  for (const c of children) if (c !== null && c !== false && c !== undefined) el.append(c);
  return el;
}
