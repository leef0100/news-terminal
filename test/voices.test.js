// Voices (`/api/voices`): the reading list in config/voices.json, the feed poller against
// stand-in feeds, the router, and the demo list. Nothing here touches the network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import express from 'express';
import { createVoices } from '../src/voices/index.js';
import { loadConfig, validateConfig, HANDLE_RE } from '../src/voices/config.js';
import { createVoicePoller, excerptOf, httpLink, descriptionsOf, KEEP } from '../src/voices/poller.js';
import { DEMO_VOICES, DEMO_GROUPS, DEMO_SUGGESTED } from '../src/voices/demo.js';

const quiet = { warn() {}, log() {}, error() {} };
const NOW = Date.UTC(2026, 10, 19, 16, 0, 0);
const raw = JSON.parse(readFileSync(new URL('../config/voices.json', import.meta.url), 'utf8'));

// ---------------------------------------------------------------------------- the list
test('config: well-formed, unique, https only, handles valid', () => {
  const cfg = loadConfig();
  assert.ok(cfg.voices.length >= 25 && cfg.voices.length <= 40, 'between 25 and 40 entries');
  const uniq = (list, what) => assert.equal(new Set(list).size, list.length, what + ' repeat');
  uniq(cfg.voices.map((v) => v.id), 'ids');
  uniq(cfg.voices.filter((v) => v.x).map((v) => v.x.toLowerCase()), 'handles');
  uniq(cfg.voices.filter((v) => v.feed).map((v) => v.feed.toLowerCase()), 'feeds');
  uniq(cfg.voices.map((v) => v.site.toLowerCase()), 'sites');
  uniq(cfg.voices.map((v) => (v.name + '|' + v.publication).toLowerCase()), 'name and publication');
  const groups = new Set(cfg.groups.map((g) => g.id));
  for (const v of raw.voices) {
    assert.match(v.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(groups.has(v.group), v.id + ' group');
    if (v.x !== undefined) assert.match(v.x, /^[A-Za-z0-9_]{1,15}$/, v.id + ' handle');
    for (const k of ['feed', 'site']) if (v[k] !== undefined) assert.equal(new URL(v[k]).protocol, 'https:', v.id + ' ' + k);
    assert.ok(v.site, v.id + ' site');
    assert.ok(v.name && v.publication && v.covers && v.covers.length <= 120, v.id + ' text');
    assert.match(v.verified, /2026-\d\d-\d\d/, v.id + ' says when it was checked');
    // Only the fields the brief allows: nothing personal has anywhere to live.
    assert.deepEqual(Object.keys(v).filter((k) => !['id', 'name', 'publication', 'group', 'covers', 'x', 'feed', 'site', 'verified', 'excerpt'].includes(k)), [], v.id + ' extra fields');
    // Neutral descriptions: no verdicts on anyone.
    assert.doesNotMatch(v.covers, /\b(bull|bear|best|top|legend|genius|guru|famous|called|predicted)/i, v.id + ' covers is neutral');
  }
  for (const g of cfg.groups) assert.ok(cfg.voices.some((v) => v.group === g.id), g.id + ' has entries');
  assert.equal(cfg.suggested.length, 8);
  for (const id of cfg.suggested) assert.ok(cfg.voices.find((v) => v.id === id).x, id + ' has a handle');
  assert.ok(cfg.voices.some((v) => v.id === 'citrini' && v.feed === 'https://www.citriniresearch.com/feed'));
  assert.ok(cfg.pollMinutes >= 15);
});

test('config: bad entries are refused', () => {
  const base = () => JSON.parse(JSON.stringify({ groups: raw.groups, voices: raw.voices.slice(0, 2), suggested: [] }));
  const broken = (edit) => { const c = base(); edit(c); return () => validateConfig(c); };
  assert.doesNotThrow(() => validateConfig(base()));
  assert.throws(broken((c) => { c.voices[0].feed = 'http://plain.example.org/feed'; }), /feed must be an https/);
  assert.throws(broken((c) => { c.voices[0].feed = 'https://127.0.0.1/feed'; }), /feed must be an https/);
  assert.throws(broken((c) => { c.voices[0].feed = 'https://localhost/feed'; }), /feed must be an https/);
  assert.throws(broken((c) => { c.voices[0].feed = 'https://user:pw@site.org/feed'; }), /feed must be an https/);
  assert.throws(broken((c) => { c.voices[0].feed = 'https://site.org:8443/feed'; }), /feed must be an https/);
  assert.throws(broken((c) => { c.voices[0].site = 'javascript:alert(1)'; }), /site must be an https/);
  assert.throws(broken((c) => { c.voices[0].x = '@name'; }), /x must be a handle/);
  assert.throws(broken((c) => { c.voices[0].x = 'sixteen_chars_xx'; }), /x must be a handle/);
  assert.throws(broken((c) => { c.voices[1].id = c.voices[0].id; }), /id repeats/);
  assert.throws(broken((c) => { c.voices[1].feed = c.voices[0].feed; }), /feed repeats/);
  assert.throws(broken((c) => { c.voices[0].group = 'nope'; }), /unknown group/);
  assert.throws(broken((c) => { delete c.voices[0].verified; }), /verified/);
  assert.throws(broken((c) => { c.pollMinutes = 1; }), /pollMinutes/);
  assert.throws(broken((c) => { c.suggested = ['missing']; }), /suggested/);
});

// ---------------------------------------------------------------------------- the poller
const VOICE = (over = {}) => ({ id: 'one', name: 'Writer One', publication: 'Pub One', group: 'g', covers: 'c', x: null, feed: 'https://www.pub-one.org/feed', site: 'https://www.pub-one.org/', excerpt: true, ...over });
const rssItem = (n, { link, date, desc, title, extra = '' } = {}) => `<item><title>${title ?? 'Piece ' + n}</title><link>${link ?? 'https://www.pub-one.org/p/' + n}</link><guid>g${n}</guid>${date === null ? '' : `<pubDate>${new Date(date ?? NOW - n * 3600000).toUTCString()}</pubDate>`}${desc === undefined ? '' : `<description><![CDATA[${desc}]]></description>`}${extra}</item>`;
const rss = (items) => `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>Pub</title>${items.join('')}</channel></rss>`;
const headers = (h = {}) => ({ get: (k) => h[k.toLowerCase()] ?? null });
const answer = (body, { status = 200, h = {} } = {}) => ({ status, ok: status >= 200 && status < 300, headers: headers(h), text: async () => body });
function rig(voices, respond, tuning = {}) {
  const clock = { t: NOW };
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, init }); return respond(url, init, calls.length); };
  const poller = createVoicePoller({ voices, fetchImpl, now: () => clock.t, log: quiet, userAgent: 'Halftone-Voices/test', tuning });
  return { poller, calls, clock };
}

