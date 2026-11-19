// Browser test for the Indexes page. Starts its own demo server on a free port and drives
// headless Chrome. A few answers are swapped for small hand-made ones (by intercepting the
// request) where a check needs exact numbers, a missing source, a failure or hostile text.
//   CHROME_PATH=/path/to/chrome node test/e2e/indexes.mjs      (SHOTS=dir saves screenshots)
import puppeteer from 'puppeteer-core';
import { existsSync, mkdirSync } from 'node:fs';
import { createApp } from '../../src/server.js';

const CHROME = process.env.CHROME_PATH || ['/usr/bin/google-chrome', '/usr/bin/chromium', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'].find(existsSync);
if (!CHROME) { console.error('Set CHROME_PATH to a Chrome or Chromium binary.'); process.exit(2); }
const SHOTS = process.env.SHOTS || '';
if (SHOTS) mkdirSync(SHOTS, { recursive: true });
const svc = await createApp({ demo: true });
// Port 0: the system picks a free one, so this never collides with another test or a running server.
const server = await new Promise((r) => { const s = svc.app.listen(0, '127.0.0.1', () => r(s)); });
await svc.start();
const BASE = 'http://127.0.0.1:' + server.address().port;
const API = BASE + '/api/indexes';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const get = async (path) => (await fetch(API + path)).json();

const b = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const errs = [];
const stubs = new Map();   // endpoint ('', 'series', 'capex') -> (url) => { status, body } or null to let it through
const seen = [];           // every /api/indexes request the page made, in order
const p = await b.newPage();
p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
p.on('console', (m) => {
  // The 400s and 502s are the ones this test asks for (an unknown index, a failing source).
  if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|net::ERR_FAILED|ERR_CONNECTION_REFUSED|status of (400|429|502)/.test(m.text())) errs.push('console ' + m.text());
});
p.on('dialog', (d) => { errs.push('dialog opened: ' + d.message()); d.dismiss(); });
await p.setViewport({ width: 1440, height: 900 });
await p.setRequestInterception(true);
p.on('request', (req) => {
  const u = new URL(req.url());
  if (u.pathname.startsWith('/api/indexes')) {
    const name = u.pathname.slice('/api/indexes'.length).replace(/^\//, '');
    seen.push(name + u.search);
    const r = stubs.has(name) ? stubs.get(name)(u) : null;
    if (r) return req.respond({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) }).catch(() => {});
  }
  req.continue().catch(() => {});
});
const shot = async (name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name + '.png', fullPage: true }); };
const open = async (hash) => { await p.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' }); await p.evaluate((h) => { location.hash = h; }, hash); };
const text = (sel) => p.$eval(sel, (n) => n.textContent).catch(() => '');
const waitText = (sel, re, timeout = 6000) => p.waitForFunction((s, src) => { const n = document.querySelector(s); return n && new RegExp(src).test(n.textContent); }, { timeout }, sel, re.source).then(() => true, () => false);
const noSideScroll = () => p.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth);
const DEMO = [{ name: 'Demo data', state: 'ok', note: 'Invented for the demo.' }];

// Real demo answers, to check the page against.
const list = await get('/');
const capex = await get('/capex');
const dc = await get('/series?id=data-center&range=1y');

// ----- the list -----
await open('#indexes');
await p.waitForSelector('.ixCard');
check('one card per index, each linking to its own page', await p.$$eval('.ixCard', (n, ids) => n.length === ids.length && n.every((a, i) => a.getAttribute('href') === '#indexes/' + ids[i]), list.indexes.map((i) => i.id)));
check('every card carries the Halftone index label, a state in words, a value and a sparkline', await p.$$eval('.ixCard', (n) => n.every((a) => /Halftone index/i.test(a.querySelector('.ixTag').textContent) && /Connected/.test(a.querySelector('.ixState').textContent) && /\d/.test(a.querySelector('.ixVal').textContent) && a.querySelector('svg.ixSpark polyline'))));
const first = list.indexes.find((i) => i.id === 'data-center');
const cardText = await p.$eval('.ixCard[data-id="data-center"]', (n) => n.textContent);
check('a card shows the value and changes the server sent, with arrows as well as colour', cardText.includes(first.value.toFixed(2)) && cardText.includes(Math.abs(first.change.y1).toFixed(2) + '%') && /[▲▼]/.test(cardText), cardText.slice(0, 160));
check('the page says these are not official benchmarks', /Halftone index, not an official benchmark/.test(await text('#ixList')));
check('header names the source, its age and that demo figures are invented', /Source: Demo data/.test(await text('.ixHeadNote')) && /updated/.test(await text('.ixHeadNote')) && /Demo: invented figures/.test(await text('.ixHeadNote')));
await p.waitForSelector('#ixCapex .ixBars svg');
check('capex tracker: stacked bars as an image with a description, plus the same figures in a table', await p.$eval('#ixCapex .ixBars', (n) => n.getAttribute('role') === 'img' && /Stacked bar chart of quarterly capital expenditure for 5 companies over 8 calendar quarters/.test(n.getAttribute('aria-label')) && n.querySelectorAll('rect.ixSeg').length === 40) &&
  await p.$eval('#ixCapex table', (t, want) => t.querySelectorAll('tbody tr').length === want && t.querySelectorAll('tfoot tr').length === 4 && t.querySelectorAll('thead th[scope=col]').length === 9, capex.companies.length));
