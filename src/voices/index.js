// Voices: a reading list of public market writing, behind `/api/voices`.
//
// Titles, dates and links from each author's own public feed, grouped, with the author's
// public X handle where one was verified. Nothing here is scored, ranked or restated: an
// item is "X wrote this", with a link to where they wrote it. The list is config/voices.json
// and is the only source of addresses the server will fetch; how each entry was checked is
// in docs/VOICES-SOURCES.md.
//
// Feeds are read only while somebody is looking: the first request starts a round, a timer
// keeps the list fresh while requests keep coming, and it goes quiet when they stop.

import { Router } from 'express';
import { addressKey, createLimiter } from '../tradfi/index.js';
import { loadConfig } from './config.js';
import { createVoicePoller } from './poller.js';
import { DEMO_GROUPS, DEMO_VOICES, DEMO_SUGGESTED, demoView } from './demo.js';

const TTL = 60;            // seconds a shared cache may keep an answer
const CARD_ITEMS = 5;      // newest items sent with each voice
const LATEST_MAX = 100;
const IDLE_MS = 30 * 60000;

const one = (v) => (typeof v === 'string' ? v : '');
// A contact for feed owners, if the operator gives one: a URL or an email, nothing else.
const contactOf = (env) => { const c = one(env.VOICES_CONTACT).trim(); return /^[\w.+:/@~-]{3,120}$/.test(c) ? c : ''; };

