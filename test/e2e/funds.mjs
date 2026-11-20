// Browser test for the Funds page and the ownership block on a company page. Starts its own
// demo server on a free port and drives headless Chrome. A few answers are swapped for small
// hand-made ones (by intercepting the request) where a check needs a failure, a source that
// is off, a loading state or hostile text.
//   CHROME_PATH=/path/to/chrome node test/e2e/funds.mjs      (SHOTS=dir saves screenshots)
import puppeteer from 'puppeteer-core';
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
const API = BASE + '/api/tradfi/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const get = async (path) => (await fetch(API + path)).json();

const b = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const errs = [];
const stubs = new Map();   // endpoint name -> (url) => { status, body } or null to let it through
const seen = [];
const p = await b.newPage();
p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|net::ERR_FAILED|ERR_CONNECTION_REFUSED|status of (400|429|502)/.test(m.text())) errs.push('console ' + m.text()); });
p.on('dialog', (d) => { errs.push('dialog opened: ' + d.message()); d.dismiss(); });
await p.setViewport({ width: 1440, height: 900 });
await p.setRequestInterception(true);
p.on('request', (req) => {
  const u = new URL(req.url());
  if (u.pathname.startsWith('/api/tradfi/')) {
    const name = u.pathname.slice('/api/tradfi/'.length);
    seen.push(name + u.search);
    const r = stubs.has(name) ? stubs.get(name)(u) : null;
    if (r) return req.respond({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) }).catch(() => {});
  }
  req.continue().catch(() => {});
});
const shot = async (name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name + '.png', fullPage: true }); };
const open = async (hash) => { await p.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' }); await p.evaluate((h) => { location.hash = h; }, hash); };
// The same, from a page that has loaded nothing yet (what the page already holds is kept when a refresh fails).
const fresh = async (hash) => { await p.goto('about:blank'); await open(hash); };
const hash = () => p.evaluate(() => location.hash);
const text = (sel) => p.$eval(sel, (n) => n.textContent).catch(() => '');
const waitText = (sel, re, timeout = 6000) => p.waitForFunction((s, src) => { const n = document.querySelector(s); return n && new RegExp(src).test(n.textContent); }, { timeout }, sel, re.source).then(() => true, () => false);
const sideways = () => p.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const DEMO = [{ name: 'Demo data', state: 'ok', note: 'Invented for the demo.' }];
const wrap = (body) => ({ body: { demo: true, at: Date.now(), sources: DEMO, ...body } });

// Real demo answers, to check the page against.
const funds = await get('funds');
const biggest = funds.managers.slice().sort((a, c) => c.value - a.value)[0];
const one = await get('fund?id=' + biggest.id);
const latest = await get('insiders/latest');
const day = (s) => { const [y, m, d] = s.split('-').map(Number); return d + ' ' + ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m - 1] + ' ' + y; };

// ----- the list -----
await open('#funds');
await p.waitForSelector('#fnMgrTable tbody tr');
await p.waitForSelector('#fnInsTable tbody tr');
check('header in house style', (await text('#view-funds h1')) === 'What large managers and insiders reported' && (await text('#view-funds .kicker')) === 'Funds');
const cav = await text('#fnCaveat');
check('the caveats are stated, in plain words, above the first figure', /once a quarter/.test(cav) && /45 days/.test(cav) && /US-listed shares and some options/.test(cav) && /short positions/.test(cav) && /futures/.test(cav) && /crypto/.test(cav) && /market maker/i.test(cav) && /inventory/.test(cav) && /hedge/.test(cav) && /record, not a signal/.test(cav) &&
  await p.evaluate(() => document.querySelector('#fnCaveat').getBoundingClientRect().top < document.querySelector('#fnMgr').getBoundingClientRect().top));