test('poller: conditional requests, a descriptive User-Agent, and no more often than every 15 minutes', async () => {
  const v = VOICE();
  const { poller, calls, clock } = rig([v], (_u, init, n) => (n === 1
    ? answer(rss([rssItem(1), rssItem(2)]), { h: { etag: '"abc"', 'last-modified': 'Thu, 19 Nov 2026 10:00:00 GMT' } })
    : init.headers['if-none-match'] === '"abc"' ? answer('', { status: 304 }) : answer(rss([]))));
  await poller.pollDue();
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, v.feed);
  assert.match(calls[0].init.headers['user-agent'], /Halftone-Voices/);
  assert.equal(calls[0].init.redirect, 'manual');
  assert.equal(calls[0].init.headers['if-none-match'], undefined);
  assert.equal(poller.view(v).items.length, 2);

  // Asked again at once, and again a minute short of the interval: nothing goes out.
  await poller.pollDue();
  clock.t += 14 * 60000;
  await poller.pollDue();
  assert.equal(calls.length, 1);
  // A tuning value below 15 minutes cannot shorten the interval.
  assert.equal(createVoicePoller({ voices: [v], tuning: { intervalMs: 1000 }, userAgent: 'x' }).intervalMs, 15 * 60000);

  clock.t += 60000;
  await poller.pollDue();
  assert.equal(calls.length, 2);
  assert.equal(calls[1].init.headers['if-none-match'], '"abc"');
  assert.equal(calls[1].init.headers['if-modified-since'], 'Thu, 19 Nov 2026 10:00:00 GMT');
  // 304: the items already held stay, and the feed still counts as read.
  assert.equal(poller.view(v).items.length, 2);
  assert.equal(poller.view(v).state, 'ok');
  assert.equal(poller.view(v).checkedAt, clock.t);
});

