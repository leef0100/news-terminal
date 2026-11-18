// Full browser test: every page, two tabs, wallet-free, with a stand-in for the exchange's
// live stream. Starts its own demo server. Needs Chrome:
//   CHROME_PATH=/path/to/chrome npm run test:e2e
import puppeteer from 'puppeteer-core';
import { WebSocketServer } from 'ws';
import { existsSync, mkdirSync } from 'node:fs';
import { createApp } from '../../src/server.js';

const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!CHROME) { console.error('Set CHROME_PATH to a Chrome or Chromium binary.'); process.exit(2); }
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const svc = await createApp({ demo: true });
const server = await new Promise((r) => { const s = svc.app.listen(0, '127.0.0.1', () => r(s)); });
await svc.start();
const BASE = 'http://127.0.0.1:' + server.address().port;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const shot = (page, name) => (SHOTS ? page.screenshot({ path: SHOTS + '/' + name + '.png' }) : null);

// Stand-in for the exchange's live stream, speaking the same subscribe protocol.
function mockExchange(port) {
  const wss = new WebSocketServer({ port });
  wss.on('connection', (ws) => {
    const subs = new Map();
    ws.on('message', (raw) => {
      const m = JSON.parse(raw);
      if (m.method === 'ping') return ws.send(JSON.stringify({ channel: 'pong' }));
      const key = JSON.stringify(m.subscription);
      if (m.method === 'unsubscribe') { clearInterval(subs.get(key)); subs.delete(key); return; }
      if (m.method !== 'subscribe') return;
      const s = m.subscription;
      const px = s.coin === 'ETH' ? 2222.22 : 91234.5;
      const tick = () => {
        if (s.type === 'candle') { const step = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 }[s.interval]; const t = Math.floor(Date.now() / step) * step; ws.send(JSON.stringify({ channel: 'candle', data: { t, T: t + step - 1, s: s.coin, i: s.interval, o: String(px - 50), c: String(px), h: String(px + 20), l: String(px - 80), v: '12.5', n: 9 } })); }
        if (s.type === 'l2Book') ws.send(JSON.stringify({ channel: 'l2Book', data: { coin: s.coin, time: Date.now(), levels: [[{ px: String(px - 0.5), sz: '1.5', n: 2 }, { px: String(px - 1.5), sz: '2.5', n: 2 }], [{ px: String(px + 0.5), sz: '1.25', n: 1 }, { px: String(px + 1.5), sz: '3', n: 4 }]] } }));
        if (s.type === 'trades') ws.send(JSON.stringify({ channel: 'trades', data: [{ coin: s.coin, side: 'B', px: String(px), sz: '0.5', time: Date.now(), tid: Date.now() }] }));
        if (s.type === 'activeAssetCtx') ws.send(JSON.stringify({ channel: 'activeAssetCtx', data: { coin: s.coin, ctx: { markPx: String(px), oraclePx: String(px - 1), prevDayPx: String(px / 1.1), funding: '0.0000125', openInterest: '1000', dayNtlVlm: '5000000' } } }));
      };
      tick();
      subs.set(key, setInterval(tick, 400));
    });
    ws.on('close', () => subs.forEach(clearInterval));
  });
  return wss;
}

const b = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const errs = [];
const mk = async (opts = {}) => {
  const p = await b.newPage();
  p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
  p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|429|net::ERR_FAILED|ERR_CONNECTION_REFUSED/.test(m.text())) errs.push('console ' + m.text()); });
  await p.setViewport({ width: 1440, height: 900 });
  if (opts.init) await p.evaluateOnNewDocument(opts.init);
  return p;
};