check('capex legend names every company in stacking order', await p.$$eval('#ixCapex .ixLegend li', (n, want) => n.length === want.length && n.every((li, i) => li.textContent.includes(want[i])), capex.companies.map((c) => c.symbol)));
check('no advice language on the page', !/\b(buy|sell|undervalued|overvalued|recommend(ed)?|price target|outperform)\b/i.test(await text('#view-indexes')));
check('no sideways scroll at 1440', await noSideScroll());
await shot('indexes-1440');

// ----- one index -----
await p.click('.ixCard[data-id="data-center"]');
await p.waitForSelector('#ixParts tbody tr');
check('opening a card routes to #indexes/<id> and names the index', await p.evaluate(() => location.hash) === '#indexes/data-center' && await text('#view-indexes h1') === 'Data center index');
check('chart is an image with a spoken summary and a table alternative', await p.$eval('#ixChart', (n) => n.getAttribute('role') === 'img' && /^Line chart\. Data center index over the past year: \d+ daily points/.test(n.getAttribute('aria-label')) && n.querySelector('canvas')) && await p.$eval('#ixChartC details table', (t) => t.querySelectorAll('tbody tr').length > 100));
check('constituents table lists every member with weight, change and contribution', await p.$$eval('#ixParts tbody tr', (n, want) => n.length === want.length && n.every((tr, i) => tr.textContent.includes(want[i].id) && /14\.3%/.test(tr.textContent) && /pts/.test(tr.textContent)), dc.constituents));
const sum = Math.round(dc.constituents.reduce((a, c) => a + c.contributionPts, 0) * 100) / 100;
check('contributions are totalled beside the index’s own change', (await text('#ixParts tfoot')).includes(Math.abs(dc.changePct).toFixed(2) + '%') && (await text('#ixParts tfoot')).includes(Math.abs(sum).toFixed(2) + ' pts'), await text('#ixParts tfoot'));
check('"How this is calculated" shows the published method in plain words', await p.$$eval('#ixHow ol li', (n, want) => n.length === want.length && n.every((li, i) => li.textContent === want[i]), dc.method) && /100 on 2025-01-02/.test(await text('#ixHow')) && /Demo: the method and limits below are those of the real index/.test(await text('#ixHow')));
check('inputs are listed with source and dates; limits are stated', /Daily closing prices of 7 companies/.test(await text('#ixInputs')) && /Demo data/.test(await text('#ixInputs')) && await p.$$eval('#ixLimits li', (n) => n.length >= 3));
check('index page keeps the label and says the figures are invented', /Halftone index, not an official benchmark\. Demo: invented figures\./i.test(await text('.ixIntro')));
check('constituents link to their company pages', await p.$eval('#ixParts tbody a.ixSym', (a) => /^#stocks\/[A-Z]{6}$/.test(a.getAttribute('href'))));

// range switch
const before = seen.length;
await p.click('#ixChartC .seg button[data-range="6m"]');
check('range switch asks for that range and marks the button pressed', await waitText('#ixChartSum', /over the past six months/) && seen.slice(before).some((s) => /^series\?id=data-center&range=6m$/.test(s)) && await p.$eval('#ixChartC .seg button[data-range="6m"]', (x) => x.getAttribute('aria-pressed') === 'true' && x.classList.contains('on')));
check('tap targets are at least 40px', await p.$$eval('#ixChartC .seg button, .ixBack, #ixChartC summary', (n) => n.every((x) => x.getBoundingClientRect().height >= 40 && x.getBoundingClientRect().width >= 40)));
await p.focus('#ixChartC .seg button[data-range="1y"]');
check('focus is visible', await p.$eval('#ixChartC .seg button[data-range="1y"]', (x) => { x.focus(); const s = getComputedStyle(x); return x.matches(':focus-visible') ? s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 : true; }));
await shot('index-data-center-1440');

// the tracker page
await open('#indexes/capex');
await p.waitForSelector('#ixCapexFull .ixBars svg');
check('capex index page has the quarterly index, the bars and the table', /quarterly points/.test(await text('#ixChartSum')) && await p.$$eval('#ixCapexFull tbody tr', (n) => n.length === 5) && (await text('#ixCapexFull tfoot')).includes('Trailing four quarters'));
await shot('index-capex-1440');

// ----- not connected, pending, hostile text -----
const OFF = { demo: false, at: Date.now(), label: 'Halftone index, not an official benchmark', sources: [{ name: 'SEC EDGAR', state: 'off', note: 'Set SEC_USER_AGENT.' }], indexes: [
  { id: 'capex', name: 'AI capital spending', meaning: 'What buyers spend.', label: 'x', state: 'off', note: 'Not connected: Set SEC_USER_AGENT to your firm’s name and a contact email.', frequency: 'quarterly', value: null, change: { d1: null, m1: null, y1: null, previous: null }, spark: [], asOf: null, base: null, method: '' },
  { id: 'semis', name: '<img src=x onerror=alert(1)>', meaning: '<script>alert(2)</script>', label: 'x', state: 'pending', note: 'Reading prices: 3 of 10 companies so far.', frequency: 'daily', value: null, change: {}, spark: [], asOf: null, base: null },
  { id: 'energy', name: 'Energy cost index', meaning: 'm', state: 'error', note: 'The Energy Information Administration did not answer.', value: null, change: null, spark: null },
  { id: 'bad id!', name: 'Should not render', state: 'ok', value: 1 }
] };
stubs.set('', () => ({ body: OFF }));
stubs.set('capex', () => ({ body: { demo: false, at: Date.now(), state: 'off', note: 'Not connected: Set SEC_USER_AGENT.', label: 'Halftone index, not an official benchmark', companies: [], quarters: [], values: {}, totals: [], sources: OFF.sources } }));
await open('#indexes');
await p.waitForSelector('.ixCard-off');
check('a not-connected index shows the reason and no number', await p.$eval('.ixCard[data-id="capex"]', (a) => /Not connected/.test(a.querySelector('.ixState').textContent) && /Set SEC_USER_AGENT/.test(a.textContent) && a.querySelector('.ixVal').textContent === '–' && !a.querySelector('.ixSpark')));
check('pending and failing indexes say so in words', await p.$eval('.ixCard[data-id="semis"] .ixState', (n) => n.textContent === 'Reading inputs') && await p.$eval('.ixCard[data-id="energy"] .ixState', (n) => n.textContent === 'Source failing'));
check('text from the server is shown as text, and a malformed id is not rendered', await p.$eval('.ixCard[data-id="semis"] .ixName', (n) => n.textContent === '<img src=x onerror=alert(1)>' && !n.querySelector('img')) && await p.$$eval('.ixCard', (n) => n.length === 3) && !(await p.$('#view-indexes script')));
check('the tracker says not connected instead of drawing empty bars', /Not connected/.test(await text('#ixCapex')) && !(await p.$('#ixCapex .ixBars')));
check('header says which source is not connected', /SEC EDGAR \(not connected\)/.test(await text('.ixHeadNote')) && !/Demo/.test(await text('.ixHeadNote')));
await shot('indexes-not-connected-1440');

stubs.set('series', (u) => (u.searchParams.get('id') === 'energy' ? { status: 502, body: { error: 'The Energy Information Administration did not answer.' } } : { body: {
  demo: false, at: Date.now(), id: 'semis', name: 'AI hardware basket', meaning: 'Share prices.', summary: 's', label: 'Halftone index, not an official benchmark', state: 'off', note: 'Not connected: Set TWELVEDATA_KEY for daily price history.', frequency: 'daily', range: '1y', base: null, asOf: null, from: null, value: null, changePct: null, change: { d1: null, m1: null, y1: null, previous: null }, series: [],
  constituents: [{ id: 'NVDA', name: 'NVIDIA', reason: 'AI accelerators.', link: '#stocks/NVDA', state: 'missing', note: 'Set TWELVEDATA_KEY.', weightPct: null, latest: null, changePct: null, contributionPts: null }, { id: 'X', name: 'Evil', reason: 'r', link: 'javascript:alert(1)', state: 'missing', note: '', weightPct: null }],
  tables: [{ title: 'T', columns: [{ label: 'Source', kind: 'link' }], rows: [[{ text: 'bad', url: 'javascript:alert(1)' }], [{ text: 'ok', url: 'https://www.sec.gov/edgar/search/' }]] }], facts: [], inputs: [], method: ['Step one.'], limits: ['Limit one.'], sources: [{ name: 'Twelve Data', state: 'off', note: 'Set TWELVEDATA_KEY.' }], history: ''
} }));
await open('#indexes/semis');
await p.waitForSelector('#ixParts tbody tr');
check('a not-connected index page shows no value, no chart line, and the reason', /Not connected/.test(await text('#ixOne .ixTiles')) && /No line to draw: Not connected: Set TWELVEDATA_KEY/.test(await text('#ixChartSum')) && await p.$eval('#ixChart', (n) => n.hidden) && /Not in the index/.test(await text('#ixParts')));
check('its method and limits are still shown', /Step one\./.test(await text('#ixHow')) && /Limit one\./.test(await text('#ixLimits')) && /Twelve Data: not connected/.test(await text('#ixInputs')));
check('only official links are made; script addresses never become links', await p.$$eval('#view-indexes a', (n) => n.every((a) => !/^javascript:/i.test(a.getAttribute('href')))) && await p.$$eval('#ixTab0 a', (n) => n.length === 1 && n[0].href === 'https://www.sec.gov/edgar/search/' && n[0].rel === 'noopener noreferrer'));
await open('#indexes/energy');
check('a failing source is reported in a sentence', await waitText('#ixOne .emptyBox', /could not be loaded: The Energy Information Administration did not answer/));
stubs.clear();
await open('#indexes/nope');
check('an unknown index says so', await waitText('#ixOne .emptyBox', /There is no index by that name/));
await open('#indexes/%3Cscript%3E');
check('a malformed address asks the server nothing', await waitText('#ixOne .emptyBox', /There is no index by that name/) && !seen.slice(-3).some((s) => /script/i.test(s)));

// ----- nothing is fetched while hidden -----
await open('#indexes');
await p.waitForSelector('.ixCard');
await p.evaluate(() => { location.hash = '#news'; });
await sleep(300);
const mark = seen.length;
await p.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
await sleep(600);
check('leaving the page, or hiding the tab, stops every request', seen.length === mark);
await p.evaluate(() => { location.hash = '#indexes'; });
await sleep(500);
check('nothing is fetched while the tab is in the background', seen.length === mark);
await p.evaluate(() => { delete document.hidden; document.dispatchEvent(new Event('visibilitychange')); });
await sleep(600);
check('coming back to the tab loads again', seen.length > mark);
// The same answer twice does not rebuild the cards.
await p.evaluate(() => { document.querySelector('.ixCard').dataset.keep = '1'; location.hash = '#news'; });
await sleep(200);
await p.evaluate(() => { location.hash = '#indexes'; });
await sleep(900);
check('an unchanged answer does not rebuild the page', await p.$eval('.ixCard', (n) => n.dataset.keep === '1'));

// ----- narrow screens -----
for (const width of [768, 390]) {
  await p.setViewport({ width, height: 844 });
  await open('#indexes');
  await p.waitForSelector('#ixCapex .ixBars svg');
  await sleep(300);
  check(`no sideways scroll at ${width} (list)`, await noSideScroll());
  check(`bars fit their card at ${width}`, await p.$eval('#ixCapex .ixBars svg', (s) => s.getBoundingClientRect().right <= s.closest('.card').getBoundingClientRect().right + 1));
  if (width === 390) await shot('indexes-390');
  await open('#indexes/data-center');
  await p.waitForSelector('#ixParts tbody tr');
  await sleep(300);
  check(`no sideways scroll at ${width} (index)`, await noSideScroll());
  check(`wide tables scroll inside their own box at ${width}`, await p.$eval('#ixParts .tableWrap', (w) => w.getAttribute('tabindex') === '0' && getComputedStyle(w).overflowX === 'auto'));
  if (width === 390) { check('tap targets at 390', await p.$$eval('#ixChartC .seg button, .ixBack', (n) => n.every((x) => x.getBoundingClientRect().height >= 40))); await shot('index-data-center-390'); }
}

check('no page errors', errs.length === 0, errs.join(' | '));
await b.close();
await svc.stop();
await new Promise((r) => server.close(r));
log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