test('poller: a failing feed keeps its items, is marked, and is left alone for longer each time', async () => {
  const a = VOICE(), b = VOICE({ id: 'two', publication: 'Pub Two', feed: 'https://pub-two.org/rss/', site: 'https://pub-two.org/' });
  let fail = false;
  const { poller, calls, clock } = rig([a, b], (url) => {
    if (url === b.feed) return answer(rss([rssItem(9, { link: 'https://pub-two.org/p/9' })]));
    if (fail) return answer('nope', { status: 500 });
    return answer(rss([rssItem(1)]));
  });
  await poller.pollDue();
  assert.equal(poller.view(a).state, 'ok');
  fail = true;
  clock.t += 15 * 60000;
  await poller.pollDue();
  assert.equal(poller.view(a).state, 'error');
  assert.equal(poller.view(a).items.length, 1, 'last good items stay');
  assert.equal(poller.view(b).state, 'ok', 'one failing feed does not touch another');
  assert.deepEqual(poller.failing().map((f) => [f.voice.id, f.lastError]), [['one', 'HTTP 500']]);
  assert.equal(poller.counts().error, 1);

  // Second failure in a row: the wait doubles to 30 minutes.
  const before = calls.filter((c) => c.url === a.feed).length;
  clock.t += 15 * 60000;
  await poller.pollDue();
  assert.equal(calls.filter((c) => c.url === a.feed).length, before + 1);
  clock.t += 15 * 60000;
  await poller.pollDue();
  assert.equal(calls.filter((c) => c.url === a.feed).length, before + 1, 'not asked again after only 15 minutes');
  fail = false;
  clock.t += 15 * 60000;
  await poller.pollDue();
  assert.equal(poller.view(a).state, 'ok');
  assert.equal(poller.failing().length, 0);
});

test('poller: a thrown network error, an HTML page and a DOCTYPE feed are failures, not empty feeds', async () => {
  const mk = (id) => VOICE({ id, publication: id, feed: `https://${id}.org/feed`, site: `https://${id}.org/` });
  const vs = [mk('thrown'), mk('html'), mk('doctype'), mk('huge')];
  const { poller } = rig(vs, (url) => {
    if (url.includes('thrown')) throw Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } });
    if (url.includes('html')) return answer('<html><body>Sign in</body></html>');
    if (url.includes('doctype')) return answer('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "aaaa">]><rss><channel><item><title>&a;</title><link>https://doctype.org/1</link></item></channel></rss>');
    return answer(rss([rssItem(1)]) + ' '.repeat(600), { h: { 'content-length': '999999999' } });
  }, { maxBytes: 500 });
  await poller.pollDue();
  for (const v of vs) { assert.equal(poller.view(v).state, 'error', v.id); assert.equal(poller.view(v).items.length, 0, v.id); }
  assert.match(poller.failing().find((f) => f.voice.id === 'thrown').lastError, /ENOTFOUND/);
});

test('poller: keeps the newest 10, newest first; nothing is from the future', async () => {
  const v = VOICE();
  const items = Array.from({ length: 25 }, (_, i) => rssItem(i + 1));
  items.push(rssItem(99, { date: NOW + 7 * 86400000 }), rssItem(98, { date: null }));
  const { poller } = rig([v], () => answer(rss(items.reverse())));
  await poller.pollDue();
  const got = poller.view(v).items;
  assert.equal(KEEP, 10);
  assert.equal(got.length, 10);
  assert.equal(got[0].title, 'Piece 99');
  assert.equal(got[0].ts, NOW, 'a date in the future is pulled back to now');
  assert.deepEqual(got.slice(1).map((x) => x.title), Array.from({ length: 9 }, (_, i) => 'Piece ' + (i + 1)));
  assert.ok(got.every((x, i) => i === 0 || got[i - 1].ts >= x.ts));
  assert.deepEqual(Object.keys(got[0]).sort(), ['excerpt', 'id', 'title', 'ts', 'url']);
});