// ----- news -----
const p = await mk();
await p.goto(BASE + '/#news', { waitUntil: 'domcontentloaded' });
await p.waitForSelector('#feed .itemMain');
check('demo ribbon shown', await p.$eval('#demoRibbon', (n) => !n.hidden));
const rows = await p.$$eval('#feed .item', (n) => n.length);
check('feed renders stories', rows >= 8, rows + ' rows');
check('same story from two outlets is one row', await p.$$eval('#feed .item', (n) => n.filter((x) => x.textContent.includes('Acme Motors')).length === 1 && n.some((x) => /\+\d+ more source/.test(x.textContent))));
check('top stories listed', (await p.$$('#topList .topItem')).length >= 3);
await p.evaluate(() => [...document.querySelectorAll('#feed .item')].find((n) => n.textContent.includes('Acme Motors')).querySelector('.itemMain').click());
await p.waitForSelector('#detail:not([hidden])');
check('detail lists the other outlet', await p.$eval('#dAlso', (n) => !n.hidden && /Demo (Tech|Business)/.test(n.textContent)));
check('top stories hidden while a story is open', await p.$eval('#top', (n) => n.hidden));
await p.keyboard.press('Escape');
check('Esc returns to top stories', await p.$eval('#top', (n) => !n.hidden));
await p.evaluate(() => [...document.querySelectorAll('#feed .item')].filter((n) => n.textContent.includes('$OTTER')).pop().querySelector('.itemMain').click());
await p.waitForSelector('.tok');
const toks = await p.$$eval('.tok', (n) => n.map((x) => x.innerText.replace(/\n+/g, ' | ')));
check('token matches: real one first, copies flagged', toks.length === 3 && /Trading before this story/.test(toks[0]) && /Started trading .* after this story/.test(toks[1]), toks[1]);
await p.click('.kind.k-business');
check('topic filter', await p.$eval('#feedTitle', (n) => n.textContent) === 'Business' && await p.$$eval('#feed .item', (n) => n.length > 0 && n.every((x) => x.classList.contains('k-business') || x.textContent.includes('more source'))));
await p.click('.kind.k-all');
await p.type('#q', 'walrus');
check('search', await p.$$eval('#feed .item', (n) => n.length >= 1 && n.every((x) => /walrus/i.test(x.textContent))));
await p.$eval('#q', (n) => { n.value = ''; n.dispatchEvent(new Event('input')); });
const src = await p.$eval('#srcSel', (n) => n.options[1].value);
await p.select('#srcSel', src);
check('source filter', await p.$$eval('#feed .item', (n, s) => n.length > 0 && n.every((x) => x.textContent.includes(s) || x.textContent.includes('more source')), src), src);
await p.select('#srcSel', '');
await p.click('#onlyBreaking');
check('breaking-only filter', await p.$$eval('#feed .item', (n) => n.length > 0) && await p.$eval('#onlyBreaking', (n) => n.getAttribute('aria-pressed') === 'true'));
await p.click('#onlyBreaking');
await p.click('#feed .item .star');
await p.click('#onlySaved');
check('saved view', await p.$$eval('#feed .item', (n) => n.length === 1) && await p.$eval('#feedTitle', (n) => n.textContent) === 'Saved stories');
await p.click('#onlySaved');
await p.click('#density');
check('compact density', await p.evaluate(() => document.body.classList.contains('compact')));
await p.click('#density');
await p.evaluate(() => document.activeElement.blur());
await p.keyboard.press('j'); await p.keyboard.press('j');
check('keyboard moves selection', await p.$$eval('#feed .item.on', (n) => n.length === 1));
await shot(p, 'news');
// queued new stories while scrolled down
await p.keyboard.press('Escape');
await p.evaluate(() => { document.querySelector('#feed').style.minHeight = '3000px'; window.scrollTo(0, 1200); });
await p.waitForFunction(() => !document.getElementById('newPill').hidden, { timeout: 20000 });
const before = await p.evaluate(() => window.scrollY);
check('new stories wait behind a button while scrolled', before > 800, await p.$eval('#newPill', (n) => n.textContent));
await p.click('#newPill');
await sleep(900);
check('button brings the new stories in', await p.evaluate(() => window.scrollY < 50 && document.getElementById('newPill').hidden));
// shared link
const id = await p.$eval('#feed .item', (n) => n.dataset.id);
const p2 = await mk();
await p2.bringToFront();
await p2.goto(BASE + '/#n-' + id, { waitUntil: 'domcontentloaded' });
await p2.waitForSelector('#detail:not([hidden])');
check('shared link opens that story', await p2.$eval('#feed .item.on', (n, i) => n.dataset.id === i, id));

