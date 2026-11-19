// Browser test for the Stocks, Calendar and Private pages. Starts its own demo server on a
// free port and drives headless Chrome. A few answers are swapped for small hand-made ones
// (by intercepting the request) where a check needs exact numbers, a failure or hostile text.
//   CHROME_PATH=/path/to/chrome node test/e2e/tradfi.mjs      (SHOTS=dir saves screenshots)
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { createApp } from '../../src/server.js';

const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!CHROME) { console.error('Set CHROME_PATH to a Chrome or Chromium binary.'); process.exit(2); }
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const svc = await createApp({ demo: true });
// Port 0: the system picks a free one, so this never collides with run.mjs or a running server.
const server = await new Promise((r) => { const s = svc.app.listen(0, '127.0.0.1', () => r(s)); });
await svc.start();
const BASE = 'http://127.0.0.1:' + server.address().port;
const API = BASE + '/api/tradfi/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const get = async (path) => (await fetch(API + path)).json();

const b = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const errs = [];
const stubs = new Map();   // endpoint name -> (url) => { status, body, delay } or null to let it through
const seen = [];           // every /api/tradfi request the page made, in order
const p = await b.newPage();
p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
p.on('console', (m) => {
  // The 400s and 502s are the ones this test asks for (unknown symbols, a failing source).
  if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|net::ERR_FAILED|ERR_CONNECTION_REFUSED|status of (400|429|502)/.test(m.text())) errs.push('console ' + m.text());
});
p.on('dialog', (d) => { errs.push('dialog opened: ' + d.message()); d.dismiss(); });
await p.setViewport({ width: 1440, height: 900 });
await p.setRequestInterception(true);
p.on('request', (req) => {
  const u = new URL(req.url());
  if (u.pathname.startsWith('/api/tradfi/')) {
    const name = u.pathname.slice('/api/tradfi/'.length);
    seen.push(name + u.search);
    const r = stubs.has(name) ? stubs.get(name)(u) : null;
    if (r) {
      const send = () => req.respond({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) }).catch(() => {});
      return r.delay ? setTimeout(send, r.delay) : send();
    }
  }
  req.continue().catch(() => {});
});
const shot = async (name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name + '.png', fullPage: true }); };
const open = async (hash) => { await p.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' }); await p.evaluate((h) => { location.hash = h; }, hash); };
const hash = () => p.evaluate(() => location.hash);
const text = (sel) => p.$eval(sel, (n) => n.textContent).catch(() => '');
const waitText = (sel, re, timeout = 6000) => p.waitForFunction((s, src) => { const n = document.querySelector(s); return n && new RegExp(src).test(n.textContent); }, { timeout }, sel, re.source).then(() => true, () => false);
const DEMO = [{ name: 'Demo data', state: 'ok', note: 'Invented for the demo.' }];
const wrap = (body) => ({ body: { demo: true, at: Date.now(), sources: DEMO, ...body } });

// Real demo answers, used to pick symbols and to check the page against.
const overview = await get('overview');
const gainer = overview.movers.gainers[0];
const found = (await get('search?q=a')).results;
const co = found[0];                       // a company to open
const co2 = found[1];
const company = await get('company?symbol=' + co.symbol);

// ----- stocks overview -----
await open('#stocks');
await p.waitForSelector('.tfIndex');
check('indexes render with price, change and a sparkline', await p.$$eval('.tfIndex', (n, want) => n.length === want && n.every((x) => x.querySelector('svg.tfSpark polyline') && /[▲▼]|0\.00%/.test(x.textContent)), overview.indexes.length));
check('sector heat row', await p.$$eval('.tfHeatCell', (n, want) => n.length === want && n.every((x) => /%/.test(x.textContent)), overview.sectors.length));
check('three movers tables', await p.$$eval('#tfMov table', (n) => n.length === 3 && n.every((t) => t.querySelectorAll('tbody tr').length > 0 && t.querySelectorAll('th[scope=col]').length === 4)));
check('yield curve is drawn, described and tabled', await p.$eval('#tfCurve', (n) => n.getAttribute('role') === 'img' && /Treasury yields/.test(n.getAttribute('aria-label')) && n.querySelectorAll('circle').length >= 5) && await p.$$eval('.tfYields td', (n) => n.length >= 5));
const two = overview.yields.points.find((x) => x.tenor === '2Y').value, ten = overview.yields.points.find((x) => x.tenor === '10Y').value;
const spread = await text('.tfSpread');
check('2-year/10-year spread stated in words', spread.includes(Math.abs(ten - two).toFixed(2) + ' percentage points ' + (ten > two ? 'above' : 'below') + ' the 2-year'), spread);
check('macro tiles show period and previous value', await p.$$eval('#tfMac .tfTile', (n, want) => n.length === want && n.every((x) => /Period: /.test(x.textContent) && /Previous: /.test(x.textContent)), overview.macro.length));
check('every block names its source and age, and labels demo figures as invented', await p.$$eval('#tfOverview .tfNote', (n) => n.length >= 6 && n.filter((x) => /Source: Demo data/.test(x.textContent) && /updated/.test(x.textContent) && /Demo: invented figures/.test(x.textContent)).length >= 6));
check('watchlist starts empty with an explanation', /Your watchlist is empty/.test(await text('#tfWat')));
// market map
const tiles = await p.$$eval('#tfMapBox .tfMapTile', (n) => n.map((x) => ({ tag: x.tagName, sym: x.dataset.symbol, label: x.getAttribute('aria-label'), text: x.textContent, r: x.getBoundingClientRect().toJSON() })));
const box = await p.$eval('#tfMapBox', (n) => n.getBoundingClientRect().toJSON());
const moverSyms = new Set([...overview.movers.gainers, ...overview.movers.losers, ...overview.movers.active].map((m) => m.symbol));
check('market map: one real button per mover, labelled with symbol and change', tiles.length === moverSyms.size && tiles.every((t) => t.tag === 'BUTTON' && moverSyms.has(t.sym) && t.text.includes(t.sym) && /%/.test(t.text) && /Open the company page/.test(t.label)), tiles.length + ' tiles');
const area = tiles.reduce((s, t) => s + t.r.width * t.r.height, 0);
const overlap = tiles.some((a, i) => tiles.some((c, j) => j > i && Math.min(a.r.right, c.r.right) - Math.max(a.r.left, c.r.left) > 1 && Math.min(a.r.bottom, c.r.bottom) - Math.max(a.r.top, c.r.top) > 1));
check('market map tiles fill the box without overlapping', Math.abs(area - box.width * box.height) / (box.width * box.height) < 0.01 && !overlap, (area / (box.width * box.height)).toFixed(3));
// Area follows the square root of value traded: check the two largest tiles against the data.
const traded = (s) => { const m = [...overview.movers.gainers, ...overview.movers.losers, ...overview.movers.active].find((x) => x.symbol === s); return m.price * m.volume; };
const big = tiles.slice().sort((a, c) => c.r.width * c.r.height - a.r.width * a.r.height);
const ratio = (big[0].r.width * big[0].r.height) / (big[1].r.width * big[1].r.height), want = Math.sqrt(traded(big[0].sym) / traded(big[1].sym));
check('market map tile area follows the stated scale', Math.abs(ratio - want) / want < 0.03, ratio.toFixed(3) + ' vs ' + want.toFixed(3));
check('market map has a legend for the shading', await p.$$eval('.tfMapSw', (n) => n.length === 7) && /square-root scale/.test(await text('.tfMapLegend')));
await shot('stocks-1440');
await p.click('#tfMapBox .tfMapTile');
check('a map tile opens its company', (await hash()) === '#stocks/' + tiles[0].sym, await hash());
await p.evaluate(() => { location.hash = '#stocks'; });

// sorting a movers table
await p.waitForSelector('#tfMov [data-fk="mv-gainers-price"]');
await p.focus('#tfMov [data-fk="mv-gainers-price"]');
await p.keyboard.press('Enter');
const sorted = await p.$$eval('#tfMov table', (n) => [...n[0].querySelectorAll('tbody tr')].map((r) => Number(r.children[1].textContent.replace(/,/g, ''))));
check('movers sort by price, highest first', sorted.length > 1 && sorted.every((v, i) => i === 0 || sorted[i - 1] >= v), sorted.join(' '));
check('sorting keeps keyboard focus on the column button', await p.evaluate(() => document.activeElement && document.activeElement.dataset.fk === 'mv-gainers-price' && document.activeElement.closest('th').getAttribute('aria-sort') === 'descending'));

// ----- search with the keyboard -----
const word = co.name.split(' ')[0];
await p.focus('#tfQ');
await p.keyboard.type(word.toLowerCase());
await p.waitForSelector('#tfQL [role=option]');
check('search finds a company by name', await p.$$eval('#tfQL [role=option]', (n, s) => n.some((x) => x.textContent.includes(s)), co.symbol) && await p.$eval('#tfQ', (n) => n.getAttribute('aria-expanded') === 'true' && n.getAttribute('role') === 'combobox'));
check('search results in demo mode are labelled as invented', /invented/.test(await text('#tfQL')));
await p.keyboard.press('Escape');
check('Escape closes the results', await p.$eval('#tfQL', (n) => n.hidden));
await p.$eval('#tfQ', (n) => { n.value = ''; n.dispatchEvent(new Event('input')); });
await p.focus('#tfQ');
await p.keyboard.type('a');
await p.waitForFunction(() => document.querySelectorAll('#tfQL [role=option]').length >= 2);
await p.keyboard.press('ArrowDown');
const second = await p.$eval('#tfQ', (n) => { const li = document.getElementById(n.getAttribute('aria-activedescendant')); return li && li.getAttribute('aria-selected') === 'true' ? li.querySelector('b').textContent : ''; });
await p.keyboard.press('Enter');
check('arrow keys and Enter open the chosen result', second === found[1].symbol && (await hash()) === '#stocks/' + second, second + ' ' + (await hash()));
await p.evaluate(() => { location.hash = '#stocks'; });
await p.focus('#tfQ');
await p.keyboard.type(co.symbol.toLowerCase());
await p.keyboard.press('Enter'); // straight away, before the list has appeared
await p.waitForFunction((h) => location.hash === h, { timeout: 5000 }, '#stocks/' + co.symbol).catch(() => {});
check('a typed ticker and Enter opens the company', (await hash()) === '#stocks/' + co.symbol, await hash());

// ----- a movers row opens the company -----
await p.evaluate(() => { location.hash = '#stocks'; });
await p.waitForSelector('#tfMov tbody tr');
const rowSym = await p.$eval('#tfMov tbody tr', (r) => r.querySelector('a b').textContent);
check('a movers row holds a real link for keyboards', await p.$eval('#tfMov tbody tr th[scope=row] a', (a, s) => a.getAttribute('href') === '#stocks/' + s, rowSym) && Boolean(gainer));
await p.click('#tfMov tbody tr td:nth-child(2)');
check('clicking a movers row opens the company', (await hash()) === '#stocks/' + rowSym, await hash());

// ----- company page by deep link -----
await p.goto(BASE + '/#stocks/' + co.symbol, { waitUntil: 'domcontentloaded' });
await p.reload({ waitUntil: 'domcontentloaded' });
await waitText('#view-stocks h1', new RegExp(co.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
check('deep link opens the company', (await text('#view-stocks h1')) === co.name && (await text('#view-stocks .tfHeadNote')).includes(co.symbol) && (await text('#view-stocks .tfHeadNote')).includes(company.exchange));
await p.waitForSelector('#tfChart canvas');
await waitText('#tfChartSum', /daily candles/);
check('price chart canvas present with a description and attribution', await p.$eval('#tfChart', (n) => n.getAttribute('role') === 'img' && /Candlestick price chart/.test(n.getAttribute('aria-label'))) && await p.$eval('#tfChartC a[href="https://www.tradingview.com/"]', (a) => a.rel === 'noopener noreferrer' && /TradingView Lightweight Charts/.test(a.textContent)));
check('one chart instance', await p.$$eval('#tfChart .tv-lightweight-charts', (n) => n.length === 1));
await waitText('#tfQuote', /Day range/);
check('price block shows price, change and day range', /Day range/.test(await text('#tfQuote')) && /Previous close/.test(await text('#tfQuote')) && /[▲▼]|0\.00%/.test(await text('#tfQuote .tfPriceBox')));
check('key facts with computed values marked', await p.$$eval('#tfFacts .tfTile', (n) => n.length >= 4) && (!company.facts.some((f) => /computed/i.test(f.label)) || /†/.test(await text('#tfFacts'))));
check('filings listed', await p.$$eval('.tfFiling', (n) => n.length > 0));
await shot('company-1440');
// range switch
let before = seen.length;
await p.click('[data-fk="rg-6m"]');
await waitText('#tfChartSum', /last 6 months/);
check('range switch reloads the chart', seen.slice(before).some((u) => u.startsWith('candles') && /range=6m/.test(u)) && await p.$eval('[data-fk="rg-6m"]', (n) => n.getAttribute('aria-pressed') === 'true'));
await p.click('[data-fk="rg-max"]');
await waitText('#tfChartSum', /longest history available/);
check('Max range asks the server for it and says how far back the history goes', seen.slice(before).some((u) => /^candles.*range=max/.test(u)) && !seen.slice(before).some((u) => /^candles.*range=5y/.test(u)) && /This is all the history the source holds: it starts on 5 Jan 2015\./.test(await text('#tfChartSum')), (await text('#tfChartSum')).slice(-140));

// candle sizes, exact numbers on a small daily series (two weeks and a month boundary)
const T = (s) => Date.parse(s + 'T00:00:00Z') / 1000;
const SMALL = [
  ['2026-01-29', 10, 12, 9, 11, 100], ['2026-01-30', 11, 15, 10, 14, 200],        // Thu, Fri
  ['2026-02-02', 14, 16, 13, 15, 300], ['2026-02-03', 15, 18, 14, 17, 400], ['2026-02-04', 17, 17.5, 12, 13, 500], // Mon to Wed
  ['2026-02-09', 13, 20, 12.5, 19, 600]                                           // the Monday after
].map(([d, open, high, low, close, volume]) => ({ time: T(d), open, high, low, close, volume }));
stubs.set('candles', () => wrap({ symbol: co.symbol, candles: SMALL, delayed: true }));
await p.click('[data-fk="rg-1m"]');
await waitText('#tfChartSum', /: 6 daily candles/);
check('a delayed price history says so', /Prices are delayed/.test(await text('#tfChartSum')) && /Delayed/.test(await text('#tfChartC .tfNote')), (await text('#tfChartC .tfNote')) + ' // ' + (await text('#tfChartSum')));
await p.$eval('#tfChartData summary', (n) => n.click());
await p.waitForSelector('#tfCandles tbody tr');
const rows = () => p.$$eval('#tfCandles tbody tr', (n) => n.map((r) => [...r.children].map((c) => c.textContent).join('|')));
check('daily candles listed as numbers', (await rows()).join(' / ') === ['9 Feb 2026|13.00|20.00|12.50|19.00|600', '4 Feb 2026|17.00|17.50|12.00|13.00|500', '3 Feb 2026|15.00|18.00|14.00|17.00|400', '2 Feb 2026|14.00|16.00|13.00|15.00|300', '30 Jan 2026|11.00|15.00|10.00|14.00|200', '29 Jan 2026|10.00|12.00|9.00|11.00|100'].join(' / '), (await rows())[0]);
await p.click('[data-fk="cs-w"]');
await waitText('#tfChartSum', /: 3 weekly candles built from 6 daily ones/);
check('weekly candles: weeks start on Monday (UTC); open first, close last, extremes, volume summed', (await rows()).join(' / ') === ['9 Feb 2026|13.00|20.00|12.50|19.00|600', '2 Feb 2026|14.00|18.00|12.00|13.00|1,200', '26 Jan 2026|10.00|15.00|9.00|14.00|300'].join(' / '), (await rows()).join(' / '));
check('weekly summary states close, high and low of what is shown', /Latest close 19\.00/.test(await text('#tfChartSum')) && /high 20\.00, low 9\.00/.test(await text('#tfChartSum')) && /change over the range ▲ \+35\.71%/.test(await text('#tfChartSum')), await text('#tfChartSum'));
await p.click('[data-fk="cs-m"]');
await waitText('#tfChartSum', /: 2 monthly candles built from 6 daily ones/);
check('monthly candles: calendar months', (await rows()).join(' / ') === ['Feb 2026|14.00|20.00|12.00|19.00|1,800', 'Jan 2026|10.00|15.00|9.00|14.00|300'].join(' / '), (await rows()).join(' / '));
check('candle-size switch keeps focus and shows its state', await p.evaluate(() => document.activeElement.dataset.fk === 'cs-m' && document.activeElement.getAttribute('aria-pressed') === 'true'));
check('moving averages say when there are too few candles', /EMA 50 of monthly closes: needs 50 candles/.test(await text('#tfChartSum')));
// EMA follows the candle size shown: 60 full weeks of weekdays, checked against values worked out here.
const LONG = [];
const day0 = T('2025-01-06'); // a Monday
for (let i = 0, d = 0; LONG.length < 300; d++) {
  const t = day0 + d * 86400, wd = new Date(t * 1000).getUTCDay();
  if (wd === 0 || wd === 6) continue;
  const close = 100 + i * 0.5 + (i % 7);
  LONG.push({ time: t, open: close - 1, high: close + 2, low: close - 2, close, volume: 1000 + i });
  i++;
}
const ema = (v, n) => { let e = v.slice(0, n).reduce((a, c) => a + c, 0) / n; const k = 2 / (n + 1); for (let i = n; i < v.length; i++) e = v[i] * k + e * (1 - k); return e; };
const weeklyCloses = LONG.filter((c, i) => i % 5 === 4).map((c) => c.close);
const two2 = (n) => n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
stubs.set('candles', () => wrap({ symbol: co.symbol, candles: LONG, delayed: false }));
await p.click('[data-fk="rg-5y"]');
await p.click('[data-fk="cs-w"]');
await waitText('#tfChartSum', /: 60 weekly candles built from 300 daily ones/);
check('EMA 50 is computed on the weekly candles shown', (await text('#tfChartSum')).includes('EMA 50 of weekly closes: ' + two2(ema(weeklyCloses, 50)) + '.') && /EMA 200: needs 200 candles/.test(await text('#tfChartSum')), 'expected ' + two2(ema(weeklyCloses, 50)));
await p.click('[data-fk="cs-d"]');
await waitText('#tfChartSum', /: 300 daily candles/);
check('EMA 50 and 200 are computed on the daily candles shown', (await text('#tfChartSum')).includes('EMA 50 of daily closes: ' + two2(ema(LONG.map((c) => c.close), 50)) + '. EMA 200: ' + two2(ema(LONG.map((c) => c.close), 200)) + '.'));
stubs.delete('candles');

// ----- statements -----
check('statements: a real table with a caption stating the unit', await p.$eval('#tfStmtTable', (t) => /^Income statement, by fiscal year, newest first\. US dollars in (millions|billions|thousands)/.test(t.caption.textContent) && t.querySelectorAll('thead th[scope=col]').length >= 4 && t.querySelectorAll('tbody th[scope=row]').length >= 5));
check('periods are columns, newest first', await p.$$eval('#tfStmtTable thead th.mono', (n, want) => n.map((x) => x.querySelector('.tfPer').textContent).join() === want.join(), company.statements.annual.periods));
check('each row has a trend bar and the table a year-over-year column', await p.$$eval('#tfStmtTable tbody tr', (n) => n.filter((r) => r.querySelector('svg.tfTrend rect')).length >= 5) && /Change/.test(await text('#tfStmtTable thead')));
await p.click('[data-fk="tab-balance"]');
check('balance sheet tab', /^Balance sheet/.test(await text('#tfStmtTable caption')) && await p.evaluate(() => document.activeElement.dataset.fk === 'tab-balance'));
await p.click('[data-fk="tab-cashflow"]');
check('cash flow tab, with the computed row marked and footnoted', /^Cash flow statement/.test(await text('#tfStmtTable caption')) && await p.$$eval('#tfStmtTable .tfMark', (n) => n.length >= 1) && /† Worked out here from reported figures/.test(await text('#tfStmt')));
await p.click('[data-fk="per-quarterly"]');
check('quarterly switch', await p.$$eval('#tfStmtTable thead th.mono', (n, want) => n.map((x) => x.querySelector('.tfPer').textContent).join() === want.join(), company.statements.quarterly.periods) && /by fiscal quarter/.test(await text('#tfStmtTable caption')));
await p.click('[data-fk="per-annual"]');
await p.click('[data-fk="tab-income"]');
const parent = company.statements.annual.income.find((r) => r.children && r.children.length);
const kid = parent.children[0];
check('children start collapsed behind a disclosure button', await p.$eval('[data-fk="st-' + parent.key + '"]', (n) => n.tagName === 'BUTTON' && n.getAttribute('aria-expanded') === 'false' && n.getAttribute('aria-controls').length > 0) && await p.$eval('#tfr-' + kid.key, (n) => n.hidden));
await p.focus('[data-fk="st-' + parent.key + '"]');
await p.keyboard.press('Enter');
check('expanding a parent row reveals its children', await p.$eval('[data-fk="st-' + parent.key + '"]', (n) => n.getAttribute('aria-expanded') === 'true') && await p.$eval('#tfr-' + kid.key, (n) => !n.hidden && n.offsetHeight > 0));
// A refresh that brings changed figures: the open row, the focus and the page position survive.
await p.evaluate(() => window.scrollTo(0, document.getElementById('tfStmtTable').getBoundingClientRect().top + scrollY - 200));
const scrollBefore = await p.evaluate(() => scrollY);
const changedCo = JSON.parse(JSON.stringify(company));
changedCo.statements.annual.income[0].values[0] = 123456000000;
changedCo.at = Date.now();
stubs.set('company', () => ({ body: changedCo }));
before = seen.length;
await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await waitText('#tfStmtTable', /123\.46|123,456/);
check('a refresh redraws changed figures', /123\.46|123,456/.test(await text('#tfStmtTable')) && seen.slice(before).some((u) => u.startsWith('company')));
check('the expanded row survives the refresh', await p.$eval('[data-fk="st-' + parent.key + '"]', (n) => n.getAttribute('aria-expanded') === 'true') && await p.$eval('#tfr-' + kid.key, (n) => !n.hidden));
check('keyboard focus and scroll position survive the refresh', await p.evaluate((k) => document.activeElement.dataset.fk === 'st-' + k, parent.key) && Math.abs((await p.evaluate(() => scrollY)) - scrollBefore) < 4);
stubs.delete('company');
// unchanged answers do not rebuild a block
// The real figures come back (a change, so one rebuild); after that an identical answer rebuilds nothing.
await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await p.waitForFunction(() => !/123\.46|123,456/.test(document.getElementById('tfStmtTable').textContent));
await p.evaluate(() => { document.getElementById('tfStmtTable').dataset.mark = 'kept'; document.querySelector('.tfFilings').dataset.mark = 'kept'; });
before = seen.length;
await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
await p.waitForFunction((n) => window.__n !== n, {}, 0).catch(() => {});
await sleep(1000);
check('an identical refresh rebuilds nothing', seen.slice(before).some((u) => u.startsWith('company')) && await p.evaluate(() => document.getElementById('tfStmtTable').dataset.mark === 'kept' && document.querySelector('.tfFilings').dataset.mark === 'kept'));

// ----- number formatting, hostile text and link checks, on a hand-made company -----
const HOSTILE = '<img src=x onerror="window.__xss=1;alert(1)">';
const FAKE = {
  symbol: 'FMTCO', name: HOSTILE, cik: '0000000001', exchange: '<b>Board</b>', industry: '<script>window.__xss=2</script>', fiscalYearEnd: '12-31',
  facts: [{ label: '<i>Fact</i>', value: 1500000000, unit: 'USD', period: 'FY2025' }],
  statements: {
    annual: { periods: ['FY2025', 'FY2024', 'FY2023'], income: [
      { key: 'revenue', label: 'Revenue', unit: 'USD', values: [5000000000, 4000000000, null] },
      { key: 'netIncome', label: 'Net income', unit: 'USD', values: [-1234000000, -500000000, 250000000], derived: [true, false, false] },
      { key: 'eps', label: 'Earnings per share', unit: 'USD/share', values: [-1.5, 2.345, null] },
      { key: 'shares', label: 'Shares', unit: 'shares', values: [820000000, 800000000, 790000000] },
      { key: 'opex', label: 'Operating expenses', unit: 'USD', values: [900000000, 800000000, 700000000], children: [{ key: 'rd', label: '<u>R&D</u>', unit: 'USD', values: [400000000, null, 0] }] }
    ], balance: [], cashflow: [] },
    quarterly: { periods: [], income: [], balance: [], cashflow: [] }
  },
  filings: [
    { form: '10-K', filedAt: '2026-02-01', title: 'Good link', url: 'https://www.sec.gov/Archives/edgar/data/1/a.htm' },
    { form: '8-K', filedAt: '2026-01-20', title: 'Script link', url: 'javascript:alert(1)' },
    { form: '8-K', filedAt: '2026-01-10', title: 'Lookalike host', url: 'https://www.sec.gov.example.com/x' },
    { form: '<img src=x onerror=alert(2)>', filedAt: '2026-01-05', title: HOSTILE, url: 'http://www.sec.gov/plain-http' }
  ]
};
stubs.set('company', (u) => (u.searchParams.get('symbol') === 'FMTCO' ? wrap(FAKE) : null));
stubs.set('quote', (u) => (u.searchParams.get('symbols') === 'FMTCO' ? wrap({ quotes: [{ symbol: 'FMTCO', name: HOSTILE, price: 12.5, changePct: -2, previousClose: 12.76, open: 12.7, high: 12.9, low: 12.4, volume: 1000, marketCap: 1e9, asOf: Date.now(), delayed: true }] }) : null));
stubs.set('candles', (u) => (u.searchParams.get('symbol') === 'FMTCO' ? wrap({ symbol: 'FMTCO', candles: SMALL, delayed: true }) : null));
await p.evaluate(() => { location.hash = '#stocks/FMTCO'; });
await p.waitForSelector('#tfr-netIncome');
const cells = (key) => p.$eval('#tfr-' + key, (r) => [...r.querySelectorAll('td')].map((c) => c.textContent));
const ni = await cells('netIncome'), rev = await cells('revenue'), eps = await cells('eps'), sh = await cells('shares');
check('negatives are in parentheses, in the stated unit', ni[1].startsWith('(1,234)') && ni[3] === '(500)' && ni[4] === '250' && /US dollars in millions, except per-share figures; share counts in millions/.test(await text('#tfStmtTable caption')), ni.join(' | '));
check('null is an en dash', rev[4] === '–' && eps[4] === '–' && rev[1] === '5,000', rev.join(' | '));
check('per-share values to two decimals', eps[1] === '(1.50)' && eps[3] === '2.35' || eps[3] === '2.34', eps.join(' | '));
check('share counts in millions', sh[1] === '820.0', sh.join(' | '));
check('year-over-year column: a percentage, or n/m against a negative base', rev[2] === '▲ +25.0%' && ni[2] === 'n/m' && sh[2] === '▲ +2.5%', [rev[2], ni[2], sh[2]].join(' | '));
check('a derived figure carries a footnote mark', await p.$eval('#tfr-netIncome td:nth-child(3)', (n) => Boolean(n.querySelector('sup.tfMark'))) && /†/.test(await text('#tfStmt .tfFoot')));
check('a delayed price is labelled', /Delayed/.test(await text('#tfQuote .tfPriceBox')));
check('a hostile company name renders as text', (await text('#view-stocks h1')) === HOSTILE && await p.evaluate(() => !window.__xss && !document.querySelector('#view-stocks img, #view-stocks script, #view-stocks h1 *, #view-stocks u, #view-stocks i:not(.tfSw)')));
await p.click('[data-fk="st-opex"]');
check('hostile text in a child row label is text', (await p.$eval('#tfr-rd th', (n) => n.textContent)) === '<u>R&D</u>');
const links = await p.$$eval('.tfFiling', (n) => n.map((li) => { const a = li.querySelector('a'); return a ? [a.getAttribute('href'), a.target, a.rel].join(' ') : 'none'; }));
check('only https://www.sec.gov/ addresses become links, opened safely', links.join(' / ') === 'https://www.sec.gov/Archives/edgar/data/1/a.htm _blank noopener noreferrer / none / none / none', links.join(' / '));
stubs.delete('company'); stubs.delete('quote'); stubs.delete('candles');

// ----- quick switching: a slow answer for one company must not land on another -----
stubs.set('company', (u) => (u.searchParams.get('symbol') === co2.symbol ? { delay: 1200, ...wrap({ ...company, symbol: co2.symbol, name: 'Slow And Stale Corp.' }) } : null));
await p.evaluate((s) => { location.hash = '#stocks/' + s; }, co2.symbol);
await sleep(150);
await p.evaluate((s) => { location.hash = '#stocks/' + s; }, co.symbol);
await waitText('#view-stocks h1', new RegExp(co.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
await sleep(1500);
check('a late answer for the previous company is ignored', (await text('#view-stocks h1')) === co.name, await text('#view-stocks h1'));
stubs.delete('company');

// ----- unknown symbol -----
await p.evaluate(() => { location.hash = '#stocks/ZZZZQ'; });
await waitText('#tfCompany', /No listed company with the symbol/);
check('unknown symbol: a clear message and the search box', /No listed company with the symbol “ZZZZQ”/.test(await text('#tfCompany')) && await p.$eval('#tfQ', (n) => n.offsetWidth > 0) && await p.$eval('.tfCoMain', (n) => n.hidden));
await p.evaluate(() => { location.hash = '#stocks/' + encodeURIComponent('<b>!'); });
await waitText('#tfCompany', /No listed company/);
check('a malformed symbol in the address is shown as text and never requested', /“<b>!”/.test(await text('#tfCompany')) && !seen.some((u) => /%3Cb|<b>/i.test(u)));

// ----- watchlist -----
await p.evaluate((s) => { location.hash = '#stocks/' + s; }, co.symbol);
await p.waitForSelector('#tfWatchBtn');
await waitText('#tfWatchBtn', /Add to watchlist/);
await p.click('#tfWatchBtn');
check('add to watchlist from the company page', await p.$eval('#tfWatchBtn', (n) => n.getAttribute('aria-pressed') === 'true' && /In your watchlist/.test(n.textContent)) && await p.evaluate((s) => JSON.parse(localStorage.getItem('nt.watch')).join() === s, co.symbol));
await p.goto(BASE + '/#stocks', { waitUntil: 'domcontentloaded' });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.tfWatch tbody tr');
await waitText('.tfWatch', /\d\.\d\d/);
check('watchlist persists across a reload and shows a quote', await p.$$eval('.tfWatch tbody tr', (n, s) => n.length === 1 && n[0].textContent.includes(s) && /\d\.\d\d/.test(n[0].children[1].textContent) && /%/.test(n[0].children[2].textContent), co.symbol));
await p.focus('#tfWQ');
await p.keyboard.type(co2.symbol);
await p.keyboard.press('Enter');
await p.waitForFunction(() => document.querySelectorAll('.tfWatch tbody tr').length === 2, { timeout: 5000 }).catch(() => {});
check('add to watchlist from search', await p.$$eval('.tfWatch tbody tr', (n) => n.length === 2) && await p.evaluate((s) => JSON.parse(localStorage.getItem('nt.watch'))[1] === s, co2.symbol));
await p.click('.tfWatch [data-fk="wr-' + co.symbol + '"]');
check('remove from watchlist', await p.$$eval('.tfWatch tbody tr', (n, s) => n.length === 1 && n[0].textContent.includes(s), co2.symbol));
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.tfWatch tbody tr');
check('removal persists across a reload', await p.$$eval('.tfWatch tbody tr', (n, s) => n.length === 1 && n[0].textContent.includes(s), co2.symbol));
await p.evaluate(() => localStorage.setItem('nt.watch', JSON.stringify(['GOOD1', '<script>', 42, 'good1', null, 'x'.repeat(40)].concat(Array.from({ length: 40 }, (_, i) => 'S' + i)))));
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.tfWatch tbody tr');
check('a damaged saved watchlist is cleaned and capped at 30', await p.$$eval('.tfWatch tbody tr', (n) => n.length === 30 && n[0].textContent.includes('GOOD1') && !n.some((r) => /script/.test(r.textContent))) && /30 of 30/.test(await text('#tfWat .tfNote')));
check('more than 20 symbols are asked for in batches of at most 20', seen.filter((u) => u.startsWith('quote?')).every((u) => decodeURIComponent(u).split('=')[1].split(',').length <= 20));
await p.evaluate(() => localStorage.removeItem('nt.watch'));

// ----- a failing endpoint and a source that is off -----
stubs.set('overview', () => ({ status: 502, body: { error: 'A data source did not answer. Try again shortly.' } }));
await p.reload({ waitUntil: 'domcontentloaded' });
await waitText('#tfOverview', /could not be loaded/);
check('a 502 shows a plain message', /The market overview could not be loaded: the source behind it did not answer/.test(await text('#tfOverview [role=status]')));
stubs.set('overview', () => ({ body: { ...overview, at: Date.now(), indexes: [], yields: null, sources: [{ name: 'Index prices', state: 'off', note: 'No market data key is set' }, { name: 'US Treasury', state: 'error', note: 'Did not answer.' }, { name: 'Other data', state: 'ok', note: '' }] } }));
await p.reload({ waitUntil: 'domcontentloaded' });
await waitText('#tfIdx', /not connected/);
check('a source that is off shows a sentence, not an empty block', /Index prices are not connected on this server \(Index prices: No market data key is set\)\./.test(await text('#tfIdx')), await text('#tfIdx'));
check('a source in error says what could not be loaded', /Treasury yields could not be loaded from US Treasury: Did not answer\./.test(await text('#tfYld')), await text('#tfYld'));
check('the other blocks still render', await p.$$eval('#tfMov tbody tr', (n) => n.length > 0));
stubs.delete('overview');

// ----- nothing is fetched while the page is hidden -----
await p.evaluate(() => { location.hash = '#status'; });
await sleep(400);
before = seen.length;
await sleep(1500);
await p.evaluate(() => { location.hash = '#stocks'; });
await p.waitForSelector('.tfIndex');
check('leaving the page stops its requests; coming back restarts them', seen.slice(before).filter((u) => u.startsWith('overview')).length === 1 && seen.length > before);
const hiddenTab = await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); return true; });
before = seen.length;
await sleep(1200);
check('a background tab fetches nothing', hiddenTab && seen.length === before);
await p.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });

