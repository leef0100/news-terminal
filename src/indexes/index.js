// Halftone's house indexes for AI infrastructure: the data behind `/api/indexes`.
//
// This file is the front door. It checks every parameter before anything is spent on it,
// hands the question to the engine, and sets the headers that let a CDN share one answer
// between many viewers. The same conventions as `/api/tradfi`: every answer carries `demo`,
// `at` and `sources: [{ name, state: 'ok'|'off'|'error', note }]`; a bad parameter is 400
// at no upstream cost; a failing source is 502.
//
// The methods and baskets are data, in config/indexes.json, and are shown on the page.
// docs/INDEX-METHODS.md explains each choice and what was verified.

import { Router } from 'express';
import { readFileSync } from 'node:fs';
import { addressKey, createLimiter } from '../tradfi/index.js';
import { createEngine, RANGES } from './engine.js';
import { createMarketInputs, createCryptoInputs, createEnergyInputs, createCloudPrices, createMemoryStore } from './live.js';
import { createDemoInputs, demoConfig } from './demo.js';

export const loadConfig = () => JSON.parse(readFileSync(new URL('../../config/indexes.json', import.meta.url), 'utf8'));

// Seconds a shared cache may keep each answer.
const TTL = { list: 60, series: 60, capex: 300 };
const one = (v) => (typeof v === 'string' ? v : '');
const bad = (message) => Object.assign(new Error(message), { status: 400 });

export function createIndexes({ demo = false, env = {}, tradfi = null, hl = null, fetchImpl = fetch, now = Date.now, log = console, config = loadConfig(), store = createMemoryStore(), autoCollect = true, tuning = {} } = {}) {
  const market = createMarketInputs({ tradfi, now });
  let providers, health, stop = () => {};
  if (demo) {
    config = demoConfig(config);
    const fake = createDemoInputs({ now });
    providers = { ...market, ...fake };
    health = fake.health;
  } else {
    const energy = createEnergyInputs({ env, fetchImpl, now });
    const cloud = createCloudPrices({ env, fetchImpl, now, store, log });
    const compute = config.indexes.find((d) => d.kind === 'prices');
    if (autoCollect && compute) cloud.start(compute);
    providers = { ...market, crypto: createCryptoInputs({ hl, now }), energy: energy.energy, prices: cloud.prices, collect: () => (compute ? cloud.collect(compute) : Promise.resolve()) };
    health = () => [...energy.health(), ...cloud.health()];
    stop = cloud.stop;
  }
  const engine = createEngine({ config, providers, now, demo });
  const router = Router();
  const limiter = createLimiter({ max: tuning.requestsPerMinute ?? 240, now });

  const shared = (res, seconds) => res.set({
    'cache-control': `public, max-age=0, s-maxage=${seconds}`,
    'cdn-cache-control': `public, s-maxage=${seconds}, stale-while-revalidate=${seconds}`
  });

  // `parse` turns the query into arguments and throws for anything wrong with it, before
  // `run` is allowed to cost an upstream call.
  const route = (path, name, parse, run) => router.get(path, async (req, res) => {
    const wait = limiter.take(addressKey(req.ip), name === 'list' ? 1 : 2);
    if (wait) return res.status(429).set({ 'cache-control': 'no-store', 'retry-after': String(wait) }).json({ error: `Too many requests from your address. Try again in ${wait} seconds.` });
    let args;
    try {
      args = parse(req.query);
    } catch (e) {
      return res.status(400).set('cache-control', 'no-store').json({ error: String(e.message || e) });
    }
    try {
      const { failed, ...out } = await run(...args);
      // Every input of what was asked for is failing: an honest error, shared for two
      // seconds so an outage upstream is not multiplied by every viewer retrying.
      if (failed) return res.status(502).set({ 'cache-control': 'public, max-age=0, s-maxage=2', 'cdn-cache-control': 'public, s-maxage=2' }).json({ error: String(out.note || 'A data source did not answer. Try again shortly.'), sources: out.sources || [] });
      // An index still reading its inputs changes within seconds, so it is not held for long.
      const settling = out.state === 'pending' || (out.indexes || []).some((i) => i.state === 'pending');
      shared(res, settling ? 5 : TTL[name]).json({ demo, at: now(), ...out });
    } catch (e) {
      log.warn?.(`[indexes] ${name} failed: ${e?.message || e}`);
      res.status(502).set({ 'cache-control': 'public, max-age=0, s-maxage=2', 'cdn-cache-control': 'public, s-maxage=2' }).json({ error: 'A data source did not answer. Try again shortly.' });
    }
  });

  route('/', 'list', () => [], () => engine.list());

  route('/series', 'series', (q) => {
    const id = one(q.id).trim();
    if (!id) throw bad('id is required');
    if (id.length > 40 || !engine.has(id)) throw bad('id must be one of ' + engine.ids().join(', '));
    const range = q.range === undefined ? '1y' : one(q.range);
    if (!Object.hasOwn(RANGES, range)) throw bad('range must be one of 1m, 6m, 1y, 5y, max');
    return [id, range];
  }, (id, range) => engine.series(id, range));

  route('/capex', 'capex', () => [], () => engine.capex());

  router.use((_req, res) => res.status(404).set('cache-control', 'no-store').json({ error: 'Not found' }));

  return {
    router, engine, collect: () => providers.collect?.(),
    health: () => ({ sources: health().map((s) => ({ name: s.name, state: s.state, note: s.note, lastOk: s.lastOk ?? null, lastError: s.lastError ?? null })) }),
    stop() { stop(); engine.clear(); }
  };
}