export function createVoices({ demo = false, env = {}, fetchImpl = fetch, now = Date.now, log = console, config: given, tuning = {} } = {}) {
  const config = demo
    ? { groups: DEMO_GROUPS, voices: DEMO_VOICES.map((v) => ({ ...v, feed: null, site: null })), suggested: DEMO_SUGGESTED, pollMinutes: 15 }
    : given || loadConfig();
  const contact = contactOf(env);
  const userAgent = `Halftone-Voices/0.1 (market terminal reading list; titles and links only; each feed at most every ${config.pollMinutes} minutes${contact ? '; ' + contact : ''})`;
  const poller = demo ? null : createVoicePoller({
    voices: config.voices, fetchImpl, now, log, userAgent,
    tuning: { ...tuning, intervalMs: Math.max(config.pollMinutes * 60000, tuning.intervalMs ?? 0) }
  });
  const viewOf = demo ? demoView(now) : (v) => poller.view(v);
  const limiter = createLimiter({ max: tuning.requestsPerMinute ?? 120, now });
  const firstWaitMs = tuning.firstWaitMs ?? 2500;
  const groupName = new Map(config.groups.map((g) => [g.id, g.name]));

  // ---- keeping fresh while watched ----
  let timer = null, lastAsked = 0, stopped = false;
  const round = () => poller.pollDue().catch((e) => { log.warn?.('[voices] round failed: ' + (e?.message || e)); return 0; });
  async function touch() {
    if (demo || stopped) return;
    lastAsked = now();
    if (!timer) {
      timer = setInterval(() => { if (now() - lastAsked <= IDLE_MS) round(); }, 60000);
      timer.unref?.();
    }
    // The first viewer waits a moment for the first round, so the page is not empty; after
    // that an answer is whatever is held, and reading goes on behind it.
    const fresh = poller.counts().waiting > 0;
    const going = round();
    if (fresh) await Promise.race([going, new Promise((r) => { const t = setTimeout(r, firstWaitMs); t.unref?.(); })]);
  }

  function sources() {
    if (demo) return [{ name: 'Demo data', state: 'ok', note: 'Invented for the demo: these writers, publications and titles do not exist.' }];
    const c = poller.counts();
    const note = c.ok + c.error === 0 ? 'First check pending.'
      : `${c.ok} of ${c.feeds} feeds read` + (c.error ? `; ${c.error} could not be read just now` : '') + (c.waiting ? `; ${c.waiting} not yet checked` : '') + '.';
    return [{ name: "Authors' own public feeds", state: c.feeds && c.error === c.feeds ? 'error' : 'ok', note }];
  }
  // Every feed tried and none readable, with nothing held from before: an honest failure.
  function down() {
    if (demo) return false;
    const c = poller.counts();
    return c.feeds > 0 && c.error === c.feeds && !config.voices.some((v) => poller.view(v).items.length);
  }
  const item = (it) => ({ title: it.title, url: it.url, ts: it.ts, excerpt: it.excerpt || '' });

  function directory() {
    return {
      sources: sources(),
      panel: { max: 20 },
      suggested: config.suggested.map((id) => { const v = config.voices.find((x) => x.id === id); return { id: v.id, name: v.name, publication: v.publication, x: v.x }; }),
      groups: config.groups.map((g) => ({
        id: g.id, name: g.name,
        voices: config.voices.filter((v) => v.group === g.id).map((v) => {
          const s = viewOf(v);
          return { id: v.id, name: v.name, publication: v.publication, covers: v.covers, x: v.x || null, site: v.site || null, state: s.state, checkedAt: s.checkedAt, items: s.items.slice(0, CARD_ITEMS).map(item) };
        })
      }))
    };
  }
  function latest(group) {
    const items = [];
    for (const v of config.voices) {
      if (group && v.group !== group) continue;
      // An undated piece cannot be placed in a list ordered by time; it stays on its card.
      for (const it of viewOf(v).items) if (it.ts !== null) items.push({ voice: v.id, name: v.name, publication: v.publication, group: v.group, ...item(it) });
    }
    items.sort((a, b) => b.ts - a.ts || (a.voice < b.voice ? -1 : 1));
    return { sources: sources(), group: group || null, groups: config.groups, items: items.slice(0, LATEST_MAX) };
  }

  const router = Router();
  const shared = (res) => res.set({ 'cache-control': `public, max-age=0, s-maxage=${TTL}`, 'cdn-cache-control': `public, s-maxage=${TTL}, stale-while-revalidate=${TTL}` });
  const route = (path, parse, run) => router.get(path, async (req, res) => {
    const wait = limiter.take(addressKey(req.ip));
    if (wait) return res.status(429).set({ 'cache-control': 'no-store', 'retry-after': String(wait) }).json({ error: `Too many requests from your address. Try again in ${wait} seconds.` });
    let args;
    try { args = parse(req.query); } catch (e) { return res.status(400).set('cache-control', 'no-store').json({ error: String(e.message || e) }); }
    try {
      await touch();
      if (down()) throw new Error('no feed could be read');
      shared(res).json({ demo, at: now(), ...run(...args) });
    } catch (e) {
      log.warn?.(`[voices] ${path} failed: ${e?.message || e}`);
      res.status(502).set({ 'cache-control': 'public, max-age=0, s-maxage=2', 'cdn-cache-control': 'public, s-maxage=2' }).json({ error: "The authors' feeds could not be read just now. Try again shortly." });
    }
  });
  const none = (q, allowed) => { for (const k of Object.keys(q)) if (!allowed.includes(k)) throw new Error('Unknown parameter: ' + k.slice(0, 30)); };

  route('/', (q) => { none(q, []); return []; }, directory);
  route('/latest', (q) => {
    none(q, ['group']);
    if (q.group === undefined) return [null];
    const g = one(q.group);
    if (!groupName.has(g)) throw new Error('group must be one of: ' + [...groupName.keys()].join(', '));
    return [g];
  }, latest);
  router.use((_req, res) => res.status(404).set('cache-control', 'no-store').json({ error: 'Not found' }));

  function health() {
    if (demo) return { sources: [{ name: 'Voices (demo)', state: 'ok', note: 'Invented writers and titles.', lastOk: null, lastError: null }] };
    const c = poller.counts();
    const failing = poller.failing();
    const head = {
      name: 'Voices: author feeds',
      state: c.feeds && c.error === c.feeds ? 'error' : 'ok',
      note: c.ok + c.error === 0 ? `${c.feeds} feeds on the list. Read only while someone has Voices open; not read yet.`
        : `${c.ok} of ${c.feeds} feeds read, ${c.error} failing, ${c.waiting} not yet checked. Each at most every ${config.pollMinutes} minutes.`,
      lastOk: poller.lastOk(), lastError: failing[0]?.lastError || null
    };
    return { sources: [head, ...failing.map((f) => ({ name: 'Voices: ' + f.voice.publication, state: 'error', note: 'Feed could not be read; its last items stay on the page.', lastOk: f.lastOk, lastError: f.lastError }))] };
  }

  return { router, health, poller, config, stop() { stopped = true; clearInterval(timer); timer = null; } };
}
