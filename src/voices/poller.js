// Reads each author's own public feed, politely, and keeps titles, dates and links.
//
// What holds whatever happens:
//   - only the feed addresses in config/voices.json are ever asked for. A redirect is
//     followed only to https on the same host (with or without "www."), never elsewhere;
//   - a feed is asked for at most once per interval (15 minutes or more), a few at a time,
//     with If-None-Match / If-Modified-Since so an unchanged feed costs the author nothing,
//     and under a cap on requests per hour across all feeds;
//   - a feed that fails is left alone for longer each time, and its last good items stay;
//   - memory is bounded: the newest 10 items per voice, each a title, a link, a time and
//     at most 200 characters of the feed's own public description. The body of a piece is
//     never kept, and nothing is read from behind a login.
import { XMLParser } from 'fast-xml-parser';
import { parseFeed } from '../ingest/rss.js';
import { plainXml } from '../tradfi/util.js';

export const KEEP = 10;
export const EXCERPT_MAX = 200;
const TITLE_MAX = 240;
const MIN_INTERVAL = 15 * 60000;
const MB = 1024 * 1024;

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const textOf = (v) => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v));

// A link from a feed is passed on only if it is a plain http(s) address.
export function httpLink(value) {
  if (typeof value !== 'string' || value.length > 600 || /[\s<>"'`\\]/.test(value)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if ((u.protocol !== 'https:' && u.protocol !== 'http:') || u.username || u.password) return null;
  return u.href;
}

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', hellip: '…', mdash: '—', ndash: '–', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
// Markup out, entities decoded once, whitespace collapsed, cut at a word to 200 characters.
export function excerptOf(html, max = EXCERPT_MAX) {
  let s = String(html ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<\/?[a-zA-Z][^<>]*>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
    })
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= max) return s;
  s = s.slice(0, max - 1);
  const cut = s.lastIndexOf(' ');
  return (cut > max * 0.6 ? s.slice(0, cut) : s).replace(/[\s.,;:–—-]+$/, '') + '…';
}

// The one thing the shared feed reader does not keep: each item's public description
// (RSS <description>, Atom <summary>), by link. Full-text fields (<content:encoded>,
// Atom <content>) are never looked at.
const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });
export function descriptionsOf(xml) {
  const out = new Map();
  let doc;
  try { doc = parser.parse(xml); } catch { return out; }
  const entries = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.['rdf:RDF']?.item ?? [];
  for (const e of asArray(entries)) {
    if (!e || typeof e !== 'object') continue;
    // The link is found the same way the shared reader finds it, so the two agree.
    let link = '';
    if (typeof e.link === 'string') link = e.link.trim();
    else {
      const links = asArray(e.link);
      const alt = links.find((l) => l && l['@_rel'] === 'alternate') || links[0];
      if (alt) link = String(alt['@_href'] || alt['#text'] || '').trim();
    }
    const body = textOf(e.description ?? e.summary);
    if (link && body && !out.has(link)) out.set(link, body);
  }
  return out;
}

const bare = (host) => host.toLowerCase().replace(/^www\./, '');

