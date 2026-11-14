import { splitProtected } from './protect.js';

/**
 * "Light" style hiding — no AI, instant, runs anywhere.
 * Removes the cheap stylometric tells: punctuation habits, emoji, slang, typos,
 * British/American spelling, casing quirks. Code and logs are left untouched.
 */

const MISSPELLINGS: Record<string, string> = {
  teh: 'the', recieve: 'receive', recieved: 'received', definately: 'definitely', definatly: 'definitely',
  seperate: 'separate', seperately: 'separately', occured: 'occurred', occurence: 'occurrence', untill: 'until',
  wich: 'which', thier: 'their', alot: 'a lot', becuase: 'because', beacuse: 'because', wierd: 'weird',
  goverment: 'government', enviroment: 'environment', existance: 'existence', independant: 'independent',
  begining: 'beginning', beleive: 'believe', calender: 'calendar', collegue: 'colleague', comming: 'coming',
  concious: 'conscious', embarass: 'embarrass', foward: 'forward', freind: 'friend', grammer: 'grammar',
  happend: 'happened', immediatly: 'immediately', knowlege: 'knowledge', neccessary: 'necessary',
  noticable: 'noticeable', occassion: 'occasion', persistant: 'persistent', posible: 'possible',
  prefered: 'preferred', realy: 'really', responsability: 'responsibility', succesful: 'successful',
  suprise: 'surprise', tommorow: 'tomorrow', tomorow: 'tomorrow', truely: 'truly', wether: 'whether',
  accross: 'across', adress: 'address', arguement: 'argument', basicly: 'basically', buisness: 'business',
  finaly: 'finally', goint: 'going', insted: 'instead', probaly: 'probably', publically: 'publicly',
  recomend: 'recommend', similiar: 'similar', thru: 'through', whith: 'with', woudl: 'would',
  dont: "don't", doesnt: "doesn't", didnt: "didn't", cant: "can't", wont: "won't", isnt: "isn't",
  wasnt: "wasn't", havent: "haven't", shouldnt: "shouldn't", couldnt: "couldn't", wouldnt: "wouldn't",
  im: "I'm", ive: "I've", youre: "you're", thats: "that's", theres: "there's", whats: "what's",
};

const SLANG: Record<string, string> = {
  u: 'you', ur: 'your', pls: 'please', plz: 'please', thx: 'thanks', ty: 'thank you', tnx: 'thanks',
  btw: 'by the way', imo: 'in my opinion', imho: 'in my opinion', idk: "I don't know", tbh: 'to be honest',
  afaik: 'as far as I know', asap: 'as soon as possible', bc: 'because', b4: 'before', cuz: 'because',
  coz: 'because', gonna: 'going to', wanna: 'want to', gotta: 'have to', kinda: 'kind of', sorta: 'sort of',
  yeah: 'yes', yep: 'yes', yup: 'yes', nope: 'no', ok: 'OK', okay: 'OK', msg: 'message',
  pic: 'picture', pics: 'pictures', convo: 'conversation', rn: 'right now', tmrw: 'tomorrow',
};

// Remove the filler word (and the space before it) but keep the punctuation that follows: "Friday lol, can" → "Friday, can".
const FILLERS = /[ \t]*\b(?:lol|lmao|rofl|haha+|hehe+|xd|omg|smh|ugh+|hmm+)\b/gi;

