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
  assert.equal(s.add({ id: 'a', sourceId: 'w', text: 'A', ts: 1 }), true);
  assert.equal(s.add({ id: 'a', sourceId: 'w', text: 'A', ts: 1 }), false);
  s.add({ id: 'b', sourceId: 'x', text: 'B', ts: 3 });
  s.add({ id: 'c', sourceId: 'y', text: 'C', ts: 2 });
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
import { createMemoryBus } from '../src/bus.js';
import { storyKey, sameStory } from '../src/store.js';

test('breaking flag: tickers, listings, X posts and urgent words qualify; routine news does not', () => {
  const wire = { id: 'w', name: 'W', kind: 'wire', crypto: true };
  const mk = (text, src = wire) => enrich({ id: '1', text, ts: 1, seenAt: 2 }, src).breaking;
  assert.equal(mk('Exchange halts withdrawals after exploit'), true);
  assert.equal(mk('Fund adds $OTTER to holdings'), true);
  assert.equal(mk('Exchange to list ROCKET'), true);
  assert.equal(mk('hello', { id: 'x', name: '@a', kind: 'x' }), true);
  assert.equal(mk('Quarterly review of custody rules published'), false);
});

test('chat: validates room and text, strips control characters, limits rate and room size', async () => {
  let t = 0;
  const bus = createMemoryBus({ now: () => t });
  const chat = createChat({ hasRoom: (r) => r === 'general', bus, now: () => t, maxPerRoom: 3, burst: 2, windowMs: 1000 });
  await chat.start();
  const seen = [];
  chat.on((m) => seen.push(m.id));
  assert.equal((await chat.post({ room: 'nope', text: 'hi', ip: 'a' })).status, 404);
  assert.equal((await chat.post({ room: 'general', text: '   ', ip: 'a' })).status, 400);
  const ok = await chat.post({ room: 'general', name: ' bob\n ', text: 'gm\u0007  all', ip: 'a' });
  assert.deepEqual([ok.status, ok.msg.name, ok.msg.text], [200, 'bob', 'gm all']);
  assert.equal((await chat.post({ room: 'general', text: 'x'.repeat(500), ip: 'a' })).msg.text.length, 280);
  assert.equal((await chat.post({ room: 'general', text: 'third', ip: 'a' })).status, 429);
  assert.equal((await chat.post({ room: 'general', text: 'other person', ip: 'b' })).status, 200);
  t = 2000;
  await chat.post({ room: 'general', text: 'later', ip: 'a' });
  await chat.post({ room: 'general', text: 'latest', ip: 'a' });
  assert.deepEqual(chat.list('general').map((m) => m.text), ['other person', 'later', 'latest']);
  assert.equal(chat.counts().general, 3);
  assert.equal(new Set(seen).size, 5);
  assert.equal((await chat.post({ room: 'general', text: 'anon check', ip: 'c' })).msg.name, 'anon');
});

test('chat: a server that starts late loads the history other servers hold', async () => {
  const bus = createMemoryBus();
  const a = createChat({ hasRoom: () => true, bus });
  await a.start();
  await a.post({ room: 'general', text: 'first', ip: 'a' });
  const b = createChat({ hasRoom: () => true, bus });
  await b.start();
  await a.post({ room: 'general', text: 'second', ip: 'a' });
  assert.deepEqual(b.list('general').map((m) => m.text), ['first', 'second']);
});