export function createVoicePoller({ voices, fetchImpl = fetch, now = Date.now, log = console, userAgent, tuning = {} }) {
  const intervalMs = Math.max(MIN_INTERVAL, tuning.intervalMs ?? MIN_INTERVAL);
  const concurrency = Math.min(6, Math.max(1, tuning.concurrency ?? 3));
  const perHour = tuning.perHour ?? 240;               // every feed, every 15 minutes, with room to spare
  const maxBytes = tuning.maxBytes ?? 4 * MB;          // newsletter feeds carry full text and run to about 1 MB
  const timeoutMs = tuning.timeoutMs ?? 10000;
  const feeds = voices.filter((v) => v.feed);
  const state = new Map(voices.map((v) => [v.id, { items: [], cache: {}, tried: null, lastOk: null, lastError: null, lastErrorAt: null, fails: 0, nextAt: 0 }]));
  const spent = [];                                    // times of recent requests, for the hourly cap
  const seen = { requests: 0, refused: 0 };
  let running = null;

  function afford() {
    const t = now();
    while (spent.length && t - spent[0] >= 3600000) spent.shift();
    if (spent.length >= perHour) { seen.refused += 1; return false; }
    spent.push(t);
    seen.requests += 1;
    return true;
  }

  async function read(res) {
    const declared = Number(res.headers?.get?.('content-length'));
    if (declared > maxBytes) throw new Error('feed larger than ' + Math.round(maxBytes / MB) + ' MB');
    if (!res.body?.getReader) {
      const whole = await res.text();
      if (whole.length > maxBytes) throw new Error('feed larger than ' + Math.round(maxBytes / MB) + ' MB');
      return whole;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) { reader.cancel().catch(() => {}); throw new Error('feed larger than ' + Math.round(maxBytes / MB) + ' MB'); }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  // One conditional GET of a configured feed. Redirects are taken by hand so that none
  // can lead off the host the config names.
  async function get(voice, st) {
    const home = bare(new URL(voice.feed).hostname);
    let url = voice.feed;
    for (let hop = 0; hop < 4; hop++) {
      const headers = { 'user-agent': userAgent, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };
      if (st.cache.etag) headers['if-none-match'] = st.cache.etag;
      if (st.cache.lastModified) headers['if-modified-since'] = st.cache.lastModified;
      const res = await fetchImpl(url, { headers, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
      if ([301, 302, 303, 307, 308].includes(res.status)) {
        let next;
        try { next = new URL(res.headers.get('location'), url); } catch { throw new Error('redirect without an address'); }
        if (next.protocol !== 'https:' || next.port || next.username || bare(next.hostname) !== home) throw new Error('redirected away from its own host');
        url = next.href;
        continue;
      }
      return res;
    }
    throw new Error('too many redirects');
  }

  function shape(voice, xml, t) {
    const descriptions = voice.excerpt === false ? new Map() : descriptionsOf(xml);
    const out = [];
    const ids = new Set();
    for (const e of parseFeed(xml, voice.id)) {
      const url = httpLink(e.url);
      if (!url || ids.has(e.id)) continue;             // no usable link: nothing to send a reader to
      ids.add(e.id);
      const title = e.text.length > TITLE_MAX ? e.text.slice(0, TITLE_MAX - 1) + '…' : e.text;
      // A feed's clock is not trusted: nothing is from the future.
      const ts = e.ts === null ? null : Math.min(e.ts, t);
      let excerpt = descriptions.has(e.url) ? excerptOf(descriptions.get(e.url)) : '';
      if (excerpt === title || excerpt.length < 3) excerpt = '';
      out.push({ id: e.id, title, url, ts, excerpt });
    }
    // Newest first; items without a date go last, in the feed's own order.
    return out.map((x, i) => [x, i]).sort((a, b) => (b[0].ts ?? -Infinity) - (a[0].ts ?? -Infinity) || a[1] - b[1]).map((p) => p[0]).slice(0, KEEP);
  }

  async function pollOne(voice) {
    const st = state.get(voice.id);
    st.tried = now();
    try {
      const res = await get(voice, st);
      if (res.status !== 304) {
        if (!res.ok) {
          const asked = Number(res.headers?.get?.('retry-after'));
          if ((res.status === 429 || res.status === 503) && asked > 0) st.retryAfter = Math.min(6 * 3600000, asked * 1000);
          throw new Error('HTTP ' + res.status);
        }
        const xml = plainXml(await read(res), maxBytes);
        if (!/<(rss|feed|rdf:RDF)[\s>]/.test(xml.slice(0, 4000))) throw new Error('not a feed');
        const items = shape(voice, xml, now());
        // Kept only once the answer has been read to the end and understood.
        st.cache = { etag: res.headers.get('etag') || undefined, lastModified: res.headers.get('last-modified') || undefined };
        st.items = items;
      }
      st.lastOk = now();
      st.fails = 0;
      st.retryAfter = 0;
      st.nextAt = now() + intervalMs;
    } catch (err) {
      const why = err?.cause?.code || (err?.name === 'TimeoutError' ? 'timed out' : '');
      st.lastError = String(err?.message || err).slice(0, 160) + (why ? ' (' + why + ')' : '');
      st.lastErrorAt = now();
      st.fails += 1;
      // Each failure in a row doubles the wait, up to six hours.
      st.nextAt = now() + Math.max(st.retryAfter || 0, Math.min(6 * 3600000, intervalMs * 2 ** Math.min(st.fails - 1, 5)));
      log.warn?.(`[voices] ${voice.publication}: ${st.lastError}`);
    }
  }

  // Asks for every feed that is due, a few at a time. A round already under way is joined,
  // never doubled.
  function pollDue() {
    if (running) return running;
    const t = now();
    const due = feeds.filter((v) => state.get(v.id).nextAt <= t);
    if (!due.length) return Promise.resolve(0);
    let done = 0;
    const worker = async () => {
      for (;;) {
        const v = due.shift();
        if (!v) return;
        if (!afford()) { due.length = 0; return; }
        await pollOne(v);
        done += 1;
      }
    };
    running = Promise.all(Array.from({ length: Math.min(concurrency, due.length) }, worker)).then(() => done).finally(() => { running = null; });
    return running;
  }

  const stateOf = (v) => {
    const st = state.get(v.id);
    if (!v.feed) return 'nofeed';
    if (st.fails > 0) return 'error';
    // Asked but not yet answered is still waiting.
    return st.lastOk === null ? 'waiting' : 'ok';
  };

  return {
    pollDue,
    intervalMs,
    feeds: feeds.length,
    view(v) {
      const st = state.get(v.id);
      return { state: stateOf(v), checkedAt: st.lastOk, items: st.items };
    },
    counts() {
      let ok = 0, error = 0, waiting = 0;
      for (const v of feeds) { const s = stateOf(v); if (s === 'ok') ok += 1; else if (s === 'error') error += 1; else waiting += 1; }
      return { feeds: feeds.length, ok, error, waiting, requests: seen.requests, refused: seen.refused };
    },
    failing: () => feeds.filter((v) => stateOf(v) === 'error').map((v) => { const st = state.get(v.id); return { voice: v, lastOk: st.lastOk, lastError: st.lastError, lastErrorAt: st.lastErrorAt }; }),
    lastOk: () => feeds.reduce((m, v) => Math.max(m, state.get(v.id).lastOk || 0), 0) || null
  };
}