test('poller: excerpts are the feed\'s own description, stripped and capped; the body is never kept', async () => {
  const v = VOICE();
  const long = '<p>' + 'Markets moved because of several things at once. '.repeat(12) + '</p>';
  const { poller } = rig([v], () => answer(rss([
    rssItem(1, { desc: '<p>Short <b>public</b> subtitle &amp; more&nbsp;here</p><script>alert(1)</script><img src=x onerror=alert(2)>' }),
    rssItem(2, { desc: long, extra: '<content:encoded><![CDATA[<p>FULL BODY TEXT THAT MUST NOT BE KEPT</p>]]></content:encoded>' }),
    rssItem(3, { extra: '<content:encoded><![CDATA[<p>BODY ONLY, NO DESCRIPTION</p>]]></content:encoded>' }),
    rssItem(4, { title: 'Same as title', desc: 'Same as title' }),
    rssItem(5, { title: 'Yields &lt; 4% &amp; falling &lt;script&gt;x&lt;/script&gt;', desc: '&lt;b&gt;escaped&lt;/b&gt; markup' })
  ])));
  await poller.pollDue();
  const by = Object.fromEntries(poller.view(v).items.map((x) => [x.url.split('/').pop(), x]));
  assert.equal(by['1'].excerpt, 'Short public subtitle & more here');
  assert.ok(by['2'].excerpt.length <= 200 && by['2'].excerpt.endsWith('…'), String(by['2'].excerpt.length));
  assert.equal(by['3'].excerpt, '');
  assert.equal(by['4'].excerpt, '');
  assert.doesNotMatch(JSON.stringify(poller.view(v)), /FULL BODY|BODY ONLY|<p>|<script|onerror/);
  // Text that merely looks like markup after decoding stays text; the page sets textContent.
  assert.equal(typeof by['5'].title, 'string');

  // Switched off for an entry that asks for no excerpts.
  const quietOne = VOICE({ excerpt: false });
  const r2 = rig([quietOne], () => answer(rss([rssItem(1, { desc: 'A description' })])));
  await r2.poller.pollDue();
  assert.equal(r2.poller.view(quietOne).items[0].excerpt, '');
});

test('excerptOf, httpLink and descriptionsOf', () => {
  assert.equal(excerptOf('<div>a<br/>b</div>\n\n c &#8217; &#x41; &unknown;'), 'a b c ’ A &unknown;');
  assert.equal(excerptOf('x'.repeat(500)).length, 200);
  assert.equal(excerptOf('<style>p{}</style><!-- c -->Yields < 4% today'), 'Yields < 4% today');
  assert.equal(excerptOf(null), '');
  assert.equal(httpLink('https://a.org/p?x=1#y'), 'https://a.org/p?x=1#y');
  assert.equal(httpLink('http://a.org/p'), 'http://a.org/p');
  for (const bad of ['javascript:alert(1)', 'data:text/html,x', 'ftp://a.org/x', '//a.org/x', '/relative', '', null, 'https://a.org/"onmouseover="x', 'https://u:p@a.org/', 'https://a.org/ b', 'x'.repeat(700)]) assert.equal(httpLink(bad), null, String(bad).slice(0, 30));
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link rel="alternate" href="https://a.org/1"/><summary type="html">&lt;p&gt;Sum&lt;/p&gt;</summary><content type="html">BODY</content></entry></feed>';
  assert.deepEqual([...descriptionsOf(atom)], [['https://a.org/1', '<p>Sum</p>']]);
  assert.equal(descriptionsOf('not xml <<<').size, 0);
});

test('poller: only http(s) links are passed on', async () => {
  const v = VOICE();
  const { poller } = rig([v], () => answer(rss([
    rssItem(1, { link: 'javascript:alert(1)' }), rssItem(2, { link: 'data:text/html,hi' }), rssItem(3, { link: '' }),
    rssItem(4, { link: 'https://www.pub-one.org/p/ok' }), rssItem(5, { link: 'http://www.pub-one.org/p/plain' }), rssItem(6, { link: 'file:///etc/passwd' })
  ])));
  await poller.pollDue();
  assert.deepEqual(poller.view(v).items.map((x) => x.url).sort(), ['http://www.pub-one.org/p/plain', 'https://www.pub-one.org/p/ok']);
});

