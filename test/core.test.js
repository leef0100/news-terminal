import test from 'node:test';
import assert from 'node:assert/strict';
import { extractCashtags, extractTerms, classify, enrich } from '../src/enrich.js';
import { rankPairs, createTokenMatcher } from '../src/tokens.js';
import { parseFeed } from '../src/ingest/rss.js';
import { createStore } from '../src/store.js';
import { createPoller } from '../src/ingest/poller.js';

test('cashtags are found, upper-cased and de-duplicated; prices are ignored', () => {
  assert.deepEqual(extractCashtags('buying $otter and $OTTER, also $byte at $5'), ['OTTER', 'BYTE']);
});

test('terms keep proper nouns and drop stopwords and a lone first word', () => {
  assert.deepEqual(extractTerms('Regulator opens probe into Acme and Globex after The crash'), ['Acme', 'Globex']);
});

test('classification: listings need a crypto source, macro words win otherwise', () => {
  assert.equal(classify('Exchange to list ROCKET', { kind: 'wire', crypto: true }), 'listing');
  assert.equal(classify('Company to list shares in London', { kind: 'wire' }), 'wire');
  assert.equal(classify('Fed holds as inflation cools', { kind: 'wire' }), 'macro');
  assert.equal(classify('anything', { kind: 'x' }), 'x');
});

test('enrich drops non-http links', () => {
  const src = { id: 's', name: 'S', kind: 'wire' };
  assert.equal(enrich({ id: '1', text: 'hi', url: 'javascript:alert(1)', ts: 1, seenAt: 2 }, src).url, null);
  assert.equal(enrich({ id: '1', text: 'hi', url: 'https://a.example/x', ts: 1, seenAt: 2 }, src).url, 'https://a.example/x');
});

const POST = 1_000_000_000_000;
const pair = (address, symbol, name, createdAt, liq, chainId = 'solana') => ({
  chainId, dexId: 'pumpfun', url: 'https://dexscreener.com/solana/' + address,
  baseToken: { address, symbol, name }, liquidity: { usd: liq }, marketCap: liq * 5, pairCreatedAt: createdAt
});

test('ranking: older token first, copycats flagged, other chains and non-matches dropped', () => {
  const out = rankPairs([
    pair('COPYpump', 'OTTER', 'Otter Again', POST + 9000, 5_000_000),
    pair('REALpump', 'OTTER', 'Otter', POST - 86_400_000, 1_200_000),
    pair('ETH', 'OTTER', 'Otter', POST - 1, 9_000_000, 'ethereum'),
    pair('OTHER', 'CAT', 'Cat', POST - 1, 9_000_000)
  ], 'otter', POST, POST + 60_000);
  assert.deepEqual(out.map((t) => t.address), ['REALpump', 'COPYpump']);
  assert.equal(out[0].createdAfterPost, false);
  assert.equal(out[1].createdAfterPost, true);
  assert.equal(out[1].secondsAfterPost, 9);
  assert.equal(out[0].buyUrl, 'https://pump.fun/coin/REALpump');
});

test('ranking: several pools of one token merge to deepest pool and earliest creation', () => {
  const out = rankPairs([
    pair('TOKpump', 'BYTE', 'Byte', POST + 5000, 900_000),
    pair('TOKpump', 'BYTE', 'Byte', POST - 5000, 2000)
  ], 'BYTE', POST, POST + 60_000);
  assert.equal(out.length, 1);
  assert.equal(out[0].liquidityUsd, 900_000);
  assert.equal(out[0].createdAfterPost, false);
});

test('matcher caches searches and reports an error when the API is down', async () => {
  let calls = 0;
  const ok = async () => { calls++; return { ok: true, status: 200, json: async () => ({ pairs: [pair('REALpump', 'OTTER', 'Otter', POST - 1, 50_000)] }) }; };
  const m = createTokenMatcher({ fetchImpl: ok, now: () => POST + 1000 });
  assert.equal((await m.match(['OTTER'], POST)).tokens.length, 1);
  await m.match(['otter'], POST);
  assert.equal(calls, 1);
  const down = createTokenMatcher({ fetchImpl: async () => ({ ok: false, status: 429 }) });
  const r = await down.match(['OTTER'], POST);
  assert.deepEqual(r.tokens, []);
  assert.match(r.error, /429/);
});

const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>T</title>
<item><title><![CDATA[Fed holds &amp; markets <b>rally</b>]]></title><link>https://n.example/a</link><guid>a1</guid><pubDate>Wed, 18 Nov 2026 19:00:00 GMT</pubDate></item>
<item><title>Second</title><link>https://n.example/b</link></item></channel></rss>`;
const ATOM = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title type="html">Atom one</title>
<link rel="alternate" href="https://n.example/c"/><id>c1</id><updated>2026-11-18T19:00:00Z</updated></entry></feed>`;

test('RSS and Atom parse to headline, link and time', () => {
  const rss = parseFeed(RSS, 's');
  assert.equal(rss.length, 2);
  assert.equal(rss[0].text, 'Fed holds & markets rally');
  assert.equal(rss[0].url, 'https://n.example/a');
  assert.equal(rss[0].ts, Date.parse('2026-11-18T19:00:00Z'));
  assert.equal(rss[1].ts, null);
  const atom = parseFeed(ATOM, 's');
  assert.equal(atom[0].url, 'https://n.example/c');
  assert.equal(atom[0].text, 'Atom one');
});

test('store de-duplicates, sorts newest first and notifies once', () => {
  const s = createStore({ max: 2 });
  const seen = [];
  s.on((i) => seen.push(i.id));
  assert.equal(s.add({ id: 'a', ts: 1 }), true);
  assert.equal(s.add({ id: 'a', ts: 1 }), false);
  s.add({ id: 'b', ts: 3 });
  s.add({ id: 'c', ts: 2 });
  assert.deepEqual(s.list().map((i) => i.id), ['b', 'c']);
  assert.deepEqual(seen, ['a', 'b', 'c']);
  assert.equal(s.get('a'), null);
});

test('poller: first pull is backlog, later items are live, a failing feed does not stop others', async () => {
  const store = createStore();
  let round = 0;
  const feed = (titles) => `<rss><channel>${titles.map((t) => `<item><title>${t}</title><guid>${t}</guid></item>`).join('')}</channel></rss>`;
  const fetchImpl = async (url) => {
    if (url.includes('bad')) throw new Error('boom');
    return { ok: true, status: 200, headers: new Map(), text: async () => feed(round === 0 ? ['one'] : ['one', 'two']) };
  };
  const poller = createPoller({
    sources: [{ id: 'good', name: 'Good', kind: 'wire', url: 'https://good.example' }, { id: 'bad', name: 'Bad', kind: 'wire', url: 'https://bad.example' }],
    store, fetchImpl, log: { warn() {} }
  });
  await poller.pollAll();
  round = 1;
  await poller.pollAll();
  const items = store.list();
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.text === 'one').backfill, true);
  assert.equal(items.find((i) => i.text === 'two').backfill, false);
  const status = poller.status();
  assert.equal(status.find((s) => s.id === 'good').ok, true);
  assert.equal(status.find((s) => s.id === 'bad').ok, false);
});