const BRITISH: Record<string, string> = {
  colour: 'color', colours: 'colors', favourite: 'favorite', favour: 'favor', behaviour: 'behavior',
  honour: 'honor', labour: 'labor', neighbour: 'neighbor', humour: 'humor', centre: 'center', centres: 'centers',
  theatre: 'theater', metre: 'meter', litre: 'liter', organise: 'organize', organised: 'organized',
  organisation: 'organization', realise: 'realize', realised: 'realized', recognise: 'recognize',
  recognised: 'recognized', apologise: 'apologize', analyse: 'analyze', analysed: 'analyzed', optimise: 'optimize',
  optimised: 'optimized', prioritise: 'prioritize', customise: 'customize', initialise: 'initialize',
  licence: 'license', defence: 'defense', offence: 'offense', travelling: 'traveling', travelled: 'traveled',
  cancelled: 'canceled', cancelling: 'canceling', modelling: 'modeling', catalogue: 'catalog', dialogue: 'dialog',
  programme: 'program', grey: 'gray', cheque: 'check', tyre: 'tire', aluminium: 'aluminum', whilst: 'while',
  amongst: 'among', learnt: 'learned', spelt: 'spelled', burnt: 'burned',
};

function matchCase(original: string, replacement: string): string {
  if (original === original.toUpperCase() && original.length > 1 && replacement === replacement.toLowerCase())
    return replacement.toUpperCase();
  if (/^\p{Lu}/u.test(original)) return replacement.charAt(0).toUpperCase() + replacement.slice(1);
  return replacement;
}

function replaceWords(text: string, dict: Record<string, string>, caseInsensitive = true): string {
  return text.replace(/(?<![\p{L}\p{N}_'[\]])[\p{L}][\p{L}\p{N}]*(?![\p{L}\p{N}_'])/gu, (word) => {
    const rep = dict[caseInsensitive ? word.toLowerCase() : word];
    return rep === undefined ? word : matchCase(word, rep);
  });
}

/** URLs, emails, placeholders, file names, "e.g." — anything with inner punctuation stays verbatim. */
const KEEP_TOKEN = /(?:https?:\/\/|www\.)\S+|\[[A-Z]+_\d+\]|\S*[\p{L}\p{N}_][./\\@:][\p{L}\p{N}_]\S*/gu;

function normalizeProse(t: string): string {
  const kept: string[] = [];
  let s = t.replace(KEEP_TOKEN, (m) => `\uE000${kept.push(m) - 1}\uE001`);
  s = s.replace(/[‘’‛′]/g, "'").replace(/[“”‟″]/g, '"');
  s = s.replace(/\s*[—–]\s*/g, ' - ').replace(/(\w)--(\w)/g, '$1 - $2');
  s = s.replace(/…|\.{4,}/g, '...');
  s = s.replace(/\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/gu, '');
  s = s.replace(/(?<=^|\s)(?:[:;=]-?[)(DPpO3/\\|\]]+|[xX]D|<3|\^_\^)(?=\s|$|[.,!?])/g, '');
  s = s.replace(FILLERS, '');
  s = s.replace(/([!?])[!?]+/g, '$1');
  s = s.replace(/,{2,}/g, ',');
  s = replaceWords(s, SLANG);
  s = replaceWords(s, MISSPELLINGS);
  s = replaceWords(s, BRITISH);
  s = s.replace(/(?<![\p{L}])i(?=(?:'(?:m|ve|d|ll))?(?![\p{L}]))/gu, 'I');
  s = s.replace(/[ \t]+([,.;:!?])/g, '$1');
  s = s.replace(/([,;:])(?=[\p{L}])/gu, '$1 ');
  s = s.replace(/[ \t]{2,}/g, ' ');
  // Capitalise sentence starts (paragraph starts and after . ! ?).
  s = s.replace(/(^|[.!?]\s+|\n\s*)(\p{Ll})/gu, (_m, pre: string, ch: string) => pre + ch.toUpperCase());
  s = s.replace(/[ \t]+$/gm, '').replace(/^[ \t]+(?=\S)/gm, '').replace(/([,.;:!?])\1+/g, '$1').replace(/^[,;:]\s*/gm, '');
  s = s.replace(/\n{3,}/g, '\n\n');
  return s.replace(/\uE000(\d+)\uE001/g, (_m, i: string) => kept[Number(i)]!);
}

export function normalizeStyle(text: string): string {
  return splitProtected(text)
    .map((seg) => (seg.protected ? seg.text : normalizeProse(seg.text)))
    .join('');
}
