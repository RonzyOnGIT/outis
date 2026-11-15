import { describe, expect, it } from 'vitest';
import { anonymize, detectDictionary, detectRules, neutralizeLight, resolveSpans, restore, Vault, type DetectOptions, type EntityType, type Span } from '../src/index.js';
import { findLinks, linkMentions } from '../src/detect/links.js';

const links = (text: string) => findLinks(text).map((l) => l.text);

/** A name-model hit for `word`, as the real model reports pieces of a link. */
function ner(text: string, word: string, type: EntityType, score = 0.95): Span {
  const start = text.indexOf(word);
  if (start < 0) throw new Error(`"${word}" is not in the text`);
  return { start, end: start + word.length, type, text: word, source: 'ner', score };
}

function clean(text: string, extra: Span[] = [], opts: DetectOptions = {}): { out: string; spans: Span[] } {
  const spans = resolveSpans(text, [...detectRules(text), ...detectDictionary(text, opts.alwaysHide), ...extra], opts);
  return { out: anonymize(text, spans, new Vault()).text, spans };
}

describe('finding links', () => {
  it('recognises scheme, www and bare-domain links', () => {
    expect(links('See https://docs.python.org/3/library/re.html#module-re and www.my-site.co.uk/about-us today')).toEqual([
      'https://docs.python.org/3/library/re.html#module-re',
      'www.my-site.co.uk/about-us',
    ]);
    expect(links('My profile is linkedin.com/in/john-smith-123 and the repo is github.com/user/repo')).toEqual([
      'linkedin.com/in/john-smith-123',
      'github.com/user/repo',
    ]);
    expect(links('Open example.com, then ftp://files.example.org/pub and http://localhost:3000/api?id=5')).toEqual([
      'example.com',
      'ftp://files.example.org/pub',
      'http://localhost:3000/api?id=5',
    ]);
  });

  it('leaves sentence punctuation and unmatched brackets outside the link', () => {
    expect(links('Go to https://example.com. Then come back.')).toEqual(['https://example.com']);
    expect(links('Is it at https://example.com/a?b=1?')).toEqual(['https://example.com/a?b=1']);
    expect(links('More info (https://example.com/a_b), honestly!')).toEqual(['https://example.com/a_b']);
    expect(links('Read [the docs](https://example.com/a-b/c) and <https://example.com/x>.')).toEqual([
      'https://example.com/a-b/c',
      'https://example.com/x',
    ]);
    expect(links('Docs (see https://example.com/docs_(v2)) are old.')).toEqual(['https://example.com/docs_(v2)']);
    expect(links('visit example.org/contact-us!')).toEqual(['example.org/contact-us']);
    expect(links('He said "https://example.com/x" was down')).toEqual(['https://example.com/x']);
  });

  it('does not mistake ordinary text for a link', () => {
    for (const text of [
      'Mail jane.doe@example.com or contact.info@example.org',
      'The file is config.yaml and the entry point is src/index.ts',
      'We met at 5 p.m. in the U.S. office, e.g. on Monday',
      'It was done.Then we left, and the version is 1.2.3',
      'Use Node.js or React.js with package.json',
      'Call tel:+1-817-555-0147 or mailto:john@example.com',
      'The ratio is 3.5/5 and the speed is 2.5km/h',
    ]) {
      expect(links(text), text).toEqual([]);
    }
  });

  it('matches names the way they are written inside addresses', () => {
    expect(linkMentions('https://www.linkedin.com/in/sarah-connor-1984/', 'Sarah Connor', true)).toBe(true);
    expect(linkMentions('https://example.com/team/connor.sarah', 'Sarah Connor', true)).toBe(true);
    expect(linkMentions('https://sarahconnor.dev/about', 'Sarah Connor', true)).toBe(true);
    expect(linkMentions('https://example.com/users/Sarah%20Connor', 'Sarah Connor', true)).toBe(true);
    expect(linkMentions('https://example.com/photos/connor/2024', 'Sarah Connor', true)).toBe(true);
    expect(linkMentions('https://acme-robotics.com/careers', 'Acme Robotics')).toBe(true);
    expect(linkMentions('https://maps.example.com/?q=München+Hbf', 'Munchen')).toBe(true);
    expect(linkMentions('https://example.com/page/2', 'Larry Page', true)).toBe(false);
    expect(linkMentions('https://example.com/bernstein', 'Bern')).toBe(false);
    expect(linkMentions('https://example.com/docs/intro', 'Sarah Connor', true)).toBe(false);
  });
});

