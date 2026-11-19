// One upstream service: its cache, its spending limit and its record for the Status page.
//
// Every outside call in this module goes through one of these, so three things hold
// whatever the traffic:
//   - identical requests share one answer (cached, and coalesced while one is on its way);
//   - the service's published limit cannot be exceeded, because calls are counted against a
//     budget of our own set below it, and a call that does not fit is not made;
//   - when a call cannot be made or fails, the last answer is served for a short, stated
//     time and marked as old, and after that the caller gets an honest error.

import { AsyncLocalStorage } from 'node:async_hooks';

export function busy(message) {
  const e = new Error(message);
  e.publicMessage = message;
  return e;
}

// Who is being served. The router runs each request inside `visitor.run({ id })`, and a
// source charges the upstream calls that request causes to that visitor, so one address
// cannot spend a shared allowance on everyone's behalf. Work done outside a request (a
// background refresh) has no visitor and is charged to nobody.
export const visitor = new AsyncLocalStorage();

// Keys travel in some upstream addresses (Finnhub's `token`, FRED's `api_key`). Nothing
// that can reach a log, the Status page or a client is allowed to carry one.
const SECRET = /([?&](?:token|api_key|apikey|key)=)[^&\s"'<>]+/gi;
export const redact = (text) => String(text).replace(SECRET, '$1[hidden]');

const MB = 1024 * 1024;

export function createSource({
  name, fetchImpl = fetch, now = Date.now, timeoutMs = 8000, headers = {},
  budget = [],            // [{ max, perMs }]: at most `max` units of cost in any window of `perMs`
  perVisitor = null,      // { max, perMs }: the most of that one visitor may cause
  maxWaitMs = 0,          // how long a call may wait for room in the budget before giving up
  maxEntries = 400, failMs = 2000, maxBytes = 4 * MB,
  // Answers that mean "stop asking for a while", and for how long when the service does not say.
  pauseOn = [429], pauseMs = 30000,
  enabled = true, offNote = '', note = '',
  sleep = (ms) => new Promise((r) => setTimeout(r, ms))
}) {
  const cache = new Map();     // key -> { at, data }
  const inflight = new Map();
  const failures = new Map();  // key -> { at, error }
  const windows = budget.map((b) => ({ ...b, start: 0, spent: 0 }));
  const visitors = new Map();  // visitor id -> { start, spent }
  const seen = { lastOk: null, lastError: null, lastErrorAt: null, calls: 0, refused: 0 };
  let pausedUntil = 0, pausedBy = 0;

  const room = (cost) => {
    const t = now();
    for (const w of windows) {
      if (t - w.start >= w.perMs) { w.start = t; w.spent = 0; }
      if (w.spent + cost > w.max) return w.start + w.perMs - t; // ms until this window opens again
    }
    for (const w of windows) w.spent += cost;
    return 0;
  };
  async function afford(cost) {
    // Waiting is counted by what was actually slept, so it ends even if the clock does not move.
    let waited = 0;
    for (;;) {
      const wait = room(cost);
      if (!wait) return true;
      if (waited + wait > maxWaitMs) return false;
      waited += wait + 5;
      await sleep(wait + 5);
    }
  }
  // Charges `cost` to the visitor being served; false when that visitor has had their share.
  function fair(cost) {
    const id = perVisitor ? visitor.getStore()?.id : null;
    if (!id) return true;
    const t = now();
    let w = visitors.get(id);
    if (!w || t - w.start >= perVisitor.perMs) w = { start: t, spent: 0 };
    if (w.spent + cost > perVisitor.max) return false;
    w.spent += cost;
    visitors.delete(id);
    visitors.set(id, w);
    if (visitors.size > 5000) visitors.delete(visitors.keys().next().value);
    return true;
  }

  const remember = (key, data) => {
    cache.delete(key);
    cache.set(key, { at: now(), data });
    if (cache.size > maxEntries) cache.delete(cache.keys().next().value);
  };

  // The body, read no further than `limit` bytes: a service that has gone wrong (or been
  // replaced by something else) cannot make this server hold an answer of any size.
  async function read(res, as, limit) {
    const declared = Number(res.headers?.get?.('content-length'));
    if (declared > limit) throw new Error(`${name} sent more than ${Math.round(limit / MB)} MB`);
    if (!res.body?.getReader) {
      // A stand-in without a stream (tests): the same check, after the fact.
      if (as !== 'text' && !res.text) return res.json();
      const whole = await res.text();
      if (whole.length > limit) throw new Error(`${name} sent more than ${Math.round(limit / MB)} MB`);
      return as === 'text' ? whole : JSON.parse(whole);
    }
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) { reader.cancel().catch(() => {}); throw new Error(`${name} sent more than ${Math.round(limit / MB)} MB`); }
      chunks.push(value);
    }
    const whole = Buffer.concat(chunks).toString('utf8');
    return as === 'text' ? whole : JSON.parse(whole);
  }

  // Fetches `url` and returns `{ data, at, stale }`.
  //   ttlMs      how long an answer counts as current
  //   staleMs    how much longer it may stand in when a fresh one cannot be had
  //   as         'json' or 'text'
  //   transform  shrinks the parsed body to what is needed before it is kept; large upstream
  //              files (a company's full XBRL facts run to megabytes) are never held whole
  //   missing    statuses that mean "there is none" and are an answer in themselves (null)
  //   cost       what the call counts for against the budget
  //   maxBytes   the largest body that will be read
  //   shared     the same call serves every visitor (a fixed file or feed), so it is charged to none
  async function get(url, { ttlMs = 60000, staleMs = 0, as = 'json', transform = (x) => x, missing = [], cost = 1, key = url, init = {}, timeoutMs: callTimeout = timeoutMs, maxBytes: limit = maxBytes, shared = false } = {}) {
    if (!enabled) throw busy(`${name} is not connected`);
    const hit = cache.get(key);
    const t = now();
    if (hit && t - hit.at < ttlMs) return { data: hit.data, at: hit.at, stale: false };
    const old = () => (hit && now() - hit.at < ttlMs + staleMs ? { data: hit.data, at: hit.at, stale: true } : null);
    const orOld = (error) => { const o = old(); if (o) return o; throw error; };
    // The service has said to stop (too many requests, or a refusal): it is left alone
    // until the time it gave, whatever is being asked for.
    if (t < pausedUntil) return orOld(busy(`${name} is refusing requests for now (HTTP ${pausedBy}). Trying again in ${Math.max(1, Math.ceil((pausedUntil - t) / 1000))} seconds.`));
    // After a failure the service is left alone for a moment, so an outage is not made
    // worse by every viewer's retry.
    const failed = failures.get(key);
    if (failed && t - failed.at < failMs) return orOld(failed.error);
    if (inflight.has(key)) return inflight.get(key);
    // One visitor's share. Checked only when a call is really about to be made, and not
    // remembered as a failure of the key: the next visitor is not refused because of it.
    if (!shared && !fair(cost)) {
      seen.refused += 1;
      return orOld(Object.assign(busy(`Too many new lookups from one address for ${name}. Try again in a minute.`), { status: 429 }));
    }
    const run = (async () => {
      if (!(await afford(cost))) {
        seen.refused += 1;
        throw busy(`${name} is at its request limit. Try again shortly.`);
      }
      seen.calls += 1;
      const res = await fetchImpl(url, { ...init, headers: { ...headers, ...(init.headers || {}) }, signal: AbortSignal.timeout(callTimeout) });
      let data;
      if (missing.includes(res.status)) data = null;
      else {
        if (pauseOn.includes(res.status)) {
          const asked = Number(res.headers?.get?.('retry-after'));
          pausedUntil = now() + Math.min(600000, Math.max(1000, asked > 0 ? asked * 1000 : pauseMs));
          pausedBy = res.status;
        }
        if (!res.ok) throw new Error(`${name} HTTP ${res.status}`);
        data = transform(await read(res, as, limit));
      }
      remember(key, data);
      failures.delete(key);
      seen.lastOk = now();
      return { data, at: now(), stale: false };
    })()
      .catch((raw) => {
        // Whatever went wrong is reported without the address that was asked for.
        const error = raw?.publicMessage ? raw : Object.assign(new Error(redact((raw?.message || raw) + (raw?.cause?.code ? ' (' + raw.cause.code + ')' : ''))), { name: raw?.name || 'Error' });
        failures.set(key, { at: now(), error });
        if (failures.size > maxEntries) failures.delete(failures.keys().next().value);
        // A refusal by our own budget is not a fault of the service, so it is not
        // recorded as one.
        if (!error.publicMessage) { seen.lastError = String(error.message); seen.lastErrorAt = now(); }
        return orOld(error);
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  }

  function health() {
    if (!enabled) return { name, state: 'off', note: offNote, lastOk: null, lastError: null };
    // "error" means the latest thing that happened was a failure.
    const failing = seen.lastErrorAt !== null && (seen.lastOk === null || seen.lastErrorAt > seen.lastOk);
    return { name, state: failing ? 'error' : 'ok', note, lastOk: seen.lastOk, lastError: seen.lastError, lastErrorAt: seen.lastErrorAt, calls: seen.calls, refused: seen.refused, pausedUntil: now() < pausedUntil ? pausedUntil : null };
  }

  return { name, enabled, note, offNote, get, health, size: () => ({ cache: cache.size, failures: failures.size, visitors: visitors.size, inflight: inflight.size }) };
}

// Collects which sources an answer drew on, for the `sources` field of every response.
export function ledger(now = Date.now) {
  const rows = new Map();
  const put = (name, state, note) => {
    const prev = rows.get(name);
    // An error is never papered over by a later success from the same source.
    if (prev && prev.state === 'error' && state === 'ok') return;
    rows.set(name, { name, state, note });
  };
  const age = (at) => { const m = Math.max(1, Math.round((now() - at) / 60000)); return m >= 120 ? Math.round(m / 60) + ' hours' : m + (m === 1 ? ' minute' : ' minutes'); };
  const led = {
    ok: (name, note = '') => put(name, 'ok', note),
    off: (name, note) => put(name, 'off', note),
    error: (name, note) => put(name, 'error', note),
    // Reads through a source and records how it went. Returns the data, or throws.
    async read(source, url, opts) {
      if (!source.enabled) { put(source.name, 'off', source.offNote); throw busy(`${source.name} is not connected`); }
      try {
        const r = await source.get(url, opts);
        put(source.name, 'ok', r.stale ? `${source.note ? source.note + ' ' : ''}Showing a saved answer from ${age(r.at)} ago: the source could not be reached just now.` : source.note);
        return r.data;
      } catch (e) {
        put(source.name, 'error', e.publicMessage || 'Did not answer.');
        throw e;
      }
    },
    // The same, for a part of an answer that may be missing: null instead of an error.
    async tryRead(source, url, opts) {
      try { return await led.read(source, url, opts); } catch { return null; }
    },
    list: () => [...rows.values()]
  };
  return led;
}