test('poller: nothing is fetched outside the config; redirects stay on the feed\'s own host', async () => {
  const a = VOICE();
  const b = VOICE({ id: 'two', publication: 'Pub Two', feed: 'https://pub-two.org/feed', site: 'https://pub-two.org/' });
  const c = VOICE({ id: 'three', publication: 'Pub Three', feed: 'https://pub-three.org/feed', site: 'https://pub-three.org/' });
  const none = VOICE({ id: 'nofeed', publication: 'No Feed', feed: null, site: 'https://nofeed.org/' });
  const { poller, calls } = rig([a, b, c, none], (url) => {
    // An item that links to an internal address must never cause a request to it.
    if (url === a.feed) return answer(rss([rssItem(1, { link: 'http://169.254.169.254/latest/meta-data', desc: '<img src="http://10.0.0.1/x">' })]));
    if (url === b.feed) return answer('', { status: 302, h: { location: 'http://169.254.169.254/feed' } });
    if (url === c.feed) return answer('', { status: 301, h: { location: 'https://www.pub-three.org/feed.xml' } });
    if (url === 'https://www.pub-three.org/feed.xml') return answer(rss([rssItem(3, { link: 'https://pub-three.org/p/3' })]));
    throw new Error('unexpected request: ' + url);
  });
  await poller.pollDue();
  const allowed = new Set([a.feed, b.feed, c.feed, 'https://www.pub-three.org/feed.xml']);
  assert.ok(calls.length === 4 && calls.every((x) => allowed.has(x.url)), calls.map((x) => x.url).join(' '));
  assert.equal(poller.view(b).state, 'error');
  assert.match(poller.failing()[0].lastError, /redirected away/);
  assert.equal(poller.view(c).items.length, 1, 'www. on the same host is followed');
  assert.equal(poller.view(none).state, 'nofeed');
  assert.equal(poller.feeds, 3);
});

test('poller: a few at a time, and a cap on requests per hour', async () => {
  const vs = Array.from({ length: 12 }, (_, i) => VOICE({ id: 'v' + i, publication: 'P' + i, feed: `https://p${i}.org/feed`, site: `https://p${i}.org/` }));
  let live = 0, peak = 0;
  const { poller, calls } = rig(vs, async () => {
    live += 1; peak = Math.max(peak, live);
    await new Promise((r) => setTimeout(r, 5));
    live -= 1;
    return answer(rss([rssItem(1)]));
  }, { perHour: 8 });
  const [x, y] = [poller.pollDue(), poller.pollDue()];
  assert.equal(x, y, 'a round under way is joined, not doubled');
  await x;
  assert.ok(peak <= 3, 'at most three at once, saw ' + peak);
  assert.equal(calls.length, 8, 'the hourly cap stops the round');
  assert.equal(poller.counts().waiting, 4);
  assert.equal(poller.counts().refused, 1);
});

