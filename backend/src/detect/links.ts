/**
 * Links are single elements. Detection either leaves a link exactly as written or replaces all of
 * it with one placeholder, and the style step never rewrites the words inside one.
 */
export interface Link {
  start: number;
  end: number;
  text: string;
}

/**
 * Endings accepted for a bare "example.com" that has no path. Endings that are also everyday words
 * or file extensions (it, is, to, me, us, in, sh, py, md, …) need a path to count as a link.
 */
const BARE_TLDS = new Set(
  ('com org net edu gov mil int io ai dev app co info biz xyz tech online site store blog cloud tv cc ' +
    'uk de fr es nl ch se dk fi cz ru ua kz cn jp kr au nz ca mx br ar eu ie pt gr tr il za sg hk tw ph th vn pk ae').split(' '),
);

const BODY = '[^\\s<>"\'`]';
const LINK_RE = new RegExp(
  '(?<![\\p{L}\\p{N}_@./\\\\-])(?:' +
    `(?:https?|s?ftp|wss?|file)://${BODY}+` +
    `|www\\.${BODY}+` +
    `|(?<host>(?:[\\p{L}\\p{N}](?:[\\p{L}\\p{N}-]*[\\p{L}\\p{N}])?\\.)+(?<tld>\\p{L}{2,24}))(?![\\p{L}\\p{N}_])(?<rest>(?::\\d{2,5})?(?:[/?#]${BODY}*)?)` +
    ')',
  'giu',
);

const OPENING: Record<string, string> = { ')': '(', ']': '[', '}': '{' };

/** Sentence punctuation and unmatched closing brackets after a link are not part of it. */
function trimEnd(link: string): string {
  let end = link.length;
  for (;;) {
    const last = link[end - 1];
    if (last === undefined) break;
    if ('.,;:!?*~'.includes(last)) {
      end--;
      continue;
    }
    const open = OPENING[last];
    if (!open) break;
    const body = link.slice(0, end);
    if (body.split(last).length > body.split(open).length) end--;
    else break;
  }
  return link.slice(0, end);
}

/** Web links in `text`: URLs with a scheme, "www." addresses and bare domains such as example.com/page. */
export function findLinks(text: string): Link[] {
  const links: Link[] = [];
  for (const m of text.matchAll(LINK_RE)) {
    const start = m.index!;
    let value = trimEnd(m[0]);
    const { host, tld } = m.groups ?? {};
    if (host !== undefined && tld !== undefined) {
      // "End.Then" is a missing space, not a domain: endings are written in one case.
      if (/^\p{Lu}\p{Ll}/u.test(tld)) continue;
      if (value.length <= host.length) {
        value = host;
        // A bare name needs a well-known ending, and "first.last@example.com" is an email.
        if (!BARE_TLDS.has(tld.toLowerCase()) || text[start + host.length] === '@') continue;
      }
    } else if (!/[\p{L}\p{N}]/u.test(value.replace(/^[a-z]+:\/\/|^www\./i, ''))) continue;
    links.push({ start, end: start + value.length, text: value });
  }
  return links;
}

/** Lower-case words and numbers of a link or a name, without accents or URL escapes. */
function words(value: string): string[] {
  let plain = value;
  try {
    plain = decodeURIComponent(value);
  } catch {
    // Not valid percent-encoding: compare the text as written.
  }
  return plain
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** Path and domain words that say nothing about a person even when they equal a name ("Larry Page"). */
const GENERIC = new Set(
  ('www http https com org net html htm php asp aspx index home page pages post posts blog news about contact user users ' +
    'profile profiles account accounts login search docs doc help support article articles view file files download watch ' +
    'video images image static public share item items product products category tag tags edit new list main default ' +
    'content api app web site online info mail email link wiki forum store shop cart').split(' '),
);

function hasRun(haystack: string[], needle: string[]): boolean {
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((w, k) => haystack[i + k] === w)) return true;
  }
  return false;
}

/**
 * Does a link spell out a value that is hidden elsewhere? Matches the way names appear in
 * addresses: "sarah-connor", "connor.sarah", "sarahconnor"; for people also one name part.
 */
export function linkMentions(link: string, value: string, nameParts = false): boolean {
  const have = words(link);
  const want = words(value);
  if (!want.length || !have.length) return false;
  if (want.length > 1) {
    const orders = want.length === 2 ? [want, [want[1]!, want[0]!]] : [want];
    for (const order of orders) {
      const joined = order.join('');
      if (hasRun(have, order) || (joined.length >= 6 && have.some((w) => w.includes(joined)))) return true;
    }
  }
  const singles = want.length === 1 ? want.filter((w) => w.length >= 3) : nameParts ? want.filter((w) => w.length >= 4) : [];
  return singles.some((w) => !GENERIC.has(w) && !/^\d+$/.test(w) && have.includes(w));
}