// ----- breaking + chat across two tabs -----
const RUN = Date.now().toString(36);
const said = (page, text) => page.waitForFunction((t) => [...document.querySelectorAll('.msg .say')].some((n) => n.textContent === t), { timeout: 8000 }, text);
await p2.goto(BASE + '/#breaking'); await p2.waitForSelector('.room');
await p.bringToFront();
await p.goto(BASE + '/#breaking'); await p.waitForSelector('.room');
await p.type('#msg', 'hello ' + RUN); await p.keyboard.press('Enter');
await said(p, 'hello ' + RUN);
const once = await p.$$eval('.msg .say', (n, t) => n.filter((x) => x.textContent === t).length, 'hello ' + RUN);
check('chat message appears once for sender', once === 1, 'count ' + once);
await p2.bringToFront();
await said(p2, 'hello ' + RUN);
check('chat reaches another browser tab', true);
await p2.type('#msg', 'reply ' + RUN); await p2.keyboard.press('Enter');
await said(p2, 'reply ' + RUN);
await p.bringToFront();
await said(p, 'reply ' + RUN);
check('a tab catches up on chat when it comes back to the front', true);
const gone = await b.newPage(); await gone.bringToFront(); await gone.goto(BASE + '/#n-doesnotexist', { waitUntil: 'domcontentloaded' });
await gone.waitForFunction(() => !document.getElementById('notice').hidden, { timeout: 8000 });
check('a dead shared link says so and still shows the feed', (await gone.$$('#feed .item')).length > 0);
await gone.close(); await p2.bringToFront();
await p2.evaluate(() => document.querySelector('.room:nth-child(2)').click());
await p2.waitForFunction(() => !document.getElementById('roomTokens').hidden);
await p2.evaluate(() => document.getElementById('roomTokens').click());
await p2.waitForSelector('#detail:not([hidden])');
check('breaking item opens its tokens on the news page', await p2.evaluate(() => location.hash === '#news' && !!document.querySelector('#feed .item.on')));

await p2.close();
await p.bringToFront();
// ----- radar, markets (demo) -----
await p.goto(BASE + '/#radar'); await p.waitForSelector('.coin');
check('radar renders', (await p.$$('.coin')).length === 6 && (await p.$$('#heat tr')).length === 7);
await p.goto(BASE + '/#markets'); await p.waitForSelector('#book .bookRow.bid'); await p.waitForSelector('#mChart canvas');
await sleep(600);
check('markets demo note says prices are invented', /invented/.test(await p.$eval('#mLiveText', (n) => n.textContent)));

// ----- markets with a live stream -----
let wss = mockExchange(3999);
const m = await mk({ init: () => { window.HALFTONE_HL_WS = 'ws://127.0.0.1:3999'; } });
await m.setBypassCSP(true);
await m.bringToFront();
await m.goto(BASE + '/#markets', { waitUntil: 'domcontentloaded' });
await m.waitForFunction(() => /Streaming live/.test(document.getElementById('mLiveText').textContent), { timeout: 8000 });
await m.waitForFunction(() => /91,234\.5/.test(document.getElementById('mStats').textContent), { timeout: 5000 });
check('stream drives mark price', true, await m.$eval('.stat b', (n) => n.textContent));
check('stream drives order book', /91,235/.test(await m.$eval('#book', (n) => n.textContent)) && (await m.$$('#book .bookRow.bid')).length === 2);
check('stream drives trades tape', await m.$$eval('#mTrades .tapeRow', (n) => n.length >= 1 && /91,234\.5/.test(n[0].textContent)));
check('funding from stream', /\+0\.0013%/.test(await m.$eval('#mStats', (n) => n.textContent)));
await m.evaluate(() => [...document.querySelectorAll('#mCoins .kind')].find((n) => n.textContent.includes('ETH')).click());
await m.waitForFunction(() => /2,222\.22/.test(document.getElementById('mStats').textContent), { timeout: 5000 });
await sleep(1200);
check('switching market re-subscribes and stays on the stream', /2,222/.test(await m.$eval('#book', (n) => n.textContent)) && await m.$$eval('#mTrades .tapeRow', (n) => n.length >= 1 && n.every((x) => /2,222\.22/.test(x.textContent))));
await shot(m, 'markets-live');
for (const c of wss.clients) c.terminate();
await new Promise((r) => wss.close(r));
await m.waitForFunction(() => /unavailable/.test(document.getElementById('mLiveText').textContent), { timeout: 8000 });
check('stream loss falls back to polling', true);
wss = mockExchange(3999);
await m.waitForFunction(() => /Streaming live/.test(document.getElementById('mLiveText').textContent), { timeout: 40000 });
check('stream reconnects on its own', true);
for (const c of wss.clients) c.terminate();
wss.close();