check('no language that suggests copying anyone', !/copy|follow the|smart money|mirror|what to buy|should buy|top picks|conviction/i.test(await text('#view-funds')));
check('every tracked manager is listed with period, filing date and value', await p.$$eval('#fnMgrTable tbody tr', (n, want) => n.length === want && n.every((r) => r.querySelector('th[scope=row] a[href^="#funds/"]') && /\d{4}/.test(r.textContent) && /\$/.test(r.textContent) && /days? ago|today/.test(r.textContent)), funds.managers.length));
check('the list opens sorted by reported value, largest first', (await p.$eval('#fnMgrTable tbody tr th b', (n) => n.textContent)) === biggest.name && await p.$eval('#fnMgrTable th[aria-sort]', (n) => n.getAttribute('aria-sort') === 'descending' && /Reported value/.test(n.textContent)));
check('a market maker is labelled in words', await p.$$eval('#fnMgrTable tbody tr', (n) => n.some((r) => /Market maker: mostly inventory and hedges/.test(r.textContent))) === funds.managers.some((m) => m.marketMaker));
check('blocks name their source and age and label demo figures as invented', await p.$$eval('#fnList .tfNote', (n) => n.length === 2 && n.every((x) => /Source: Demo data/.test(x.textContent) && /updated/.test(x.textContent) && /Demo: invented/.test(x.textContent))));
await p.click('[data-fk="fm-name"]');
const names = await p.$$eval('#fnMgrTable tbody tr th b', (n) => n.map((x) => x.textContent));
check('sorting by manager name', names.join('|') === names.slice().sort((a, c) => a.localeCompare(c)).join('|') && names.length > 3, names.slice(0, 3).join(', '));
check('sorting keeps keyboard focus on the column button and says the order', await p.evaluate(() => document.activeElement && document.activeElement.dataset.fk === 'fm-name' && document.activeElement.closest('th').getAttribute('aria-sort') === 'ascending'));
await p.click('[data-fk="fm-positions"]');
const counts = await p.$$eval('#fnMgrTable tbody tr td:nth-child(5)', (n) => n.map((x) => Number(x.textContent.replace(/,/g, ''))));
check('sorting by positions, most first', counts.every((v, i) => i === 0 || counts[i - 1] >= v), counts.join(' '));