describe('links are one element for detection', () => {
  it('keeps a link exactly as written when nothing personal is inside', () => {
    const text = 'Check https://maps.google.com/maps/dir/station and https://www.youtube.com/watch?v=dQw4w9WgXcQ please';
    // The name model reads domain and path words as organisations and places.
    const noise = [ner(text, 'google', 'ORG'), ner(text, 'com', 'ORG'), ner(text, 'station', 'LOCATION'), ner(text, 'youtube', 'ORG')];
    const { out, spans } = clean(text, noise);
    expect(spans).toEqual([]);
    expect(out).toBe(text);
  });

  it('hides the whole link when it carries personal information', () => {
    const text = 'Reset here: https://example.com/reset?token=sk-abcdefghijklmnopqrstuvwxyz123456&email=dreyes91@example.com thanks';
    const { out, spans } = clean(text);
    expect(out).toBe('Reset here: [URL_1] thanks');
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ type: 'URL', text: 'https://example.com/reset?token=sk-abcdefghijklmnopqrstuvwxyz123456&email=dreyes91@example.com' });
    expect(spans[0]!.contains).toContain('SECRET');
    expect(clean('Admin panel http://192.168.1.10:8080/admin is down').out).toBe('Admin panel [URL_1] is down');
  });

  it('hides a profile link for a confident person name, never pieces of it', () => {
    const text = 'My profile is https://www.linkedin.com/in/sarah-connor-1984/ btw';
    const found = [ner(text, 'linkedin', 'ORG'), ner(text, 'com', 'ORG'), ner(text, 'sarah', 'PERSON'), ner(text, 'connor', 'PERSON')];
    expect(clean(text, found).out).toBe('My profile is [URL_1] btw');
    // An unsure guess inside a link is not enough to remove it.
    expect(clean(text, [ner(text, 'sarah', 'PERSON', 0.7)]).out).toBe(text);
  });

  it('hides a link that spells out a name hidden elsewhere in the text', () => {
    const text = 'I am Sarah Connor from Cyberdyne. Profile: linkedin.com/in/sarah-connor-1984, site: https://cyberdyne.example/team, docs: https://example.com/docs';
    const found = [ner(text, 'Sarah Connor', 'PERSON'), ner(text, 'Cyberdyne', 'ORG')];
    expect(clean(text, found).out).toBe('I am [PERSON_1] from [ORG_1]. Profile: [URL_1], site: [URL_2], docs: https://example.com/docs');
  });

  it('uses the Always hide list for links too', () => {
    const opts: DetectOptions = { alwaysHide: [{ value: 'Sarah Connor', type: 'PERSON' }] };
    expect(clean('Portfolio: https://sarahconnor.dev/work and https://example.com/u/sarah_connor/cv', [], opts).out).toBe('Portfolio: [URL_1] and [URL_2]');
    expect(clean('Photos: https://example.com/albums/Sarah/2024', [], opts).out).toBe('Photos: [URL_1]');
    expect(clean('Docs: https://example.com/albums/2024', [], opts).out).toBe('Docs: https://example.com/albums/2024');
  });

  it('hides every link as a whole when the Link category is on', () => {
    const opts: DetectOptions = { policy: { URL: true } };
    const text = 'See example.com/pricing and https://example.com/reset?email=dreyes91@example.com now';
    expect(clean(text, [], opts).out).toBe('See [URL_1] and [URL_2] now');
  });

  it('respects Never hide and switched-off categories', () => {
    const text = 'Use https://example.com/reset?email=dreyes91@example.com now';
    expect(clean(text, [], { neverHide: ['https://example.com/reset?email=dreyes91@example.com'] }).out).toBe(text);
    expect(clean(text, [], { policy: { EMAIL: false } }).out).toBe(text);
  });

  it('keeps a hidden link hidden when resolved spans are checked again', () => {
    const text = 'My profile is https://www.linkedin.com/in/sarah-connor-1984/ btw';
    const first = clean(text, [ner(text, 'sarah', 'PERSON'), ner(text, 'connor', 'PERSON')]).spans;
    // Documents run a second, whole-document pass over spans that were already resolved per chunk.
    const second = resolveSpans(text, [...first, ...detectRules(text)]);
    expect(second.map((s) => `${s.type}:${s.text}`)).toEqual(['URL:https://www.linkedin.com/in/sarah-connor-1984/']);
    expect(resolveSpans(text, first, { policy: { PERSON: false } })).toEqual([]);
  });

  it('restores a hidden link in the answer', () => {
    const text = 'Admin panel http://192.168.1.10:8080/admin is down';
    const vault = new Vault();
    const spans = resolveSpans(text, detectRules(text));
    const anon = anonymize(text, spans, vault).text;
    expect(anon).toBe('Admin panel [URL_1] is down');
    expect(restore('Open [URL_1] in a browser.', vault)).toBe('Open http://192.168.1.10:8080/admin in a browser.');
  });

  it('still replaces phone and mail addresses that are not web links', () => {
    expect(clean('Call tel:+1-817-555-0147 or mailto:john@example.com').out).toBe('Call tel:[PHONE_1] or mailto:[EMAIL_1]');
  });
});

describe('links are one element for the style step', () => {
  it('never rewrites a link and keeps punctuation outside it', () => {
    expect(neutralizeLight('My profile is linkedin.com/in/john-smith-123.')).toBe('My profile is linkedin.com/in/john-smith-123.');
    expect(neutralizeLight('Go to example.com, then github.com/user/repo, lol.')).toBe('Go to example.com, then github.com/user/repo.');
    expect(neutralizeLight('Docs (see https://example.com/docs_(v2)) are old.')).toBe('Docs, see https://example.com/docs_(v2), are old.');
    expect(neutralizeLight('email me: someone@example.com, or visit example.org/contact-us!')).toBe('Email me: someone@example.com, or visit example.org/contact-us.');
    expect(neutralizeLight('So, u can see it at https://ex.com/u/w/lol?ok=1 lol')).toContain('https://ex.com/u/w/lol?ok=1');
    expect(neutralizeLight('Use HTTPS://EXAMPLE.COM/PATH now!!')).toBe('Use HTTPS://EXAMPLE.COM/PATH now.');
  });

  it('keeps file names and abbreviations without doubling the period', () => {
    expect(neutralizeLight('The file is config.yaml.')).toBe('The file is config.yaml.');
    expect(neutralizeLight('Open "notes.txt", then src/index.ts!')).toBe('Open "notes.txt", then src/index.ts.');
    expect(neutralizeLight('We meet at 5 p.m.')).toBe('We meet at 5 p.m.');
  });
});