await m.close();
await p.bringToFront();
// ----- keyboard focus survives a live update -----
await p.goto(BASE + '/#news'); await p.waitForSelector('#feed .itemMain');
await p.evaluate(() => document.querySelectorAll('#feed .itemMain')[2].focus());
const focused = await p.evaluate(() => document.activeElement.dataset.fk);
const rowsBefore = await p.$eval('#count', (n) => n.textContent);
await p.waitForFunction((c) => document.getElementById('count').textContent !== c, { timeout: 20000 }, rowsBefore);
check('keyboard focus stays on the same story when a new one arrives', await p.evaluate((k) => document.activeElement.dataset.fk === k, focused), focused);

// ----- a failed first load recovers by itself -----
const flaky = await b.newPage(); await flaky.bringToFront();
await flaky.setRequestInterception(true);
let failedOnce = false;
flaky.on('request', (r) => { if (!failedOnce && r.url().endsWith('/api/feed')) { failedOnce = true; r.respond({ status: 502, contentType: 'application/json', body: '{"error":"x"}' }); } else r.continue(); });
await flaky.goto(BASE + '/#news', { waitUntil: 'domcontentloaded' });
await flaky.waitForSelector('#feed .itemMain', { timeout: 15000 });
check('a failed first load is retried until the feed appears', failedOnce && (await flaky.$$('#feed .item')).length > 5);
await flaky.close();

// ----- a server at its connection limit: the page polls instead, chat included -----
const fullSvc = await createApp({ demo: true, sseMax: 0 });
const fullServer = await new Promise((r) => { const s2 = fullSvc.app.listen(0, '127.0.0.1', () => r(s2)); });
await fullSvc.start();
const FULL = 'http://127.0.0.1:' + fullServer.address().port;
const q = await b.newPage(); await q.bringToFront();
await q.goto(FULL + '/#news', { waitUntil: 'domcontentloaded' });
await q.waitForSelector('#feed .itemMain');
await q.waitForFunction(() => /polling/.test(document.getElementById('liveText').textContent), { timeout: 8000 });
const countThen = await q.$eval('#count', (n) => n.textContent);
await q.waitForFunction((c) => document.getElementById('count').textContent !== c, { timeout: 25000 }, countThen);
check('refused a live connection, the page polls and still gets new stories', await q.$eval('#offline', (n) => n.hidden));
await q.evaluate(() => { location.hash = '#breaking'; });
await q.waitForSelector('.room');
await fetch(FULL + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'general', name: 'other', text: 'from someone else ' + RUN }) });
await said(q, 'from someone else ' + RUN);
check('chat still arrives when its live connection is refused', true);
await q.close(); await fullSvc.stop(); fullServer.close();
await p.bringToFront();

// ----- home + phones -----
await p.goto(BASE + '/#home'); await p.waitForSelector('.clip');
check('home collage', (await p.$$('.clip')).length === 14);
await sleep(500); await shot(p, 'home3');
await p.setViewport({ width: 390, height: 844 });
for (const v of ['home', 'news', 'breaking', 'radar', 'markets']) {
  await p.goto(BASE + '/#' + v); await sleep(700);
  check('phone ' + v + ' has no sideways scroll', !(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)));
  if (v === 'news') await shot(p, 'phone-news');
}
check('no script errors or blocked resources', errs.length === 0, errs.slice(0, 4).join(' || '));
log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
await b.close();
await svc.stop();
server.close();
process.exit(fails ? 1 : 0);
