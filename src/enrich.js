// Turns a raw headline or post into a feed item: kind, cashtags and search terms.

const CASHTAG = /\$([A-Za-z][A-Za-z0-9]{1,11})\b/g;

const LISTING = /\b(to list|will list|lists|listing|listed on|adds support for|delist(s|ing)?)\b/i;
const MACRO_CASED = /\b(CPI|FOMC|Fed|ECB|PCE|GDP)\b/;
const MACRO_WORDS = /\b(federal reserve|rate cuts?|rate hikes?|interest rates?|inflation|jobs report|payrolls|treasury yields?|tariffs?)\b/i;

const STOP = new Set(
  ('The A An And Or But For Nor With From Into Over After Before Why How What When Where Who Its His Her ' +
    'Their This That These Those New Says Said Will Has Have Had Are Was Were Is Be Been Not Now More Most ' +
    'Than Then Amid As At By In Of On To Up US U.S. Inc Corp Ltd Co Mr Ms Dr January February March April May ' +
    'June July August September October November December Monday Tuesday Wednesday Thursday Friday Saturday Sunday')
    .split(' ')
    .map((w) => w.toLowerCase())
);

export function extractCashtags(text) {
  const out = [];
  for (const m of String(text).matchAll(CASHTAG)) {
    const t = m[1].toUpperCase();
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

// Proper-noun style words a trader might want to search tokens for.
export function extractTerms(text, max = 5) {
  const words = String(text)
    .replace(/[“”"'’‘(),:;!?]/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const out = [];
  words.forEach((w, i) => {
    const clean = w.replace(/\.$/, '');
    if (clean.startsWith('$')) return;
    if (!/^[A-Z][A-Za-z0-9]{2,}$/.test(clean)) return;
    if (STOP.has(clean.toLowerCase())) return;
    // The first word of a headline is capitalised whatever it is: keep it only if it recurs.
    if (i === 0 && !words.slice(1).some((x) => x.replace(/\.$/, '') === clean)) return;
    if (!out.includes(clean)) out.push(clean);
  });
  return out.slice(0, max);
}

export function classify(text, source) {
  if (source.kind && source.kind !== 'wire') return source.kind;
  if (source.crypto && LISTING.test(text)) return 'listing';
  if (MACRO_CASED.test(text) || MACRO_WORDS.test(text)) return 'macro';
  return 'wire';
}

export function enrich(raw, source) {
  const text = String(raw.text || '').replace(/\s+/g, ' ').trim();
  return {
    id: raw.id,
    ts: raw.ts,
    seenAt: raw.seenAt,
    backfill: Boolean(raw.backfill),
    kind: classify(text, source),
    sourceId: source.id,
    source: source.name,
    text,
    url: /^https?:\/\//i.test(raw.url || '') ? raw.url : null,
    cashtags: extractCashtags(text),
    terms: extractTerms(text)
  };
}
