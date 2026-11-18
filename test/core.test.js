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

import { createChat } from '../src/chat.js';

test('breaking flag: tickers, listings, X posts and urgent words qualify; routine news does not', () => {
  const wire = { id: 'w', name: 'W', kind: 'wire', crypto: true };
  const mk = (text, src = wire) => enrich({ id: '1', text, ts: 1, seenAt: 2 }, src).breaking;
  assert.equal(mk('Exchange halts withdrawals after exploit'), true);
  assert.equal(mk('Fund adds $OTTER to holdings'), true);
  assert.equal(mk('Exchange to list ROCKET'), true);
  assert.equal(mk('hello', { id: 'x', name: '@a', kind: 'x' }), true);
  assert.equal(mk('Quarterly review of custody rules published'), false);
});

test('chat: validates room and text, strips control characters, limits rate and room size', () => {
  let t = 0;
  const chat = createChat({ hasRoom: (r) => r === 'general', now: () => t, maxPerRoom: 3, burst: 2, windowMs: 1000 });
  const seen = [];
  chat.on((m) => seen.push(m.id));
  assert.equal(chat.post({ room: 'nope', text: 'hi', ip: 'a' }).status, 404);
  assert.equal(chat.post({ room: 'general', text: '   ', ip: 'a' }).status, 400);
  const ok = chat.post({ room: 'general', name: ' bob\n ', text: 'gm\u0007  all', ip: 'a' });
  assert.deepEqual([ok.status, ok.msg.name, ok.msg.text], [200, 'bob', 'gm all']);
  assert.equal(chat.post({ room: 'general', text: 'x'.repeat(500), ip: 'a' }).msg.text.length, 280);
  assert.equal(chat.post({ room: 'general', text: 'third', ip: 'a' }).status, 429);
  assert.equal(chat.post({ room: 'general', text: 'other person', ip: 'b' }).status, 200);
  t = 2000;
  chat.post({ room: 'general', text: 'later', ip: 'a' });
  chat.post({ room: 'general', text: 'latest', ip: 'a' });
  assert.deepEqual(chat.list('general').map((m) => m.text), ['other person', 'later', 'latest']);
  assert.equal(chat.counts().general, 3);
  assert.equal(seen.length, 5);
  assert.equal(chat.post({ room: 'general', text: 'anon check', ip: 'c' }).msg.name, 'anon');
});

import { topicOf, impactOf } from '../src/enrich.js';

test('topics: keyword rules first, then the source topic, tickers are crypto', () => {
  const t = (text, src = { id: 's', name: 'S', kind: 'wire', topic: 'world' }) => enrich({ id: '1', text, ts: 1, seenAt: 2 }, src).topic;
  assert.equal(t('Chipmaker board ousts chief executive'), 'technology');
  assert.equal(t('Retailer posts record earnings'), 'business');
  assert.equal(t('Stocks slide as bond yields climb'), 'markets');
  assert.equal(t('Fed signals rate cuts'), 'macro');
  assert.equal(t('Senate passes spending bill'), 'politics');
  assert.equal(t('Fund buys $OTTER'), 'crypto');
  assert.equal(t('Storm closes northern ports'), 'world');
  assert.equal(t('Storm closes northern ports', { id: 's', name: 'S', kind: 'wire', topic: 'business' }), 'business');
  assert.equal(topicOf('anything', { crypto: true }, 'wire'), 'crypto');
});

test('impact: dramatic headlines outrank routine ones', () => {
  assert.ok(impactOf('Board ousts founder in surprise vote after record loss', false) > impactOf('Stocks plunge', false));
  assert.equal(impactOf('Quarterly review of custody rules published', false), 0);
});

import { createHyperliquid } from '../src/hyperliquid.js';
import { createRadar, readTilt } from '../src/radar.js';
import { demoMarketFetch } from '../src/ingest/demo-markets.js';

test('hyperliquid adapter: markets, book, candles and trades parse and cache', async () => {
  let calls = 0;
  const base = demoMarketFetch(() => 1_700_000_000_000);
  const hl = createHyperliquid({ fetchImpl: (u, i) => { calls++; return base(u, i); }, now: () => 1_700_000_000_000 });
  const markets = await hl.markets();
  assert.equal(markets[0].coin, 'BTC');
  assert.ok(markets[0].mark > 0 && markets[0].openInterestUsd > 0);
  await hl.markets();
  assert.equal(calls, 1);
  const book = await hl.book('ETH');
  assert.ok(book.bids[0].px < book.asks[0].px);
  assert.ok(book.bids[0].px > book.bids[1].px && book.asks[0].px < book.asks[1].px);
  const candles = await hl.candles('BTC', '1h');
  assert.ok(candles.length > 100);
  assert.ok(candles.every((c, i) => c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close) && (i === 0 || c.time > candles[i - 1].time)));
  const trades = await hl.trades('SOL');
  assert.ok(trades.length && trades[0].time >= trades[trades.length - 1].time);
  await assert.rejects(() => hl.candles('BTC', '7m'));
  const down = createHyperliquid({ fetchImpl: async () => ({ ok: false, status: 500 }) });
  await assert.rejects(() => down.markets(), /500/);
});

test('radar: blends venues, converts funding, and survives a venue being blocked', async () => {
  const t = 1_700_000_000_000;
  const base = demoMarketFetch(() => t);
  const fetchImpl = (u, i) => (String(u).includes('bybit') ? Promise.resolve({ ok: false, status: 403 }) : base(u, i));
  const hl = createHyperliquid({ fetchImpl, now: () => t });
  const radar = createRadar({ fetchImpl, hl, now: () => t });
  const snap = await radar.snapshot();
  const venue = (n) => snap.venues.find((v) => v.name === n);
  assert.equal(venue('Binance').ok, true);
  assert.equal(venue('Bybit').ok, false);
  assert.match(venue('Bybit').error, /403/);
  assert.equal(venue('Papertrade').ok, false);
  const eth = snap.coins.find((c) => c.coin === 'ETH');
  assert.ok(eth.price > 0);
  assert.ok(eth.positioning.every((p) => Math.abs(p.longPct + p.shortPct - 100) < 0.02));
  assert.ok(eth.blendedLongPct > 60 && eth.tilt === 'long');
  const hlFunding = eth.funding.find((f) => f.venue === 'Hyperliquid');
  const bnFunding = eth.funding.find((f) => f.venue === 'Binance');
  assert.ok(Math.abs(hlFunding.rate8h - bnFunding.rate8h) < 1e-9, 'hourly funding is scaled to 8h');
  assert.ok(Math.abs(bnFunding.annualPct - bnFunding.rate8h * 109500) < 0.01);
  assert.ok(eth.openInterest.some((o) => o.venue === 'Binance') && !eth.openInterest.some((o) => o.venue === 'Bybit'));
  assert.ok(eth.coinbasePremiumPct > 0);
  assert.ok(snap.bigTrades.every((x) => x.usd >= snap.bigTradeUsd));
  assert.equal(await radar.snapshot(), snap, 'cached within the ttl');
});

test('tilt wording', () => {
  assert.equal(readTilt(72, 0.0001).tilt, 'long');
  assert.match(readTilt(72, 0.0001).note, /Crowded long: 72%.*Longs are paying/);
  assert.match(readTilt(30, -0.0001).note, /Crowded short: 70%.*Shorts are paying/);
  assert.equal(readTilt(50, null).tilt, 'balanced');
  assert.equal(readTilt(null, null).tilt, 'unknown');
});
