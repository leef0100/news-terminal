// Stocks, calendar and private markets: the data behind `/api/tradfi`.
//
// This file is the front door: it checks every parameter before anything is spent on it,
// hands the question to the demo or the live data behind it, and sets the headers that let
// a CDN share one answer between many viewers. The contract is in docs/BRIEF-tradfi.md and
// the sources, with what was and was not verified, in docs/TRADFI-SOURCES.md.

import { Router } from 'express';
import { DAY, SYMBOL_RE, RANGES, bad, parseDay, isoDay } from './util.js';
import { createDemoBackend } from './demo.js';
import { createLiveBackend } from './live.js';
import { visitor } from './source.js';

// Seconds a shared cache may keep each answer.
const TTL = { overview: 15, search: 300, quote: 5, candles: 60, company: 300, calendar: 300, ipos: 120, private: 120 };

// What each request counts for against one address's allowance. The routes that can set
// off new work upstream (a company's filings, a price history) count for more.
const WEIGHT = { overview: 1, search: 1, quote: 1, candles: 3, company: 3, calendar: 2, ipos: 1, private: 1 };

// One address, as far as limits go. An IPv6 customer usually holds a whole /64, so the
// first four groups are the address; "::ffff:1.2.3.4" is the IPv4 address inside it.
export function addressKey(ip) {
  const s = String(ip || 'unknown').toLowerCase();
  const v4 = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) return v4[1];
  if (!s.includes(':')) return s.slice(0, 64);
  const [head, tail = ''] = s.split('::');
  const groups = head.split(':').filter(Boolean);
  if (s.includes('::')) while (groups.length + tail.split(':').filter(Boolean).length < 8) groups.push('0');
  return groups.slice(0, 4).join(':');
}

// At most `max` units of weight from one address in any window of `perMs`. The table of
// addresses is bounded: when full, the address heard from longest ago is forgotten.
export function createLimiter({ max, perMs = 60000, now = Date.now, maxAddresses = 20000 }) {
  const seen = new Map();
  return {
    // 0 when the request may go ahead, otherwise the seconds until it may.
    take(address, cost = 1) {
      const t = now();
      let w = seen.get(address);
      if (!w || t - w.start >= perMs) w = { start: t, spent: 0 };
      seen.delete(address);
      seen.set(address, w);
      if (seen.size > maxAddresses) seen.delete(seen.keys().next().value);
      if (w.spent + cost > max) return Math.max(1, Math.ceil((w.start + perMs - t) / 1000));
      w.spent += cost;
      return 0;
    },
    size: () => seen.size
  };
}

const one = (v) => (typeof v === 'string' ? v : '');
function symbolOf(v) {
  const s = one(v).trim().toUpperCase();
  if (!SYMBOL_RE.test(s)) throw bad('symbol must be 1 to 12 letters, digits, dots, dashes or colons');
  return s;
}

export function createTradfi({ demo = false, env = {}, fetchImpl = fetch, now = Date.now, log = console, tuning = {}, backend: given } = {}) {
  const backend = given || (demo ? createDemoBackend({ now }) : createLiveBackend({ env, fetchImpl, now, log, tuning }));
  const router = Router();
  // Every route, per address (`req.ip`, which is the visitor's own address behind the
  // configured proxy). Generous for a person with several tabs; a script is stopped here
  // before it costs anything. Upstream allowances have their own per-address share on top
  // (see `perVisitor` in live.js), counted only when a request causes a real upstream call.
  const limiter = createLimiter({ max: tuning.requestsPerMinute ?? 300, now });

  const shared = (res, seconds) => res.set({
    'cache-control': `public, max-age=0, s-maxage=${seconds}`,
    'cdn-cache-control': `public, s-maxage=${seconds}, stale-while-revalidate=${seconds}`
  });

  // `parse` turns the query into arguments and throws for anything wrong with it, before
  // `run` is allowed to cost an upstream call.
  const route = (name, parse, run) => router.get('/' + name, async (req, res) => {
    const who = addressKey(req.ip);
    const wait = limiter.take(who, WEIGHT[name]);
    if (wait) return res.status(429).set({ 'cache-control': 'no-store', 'retry-after': String(wait) }).json({ error: `Too many requests from your address. Try again in ${wait} seconds.` });
    let args;
    try {
      args = parse(req.query);
    } catch (e) {
      return res.status(400).set('cache-control', 'no-store').json({ error: String(e.message || e) });
    }
    try {
      const out = await visitor.run({ id: who }, () => run(...args));
      shared(res, TTL[name]).json({ demo, at: now(), ...out });
    } catch (e) {
      if (e?.status === 400) return res.status(400).set('cache-control', 'no-store').json({ error: String(e.message) });
      // This visitor's own share of an upstream allowance is used up: their problem alone, so never shared by a cache.
      if (e?.status === 429) return res.status(429).set({ 'cache-control': 'no-store', 'retry-after': '60' }).json({ error: String(e.publicMessage || e.message) });
      log.warn?.(`[tradfi] ${name} failed: ${e?.message || e}`);
      // Failures are shared for two seconds, so an outage upstream is not multiplied by
      // every viewer retrying through the CDN.
      res.status(502).set({ 'cache-control': 'public, max-age=0, s-maxage=2', 'cdn-cache-control': 'public, s-maxage=2' }).json({ error: String(e?.publicMessage || 'A data source did not answer. Try again shortly.') });
    }
  });

  route('overview', () => [], () => backend.overview());

  route('search', (q) => {
    const text = one(q.q).trim();
    if (!text) throw bad('q is required');
    if (text.length > 40) throw bad('q is too long');
    return [text];
  }, (text) => backend.search(text));

  route('quote', (q) => {
    const list = [...new Set(one(q.symbols).split(',').map((s) => s.trim()).filter(Boolean).map(symbolOf))];
    if (!list.length) throw bad('symbols is required');
    if (list.length > 20) throw bad('At most 20 symbols');
    return [list];
  }, (list) => backend.quote(list));

  route('candles', (q) => {
    const range = q.range === undefined ? '1y' : one(q.range);
    if (!Object.hasOwn(RANGES, range)) throw bad('range must be one of 1m, 6m, 1y, 5y, max');
    return [symbolOf(q.symbol), range];
  }, (symbol, range) => backend.candles(symbol, range));

  route('company', (q) => [symbolOf(q.symbol)], (symbol) => backend.company(symbol));

  route('calendar', (q) => {
    const today = Math.floor(now() / DAY) * DAY;
    const from = q.from === undefined ? today : parseDay(one(q.from));
    if (from === null) throw bad('from must be a date, YYYY-MM-DD');
    const to = q.to === undefined ? from + 30 * DAY : parseDay(one(q.to));
    if (to === null) throw bad('to must be a date, YYYY-MM-DD');
    if (to < from) throw bad('to is before from');
    if (to - from > 45 * DAY) throw bad('At most 45 days');
    // Nothing is known about dates far from the present, so they are refused, not looked up.
    if (from < today - 400 * DAY || to > today + 400 * DAY) throw bad('Dates must be within about a year of today');
    return [from, to];
  }, async (from, to) => ({ from: isoDay(from), to: isoDay(to), ...(await backend.calendar(from, to)) }));

  route('ipos', () => [], () => backend.ipos());
  route('private', () => [], () => backend.private());

  router.use((_req, res) => res.status(404).set('cache-control', 'no-store').json({ error: 'Not found' }));

  return { router, health: () => backend.health(), stop: () => backend.stop() };
}
