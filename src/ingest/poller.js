// Polls every configured source on a timer and pushes new items into the store.
import { fetchFeed } from './rss.js';
import { enrich } from '../enrich.js';

export function createPoller({ sources, store, pollSeconds = 20, fetchImpl = fetch, now = Date.now, log = console }) {
  const state = new Map(sources.map((s) => [s.id, { cache: {}, first: true, ok: null, error: null, lastPoll: null, lastOk: null, ms: null, count: 0, seen: new Set() }]));
  let timer = null;

  async function pollOne(source) {
    const st = state.get(source.id);
    const began = now();
    try {
      const entries = await fetchFeed(source, { fetchImpl, cache: st.cache });
      st.ms = now() - began;
      const seenAt = now();
      for (const e of entries) {
        // Each entry is handled once per source, for good. Feeds keep listing old entries
        // long after they have left our window; without this they would come back as "new".
        if (st.seen.has(e.id)) continue;
        st.seen.add(e.id);
        if (st.seen.size > 5000) st.seen.delete(st.seen.values().next().value);
        // A feed's clock is not trusted: no date means "now", and nothing is from the future.
        const ts = Math.min(e.ts ?? seenAt, seenAt);
        // Everything in the first pull is backlog: no alerts, no latency figure.
        const added = store.add(enrich({ ...e, ts, seenAt, backfill: st.first }, source));
        if (added) st.count += 1;
      }
      st.first = false;
      st.ok = true;
      st.error = null;
      st.lastOk = now();
    } catch (err) {
      st.ok = false;
      // Node reports every network failure as "fetch failed"; the reason is one level down.
      const why = err?.cause?.code || err?.cause?.message;
      st.error = String(err.message || err) + (why ? ' (' + why + ')' : '');
      log.warn(`[feed] ${source.name}: ${st.error}`);
    }
    st.lastPoll = now();
  }

  // A slow round is allowed to finish; the next tick is skipped rather than piled on top.
  let running = false;
  const pollAll = async () => {
    if (running) return;
    running = true;
    try {
      await Promise.allSettled(sources.map(pollOne));
    } finally {
      running = false;
    }
  };

  return {
    pollAll,
    start() {
      pollAll();
      timer = setInterval(pollAll, pollSeconds * 1000);
    },
    stop() {
      clearInterval(timer);
    },
    status() {
      return sources.map((s) => {
        const st = state.get(s.id);
        return { id: s.id, name: s.name, ok: st.ok, error: st.error, lastPoll: st.lastPoll, lastOk: st.lastOk, ms: st.ms, items: st.count };
      });
    }
  };
}