test('stories: the same event from two outlets shares a storyId; look-alikes do not', () => {
  const s = createStore();
  const mk = (id, sourceId, text, ts = 1000, publisher) => { const it = { id, sourceId, publisher, text, ts }; return s.add(it) ? it : null; };
  const a = mk('a', 'wsj', 'Acme Motors board ousts founder in surprise vote');
  const b = mk('b', 'nyt', 'Acme Motors ousts founder after surprise board vote');
  const c = mk('c', 'ft', 'Central bank holds interest rates steady');
  const d = mk('d', 'wsj', 'Acme Motors board ousts founder in surprise vote, shares fall');
  const late = mk('e', 'nyt', 'Acme Motors board ousts founder in surprise vote', 1000 + 7 * 3600000);
  assert.deepEqual([a.storyId, b.storyId, c.storyId], ['a', 'a', 'c']);
  assert.equal(d.storyId, 'a', 'matches the other outlet\'s copy, never its own');
  assert.equal(late.storyId, 'e', 'outside the six-hour window');
  const same = (x, y) => sameStory(storyKey(x), storyKey(y)) > 0;
  for (const [x, y] of [
    ['Apple beats earnings expectations', 'Amazon beats earnings expectations'],
    ['Apple Beats Earnings Expectations', 'Amazon Beats Earnings Expectations'],
    ['Nvidia stock jumps after earnings beat', 'AMD stock jumps after earnings beat'],
    ['Bitcoin ETF sees record inflows', 'Bitcoin ETF sees record outflows'],
    ['Tesla shares rise 5% after earnings', 'Tesla shares fall 5% after earnings'],
    ['Tesla shares rise 5% after earnings', 'Tesla shares rise 8% after earnings'],
    ['Binance to list PEPE perpetual futures', 'Binance to list WIF perpetual futures']
  ]) assert.equal(same(x, y), false, x + ' / ' + y);
  for (const [x, y] of [
    ['SEC sues Binance over securities violations', 'Binance sued by SEC for alleged securities law breaches'],
    ['Fed holds rates steady', 'Fed holds rates steady, signals cuts'],
    ['Fed Holds Rates Steady As Inflation Cools', 'Fed holds rates steady as inflation cools'],
    ['Exchange halts withdrawals after exploit', 'Exchange halts withdrawals after $200M exploit']
  ]) assert.equal(same(x, y), true, x + ' / ' + y);
});

test('store: one outlet repeating a headline across its sections is one item; stale items do not churn', () => {
  const s = createStore({ max: 3 });
  assert.equal(s.add({ id: '1', sourceId: 'wsj-markets', publisher: 'wsj', text: 'Stocks slide', ts: 10 }), true);
  assert.equal(s.add({ id: '2', sourceId: 'wsj-business', publisher: 'wsj', text: 'stocks slide ', ts: 11 }), false);
  s.add({ id: '3', sourceId: 'a', text: 'Three', ts: 12 });
  s.add({ id: '4', sourceId: 'a', text: 'Four', ts: 13 });
  const v = s.version();
  assert.equal(s.add({ id: 'old', sourceId: 'a', text: 'Too old to keep', ts: 1 }), false);
  assert.equal(s.version(), v, 'nothing changed, so cached answers stay valid');
});

test('bus: shared rate limit resets after its window', async () => {
  let t = 0;
  const bus = createMemoryBus({ now: () => t });
  assert.deepEqual([await bus.allow('k', 2, 100), await bus.allow('k', 2, 100), await bus.allow('k', 2, 100)], [true, true, false]);
  t = 100;
  assert.equal(await bus.allow('k', 2, 100), true);
  const got = [];
  bus.on('s', (o) => got.push(o.n));
  for (let n = 1; n <= 4; n++) await bus.append('s', { n }, 3);
  assert.deepEqual(got, [1, 2, 3, 4]);
  assert.deepEqual((await bus.history('s')).map((o) => o.n), [2, 3, 4]);
});