// insiders
const rowsAll = await p.$$eval('#fnInsTable tbody tr', (n) => n.length);
check('latest insider filings list transactions in plain words', rowsAll === latest.transactions.length && /Purchase \(open market or private\)|Sale \(open market or private\)|Gift|Grant or award/.test(await text('#fnInsTable')) && !/\b[PSAMFG]\b\s*$/.test(await text('#fnInsTable tbody tr td:nth-child(4)')), String(rowsAll));
check('insider rows link the company page', await p.$eval('#fnInsTable tbody tr th a', (a) => /^#stocks\/[A-Z]+$/.test(a.getAttribute('href'))));
await p.click('[data-fk="fi-buys"]');
const buys = latest.transactions.filter((t) => t.kind === 'purchase' && !t.derivative).length;
check('purchases-only filter', await p.$$eval('#fnInsTable tbody tr', (n, want) => n.length === want && n.every((r) => /Purchase/.test(r.textContent)), buys) && buys > 0 && buys < rowsAll && await p.$eval('[data-fk="fi-buys"]', (n) => n.getAttribute('aria-pressed') === 'true' && document.activeElement === n), buys + ' of ' + rowsAll);
check('the filter says what it shows', new RegExp(buys + ' purchases? among ' + rowsAll + ' rows').test(await text('#fnIns .tfRange')), await text('#fnIns .tfRange'));
await p.click('[data-fk="fi-all"]');
check('tap targets are at least 40px tall', await p.$$eval('#view-funds button, #view-funds .fnMgrLink, #view-funds .fnBack', (n) => n.filter((x) => x.offsetParent).every((x) => x.getBoundingClientRect().height >= 40)));
await p.focus('#fnMgrTable tbody tr th a');
check('focus is visible on a manager link', await p.$eval('#fnMgrTable tbody tr th a', (a) => { a.focus(); const s = getComputedStyle(a); return a.matches(':focus') && (a.matches(':focus-visible') ? s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 : true); }));
await shot('funds-1440');

// ----- one manager -----
await p.evaluate((name) => { [...document.querySelectorAll('#fnMgrTable tbody tr th a')].find((a) => a.textContent.includes(name)).click(); }, biggest.name);
await p.waitForSelector('#fnHoldTable tbody tr');
check('opening a manager changes the address', (await hash()) === '#funds/' + biggest.id, await hash());
check('manager name is the heading', (await text('#view-funds h1')) === biggest.name);
const asOf = await text('#fnAsOf');
check('period and filing date are prominent, with the age in days', asOf.includes('Holdings as of ' + day(one.filing.period)) && asOf.includes('filed ' + day(one.filing.filedAt)) && /\d+ days? ago|today/.test(asOf) && await p.$eval('.fnAsOfMain', (n) => parseFloat(getComputedStyle(n).fontSize) >= 22), asOf);
check('the caveats stay on the manager page', /45 days/.test(await text('#fnCaveat')) && await p.$eval('#fnCaveat', (n) => n.offsetParent !== null));
check('a market maker’s page says what its list is', !one.marketMaker || /makes markets/.test(await text('#fnSum')));
check('top holdings: issuer, share of total with a bar, value, shares, change in words', await p.$$eval('#fnHoldTable tbody tr', (n, want) => n.length === want && n.every((r) => r.querySelector('.fnBarFill') && /%/.test(r.querySelector('.fnShare').textContent) && /New position|No change|Added|Reduced/.test(r.querySelector('.fnChange').textContent)), one.holdings.length));
const top = one.holdings[0];
const firstRow = await p.$eval('#fnHoldTable tbody tr', (r) => [...r.children].map((c) => c.textContent));
check('the first holding matches the answer', firstRow[1].includes(top.symbol) && firstRow[1].includes(top.issuer) && firstRow[2].includes(top.pct.toFixed(2) + '%') && firstRow[4].replace(/,/g, '').startsWith(String(top.shares)), firstRow.join(' | '));
check('bars are scaled to the largest holding', await p.$$eval('#fnHoldTable .fnBarFill', (n) => parseFloat(n[0].style.width) === 100 && n.every((x, i) => i === 0 || parseFloat(n[i - 1].style.width) >= parseFloat(x.style.width))));
check('mapped tickers link to the company page', await p.$eval('#fnHoldTable tbody tr th a', (a, s) => a.getAttribute('href') === '#stocks/' + s, top.symbol));
for (const k of ['new', 'exits', 'increases', 'decreases']) {
  const want = one.changes[k].length;
  const got = await p.$$eval('#fnChg-' + k + ' tbody tr', (n) => n.length).catch(() => 0);
  check('changes: ' + k + ' (' + want + ') listed with its count', got === want && (await text('#fnChg-' + k + ' h3')).includes('(' + one.changes.counts[k] + ')') && (want > 0 || /None\./.test(await text('#fnChg-' + k))), String(got));
}
check('changes are said to be by shares, not value', /number of shares, not by value/.test(await text('#fnChg')));
check('options are listed apart and explained', one.options.length === 0 || (await p.$$eval('#fnOptTable tbody tr', (n, want) => n.length === want && n.every((r) => /Put option|Call option/.test(r.textContent)), one.options.length) && /not what the options cost/.test(await text('#fnOpt'))));
check('demo: no link to a filing, and it says why', /Demo: there is no real filing to open/.test(await text('.fnLinks')) && await p.$$eval('#fnOne a[target=_blank]', (n) => n.length === 0));
check('no sideways page scroll at 1440', (await sideways()) <= 0);
await shot('fund-1440');
await p.click('.fnBack');
await p.waitForSelector('#fnMgrTable tbody tr');
check('back to the list', (await hash()) === '#funds' && (await text('#view-funds h1')) === 'What large managers and insiders reported' && await p.$eval('#fnOne', (n) => n.hidden));

// ----- deep links -----
await open('#funds/' + Number(biggest.id));
await p.waitForSelector('#fnHoldTable tbody tr');
check('deep link opens the manager (number without leading zeros)', (await text('#view-funds h1')) === biggest.name && await p.$eval('#fnList', (n) => n.hidden));
check('the page title names the manager', (await p.title()).includes(biggest.name));
await open('#funds/not-a-number');
check('a deep link that is not a number says so and fetches nothing', await waitText('#fnState', /is not a manager’s number/) && !seen.some((u) => /^fund\?id=not/.test(u)));
await open('#funds/1067983');
check('an untracked number says no such manager is followed', await waitText('#fnState', /No tracked manager has the number/), await text('#fnState'));

// ----- hostile text renders as text -----
{
  const evil = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=1</script>';
  stubs.set('funds', () => wrap({ tracked: 1, loaded: 1, pending: 0, managers: [{ id: '0000000042', name: evil, marketMaker: false, state: 'ready', period: '2026-09-30', filedAt: '2026-11-13', form: '13F-HR', value: 1e9, positions: 2, optionPositions: 0, url: 'javascript:alert(1)' }] }));
  stubs.set('insiders/latest', () => wrap({ detailsPending: 0, transactions: [{ form: '4', filedAt: '2026-11-18', accession: 'x', url: 'https://evil.example/x', detail: true, issuer: evil, symbol: '"><b>X', owner: evil, role: evil, moreOwners: 0, planned: false, date: '2026-11-17', code: 'P', kind: 'purchase', meaning: evil, acquired: true, shares: 10, price: 1, value: 10, sharesAfter: 10, security: evil, derivative: false, direct: true }] }));
  stubs.set('fund', () => wrap({ id: '0000000042', name: evil, marketMaker: true, state: 'ready', filerName: evil, filing: { period: '2026-09-30', form: evil, filedAt: '2026-11-13', url: 'https://www.sec.gov.evil.example/x', amended: false, capped: false }, previous: null, totals: { value: 100, holdingsValue: 100, optionsValue: 0, positions: 1, optionPositions: 0 },
    holdings: [{ issuer: evil, titleOfClass: evil, cusip: evil, symbol: '<script>x', value: 100, shares: 5, unit: 'SH', pct: 100, previousShares: null, change: evil }], options: [], changes: null, notes: [evil] }));
  await open('#funds');
  await p.waitForSelector('#fnMgrTable tbody tr');
  await p.waitForSelector('#fnInsTable tbody tr');
  check('hostile names in the list render as text', (await text('#fnMgrTable tbody th b')) === evil && (await text('#fnInsTable')).includes(evil) && await p.$$eval('#view-funds img, #view-funds script, #view-funds b > b', (n) => n.length === 0));
  check('a link that is not to the SEC is not made; a bad ticker gets no link', await p.$$eval('#fnInsTable a', (n) => n.length === 0));
  await p.click('#fnMgrTable tbody th a');
  await p.waitForSelector('#fnHoldTable tbody tr');
  check('hostile text in a manager’s filing renders as text', (await text('#view-funds h1')) === evil && (await text('#fnHoldTable')).includes(evil) && (await text('.fnNotes')).includes(evil) && await p.$$eval('#view-funds img, #view-funds script', (n) => n.length === 0) && await p.$$eval('#fnOne a[target=_blank], #fnHoldTable a', (n) => n.length === 0));
  check('nothing hostile ran', await p.evaluate(() => window.__pwned === undefined));
  check('a filing without a comparison says changes are not shown', /Changes are not shown/.test(await text('#fnChg')));
  stubs.clear();
}

// ----- failures, "off" and loading states -----
{
  stubs.set('funds', () => ({ status: 502, body: { error: 'A data source did not answer. Try again shortly.' } }));
  stubs.set('insiders/latest', () => ({ status: 502, body: { error: 'x' } }));
  stubs.set('fund', () => ({ status: 502, body: { error: 'x' } }));
  await fresh('#funds');
  check('502: the list says plainly that the SEC did not answer', await waitText('#fnMgr .emptyBox', /could not be loaded: the SEC’s filing system did not answer/) && await waitText('#fnInsBody .emptyBox', /latest insider filings could not be loaded/), await text('#fnMgr .emptyBox'));
  check('the caveats are still shown when nothing loads', /45 days/.test(await text('#fnCaveat')));
  await fresh('#funds/' + biggest.id);
  check('502: a manager page says so and offers to try again', await waitText('#fnState', /This manager’s filing could not be loaded/) && await p.$eval('#fnState button', (n) => n.textContent === 'Try again'));
  stubs.delete('fund');
  await p.click('#fnState button');
  check('“Try again” loads the manager once the source answers', await p.waitForSelector('#fnHoldTable tbody tr', { timeout: 6000 }).then(() => true, () => false));

  const OFF = [{ name: 'SEC EDGAR', state: 'off', note: 'Set SEC_USER_AGENT to your firm’s name and a contact email.' }];
  const blank = (m) => ({ id: m.id, name: m.name, marketMaker: m.marketMaker, state: 'off', note: null, period: null, filedAt: null, form: null, value: null, positions: null, optionPositions: null, url: null });
  stubs.set('funds', () => ({ body: { demo: false, at: Date.now(), sources: OFF, managers: funds.managers.map(blank), tracked: funds.managers.length, loaded: 0, pending: 0 } }));
  stubs.set('insiders/latest', () => ({ body: { demo: false, at: Date.now(), sources: OFF, transactions: [], detailsPending: 0 } }));
  stubs.set('fund', () => ({ body: { demo: false, at: Date.now(), sources: OFF, id: biggest.id, name: biggest.name, marketMaker: false, state: 'off', filing: null, previous: null, totals: null, holdings: [], options: [], changes: null, notes: [] } }));
  await fresh('#funds');
  await waitText('#fnMgr', /Not connected/);
  check('off: the list says the source is not connected, and shows no figures', /SEC EDGAR is not connected on this server: Set SEC_USER_AGENT/.test(await text('#fnMgr')) && await p.$$eval('#fnMgrTable tbody tr', (n) => n.every((r) => /Not connected/.test(r.textContent) && !/\$/.test(r.textContent))) && /SEC EDGAR is not connected/.test(await text('#fnInsBody')));
  await fresh('#funds/' + biggest.id);
  check('off: a manager page says holdings are not shown and why', await waitText('#fnState', /Holdings are not shown\. SEC EDGAR is not connected on this server/) && await p.$eval('#fnMain', (n) => n.hidden));

  let n = 0;
  const loading = (m, i) => (i === 0 ? { ...m } : { ...blank(m), state: 'loading' });
  stubs.set('funds', () => { n += 1; return { body: { demo: false, at: Date.now(), sources: [{ name: 'SEC EDGAR', state: 'ok', note: '' }], managers: n < 2 ? funds.managers.map(loading) : funds.managers, tracked: funds.managers.length, loaded: n < 2 ? 1 : funds.managers.length, pending: n < 2 ? funds.managers.length - 1 : 0 } }; });
  await fresh('#funds');
  await waitText('#fnMgr', /Still being read from the SEC/);
  check('loading: rows not yet read say so, and the page says how many', await p.$$eval('#fnMgrTable tbody tr', (r) => r.filter((x) => /Still being read from the SEC/.test(x.textContent)).length) === funds.managers.length - 1 && new RegExp((funds.managers.length - 1) + ' of ' + funds.managers.length + ' managers’ filings are still being read').test(await text('#fnMgr')));
  check('the page looks again by itself and fills the rows in', await p.waitForFunction(() => !/Still being read/.test(document.querySelector('#fnMgr').textContent), { timeout: 12000 }).then(() => true, () => false));
  stubs.clear();
}

// ----- nothing is fetched while the page is hidden -----
{
  await open('#funds');
  await p.waitForSelector('#fnMgrTable tbody tr');
  await open('#news');
  await sleep(300);
  const before = seen.filter((u) => /^(funds|fund\?|insiders)/.test(u)).length;
  await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await sleep(600);
  check('another page being open, nothing of Funds is fetched', seen.filter((u) => /^(funds|fund\?|insiders)/.test(u)).length === before);
}

// ----- the block on a company page -----
{
  const sym = one.holdings[0].symbol;
  const holders = await get('holders?symbol=' + sym), insiders = await get('insiders?symbol=' + sym);
  await open('#stocks/' + sym);
  await p.waitForSelector('#fnCoHolders table tbody tr');
  await p.waitForSelector('#fnCoInsiders');
  check('company page: “Who holds it and who is trading it” block', (await text('#tfOwnT')) === 'Who holds it and who is trading it' && await p.$$eval('#fnCoHolders tbody tr', (n, want) => n.length === want && n.every((r) => r.querySelector('a[href^="#funds/"]')), holders.holders.length), String(holders.holders.length));
  check('company page: the 13F caveat sits with the holders, with a link to the full one', /not every holder/.test(await text('#fnCoHolders')) && /months old/.test(await text('#fnCoHolders')) && await p.$eval('#fnCoHolders a.link', (a) => a.getAttribute('href') === '#funds'));
  check('company page: insider transactions', await p.$$eval('#fnCoInsiders tbody tr', (n, want) => n.length === want, Math.min(15, insiders.transactions.length)) && insiders.transactions.length > 0);
  check('company page: stakes above 5%', insiders.stakes.length ? await p.$$eval('#fnCoStakes .tfFiling', (n, want) => n.length === want, insiders.stakes.length) : /No Schedule 13D or 13G/.test(await text('#fnCoStakes')));
  await p.click('#fnCoHolders tbody tr th a');
  check('a holder links to its manager page', await p.waitForSelector('#fnHoldTable tbody tr', { timeout: 6000 }).then(() => true, () => false) && /^#funds\/\d{10}$/.test(await hash()));
  await shot('company-1440');
}

// ----- narrow screens -----
for (const [w, name] of [[768, '768'], [390, '390']]) {
  await p.setViewport({ width: w, height: 844 });
  await open('#funds');
  await p.waitForSelector('#fnMgrTable tbody tr');
  await p.waitForSelector('#fnInsTable tbody tr');
  check(`no sideways page scroll at ${name}px (list)`, (await sideways()) <= 0, String(await sideways()));
  check(`wide tables scroll inside their own box at ${name}px`, await p.$$eval('#view-funds .tableWrap', (n) => n.every((x) => x.getBoundingClientRect().right <= document.documentElement.clientWidth + 1)));
  await shot('funds-' + name);
  await open('#funds/' + biggest.id);
  await p.waitForSelector('#fnHoldTable tbody tr');
  check(`no sideways page scroll at ${name}px (manager)`, (await sideways()) <= 0, String(await sideways()));
  check(`tap targets are at least 40px tall at ${name}px`, await p.$$eval('#view-funds button, #view-funds .fnBack, #view-funds .tfSym', (n) => n.filter((x) => x.offsetParent).every((x) => x.getBoundingClientRect().height >= 40)));
  await shot('fund-' + name);
}
await open('#stocks/' + one.holdings[0].symbol);
await p.waitForSelector('#fnCoHolders table tbody tr');
check('no sideways page scroll at 390px (company page with the block)', (await sideways()) <= 0, String(await sideways()));

check('no script errors', errs.length === 0, errs.slice(0, 4).join(' || '));
log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
await b.close();
await svc.stop();
server.close();
process.exit(fails ? 1 : 0);
