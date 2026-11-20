// Browser test for the Voices page. Starts its own demo server on a free port and drives
// headless Chrome. A few answers are swapped for small hand-made ones (by intercepting the
// request) where a check needs a real link, a failure or hostile text.
//   CHROME_PATH=/path/to/chrome node test/e2e/voices.mjs      (SHOTS=dir saves screenshots)
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(...a);
let fails = 0;
const check = (name, ok, extra = '') => { if (!ok) fails++; log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? '  ' + extra : '')); };
const get = async (path) => (await fetch(BASE + '/api/voices' + path)).json();

const b = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
const errs = [];
const stubs = new Map();   // '' or 'latest' -> () => { status, body }
const seen = [];           // every /api/voices request the page made
const outside = [];        // any request to a host other than this server
const p = await b.newPage();
p.on('pageerror', (e) => errs.push('pageerror ' + e.message));
p.on('console', (m) => { if (m.type() === 'error' && !/fonts\.g|ERR_TUNNEL|net::ERR_FAILED|ERR_CONNECTION_REFUSED|ERR_NAME_NOT_RESOLVED|status of (400|429|502)/.test(m.text())) errs.push('console ' + m.text()); });
p.on('dialog', (d) => { errs.push('dialog opened: ' + d.message()); d.dismiss(); });
await p.setViewport({ width: 1440, height: 900 });
await p.setRequestInterception(true);
p.on('request', (req) => {
  const u = new URL(req.url());
  if (u.origin !== BASE && !/^(data|blob|about):/.test(req.url())) {
    if (!/fonts\.(googleapis|gstatic)\.com$/.test(u.hostname)) outside.push(req.url());
    return req.abort().catch(() => {});
  }
  if (u.pathname.startsWith('/api/voices')) {
    const name = u.pathname.slice('/api/voices'.length).replace(/^\//, '');
    seen.push(name + u.search);
    const r = stubs.has(name) ? stubs.get(name)(u) : null;
    if (r) return req.respond({ status: r.status || 200, contentType: 'application/json', body: JSON.stringify(r.body) }).catch(() => {});
  }
  req.continue().catch(() => {});
});
const shot = async (name) => { if (SHOTS) await p.screenshot({ path: SHOTS + '/' + name + '.png', fullPage: true }); };
// A full load, then the hash: what a visitor arriving by link gets.
const open = async (hash) => { await p.goto('about:blank'); await p.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' }); await p.evaluate((h) => { location.hash = h; }, hash); };
const text = (sel) => p.$eval(sel, (n) => n.textContent).catch(() => '');
const waitText = (sel, re, timeout = 6000) => p.waitForFunction((s, src) => { const n = document.querySelector(s); return n && new RegExp(src).test(n.textContent); }, { timeout }, sel, re.source).then(() => true, () => false);
const panel = () => p.evaluate(() => JSON.parse(localStorage.getItem('nt.xpanel') || '[]'));
const V = '#view-voices ';

const dir = await get('/');
const latest = await get('/latest');
const voices = dir.groups.flatMap((g) => g.voices.map((v) => ({ ...v, group: g.id })));
const withX = voices.filter((v) => v.x);

// ----- nothing is asked for until the page is opened -----
await p.goto(BASE + '/#home', { waitUntil: 'domcontentloaded' });
await sleep(600);
check('nothing is fetched for Voices while another page is showing', seen.length === 0, seen.join(' '));

// ----- render in demo -----
await p.evaluate(() => { location.hash = '#voices'; });
await p.waitForSelector(V + '.vcCard');
check('header in the house style', await p.$eval(V + '.breakHead', (n) => /Voices/.test(n.querySelector('.kicker').textContent) && n.querySelector('h1.display').textContent.length > 10));
const lede = await text(V + '.vcLede');
check('one sentence says what this is and is not', /reading list of public writing/.test(lede) && /author’s site/.test(lede) && /nothing here is Halftone’s view, a recommendation or advice/.test(lede) && /nobody is rated or ranked/.test(lede), lede.slice(0, 80));
check('demo is labelled as invented', /Demo: every writer, publication, handle and title below is invented/.test(await text(V + '.vcDemo')) && /Demo data/.test(await text(V + '.vcHeadNote')));
check('suggested panel offers eight handles and one button', await p.$$eval(V + '.vcSugList li', (n) => n.length) === 8 && /Add these 8 to My panel/.test(await text('#vcSugAdd')));
check('a chip per group, plus All', await p.$$eval(V + '.vcChip', (n) => n.map((x) => x.textContent + ':' + x.getAttribute('aria-pressed')).join('|')) === ['All:true'].concat(dir.groups.map((g) => g.name + ':false')).join('|'));
const stream = await p.$$eval(V + '.vcItem', (n) => n.map((x) => ({ who: x.querySelector('.vcMeta .strong').textContent, pub: x.querySelector('.vcMeta .muted').textContent, title: x.querySelector('.vcTitle').textContent, when: x.querySelector('time') && x.querySelector('time').getAttribute('datetime') })));
check('latest stream: who, where, title and when, newest first', stream.length === 14 && stream.every((s, i) => s.who === latest.items[i].name && s.pub === 'wrote in ' + latest.items[i].publication && s.title === latest.items[i].title && Date.parse(s.when) === latest.items[i].ts), stream.length + ' rows');
check('the stream says how much is shown and can show all', /14 of \d+/.test(await text(V + '.vcStreamBox .sideHead .muted')) && /Show all \d+/.test(await text(V + '.vcMore')));
await p.click(V + '.vcMore');
check('show all lists every piece', await p.$$eval(V + '.vcItem', (n) => n.length) === latest.items.length);
await p.click(V + '.vcMore');
const cards = await p.$$eval(V + '.vcCard', (n) => n.map((c) => ({ id: c.dataset.voice, name: c.querySelector('.vcName').textContent, pub: c.querySelector('.vcPub').textContent, covers: c.querySelector('.vcCovers').textContent, items: c.querySelectorAll('.vcCardItems li').length, add: Boolean(c.querySelector('button.vcAdd')), x: c.querySelector('.vcX') ? c.querySelector('.vcX').textContent : '' })));
check('directory: a card per voice with name, publication, what they cover and three newest pieces', cards.length === voices.length && cards.every((c) => { const v = voices.find((x) => x.id === c.id); return v && c.name === v.name && c.pub === v.publication && c.covers === 'Covers: ' + v.covers && c.items === 3; }));
check('a card has "Add to My panel" exactly when it has a handle', cards.every((c) => c.add === Boolean(voices.find((v) => v.id === c.id).x)));
check('demo handles and titles are never links', await p.$$eval(V + '.vcCard a, ' + V + '.vcItem a', (n) => n.length) === 0 && cards.filter((c) => c.x).every((c) => /placeholder/.test(c.x)));
check('each group has "Add all to My panel"', await p.$$eval(V + '.vcGroup', (n) => n.every((g) => g.querySelector('h3') && g.querySelector('.vcAddAll'))) && await p.$$eval(V + '.vcGroup', (n) => n.length) === dir.groups.length);
check('no opinions of our own: no ratings, ranks or bullish/bearish labels', !/\b(bullish|bearish|rating|rated \d|score|leaderboard|top call|buy|sell)\b/i.test((await text('#view-voices')).replace(/nobody is rated or ranked/, '')));
check('nothing outside this server is requested by the page', outside.length === 0, outside.slice(0, 3).join(' '));
await shot('voices-1440');

// ----- filters and search -----
const g2 = dir.groups[2];
await p.click(V + `.vcChip[data-group="${g2.id}"]`);
check('a group chip narrows the directory to that group', await p.$$eval(V + '.vcGroup', (n) => n.map((x) => x.dataset.group).join()) === g2.id && await p.$$eval(V + '.vcCard', (n) => n.length) === g2.voices.length);
const want = latest.items.filter((x) => x.group === g2.id);
check('and the stream to that group', (await p.$$eval(V + '.vcItem .vcTitle', (n) => n.map((x) => x.textContent))).join('|') === want.slice(0, 14).map((x) => x.title).join('|'));
check('the chosen chip is pressed and keeps keyboard focus', await p.evaluate((id) => document.activeElement.dataset.group === id && document.activeElement.getAttribute('aria-pressed') === 'true', g2.id));
check('filtering asks the server for nothing more', seen.length === 2, seen.join(' '));
await p.click(V + '.vcChip[data-group=""]');
const target = voices[4];
await p.type('#vcQ', target.name.split(' ')[0].toLowerCase());
check('search by name finds the writer', (await p.$$eval(V + '.vcCard', (n) => n.map((x) => x.dataset.voice))).join() === target.id && await p.$$eval(V + '.vcItem .vcMeta .strong', (n, nm) => n.length > 0 && n.every((x) => x.textContent === nm), target.name));
await p.$eval('#vcQ', (n) => { n.value = ''; });
const word = latest.items[3].title.split(' ').slice(0, 3).join(' ');
await p.type('#vcQ', word.toUpperCase());
check('search by title finds the piece, whatever the case', (await p.$$eval(V + '.vcItem .vcTitle', (n) => n.map((x) => x.textContent))).includes(latest.items[3].title) && await p.$$eval(V + '.vcCard', (n) => n.length) >= 1, word);
await p.$eval('#vcQ', (n) => { n.value = ''; });
await p.type('#vcQ', 'zzzz-no-such');
check('a search with no match says so in both places', /No piece matches/.test(await text(V + '.vcStreamBox .emptyBox')) && /No writer or title matches/.test(await text(V + '.vcDirBox .emptyBox')) && await p.$$eval(V + '.vcCard', (n) => n.length) === 0);
await p.$eval('#vcQ', (n) => { n.value = ''; n.dispatchEvent(new Event('input', { bubbles: true })); });
check('clearing the search brings everything back', await p.$$eval(V + '.vcCard', (n) => n.length) === voices.length);

// ----- add to My panel, then see it there -----
const first = withX[0];
const btn = V + `.vcCard[data-voice="${first.id}"] button.vcAdd`;
await p.focus(btn);
await p.keyboard.press('Enter');
const msg1 = await text(V + `.vcCard[data-voice="${first.id}"] .vcMsg`);
check('adding a handle says so, with the count', msg1 === `@${first.x} added to My panel (1 of 20).`, msg1);
check('it is saved in the same format My panel uses', JSON.stringify(await panel()) === JSON.stringify([first.x]));
check('the button shows the account is in the panel', /In My panel/.test(await text(btn)) && await p.$eval(btn, (n) => n.classList.contains('on')));
check('the status line is announced to screen readers', await p.$eval(V + `.vcCard[data-voice="${first.id}"] .vcMsg`, (n) => n.getAttribute('role') === 'status'));
await p.click(btn);
check('adding it again says it is already there', (await text(V + `.vcCard[data-voice="${first.id}"] .vcMsg`)) === `@${first.x} is already in your panel.` && (await panel()).length === 1);
// By the nav link, without a reload: the panel that was already loaded must know about it.
await p.click('.tabs a[data-view="panel"]');
await p.waitForSelector('#xpList .xpAcct');
check('open My panel and the account is there', (await p.$$eval('#xpList .xpAcct b', (n) => n.map((x) => x.textContent))).join() === '@' + first.x && /1 of 20/.test(await text('#xpCount')), await text('#xpList'));
// And the two pages stay in step: an account added on the panel page does not wipe ours.
await p.type('#xpInput', 'hftdemo_typed');
await p.keyboard.press('Enter');
check('an account then added on the panel page keeps the one added from Voices', JSON.stringify(await panel()) === JSON.stringify([first.x, 'hftdemo_typed']));
check('the panel box was left as the viewer had it', await p.$eval('#xpInput', (n) => n.value) === '' && await text('#xpErr') === '');
await p.click('#xpList .xpAcct:last-child .xpRemove');
await p.click('.tabs a[data-view="voices"]');
await p.waitForSelector(V + '.vcCard');

// group and suggested
const g0 = dir.groups[0], g0x = g0.voices.filter((v) => v.x).map((v) => v.x);
await p.click(V + `.vcGroup[data-group="${g0.id}"] .vcAddAll`);
const msgG = await text(V + `.vcGroup[data-group="${g0.id}"] > .vcMsg`);
check('"Add all" reports how many were added and how many were already there', msgG === `Added ${g0x.length - 1} of ${g0x.length} to My panel (${g0x.length} of 20). 1 was already there.`, msgG);
await p.click('#vcSugAdd');
const sugX = dir.suggested.map((s) => s.x), newOnes = sugX.filter((x) => !g0x.includes(x)).length;
const msgS = await text(V + '.vcSug .vcMsg');
check('the suggested panel adds its eight in one click', msgS.startsWith(`Added ${newOnes} of 8 to My panel (${g0x.length + newOnes} of 20).`) && (await panel()).length === g0x.length + newOnes, msgS);
check('"Open My panel" goes to the panel', await p.$eval(V + '.vcSugActs a', (n) => n.getAttribute('href')) === '#panel');

// ----- panel full -----
const filler = Array.from({ length: 19 }, (_, i) => 'filler_acct_' + i);
await p.evaluate((list) => localStorage.setItem('nt.xpanel', JSON.stringify(list)), filler);
await open('#voices');
await p.waitForSelector(V + '.vcCard');
const g1 = dir.groups[1], g1x = g1.voices.filter((v) => v.x).map((v) => v.x);
await p.click(V + `.vcGroup[data-group="${g1.id}"] .vcAddAll`);
const msgF = await text(V + `.vcGroup[data-group="${g1.id}"] > .vcMsg`);
check('"Add all" respects the limit of 20 and says what was left out', msgF === `Added 1 of ${g1x.length} to My panel (20 of 20). The panel is full, so ${g1x.length - 1} ${g1x.length - 1 === 1 ? 'was' : 'were'} left out.` && (await panel()).length === 20, msgF);
const other = withX.find((v) => v.group === dir.groups[2].id);
await p.click(V + `.vcCard[data-voice="${other.id}"] button.vcAdd`);
const msgFull = await text(V + `.vcCard[data-voice="${other.id}"] .vcMsg`);
check('a full panel says so and adds nothing', msgFull === 'My panel is full (20 of 20). Remove an account there to add another.' && (await panel()).length === 20 && !(await panel()).includes(other.x), msgFull);
// A damaged list is treated as My panel treats it: empty, not an error.
await p.evaluate(() => localStorage.setItem('nt.xpanel', '{"not":"a list"'));
await open('#voices');
await p.waitForSelector(V + '.vcCard');
await p.click(V + `.vcCard[data-voice="${other.id}"] button.vcAdd`);
check('a damaged saved list is started again, not a crash', JSON.stringify(await panel()) === JSON.stringify([other.x]));
await p.evaluate(() => localStorage.removeItem('nt.xpanel'));

// ----- real links, and hostile text from a feed -----
const NASTY = '<img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script> & "quoted" title';
const mk = (over) => ({ id: 'safe-one', name: 'Plain Writer', publication: 'Plain Letter', covers: 'Rates', x: 'plain_writer', site: 'https://plain-letter.example.org/', state: 'ok', checkedAt: Date.now(), items: [], ...over });
const item = (title, url, ts, excerpt = '') => ({ title, url, ts, excerpt });
const now = Date.now();
const hostile = {
  demo: false, at: now, sources: [{ name: "Authors' own public feeds", state: 'ok', note: '<b>2 of 3</b> feeds read.' }], panel: { max: 20 },
  suggested: [{ id: 'safe-one', name: '<i>Plain</i> Writer', publication: 'Plain Letter', x: 'plain_writer' }, { id: 'bad', name: 'Bad Handle', publication: 'x', x: 'not a handle"><img src=x>' }],
  groups: [{ id: 'macro', name: 'Macro <script>window.__pwned=3</script>', voices: [
    mk({ items: [item('A real piece', 'https://plain-letter.example.org/p/1', now - 3600000), item(NASTY, 'https://plain-letter.example.org/p/2', now - 7200000)] }),
    mk({ id: 'evil', name: NASTY, publication: '<svg onload="window.__pwned=4">', covers: '"><img src=x onerror="window.__pwned=5">', x: 'evil"onclick="x', site: 'javascript:window.__pwned=6', state: 'error', items: [item('Link is script', 'javascript:window.__pwned=7', now), item('Link is data', 'data:text/html,<script>window.__pwned=8</script>', now), item('Link has a quote', 'https://a.example.org/"onmouseover="window.__pwned=9', now)] }),
    mk({ id: 'quiet', name: 'No Feed Desk', publication: 'Quiet', x: null, state: 'nofeed', items: [] }),
    { id: '../../etc', name: 'Bad id', publication: 'x', covers: 'x', items: [] }, null, 'string', 42
  ] }, null, { id: 'BAD ID', name: 'x', voices: [] }]
};
const hostileLatest = { demo: false, at: now, sources: hostile.sources, group: null, items: [
  { voice: 'safe-one', name: 'Plain Writer', publication: 'Plain Letter', group: 'macro', ...item('A real piece', 'https://plain-letter.example.org/p/1', now - 3600000, 'Its public subtitle.') },
  { voice: 'evil', name: NASTY, publication: '<svg onload="window.__pwned=4">', group: 'macro', ...item(NASTY, 'javascript:window.__pwned=10', now - 60000, '<img src=x onerror="window.__pwned=11">') },
  null, 'x', { title: 12, url: 12, ts: 'soon' }
] };
stubs.set('', () => ({ body: hostile }));
stubs.set('latest', () => ({ body: hostileLatest }));
await open('#voices');
await p.waitForSelector(V + '.vcCard[data-voice="evil"]');
await sleep(300);
check('hostile text from a feed runs nothing', await p.evaluate(() => window.__pwned === undefined));
check('and adds no elements: it is shown as the text it is', await p.$$eval('#view-voices img, #view-voices script, #view-voices svg, #view-voices i, #view-voices [onerror], #view-voices [onclick], #view-voices [onmouseover]', (n) => n.length) === 0 && (await p.$eval(V + '.vcCard[data-voice="evil"] .vcName', (n) => n.textContent)) === NASTY.slice(0, 80) && (await p.$$eval(V + '.vcItem .vcTitle', (n) => n.map((x) => x.textContent))).includes(NASTY));
const hrefs = await p.$$eval('#view-voices a', (n) => n.map((a) => a.getAttribute('href')));
check('only http(s) links become links', hrefs.every((h) => /^https:\/\/(plain-letter\.example\.org\/|x\.com\/plain_writer$)/.test(h) || h === '#panel') && await p.$$eval(V + '.vcCard[data-voice="evil"] a', (n) => n.length) === 0, hrefs.join(' '));
check('a title with a bad link is plain text', await p.$$eval(V + '.vcCard[data-voice="evil"] .vcCardItems span.vcTitle', (n) => n.length) === 3);
check('an unusable handle gets no button and no X link', await p.$$eval(V + '.vcCard[data-voice="evil"] button', (n) => n.length) === 0 && await p.$$eval(V + '.vcSugList li', (n) => n.length) === 1);
const real = await p.$eval(V + '.vcItem a.vcTitle', (a) => ({ href: a.href, target: a.target, rel: a.rel, text: a.textContent }));
check('a real piece links to the author in a new tab with rel="noopener noreferrer"', real.href === 'https://plain-letter.example.org/p/1' && real.target === '_blank' && real.rel === 'noopener noreferrer' && real.text === 'A real piece');
check('every outside link on the page opens that way', await p.$$eval('#view-voices a[href^="http"]', (n) => n.length >= 4 && n.every((a) => a.target === '_blank' && a.rel === 'noopener noreferrer')));
check('the X profile link is built from the checked handle', await p.$eval(V + '.vcCard[data-voice="safe-one"] a.vcX', (a) => a.href === 'https://x.com/plain_writer' && /@plain_writer on X/.test(a.textContent)));
check('the site link shows the host', await p.$eval(V + '.vcCard[data-voice="safe-one"] a.vcSite', (a) => a.textContent === 'plain-letter.example.org'));
check('a public excerpt is shown as text under its title', (await p.$$eval(V + '.vcExcerpt', (n) => n.map((x) => x.textContent))).join('|') === 'Its public subtitle.|<img src=x onerror="window.__pwned=11">');
check('a feed that failed, and a voice with no feed, each say so plainly', /could not be read just now/.test(await text(V + '.vcCard[data-voice="evil"] .vcState')) && /No public feed on file/.test(await text(V + '.vcCard[data-voice="quiet"] .vcState')));
check('entries that are not entries are left out', (await p.$$eval(V + '.vcCard', (n) => n.map((x) => x.dataset.voice))).join() === 'safe-one,evil,quiet' && await p.$$eval(V + '.vcItem', (n) => n.length) === 2);
check('live data is not labelled demo, and names its source', await p.$eval(V + '.vcDemo', (n) => n.hidden) && /Source: authors' own public feeds · <b>2 of 3<\/b> feeds read\./.test(await text(V + '.vcHeadNote')));

// ----- 502 -----
const fail = () => ({ status: 502, body: { error: "The authors' feeds could not be read just now. Try again shortly." } });
stubs.set('', fail); stubs.set('latest', fail);
await open('#voices');
check('a 502 shows a plain message', await waitText(V + '.vcErr', /Voices could not be loaded\. The authors' feeds could not be read just now\. Try again shortly\./) && await p.$eval(V + '.vcErr', (n) => !n.hidden && n.getAttribute('role') === 'alert'), (await text(V + '.vcErr')) + ' | ' + seen.slice(-3).join(','));
check('and no half-drawn page or endless "Loading"', await p.$$eval(V + '.vcCard, ' + V + '.vcItem', (n) => n.length) === 0 && !/Loading/.test(await text('#view-voices')) && !/undefined|null|NaN|\[object/.test(await text('#view-voices')));
stubs.set('', () => ({ status: 502, body: '<html>Bad gateway</html>' }));
await open('#voices');
check('a 502 that is not JSON still gets a sentence', await waitText(V + '.vcErr', /Voices could not be loaded\. HTTP 502/));
stubs.clear();

// ----- hidden means quiet -----
await open('#voices');
await p.waitForSelector(V + '.vcCard');
await p.evaluate(() => { location.hash = '#status'; });
const before = seen.length;
await sleep(1200);
check('leaving the page stops its requests', seen.length === before, String(seen.length - before));
check('only the two documented endpoints were ever asked for', seen.every((s) => s === '' || s === 'latest'), [...new Set(seen)].join(' '));

// ----- keyboard and layout -----
await open('#voices');
await p.waitForSelector(V + '.vcCard');
await p.focus('#vcQ');
await p.keyboard.press('Tab');
check('focus is visible when moving by keyboard', await p.evaluate(() => { const n = document.activeElement, s = getComputedStyle(n); return document.getElementById('view-voices').contains(n) && n.tagName === 'BUTTON' && n.matches(':focus-visible') && s.outlineStyle === 'solid' && parseFloat(s.outlineWidth) >= 2; }));
const sizes = async () => p.$$eval('#view-voices button, #view-voices a, #view-voices input', (n) => n.filter((x) => x.offsetParent !== null).map((x) => { const r = x.getBoundingClientRect(); return { t: (x.textContent || x.placeholder).slice(0, 30), h: Math.round(r.height), w: Math.round(r.width) }; }).filter((r) => r.h < 40 || r.w < 40));
const scrolls = () => p.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
let small = await sizes();
check('1440px: tap targets are at least 40px', small.length === 0, JSON.stringify(small.slice(0, 4)));
let sw = await scrolls();
check('1440px: no sideways scroll', sw.doc <= sw.win, JSON.stringify(sw));
check('1440px: stream and directory sit side by side', await p.evaluate(() => { const a = document.querySelector('.vcStreamBox').getBoundingClientRect(), d = document.querySelector('.vcDirBox').getBoundingClientRect(); return d.left >= a.right && Math.abs(a.top - d.top) < 4; }));
for (const w of [768, 390]) {
  await p.setViewport({ width: w, height: 844 });
  await open('#voices');
  await p.waitForSelector(V + '.vcCard');
  await sleep(150);
  sw = await scrolls();
  check(w + 'px: no sideways scroll', sw.doc <= sw.win, JSON.stringify(sw));
  small = await sizes();
  check(w + 'px: tap targets are at least 40px', small.length === 0, JSON.stringify(small.slice(0, 4)));
  check(w + 'px: nothing in the view is wider than the screen', await p.$$eval('#view-voices *', (n, width) => n.filter((x) => x.getBoundingClientRect().right > width + 1).length, w) === 0);
  await shot('voices-' + w);
}
// The stubbed live page too, at phone width: long hostile strings must wrap.
stubs.set('', () => ({ body: hostile })); stubs.set('latest', () => ({ body: hostileLatest }));
await open('#voices');
await p.waitForSelector(V + '.vcCard[data-voice="evil"]');
sw = await scrolls();
check('390px: long unbroken text from a feed wraps', sw.doc <= sw.win, JSON.stringify(sw));
await shot('voices-390-live-stub');
await p.setViewport({ width: 1440, height: 900 });
await open('#voices');
await p.waitForSelector(V + '.vcCard[data-voice="evil"]');
await shot('voices-1440-live-stub');
stubs.clear();

check('no script errors', errs.length === 0, errs.slice(0, 4).join(' || '));
log(fails ? `\n${fails} FAILED` : '\nALL PASSED');
await b.close();
await svc.stop();
server.close();
process.exit(fails ? 1 : 0);