test('token search: many callers at once cause a single upstream request', async () => {
  let calls = 0;
  const slow = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return { ok: true, status: 200, json: async () => ({ pairs: [pair('REALpump', 'OTTER', 'Otter', POST - 1, 50_000), pair('BIGpump', 'OTTER', 'Otter Two', POST + 5, 90_000)] }) }; };
  const m = createTokenMatcher({ fetchImpl: slow });
  const all = await Promise.all(Array.from({ length: 50 }, () => m.search('OTTER')));
  assert.equal(calls, 1);
  assert.deepEqual(all[0].map((t) => t.address), ['BIGpump', 'REALpump'], 'deepest liquidity first');
  assert.ok(all[0].every((t) => t.createdAt > 0 && t.createdAfterPost === false));
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

test('token search: a flood of made-up words cannot shut out words that are in the news', async () => {
  let calls = 0, t = 0;
  const ok = async () => { calls++; return { ok: true, status: 200, json: async () => ({ pairs: [] }) }; };
  const m = createTokenMatcher({ fetchImpl: ok, now: () => t, upstreamPerMinute: 6, ttlMs: 1000 });
  await m.search('junk1'); await m.search('junk2'); await m.search('junk3');
  await assert.rejects(() => m.search('junk4'), /busy/, 'made-up words get half the allowance');
  await m.search('OTTER', 8, { priority: true });
  await m.search('ROCKET', 8, { priority: true });
  await m.search('BYTE', 8, { priority: true });
  await assert.rejects(() => m.search('WALRUS', 8, { priority: true }), /busy/, 'the whole allowance is still a ceiling');
  assert.equal(calls, 6);
  assert.deepEqual(await m.search('junk1'), [], 'a cached word still answers');
  t = 61000;
  await m.search('junk4');
  assert.equal(calls, 7);
});

test('rss: angle brackets and ampersands in a headline survive; real markup is removed', () => {
  const feed = (t) => `<rss><channel><item><title>${t}</title><guid>g</guid></item></channel></rss>`;
  assert.equal(parseFeed(feed('Yields &lt; 4% as oil &gt; $90; AT&amp;T slides'), 's')[0].text, 'Yields < 4% as oil > $90; AT&T slides');
  assert.equal(parseFeed(feed('<![CDATA[S&P <5,000 for first time; Nasdaq >1% lower]]>'), 's')[0].text, 'S&P <5,000 for first time; Nasdaq >1% lower');
  assert.equal(parseFeed(feed('<![CDATA[Markets <b>rally</b> &amp; hold]]>'), 's')[0].text, 'Markets rally & hold');
});

test('poller: undated, future-dated and aged-out entries never come back as new', async () => {
  let t = 1_000_000;
  const store = createStore({ max: 2 });
  let xml = '';
  const fetchImpl = async () => ({ ok: true, status: 200, headers: new Map(), text: async () => xml });
  const poller = createPoller({ sources: [{ id: 's', name: 'S', kind: 'wire', url: 'https://s.example' }], store, fetchImpl, now: () => t, log: { warn() {} } });
  const item = (title, date) => `<item><title>${title}</title><guid>${title}</guid>${date ? `<pubDate>${new Date(date).toUTCString()}</pubDate>` : ''}</item>`;
  xml = `<rss><channel>${item('Undated entry')}${item('From the future', t + 86_400_000)}</channel></rss>`;
  await poller.pollAll();
  assert.ok(store.list().every((i) => i.ts <= t), 'nothing is dated after it was seen');
  t += 60_000;
  xml = `<rss><channel>${item('Undated entry')}${item('From the future', t + 86_400_000)}${item('Newer one', t)}${item('Newer two', t)}</channel></rss>`;
  await poller.pollAll();
  assert.deepEqual(store.list().map((i) => i.text).sort(), ['Newer one', 'Newer two'], 'the first two aged out');
  const v = store.version();
  t += 60_000;
  await poller.pollAll();
  await poller.pollAll();
  assert.equal(store.version(), v, 'entries already handled are not re-added');
  assert.ok(!store.list().some((i) => i.text === 'Undated entry'));
});

test('chat: the general room survives any number of other rooms; spoofed names are cleaned', async () => {
  const bus = createMemoryBus();
  const chat = createChat({ hasRoom: () => true, bus, maxRooms: 5, burst: 1000 });
  await chat.start();
  await chat.post({ room: 'general', text: 'keep me', ip: 'a' });
  for (let i = 0; i < 20; i++) await chat.post({ room: 'room' + i, text: 'x', ip: 'a' });
  assert.deepEqual(chat.list('general').map((m) => m.text), ['keep me']);
  assert.ok(Object.keys(chat.counts()).length <= 5);
  assert.equal(chat.list('room19').length, 1, 'the most recent room is kept');
  const spoof = await chat.post({ room: 'general', name: '‮nimda​', text: 'hi', ip: 'b' });
  assert.equal(spoof.msg.name, 'nimda');
});

test('market data: failures are not passed on per request, and the last good answer is kept', async () => {
  let calls = 0, t = 0, down = false;
  const base = demoMarketFetch(() => 1_700_000_000_000);
  const fetchImpl = (u, i) => { calls++; return down ? Promise.resolve({ ok: false, status: 503 }) : base(u, i); };
  const hl = createHyperliquid({ fetchImpl, now: () => t });
  const good = await hl.markets();
  down = true;
  t = 6000;
  assert.deepEqual(await hl.markets(), good, 'serves the last good list while the exchange is failing');
  const before = calls;
  for (let i = 0; i < 200; i++) await hl.markets();
  assert.equal(calls, before, 'two hundred requests during an outage made no upstream calls');
  await assert.rejects(() => hl.book('BTC'), /503/);
  const afterBook = calls;
  for (let i = 0; i < 50; i++) await assert.rejects(() => hl.book('BTC'));
  assert.equal(calls, afterBook);
  assert.equal(await hl.has('BTC'), true);
  assert.equal(await hl.has('FAKE1'), false);
});

test('hyperliquid adapter: grouped depth, funding history, and a cap on what this server spends', async () => {
  let t = 1_700_000_000_000;
  const calls = [];
  const fetchImpl = async (_url, init) => {
    const body = JSON.parse(init.body);
    calls.push(body);
    if (body.type === 'l2Book') return { ok: true, status: 200, json: async () => ({ time: t, levels: [[{ px: '99', sz: '2' }, { px: '98', sz: '0' }], [{ px: '101', sz: '3' }]] }) };
    if (body.type === 'fundingHistory') return { ok: true, status: 200, json: async () => [{ time: 2000, fundingRate: '0.00002' }, { time: 1000, fundingRate: '-0.00001' }, { time: 'x', fundingRate: 'y' }] };
    return { ok: true, status: 200, json: async () => [] };
  };
  const hl = createHyperliquid({ fetchImpl, now: () => t, weightPerMinute: 34 });
  const d = await hl.depth('BTC', 9);
  assert.equal(d.sig, 3, 'an unsupported grouping falls back to the default');
  assert.deepEqual(d.bids, [{ px: 99, sz: 2 }], 'empty levels are dropped');
  assert.deepEqual(d.asks, [{ px: 101, sz: 3 }]);
  assert.equal(calls[0].nSigFigs, 3);
  const f = await hl.fundingHistory('BTC');
  assert.deepEqual(f, [{ time: 1000, rate: -0.00001 }, { time: 2000, rate: 0.00002 }], 'oldest first, bad rows dropped');
  assert.equal(calls[1].startTime % 3600000, 0, 'the start is on the hour so everyone shares one cached answer');
  // 2 + 30 of the 34 allowed are spent. A fresh question is refused, an old one is answered from memory.
  await assert.rejects(hl.fundingHistory('ETH'), /allowance/);
  t += 5000;
  assert.deepEqual((await hl.depth('BTC', 3)).bids, [{ px: 99, sz: 2 }]);
  const before = calls.length;
  t += 60000;
  await hl.fundingHistory('ETH');
  assert.equal(calls.length, before + 1, 'the allowance refills each minute');
});

test('radar: funding is compared on each market\'s own settlement interval, and a missing venue is named', async () => {
  const { demoMarketFetch } = await import('../src/ingest/demo-markets.js');
  const base = demoMarketFetch(() => 1_700_000_000_000);
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (u.includes('/fapi/v1/fundingInfo')) return { ok: true, status: 200, json: async () => [{ symbol: 'HYPEUSDT', fundingIntervalHours: 4 }] };
    if (u.includes('api.bybit.com')) return { ok: false, status: 403, json: async () => ({}) }; // what a US server gets
    return base(url, init);
  };
  const hl = createHyperliquid({ fetchImpl, now: () => 1_700_000_000_000 });
  const snap = await createRadar({ fetchImpl, hl, now: () => 1_700_000_000_000 }).snapshot();
  const coin = (c) => snap.coins.find((x) => x.coin === c);
  const bn = (c) => coin(c).funding.find((f) => f.venue === 'Binance');
  assert.equal(bn('HYPE').intervalHours, 4);
  assert.ok(Math.abs(bn('HYPE').rate8h - 0.00082) < 1e-12, 'a 4-hour rate counts twice in 8 hours');
  assert.ok(Math.abs(bn('HYPE').annualPct - 0.00041 * 6 * 365 * 100) < 0.01);
  assert.equal(bn('BTC').intervalHours, 8);
  assert.equal(snap.venues.find((v) => v.name === 'Bybit').ok, false);
  assert.deepEqual(coin('BTC').blendedFrom, ['Binance'], 'the long/short figure says it is Binance alone');
  assert.match(coin('BTC').note, /on Binance\./);
  assert.ok(!coin('BTC').openInterestFrom.includes('Bybit'));
  assert.equal(coin('BTC').coinbasePremiumVs, 'Binance futures');
});