// ---------------------------------------------------------------------------- the router
async function serve(options) {
  const voices = createVoices({ log: quiet, now: () => NOW, ...options });
  const app = express();
  app.use('/api/voices', voices.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/voices${path}`);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { voices, get, close: () => { voices.stop(); return new Promise((r) => server.close(r)); } };
}
const SMALL = validateConfig({
  groups: [{ id: 'macro', name: 'Macro' }, { id: 'crypto', name: 'Crypto' }],
  suggested: ['alpha'],
  voices: [
    { id: 'alpha', name: 'Alpha Writer', publication: 'Alpha Letter', group: 'macro', covers: 'Rates', x: 'alpha_w', feed: 'https://alpha-letter.org/feed', site: 'https://alpha-letter.org/', verified: 'test 2026-11-19' },
    { id: 'beta', name: 'Beta Desk', publication: 'Beta Notes', group: 'crypto', covers: 'Chains', feed: 'https://beta-notes.org/feed', site: 'https://beta-notes.org/', verified: 'test 2026-11-19' },
    { id: 'gamma', name: 'Gamma', publication: 'Gamma Site', group: 'crypto', covers: 'Tokens', x: 'gamma_x', site: 'https://gamma-site.org/', verified: 'test 2026-11-19' }
  ]
});

test('router: directory and latest, shapes, validation and cache headers', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push(url);
    assert.match(init.headers['user-agent'], /^Halftone-Voices\/0\.1 \(.*at most every 15 minutes; https:\/\/halftone\.example\/contact\)$/);
    if (url === 'https://alpha-letter.org/feed') return answer(rss(Array.from({ length: 8 }, (_, i) => rssItem(i + 1, { link: 'https://alpha-letter.org/p/' + (i + 1), desc: 'Subtitle ' + (i + 1) }))));
    return answer(rss([rssItem(1, { link: 'https://beta-notes.org/p/1', date: NOW - 1800000, title: '&lt;img src=x onerror=alert(1)&gt; &lt;b&gt;bold&lt;/b&gt; claim' }), rssItem(2, { link: 'https://beta-notes.org/p/2', date: null })]));
  };
  const s = await serve({ config: SMALL, fetchImpl, env: { VOICES_CONTACT: 'https://halftone.example/contact' } });
  try {
    assert.equal(calls.length, 0, 'nothing is fetched until someone asks');
    const dir = await s.get('/');
    assert.equal(dir.status, 200);
    assert.equal(dir.headers.get('cache-control'), 'public, max-age=0, s-maxage=60');
    assert.equal(dir.headers.get('cdn-cache-control'), 'public, s-maxage=60, stale-while-revalidate=60');
    assert.equal(dir.body.demo, false);
    assert.equal(dir.body.at, NOW);
    assert.deepEqual(dir.body.sources, [{ name: "Authors' own public feeds", state: 'ok', note: '2 of 2 feeds read.' }]);
    assert.deepEqual(dir.body.groups.map((g) => [g.id, g.name, g.voices.map((v) => v.id)]), [['macro', 'Macro', ['alpha']], ['crypto', 'Crypto', ['beta', 'gamma']]]);
    const alpha = dir.body.groups[0].voices[0];
    assert.deepEqual(Object.keys(alpha).sort(), ['checkedAt', 'covers', 'id', 'items', 'name', 'publication', 'site', 'state', 'x']);
    assert.equal(alpha.items.length, 5);
    assert.deepEqual(alpha.items[0], { title: 'Piece 1', url: 'https://alpha-letter.org/p/1', ts: NOW - 3600000, excerpt: 'Subtitle 1' });
    assert.equal(dir.body.groups[1].voices[1].state, 'nofeed');
    assert.deepEqual(dir.body.suggested, [{ id: 'alpha', name: 'Alpha Writer', publication: 'Alpha Letter', x: 'alpha_w' }]);
    assert.doesNotMatch(JSON.stringify(dir.body), /verified|"feed"/, 'verification notes and feed addresses stay on the server');
    assert.doesNotMatch(JSON.stringify(dir.body), /<img|onerror=/, 'markup in a title is stripped by the shared reader');

    const all = await s.get('/latest');
    assert.equal(all.status, 200);
    assert.equal(all.headers.get('cache-control'), 'public, max-age=0, s-maxage=60');
    assert.equal(all.body.items.length, 9, 'the undated piece stays off the time-ordered list');
    assert.equal(all.body.items[0].voice, 'beta');
    assert.deepEqual(Object.keys(all.body.items[0]).sort(), ['excerpt', 'group', 'name', 'publication', 'title', 'ts', 'url', 'voice']);
    assert.ok(all.body.items.every((x, i) => i === 0 || all.body.items[i - 1].ts >= x.ts));
    const crypto = await s.get('/latest?group=crypto');
    assert.deepEqual([crypto.body.group, crypto.body.items.map((x) => x.voice)], ['crypto', ['beta']]);

    for (const bad of ['/latest?group=nope', '/latest?group=', '/latest?group=a&group=b', '/latest?url=https://evil.example/feed', '/?feed=https://evil.example/feed']) {
      const r = await s.get(bad);
      assert.equal(r.status, 400, bad);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.ok(r.body.error);
    }
    assert.equal((await s.get('/nothing')).status, 404);
    assert.deepEqual([...new Set(calls)].sort(), ['https://alpha-letter.org/feed', 'https://beta-notes.org/feed'], 'only configured feeds were asked for');
    assert.equal(calls.length, 2, 'later requests are served from what is held');
    const health = s.voices.health();
    assert.deepEqual(Object.keys(health.sources[0]).sort(), ['lastError', 'lastOk', 'name', 'note', 'state']);
    assert.equal(health.sources[0].state, 'ok');
  } finally { await s.close(); }
});

test('router: latest holds at most 100, and 502 when no feed can be read', async () => {
  const many = validateConfig({
    groups: [{ id: 'macro', name: 'Macro' }],
    voices: Array.from({ length: 14 }, (_, i) => ({ id: 'w' + i, name: 'W' + i, publication: 'P' + i, group: 'macro', covers: 'c', feed: `https://p${i}.org/feed`, site: `https://p${i}.org/`, verified: 'test 2026-11-19' }))
  });
  const ok = await serve({ config: many, fetchImpl: async (url) => answer(rss(Array.from({ length: 12 }, (_, i) => rssItem(i + 1, { link: url.replace('/feed', '/p/') + i })))) });
  try { assert.equal((await ok.get('/latest')).body.items.length, 100); } finally { await ok.close(); }

  const down = await serve({ config: SMALL, fetchImpl: async () => answer('gone', { status: 503 }) });
  try {
    for (const path of ['/', '/latest']) {
      const r = await down.get(path);
      assert.equal(r.status, 502, path);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=0, s-maxage=2');
      assert.match(r.body.error, /could not be read just now/);
      assert.doesNotMatch(r.body.error, /503|https?:/);
    }
    const h = down.voices.health().sources;
    assert.equal(h[0].state, 'error');
    assert.deepEqual(h.slice(1).map((x) => [x.name, x.state, x.lastError]), [['Voices: Alpha Letter', 'error', 'HTTP 503'], ['Voices: Beta Notes', 'error', 'HTTP 503']]);
  } finally { await down.close(); }
});