// ----- calendar -----
await p.emulateTimezone('America/New_York');
await p.goto(BASE + '/#calendar', { waitUntil: 'domcontentloaded' });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.tfEvent');
const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const calReq = () => seen.filter((u) => u.startsWith('calendar')).pop();
const firstReq = calReq();
const fromDay = new URLSearchParams(firstReq.split('?')[1]).get('from'), toDay = new URLSearchParams(firstReq.split('?')[1]).get('to');
check('agenda asks for the next 30 days', (Date.parse(toDay) - Date.parse(fromDay)) / 864e5 === 29, firstReq);
const cal = await get('calendar?from=' + fromDay + '&to=' + toDay);
check('agenda is grouped by day, in date order', await p.$$eval('.tfDay h3', (n) => n.length > 2 && n.map((h) => h.id).every((id, i, a) => i === 0 || a[i - 1] < id)));
check('every event is listed', (await p.$$('.tfEvent')).length === cal.events.length, (await p.$$('.tfEvent')).length + ' of ' + cal.events.length);
check('the time zone is named once', (await text('#tfCalRange')).includes('America/New York') && (await text('#tfAgenda')).indexOf('America') === -1, await text('#tfCalRange'));
const timed = cal.events.find((e) => e.time === '08:30');
const timeOf = (title, date) => p.evaluate((t, d) => { const li = [...document.querySelectorAll('#tfDay-' + d + ' ~ ul .tfEvent, .tfDay .tfEvent')].find((x) => x.closest('.tfDay').querySelector('h3').id === 'tfDay-' + d && x.textContent.includes(t)); return li ? li.querySelector('.tfTime').textContent : ''; }, title, date);
if (timed) check('a time in the source zone reads the same for a viewer in that zone', (await timeOf(timed.title, timed.date)) === '08:30', await timeOf(timed.title, timed.date));
check('today is marked when it has events', cal.events.some((e) => e.date === iso(new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' })))) ? await p.$$eval('.tfDay.today', (n) => n.length === 1 && /Today/.test(n[0].textContent)) : true);
check('importance has a marker and words for screen readers', await p.$$eval('.tfEvent', (n) => n.every((x) => /[●○]{3}/.test(x.querySelector('.tfImp').textContent) && /(Low|Medium|High) importance/.test(x.querySelector('.tfImpBox .sr').textContent))));
const earn = cal.events.find((e) => e.kind === 'earnings' && e.symbol);
if (earn) check('earnings rows link to the company page', await p.$$eval('.tfEvent[data-kind=earnings] a', (n, s) => n.some((a) => a.getAttribute('href') === '#stocks/' + s), earn.symbol));
const kinds = ['earnings', 'ipo', 'economic', 'central-bank'];
check('four filter chips, pressed, with counts', await p.$$eval('.tfChip', (n) => n.length === 4 && n.every((x) => x.getAttribute('aria-pressed') === 'true')) && await p.$eval('[data-fk="ck-earnings"] .n', (n, c) => n.textContent === String(c), cal.events.filter((e) => e.kind === 'earnings').length));
await p.click('[data-fk="ck-earnings"]');
check('switching a kind off hides its events', await p.$eval('[data-fk="ck-earnings"]', (n) => n.getAttribute('aria-pressed') === 'false') && (await p.$$('.tfEvent[data-kind=earnings]')).length === 0 && (await p.$$('.tfEvent')).length === cal.events.filter((e) => e.kind !== 'earnings').length);
check('the chip keeps focus', await p.evaluate(() => document.activeElement.dataset.fk === 'ck-earnings'));
for (const k of kinds.slice(1)) await p.click('[data-fk="ck-' + k + '"]');
check('all kinds off: an empty state says so', /Every kind of event is switched off/.test(await text('#tfAgenda')));
for (const k of kinds) await p.click('[data-fk="ck-' + k + '"]');
// an empty state per filter: a window that holds only one economic event
stubs.set('calendar', () => wrap({ timezone: 'America/New_York', events: [{ date: fromDay, time: '08:30', kind: 'economic', title: 'Only event <b>x</b>', symbol: null, detail: 'd', importance: 3, source: 'Test', url: 'https://www.bls.gov/schedule/' }, { date: fromDay, time: null, kind: 'mystery', title: 'Unknown kind', importance: 9 }] }));
await p.click('#tfCalNext');
await waitText('#tfAgenda', /Only event/);
check('paging forward asks for the following 30 days', new URLSearchParams(calReq().split('?')[1]).get('from') === iso(new Date(Date.parse(fromDay + 'T12:00:00') + 30 * 864e5)), calReq());
check('unknown kinds are dropped; hostile titles are text; official links are checked', (await p.$$('.tfEvent')).length === 1 && /Only event <b>x<\/b>/.test(await text('.tfEvTitle')) && await p.$eval('.tfEvMeta a', (a) => a.href === 'https://www.bls.gov/schedule/' && a.rel === 'noopener noreferrer'));
await p.click('[data-fk="ck-economic"]');
check('an empty state names the kinds that are on', /No earnings dates, IPO dates or central-bank dates between .* 1 other event is hidden by the filters above\./.test(await text('#tfAgenda')), await text('#tfAgenda'));
await p.click('[data-fk="ck-economic"]');
// the viewer's own zone: 08:30 in New York is 13:30 in London
await p.emulateTimezone('Europe/London');
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('.tfEvent');
check('times are shown in the viewer\'s zone', (await text('.tfEvent .tfTime')) === '13:30' && (await text('#tfCalRange')).includes('Europe/London'), await text('.tfEvent .tfTime'));
stubs.delete('calendar');
await p.click('#tfCalPrev');
await sleep(300);
check('paging back asks for the 30 days before', new URLSearchParams(calReq().split('?')[1]).get('to') === iso(new Date(Date.parse(new URLSearchParams(seen.filter((u) => u.startsWith('calendar')).slice(-2)[0].split('?')[1]).get('from') + 'T12:00:00') - 864e5)), calReq());
check('the Today button returns to the current window', await p.$eval('#tfCalToday', (n) => !n.disabled));
await p.click('#tfCalToday');
await p.waitForSelector('.tfEvent');
check('back on the next 30 days', /the next 30 days/.test(await text('#tfCalRange')) && await p.$eval('#tfCalToday', (n) => n.disabled));
const ipos = await get('ipos');
await p.waitForSelector('#tfIpoC tbody tr');
check('IPO table on the calendar', await p.$$eval('#tfIpoC tbody tr', (n, want) => n.length === want, ipos.pipeline.length) && await p.$$eval('#tfIpoC thead th', (n) => n.map((x) => x.textContent).join('|') === 'Company|Exchange|Status|Expected date|Price range|Filing'));
await shot('calendar-1440');

// ----- private -----
const priv = await get('private');
await p.goto(BASE + '/#private', { waitUntil: 'domcontentloaded' });
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('#tfRaises tbody tr');
check('the page says what the data is and is not', /disclosed to the SEC on Form D/.test(await text('.tfLede')) && /does not show valuations/.test(await text('.tfLede')) && /not a complete record/.test(await text('.tfLede')));
check('IPO pipeline table', await p.$$eval('#tfIpoP tbody tr', (n, want) => n.length === want, ipos.pipeline.length));
check('every raise is listed, newest filing first', await p.$$eval('#tfRaises tbody tr', (n, want) => n.length === want, priv.raises.length) && (await p.$eval('#tfRaises tbody th', (n) => n.textContent)) === priv.raises.slice().sort((a, c) => (a.filedAt < c.filedAt ? 1 : a.filedAt > c.filedAt ? -1 : 0))[0].issuer);
await p.click('[data-fk="pv-amountSold"]');
const topSold = priv.raises.slice().sort((a, c) => c.amountSold - a.amountSold)[0];
check('sort by amount sold, largest first', (await p.$eval('#tfRaises tbody th', (n) => n.textContent)) === topSold.issuer && await p.evaluate(() => document.activeElement.dataset.fk === 'pv-amountSold'));
await p.click('[data-fk="pv-issuer"]');
check('sort by issuer, A to Z', (await p.$eval('#tfRaises tbody th', (n) => n.textContent)) === priv.raises.map((r) => r.issuer).sort((a, c) => a.localeCompare(c))[0]);
const industries = [...new Set(priv.raises.map((r) => r.industry))].sort();
check('the industry filter is built from the data', await p.$$eval('#tfPvInd option', (n, want) => n.length === want.length + 1 && n.slice(1).every((o, i) => o.value === want[i]), industries));
const pickInd = industries.find((i) => priv.raises.filter((r) => r.industry === i).length >= 2) || industries[0];
await p.select('#tfPvInd', pickInd);
const inInd = priv.raises.filter((r) => r.industry === pickInd);
check('filter by industry', await p.$$eval('#tfRaises tbody tr', (n, ind, want) => n.length === want && n.every((r) => r.children[1].textContent === ind), pickInd, inInd.length) && (await text('#tfPvSum')).startsWith(inInd.length + ' of ' + priv.raises.length + ' filing'), await text('#tfPvSum'));
check('the total row counts what is shown', (await text('#tfRaises tfoot th')) === 'Total shown (' + inInd.length + ')');
await p.select('#tfPvInd', '');
await p.type('#tfPvQ', priv.raises[0].issuer.slice(0, 6).toLowerCase());
check('filter by issuer name', await p.$$eval('#tfRaises tbody tr', (n, q) => n.length >= 1 && n.every((r) => r.children[0].textContent.toLowerCase().includes(q)), priv.raises[0].issuer.slice(0, 6).toLowerCase()));
await shot('private-1440');
// exact totals, an indefinite offering, hostile text and link checks on three hand-made filings
stubs.set('private', () => wrap({ raises: [
  { issuer: HOSTILE, industry: 'Biotechnology', state: 'CA', filedAt: '2026-11-03', amountOffered: 1000000, amountSold: 500000, firstSale: '2026-10-30', form: 'D', url: 'https://www.sec.gov/Archives/edgar/data/2/d.xml' },
  { issuer: 'Beta Fund LP', industry: 'Pooled Investment Fund', state: 'NY', filedAt: '2026-11-02', amountOffered: null, amountSold: 2000000, firstSale: null, form: 'D', url: 'https://evil.example/https://www.sec.gov/' },
  { issuer: 'Gamma Bio Inc.', industry: 'Biotechnology', state: 'TX', filedAt: '2026-11-01', amountOffered: 2500000, amountSold: 700000, firstSale: '2026-10-20', form: 'D/A', url: null }
] }));
await p.reload({ waitUntil: 'domcontentloaded' });
await p.waitForSelector('#tfRaises tbody tr');
check('totals for what is shown', (await text('#tfPvSum')) === '3 filings shown: $3.5M offered, $3.2M sold (1 filing states no fixed amount offered and is left out of the offered total).' && (await p.$$eval('#tfRaises tfoot td', (n) => n.slice(0, 2).map((x) => x.textContent).join(' '))) === '$3.5M $3.2M', await text('#tfPvSum'));
await p.select('#tfPvInd', 'Biotechnology');
check('totals follow the filter', (await text('#tfPvSum')) === '2 of 3 filings shown: $3.5M offered, $1.2M sold.' && (await text('#tfRaises tfoot th')) === 'Total shown (2)', await text('#tfPvSum'));
await p.select('#tfPvInd', '');
check('no fixed amount reads "Indefinite"; a missing date is an en dash', await p.$$eval('#tfRaises tbody tr', (n) => { const r = n.find((x) => x.textContent.includes('Beta Fund')); return r.children[3].textContent === 'Indefinite' && r.children[5].textContent === '–'; }));
check('a hostile issuer name renders as text', await p.$$eval('#tfRaises tbody th', (n, h) => n.some((x) => x.textContent === h), HOSTILE) && await p.evaluate(() => !window.__xss && !document.querySelector('#view-private img')));
check('only SEC addresses become filing links', await p.$$eval('#tfRaises tbody a', (n) => n.length === 1 && n[0].href === 'https://www.sec.gov/Archives/edgar/data/2/d.xml' && n[0].target === '_blank' && n[0].rel === 'noopener noreferrer'));
stubs.set('private', () => ({ status: 502, body: { error: 'down' } }));
stubs.set('ipos', () => wrap({ pipeline: [], sources: [{ name: 'SEC EDGAR', state: 'off', note: 'No contact address is set' }] }));
await p.reload({ waitUntil: 'domcontentloaded' });
await waitText('#tfPvBody', /could not be loaded/);
check('private page: a 502 and a source that is off both show sentences', /Private raises could not be loaded/.test(await text('#tfPvBody')) && /The IPO pipeline is not connected on this server \(SEC EDGAR: No contact address is set\)\./.test(await text('#tfIpoP')), await text('#tfIpoP'));
stubs.delete('private'); stubs.delete('ipos');
await p.emulateTimezone(null);

// ----- sizes: no sideways scroll, tap targets -----
for (const [w, h] of [[390, 844], [768, 1024], [1440, 900]]) {
  await p.setViewport({ width: w, height: h });
  for (const [name, at, ready] of [['stocks', '#stocks', '.tfIndex'], ['company', '#stocks/' + co.symbol, '#tfStmtTable'], ['calendar', '#calendar', '.tfEvent'], ['private', '#private', '#tfRaises tbody tr']]) {
    await p.goto(BASE + '/' + at, { waitUntil: 'domcontentloaded' });
    await p.reload({ waitUntil: 'domcontentloaded' });
    await p.waitForSelector(ready);
    await sleep(500);
    check(w + 'px ' + name + ' has no sideways scroll', !(await p.evaluate(() => document.documentElement.scrollWidth > innerWidth)), await p.evaluate(() => document.documentElement.scrollWidth + ' in ' + innerWidth));
    if (w === 390) {
      const small = await p.evaluate((view) => [...document.querySelectorAll('#view-' + view + ' button, #view-' + view + ' a, #view-' + view + ' select, #view-' + view + ' input, #view-' + view + ' summary')]
        .filter((n) => n.offsetWidth > 0 && !n.closest('.tfMapBox') && !n.closest('#tfChart'))
        .map((n) => { const r = n.getBoundingClientRect(), pad = parseFloat(getComputedStyle(n).paddingTop) + parseFloat(getComputedStyle(n).paddingBottom); return { t: (n.dataset.fk || n.textContent).slice(0, 30), h: getComputedStyle(n).display === 'inline' ? parseFloat(getComputedStyle(n).lineHeight) + pad : r.height }; })
        .filter((x) => x.h < 39.5), name === 'company' ? 'stocks' : name);
      check('390px ' + name + ': tap targets are at least 40px tall', small.length === 0, small.slice(0, 5).map((x) => x.t + ' ' + Math.round(x.h)).join(', '));
      await shot(name + '-390');
    }
  }
}

// ----- review: perpetual prices are labelled as such wherever they appear -----
await p.setViewport({ width: 1440, height: 900 });
{
  const HLS = [{ name: 'Hyperliquid perpetuals', state: 'ok', note: 'Perpetual contract prices on Hyperliquid.' }, { name: 'US Treasury', state: 'ok', note: '' }, { name: 'Sector performance', state: 'off', note: 'Not connected: no source with display rights is configured for sector moves.' }];
  const pq = (symbol, price, changePct, volumeUsd) => ({ symbol, name: symbol + ' Example Corp', price, changePct, volume: null, volumeUsd, kind: 'perp' });
  stubs.set('overview', () => ({ body: { demo: false, at: Date.now(), sources: HLS, sectors: [], macro: [], yields: overview.yields,
    indexes: [{ symbol: 'HL:XYZ100', name: 'XYZ100 perpetual on Hyperliquid', price: 25500, changePct: 2, spark: [1, 2, 3], asOf: Date.now(), delayed: false, kind: 'perp', changeBasis: '24h', source: 'Hyperliquid perpetual (xyz:XYZ100)' }],
    movers: { gainers: [pq('NVDA', 190, 3.1, 5e7), pq('TSLA', 420, 1.2, 7e7)], losers: [pq('AMD', 150, -2.5, 2e7)], active: [pq('TSLA', 420, 1.2, 7e7), pq('NVDA', 190, 3.1, 5e7)], universe: 'The 3 US shares that have a perpetual contract on Hyperliquid, by that contract’s 24-hour change. Not the whole market.' } } }));
  stubs.set('quote', (u) => ({ body: { demo: false, at: Date.now(), sources: [HLS[0]], quotes: u.searchParams.get('symbols').split(',').map((s) => ({ symbol: s, name: null, price: 190, changePct: -4, previousClose: null, open: null, high: null, low: null, volume: null, volumeUsd: 9e6, marketCap: null, asOf: Date.now(), delayed: false, kind: 'perp', changeBasis: '24h', source: 'Hyperliquid perpetual (xyz:' + s + ')' })) } }));
  stubs.set('candles', (u) => ({ body: { demo: false, at: Date.now(), sources: [HLS[0]], symbol: u.searchParams.get('symbol'), interval: '1d', delayed: false, kind: 'perp', source: 'Hyperliquid perpetual (xyz:NVDA)', range: u.searchParams.get('range'), historyStart: '2026-02-02', capped: false,
    candles: [{ time: Date.UTC(2026, 1, 2) / 1000, open: 10, high: 12, low: 9, close: 11, volume: 5 }, { time: Date.UTC(2026, 1, 3) / 1000, open: 11, high: 13, low: 10, close: 12, volume: 6 }] } }));
  stubs.set('company', () => ({ body: { demo: false, at: Date.now(), symbol: 'NVDA', name: null, cik: null, exchange: null, industry: null, fiscalYearEnd: null, facts: [], statements: null, filings: [], sources: [{ name: 'SEC EDGAR', state: 'off', note: 'Set SEC_USER_AGENT.' }] } }));
  await p.evaluate(() => localStorage.setItem('nt.watch', '["NVDA"]'));
  await p.goto(BASE + '/#stocks', { waitUntil: 'domcontentloaded' });
  await p.reload({ waitUntil: 'domcontentloaded' });
  await waitText('#tfIdx', /XYZ100 perpetual/);
  await waitText('#tfWat', /190\.00/);
  const idx = await text('#tfIdx'), mov = await text('#tfMov'), map = await text('#tfMap'), wat = await text('#tfWat');
  check('index tile from a perpetual says so, and is not called an index level', /Perpetual contract price, not the index level/.test(idx) && /not the stock exchange’s price/.test(idx) && /change over 24 hours/.test(idx) && !/Latest ·/.test(idx), idx.slice(0, 200));
  check('movers from perpetuals: every row and both columns say so, with dollars traded in place of share volume', await p.$$eval('#tfMov tbody tr', (n) => n.length === 5 && n.every((r) => /· perpetual/.test(r.textContent) && /\$\d/.test(r.lastElementChild.textContent))) && /Change, 24h/.test(mov) && /Traded, 24h/.test(mov) && /Not the whole market/.test(mov) && /not the stock exchange’s price/.test(mov), mov.slice(0, 160));
  check('market map from perpetuals says what it is shaded and sized by', /24-hour change of each company’s perpetual contract on Hyperliquid \(not its exchange price\)/.test(map) && /value traded in the perpetual contract/.test(map) && await p.$$eval('.tfMapTile', (n) => n.length === 3 && n.every((b) => /Perpetual contract on Hyperliquid/.test(b.getAttribute('aria-label')))), map.slice(-260));
  check('watchlist rows priced from a perpetual say so', /perpetual price, 24h change/.test(wat) && /not the stock exchange’s price/.test(wat), wat.slice(0, 200));
  check('a block with no source of its own is credited to nobody', !/Source:/.test(await text('#tfSec .tfNote')) && /Sector moves are not connected on this server \(Sector performance/.test(await text('#tfSec')) && /Source: Hyperliquid perpetuals ·/.test(await text('#tfIdx .tfNote')) && /Source: US Treasury ·/.test(await text('#tfYld .tfNote')), (await text('#tfSec .tfNote')) + ' | ' + (await text('#tfIdx .tfNote')));
  await shot('perp-overview-1440');
  await open('#stocks/NVDA');
  await waitText('#tfQuote', /Perpetual contract price/);
  await waitText('#tfChartSum', /daily candles/);
  const qt = await text('#tfQuote'), ch = await text('#tfChartC');
  check('company price from a perpetual: labelled, sourced, and without exchange-only figures', /Perpetual contract price/.test(qt) && /Hyperliquid perpetual \(xyz:NVDA\)/.test(qt) && /change over 24 hours/.test(qt) && /not the stock exchange’s price/.test(qt) && !/Market value|Previous close|Day range/.test(qt) && /Exchange price\s*Not connected/.test(qt), qt.slice(0, 300));
  check('chart of a perpetual: the heading, the note, the summary and the description all say so', /Price chart: perpetual contract, not the exchange price/.test(ch) && /Perpetual contract ·/.test(await text('#tfChartC .tfNote')) && /^Perpetual contract prices from Hyperliquid, not stock exchange prices\./.test(await text('#tfChartSum')) && /Perpetual contract prices from Hyperliquid/.test(await p.$eval('#tfChart', (n) => n.getAttribute('aria-label'))));
  check('with the SEC off, facts, statements and filings each say they are not connected', /Key facts are not connected/.test(await text('#tfFacts')) && /Financial statements are not connected/.test(await text('#tfStmt')) && /Filings are not connected/.test(await text('#tfFil')));
  await shot('perp-company-1440');
  ['overview', 'quote', 'candles', 'company'].forEach((n) => stubs.delete(n));
  await p.evaluate(() => localStorage.removeItem('nt.watch'));
}

// ----- review: "a year earlier" is found by date, not by counting columns -----
{
  const row = (key, label, values) => ({ key, label, unit: 'USD', values });
  const S = (periods, periodEnds, values) => ({ periods, periodEnds, income: [row('revenue', 'Revenue', values)], balance: [], cashflow: [] });
  stubs.set('company', () => wrap({ symbol: co.symbol, name: 'Gap Test Co', cik: '1', exchange: 'X', industry: 'Y', fiscalYearEnd: '01-31', facts: [], filings: [],
    statements: {
      // The year-end moved from September to December: FY2023 and FY2022 end fifteen months apart.
      annual: S(['FY2024', 'FY2023', 'FY2022'], ['2024-12-31', '2023-12-31', '2022-09-30'], [380e6, 345e6, 300e6]),
      // Two quarters are missing, so four columns back is not the same quarter a year before.
      quarterly: S(['Q1 FY2025', 'Q4 FY2024', 'Q1 FY2024', 'Q4 FY2023', 'Q3 FY2023'], ['2025-05-03', '2025-02-01', '2024-05-04', '2024-02-03', '2023-10-28'], [27e6, null, 25e6, 20e6, 18e6])
    } }));
  await open('#stocks/' + co.symbol);
  await p.waitForSelector('#tfStmtTable');
  const head = () => p.$$eval('#tfStmtTable thead th', (n) => n.map((x) => x.textContent));
  const cells = () => p.$$eval('#tfr-revenue td', (n) => n.map((x) => x.textContent));
  check('annual columns print the day each fiscal year ends', (await head()).slice(2).join('|') === 'FY2024, ending 31 Dec 2024|Change from a year earliervs FY2023|FY2023, ending 31 Dec 2023|FY2022, ending 30 Sep 2022', (await head()).join('|'));
  check('annual change is against the year ending twelve months before', (await cells())[2] === '▲ +10.1%', (await cells()).join('|'));
  await p.click('[data-fk="per-quarterly"]');
  await waitText('#tfStmtTable caption', /by fiscal quarter/);
  check('quarterly change skips the gap: Q1 against last year’s Q1 (+8.0%), not four columns back (+50.0%)', (await cells())[2] === '▲ +8.0%' && /vs Q1 FY2024/.test((await head())[3]) && /\(Q1 FY2024\)/.test(await text('#tfStmt .tfFoot')), (await cells()).join('|') + ' ' + (await head())[3]);
  check('quarter columns print their end dates, so a January year-end is plain', /Q1 FY2025, ending 3 May 2025/.test((await head())[2]));
  stubs.set('company', () => wrap({ symbol: co.symbol, name: 'Gap Test Co', cik: '1', exchange: 'X', industry: 'Y', fiscalYearEnd: '12-31', facts: [], filings: [],
    statements: { annual: S(['FY2024', 'FY2022'], ['2024-12-31', '2022-09-30'], [380e6, 300e6]), quarterly: S([], [], []) } }));
  await p.click('[data-fk="per-annual"]');
  await open('#stocks'); await open('#stocks/' + co.symbol);
  await waitText('#tfStmt .tfFoot', /not among the periods shown/);
  check('with no period a year earlier there is no change figure (not a 27-month comparison)', (await cells())[2] === '–' && /not among the periods shown/.test(await text('#tfStmt .tfFoot')), (await cells()).join('|'));
  stubs.delete('company');
}

// ----- review: event times across daylight-saving changes, in two viewer zones -----
{
  const ev = (date, time, title) => ({ date, time, kind: 'economic', title, symbol: null, detail: null, importance: 2, source: 'Test', url: null });
  // US clocks go back on 1 November 2026; UK clocks went back a week earlier, on 25 October.
  stubs.set('calendar', () => wrap({ timezone: 'America/New_York', events: [
    ev('2026-10-22', '08:30', 'A both on summer time'), ev('2026-10-29', '08:30', 'B only New York on summer time'), ev('2026-11-05', '08:30', 'C both on winter time'),
    ev('2026-10-22', '20:30', 'D evening in New York'), ev('2026-11-01', null, 'E all day on the changeover'), ev('2026-03-08', '08:30', 'F the morning US clocks go forward'), ev('2026-03-08', null, 'G all day in March')] }));
  stubs.set('ipos', () => wrap({ pipeline: [] }));
  const agenda = () => p.$$eval('.tfDay', (days) => Object.fromEntries(days.flatMap((d) => [...d.querySelectorAll('.tfEvent')].map((e) => [e.querySelector('.tfEvTitle').textContent.charAt(0), d.querySelector('h3').id.slice(6) + ' ' + e.querySelector('.tfTime').textContent.replace(' no time given', '')]))));
  await p.emulateTimezone('Europe/London');
  await open('#calendar');
  await waitText('#tfAgenda', /C both on winter time/);
  let a = await agenda();
  check('London: 08:30 New York is 13:30, then 12:30 in the week only New York is on summer time, then 13:30', a.A === '2026-10-22 13:30' && a.B === '2026-10-29 12:30' && a.C === '2026-11-05 13:30' && a.F === '2026-03-08 12:30', JSON.stringify(a));
  check('London: an evening event in New York is filed under the next day', a.D === '2026-10-23 01:30', a.D);
  check('London: all-day events stay on their date', a.E === '2026-11-01 –' && a.G === '2026-03-08 –', a.E + ' | ' + a.G);
  for (const [zone, wantA, wantD] of [['Pacific/Auckland', '2026-10-23 01:30', '2026-10-23 13:30'], ['America/Los_Angeles', '2026-10-22 05:30', '2026-10-22 17:30']]) {
    await p.emulateTimezone(zone);
    await open('#home'); await open('#calendar');
    await p.reload({ waitUntil: 'domcontentloaded' });
    await waitText('#tfAgenda', /C both on winter time/);
    a = await agenda();
    check(zone + ': timed events move to the viewer’s clock and date; all-day events do not shift a day', a.A === wantA && a.D === wantD && a.E === '2026-11-01 –' && a.G === '2026-03-08 –', JSON.stringify(a));
  }
  await p.emulateTimezone(null);
  stubs.delete('calendar'); stubs.delete('ipos');
}

// ----- review: a filing whose details have not been read is not shown as "Indefinite" -----
{
  const r = (issuer, detail, amountOffered, amountSold) => ({ issuer, industry: detail ? 'Other Technology' : null, state: detail ? 'CA' : null, filedAt: '2026-11-18', amountOffered, amountSold, firstSale: null, form: 'D', url: null, detail });
  let n = 0;
  stubs.set('private', () => { n += 1; return { body: { demo: false, at: Date.now(), sources: [{ name: 'SEC EDGAR', state: 'ok', note: '' }], detailsPending: n < 2 ? 1 : 0, raises: [r('Unread Example LLC', n >= 2, n >= 2 ? 2e6 : null, n >= 2 ? 1e6 : null), r('Open Ended Example LP', true, null, 5e6), r('Big Example Inc', true, 999960000, 999400)] } }; });
  stubs.set('ipos', () => wrap({ pipeline: [] }));
  await open('#private');
  await p.waitForSelector('#tfRaises tbody tr');
  const cellsOf = (name) => p.$$eval('#tfRaises tbody tr', (rows, nm) => [...rows.find((x) => x.textContent.includes(nm)).querySelectorAll('td')].map((c) => c.textContent), name);
  const first = await cellsOf('Unread Example');
  check('unread filing: amounts say "Not read", never "Indefinite" or $0', first[2] === 'Not read' && first[3] === 'Not read' && (await cellsOf('Open Ended'))[2] === 'Indefinite', first.join('|'));
  check('the totals leave the unread filing out and say why', /\$1\.00B offered, \$6\.0M sold/.test(await text('#tfPvSum')) && /1 filing is listed without amounts while the details are read from the SEC/.test(await text('#tfPvSum')), await text('#tfPvSum'));
  check('the page looks again by itself and fills the amounts in', await waitText('#tfPvSum', /\$1\.00B offered, \$7\.0M sold/, 9000) && (await cellsOf('Unread Example'))[2] === '$2.0M', await text('#tfPvSum'));
  const big = await cellsOf('Big Example');
  check('amounts round into the next unit cleanly: $1.00B, not $1,000.0M', big[2] === '$1.00B' && big[3] === '$999K', big.join('|'));
  stubs.delete('private'); stubs.delete('ipos');
  await open('#stocks');
  await p.waitForSelector('#tfMac .tfTile');
  check('rates keep a decimal: 4.0% beside 4.25%', /Central bank policy rate\s*4\.0%/.test(await text('#tfMac')) && /Previous: 4\.25%/.test(await text('#tfMac')), (await text('#tfMac')).slice(0, 200));
  check('the watchlist card has no dead space above its message', await p.$eval('#tfWat .tfSearch', (n) => n.getBoundingClientRect().height < 80));
}

check('no script errors', errs.length === 0, errs.slice(0, 4).join(' || '));
log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
await b.close();
await svc.stop();
server.close();
process.exit(fails ? 1 : 0);