test('x panel: shares accounts between viewers, asks only for new posts, and stops at its limits', async () => {
  const { createXPanel, validHandle } = await import('../src/xpanel.js');
  assert.ok(validHandle('elonmusk') && validHandle('a_b_1') && !validHandle('bad-name') && !validHandle('') && !validHandle('x'.repeat(16)) && !validHandle('a,b'));

  // No key: says so, and shows nothing as a post.
  const off = createXPanel({}).panel(['someone']);
  assert.equal(off.enabled, false);
  assert.deepEqual(off.posts, []);
  // Demo: placeholders only, never worded as something the person said.
  const demo = createXPanel({ demo: true }).panel(['Someone', 'someone', 'bad-name']);
  assert.equal(demo.posts.length, 1, 'one account, however it was typed');
  assert.ok(demo.posts[0].placeholder && /^Placeholder\./.test(demo.posts[0].text));

  let t = Date.UTC(2026, 0, 1, 12);
  const calls = [];
  let next = [{ id: '1002', text: 'second', created_at: '2026-01-01T11:59:00Z' }, { id: '1001', text: 'first', created_at: '2026-01-01T11:00:00Z' }];
  let status = 200;
  const fetchImpl = async (url, init) => {
    calls.push(String(url));
    assert.equal(init.headers.authorization, 'Bearer k');
    if (status !== 200) return { ok: false, status, headers: { get: () => String((t + 120000) / 1000) }, json: async () => ({}) };
    if (String(url).includes('/users/by?')) return { ok: true, status: 200, json: async () => ({ data: [{ id: '42', username: 'Alice', name: 'Alice A' }] }) };
    const out = next; next = [];
    return { ok: true, status: 200, json: async () => ({ data: out }) };
  };
  const x = createXPanel({ token: 'k', fetchImpl, now: () => t, log: { warn() {} }, dailyPosts: 3, tickMs: 1e9 });
  let p = x.panel(['alice', 'ghost']);
  assert.deepEqual(p.accounts.map((a) => a.state), ['waiting', 'waiting']);
  await x.tick();
  p = x.panel(['ALICE', 'ghost']);
  assert.deepEqual(p.accounts.map((a) => [a.handle, a.state]), [['Alice', 'ok'], ['ghost', 'notfound']]);
  assert.deepEqual(p.posts.map((q) => q.text), ['second', 'first'], 'newest first');
  assert.equal(p.posts[0].url, 'https://x.com/Alice/status/1002');
  assert.equal(calls.filter((c) => c.includes('/users/by?')).length, 1, 'names are looked up once, together');

  // The next check asks only for posts after the newest one held.
  t += 30000;
  next = [{ id: '1003', text: 'third', created_at: '2026-01-01T12:00:20Z' }];
  await x.tick();
  assert.match(calls.at(-1), /since_id=1002/);
  assert.equal(x.panel(['alice']).posts[0].text, 'third');
  // Three posts read: the day's limit. Nothing more is fetched until tomorrow.
  const before = calls.length;
  t += 30000;
  await x.tick();
  assert.equal(calls.length, before);
  assert.equal(x.panel(['alice']).paused, 'budget');
  t += 86400000;
  x.panel(['alice']); // someone is still watching
  await x.tick();
  assert.equal(calls.length, before + 1, 'a new day, a new allowance');

  // Told to slow down: waits for the time given.
  status = 429; t += 30000;
  await x.tick();
  const after = calls.length;
  t += 30000; status = 200;
  await x.tick();
  assert.equal(calls.length, after, 'still waiting');
  assert.equal(x.panel(['alice']).paused, 'rate');
  t += 120000;
  await x.tick();
  assert.equal(calls.length, after + 1);

  // An account nobody asks about any more stops being checked.
  t += 700000;
  const idle = calls.length;
  await x.tick();
  assert.equal(calls.length, idle);
  x.stop();
});