test('router: too many requests from one address are refused', async () => {
  const s = await serve({ demo: true, tuning: { requestsPerMinute: 3 } });
  try {
    for (let i = 0; i < 3; i++) assert.equal((await s.get('/')).status, 200);
    const r = await s.get('/');
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
  } finally { await s.close(); }
});

// ---------------------------------------------------------------------------- demo
test('demo: invented writers only, labelled, nothing fetched, no entry from the real list', async () => {
  const real = loadConfig();
  const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const realNames = new Set(real.voices.flatMap((v) => [norm(v.name), norm(v.publication)]));
  const realHandles = new Set(real.voices.filter((v) => v.x).map((v) => v.x.toLowerCase()));
  const realIds = new Set(real.voices.map((v) => v.id));
  const realHosts = real.voices.flatMap((v) => [v.site, v.feed].filter(Boolean).map((u) => new URL(u).hostname.replace(/^www\./, '')));
  // Words that identify a real entry on their own ("citrini", "stratechery", "damodaran"...).
  const realWords = new Set(real.voices.flatMap((v) => (norm(v.name) + ' ' + norm(v.publication)).split(' ')).filter((w) => w.length >= 6 && !['research', 'economics', 'newsletter', 'street', 'federal', 'reserve', 'markets', 'network', 'common', 'unchained', 'interest', 'crypto', 'digest', 'trader', 'wealth', 'picture', 'returns'].includes(w)));
  for (const v of DEMO_VOICES) {
    assert.ok(!realNames.has(norm(v.name)) && !realNames.has(norm(v.publication)), v.name);
    assert.ok(!realIds.has(v.id) && v.id.startsWith('demo-'), v.id);
    for (const w of (norm(v.name) + ' ' + norm(v.publication)).split(' ')) assert.ok(!realWords.has(w), `${v.id}: "${w}" is a real entry's word`);
    if (v.x) { assert.match(v.x, HANDLE_RE); assert.ok(v.x.startsWith('hftdemo_') && !realHandles.has(v.x.toLowerCase()), v.x); }
    assert.ok(DEMO_GROUPS.some((g) => g.id === v.group));
  }
  assert.equal(DEMO_SUGGESTED.length, 8);

  let fetched = 0;
  const s = await serve({ demo: true, fetchImpl: async () => { fetched += 1; throw new Error('demo must not fetch'); } });
  try {
    const dir = await s.get('/');
    assert.equal(dir.status, 200);
    assert.equal(dir.body.demo, true);
    assert.match(dir.body.sources[0].note, /Invented/);
    assert.equal(dir.body.suggested.length, 8);
    const text = JSON.stringify(dir.body).toLowerCase();
    for (const h of realHosts) assert.ok(!text.includes(h), 'demo mentions ' + h);
    const voices = dir.body.groups.flatMap((g) => g.voices);
    assert.equal(voices.length, DEMO_VOICES.length);
    assert.ok(voices.every((v) => v.site === null && v.items.length >= 3 && v.items.every((it) => it.url === null && it.ts <= NOW)), 'demo items carry no links');
    const latest = await s.get('/latest?group=macro');
    assert.equal(latest.body.demo, true);
    assert.ok(latest.body.items.length > 5 && latest.body.items.every((x) => x.group === 'macro'));
    assert.deepEqual(await s.get('/').then((r) => r.body.groups), dir.body.groups, 'the same answer every time');
    assert.equal(fetched, 0);
    assert.match(s.voices.health().sources[0].name, /demo/);
  } finally { await s.close(); }
});
