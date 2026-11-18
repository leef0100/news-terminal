// Polls every configured source on a timer and pushes new items into the store.
import { fetchFeed } from './rss.js';
import { enrich } from '../enrich.js';

export function createPoller({ sources, store, pollSeconds = 20, fetchImpl = fetch, now = Date.now, log = console }) {
  const state = new Map(sources.map((s) => [s.id, { cache: {}, first: true, ok: null, error: null, lastPoll: null, count: 0 }]));
  let timer = null;

  async function pollOne(source) {
    const st = state.get(source.id);
    try {
      const entries = await fetchFeed(source, { fetchImpl, cache: st.cache });
      const seenAt = now();
      for (const e of entries) {
        // Everything in the first pull is backlog: no alerts, no latency figure.
        const added = store.add(enrich({ ...e, ts: e.ts ?? seenAt, seenAt, backfill: st.first }, source));
        if (added) st.count += 1;
      }
      st.first = false;
      st.ok = true;
      st.error = null;
    } catch (err) {
      st.ok = false;
      st.error = String(err.message || err);
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
        return { id: s.id, name: s.name, ok: st.ok, error: st.error, lastPoll: st.lastPoll, items: st.count };
      });
    }
  };
}
