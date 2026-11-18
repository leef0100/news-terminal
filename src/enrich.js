// Turns a raw headline or post into a feed item: kind, cashtags and search terms.

const CASHTAG = /\$([A-Za-z][A-Za-z0-9]{1,11})\b/g;

const LISTING = /\b(to list|will list|lists|listing|listed on|adds support for|delist(s|ing)?)\b/i;
const MACRO_CASED = /\b(CPI|FOMC|Fed|ECB|PCE|GDP)\b/;
const MACRO_WORDS = /\b(federal reserve|rate cuts?|rate hikes?|interest rates?|inflation|jobs report|payrolls|treasury yields?|tariffs?)\b/i;

// Words that mark a headline as urgent enough for the Breaking page.
const URGENT = /\b(breaking|just in|urgent|halts?|halted|hack(ed|s)?|exploit(ed)?|approv(es|ed|al)|sues|sued|bans?|banned|crash(es|ed)?|surg(es|ed|ing)|plung(es|ed|ing)|soars?|tumbl(es|ed)|liquidat(ed|ions?)|delist(s|ed|ing)?|outage|emergency)\b/i;

// Topic rules, checked in order; the first match wins, then the source's own topic.
const TOPICS = [
  ['crypto', /\b(bitcoin|btc|ethereum|ether|solana|crypto\w*|tokens?|stablecoins?|memecoins?|defi|blockchain|altcoins?|airdrops?|on-?chain|nft)\b/i],
  ['technology', /\b(AI|A\.I\.|artificial intelligence|chips?|chipmakers?|semiconductors?|software|startups?|cyber\w*|data cent(er|re)s?|cloud|robots?|robotics|smartphones?|quantum|tech)\b/i],
  ['business', /\b(CEO|CFO|chief executive|earnings|merger|acquisition|acquires?|buyout|takeover|layoffs?|IPO|revenue|profits?|bankrupt\w*|board|shareholders?|antitrust)\b/i],
  ['markets', /\b(stocks?|shares|S&P|Nasdaq|Dow|equit(y|ies)|bonds?|yields?|oil|gold|commodit(y|ies)|rall(y|ies)|sell-?off|futures|Wall Street|investors?)\b/i],
  ['politics', /\b(election|Congress|Senate|White House|president|prime minister|parliament|lawmakers?|sanctions?|legislation|government|court|regulators?|ministers?)\b/i]
];

// Words that make a headline front-page material, used to pick what the home collage shows.
const IMPACT = /\b(oust(s|ed|er)?|resign(s|ed|ation)?|fired|steps? down|dies|dead|killed|attack(s|ed)?|war|invasion|invades?|explosion|collaps(e|es|ed)|bankrupt\w*|default(s|ed)?|record|historic|crisis|panic|shock(s|ed)?|surprise|arrest(s|ed)?|indict(s|ed|ment)?|seiz(es|ed)|shutdown|unprecedented|biggest|worst|largest|billions?|trillions?)\b/gi;

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

export function topicOf(text, source, kind, cashtags = []) {
  if (kind === 'macro') return 'macro';
  if (cashtags.length || kind === 'listing') return 'crypto';
  for (const [topic, re] of TOPICS) if (re.test(text)) return topic;
  return source.topic || (source.crypto ? 'crypto' : 'world');
}

// 0 for routine news; higher for headlines with more front-page words, urgency or a ticker.
export function impactOf(text, breaking) {
  const hits = new Set((text.match(IMPACT) || []).map((w) => w.toLowerCase()));
  return hits.size * 3 + (URGENT.test(text) ? 2 : 0) + (breaking ? 1 : 0);
}

export function enrich(raw, source) {
  const text = String(raw.text || '').replace(/\s+/g, ' ').trim();
  const kind = classify(text, source);
  const cashtags = extractCashtags(text);
  const breaking = kind === 'listing' || kind === 'x' || cashtags.length > 0 || URGENT.test(text);
  return {
    id: raw.id,
    ts: raw.ts,
    seenAt: raw.seenAt,
    backfill: Boolean(raw.backfill),
    kind,
    topic: topicOf(text, source, kind, cashtags),
    breaking,
    impact: impactOf(text, breaking),
    sourceId: source.id,
    source: source.name,
    text,
    url: /^https?:\/\//i.test(raw.url || '') ? raw.url : null,
    cashtags,
    terms: extractTerms(text)
  };
}
