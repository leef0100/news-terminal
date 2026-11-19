// Hyperliquid public market data (no key needed): markets, order book, candles, trades.
// Every call goes through a short-lived cache so many browsers share one upstream request.

const API = 'https://api.hyperliquid.xyz/info';
export const INTERVALS = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
export const validCoin = (c) => typeof c === 'string' && /^[A-Za-z0-9:]{1,20}$/.test(c);

// What each kind of request costs against the exchange's allowance of 1,200 a minute per
// address (their published weights; candle and history calls cost more the more they return).
const WEIGHT = { candleSnapshot: 25, fundingHistory: 30, recentTrades: 21, metaAndAssetCtxs: 20, l2Book: 2 };

export function createHyperliquid({ fetchImpl = fetch, now = Date.now, timeoutMs = 6000, weightPerMinute = 900 } = {}) {
  const cache = new Map();
  const inflight = new Map();
  const failures = new Map();
  const FAIL_MS = 2000;
  // An old answer may stand in for a failed call, but only briefly: a price from long ago
  // shown as current is worse than an honest error.
  const STALE_MS = 90000;
  const usable = (hit) => hit && now() - hit.at < STALE_MS;
  // This server is one address to the exchange, however many people it serves. Its own
  // spending is capped below the exchange's limit; past that, the last answer is reused.
  // Browsers fetch history from the exchange themselves where they can, each on their own
  // allowance, so this path is mostly a fallback.
  let windowStart = 0;
  let spent = 0;
  // When the exchange last answered and last failed, for the Status page.
  const seen = { lastOk: null, lastError: null, lastErrorAt: null };
  const afford = (type) => {
    const t = now();
    if (t - windowStart >= 60000) { windowStart = t; spent = 0; }
    const cost = WEIGHT[type] || 20;
    // History and trade calls may not use the whole allowance: a part is always kept
    // back for prices and the order book, which every page needs.
    const ceiling = type === 'metaAndAssetCtxs' || type === 'l2Book' ? weightPerMinute : weightPerMinute - Math.min(200, weightPerMinute / 4);
    if (spent + cost > ceiling) return false;
    spent += cost;
    return true;
  };

  async function info(body, ttlMs) {
    const key = JSON.stringify(body);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.data;
    // After a failure the exchange is left alone for a moment. During an outage every
    // viewer falls back to asking us, and we must not pass all of that on to a service
    // that is already struggling. The last good answer is served meanwhile, if there is one.
    const failed = failures.get(key);
    if (failed && now() - failed.at < FAIL_MS) {
      if (usable(hit)) return hit.data;
      throw failed.error;
    }
    // Requests that arrive while one is already on its way share its answer.
    if (inflight.has(key)) return inflight.get(key);
    if (!afford(body.type)) {
      if (usable(hit)) return hit.data;
      throw new Error('Hyperliquid allowance used up for this minute');
    }
    const run = (async () => {
      const res = await fetchImpl(API, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: key,
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) throw new Error('Hyperliquid HTTP ' + res.status);
      const data = await res.json();
      cache.set(key, { at: now(), data });
      failures.delete(key);
      seen.lastOk = now();
      if (cache.size > 400) cache.delete(cache.keys().next().value);
      return data;
    })()
      .catch((error) => {
        failures.set(key, { at: now(), error });
        seen.lastError = String(error?.message || error);
        seen.lastErrorAt = now();
        if (failures.size > 400) failures.delete(failures.keys().next().value);
        if (usable(hit)) return hit.data;
        throw error;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  }

  async function markets() {
    const data = await info({ type: 'metaAndAssetCtxs' }, 10000);
    const universe = data?.[0]?.universe || [];
    const ctxs = data?.[1] || [];
    return universe
      .map((u, i) => {
        const c = ctxs[i] || {};
        const mark = Number(c.markPx) || 0;
        const prev = Number(c.prevDayPx) || 0;
        return {
          coin: u.name,
          delisted: Boolean(u.isDelisted),
          maxLeverage: u.maxLeverage ?? null,
          mark,
          oracle: Number(c.oraclePx) || 0,
          change24hPct: prev ? ((mark - prev) / prev) * 100 : 0,
          fundingHourly: Number(c.funding) || 0,
          openInterestUsd: (Number(c.openInterest) || 0) * mark,
          volume24hUsd: Number(c.dayNtlVlm) || 0
        };
      })
      .filter((m) => !m.delisted && m.mark > 0)
      .sort((a, b) => b.volume24hUsd - a.volume24hUsd);
  }

  async function book(coin, depth = 16) {
    const data = await info({ type: 'l2Book', coin }, 1000);
    const side = (levels) => (levels || []).slice(0, depth).map((l) => ({ px: Number(l.px), sz: Number(l.sz) }));
    const bids = side(data?.levels?.[0]);
    const asks = side(data?.levels?.[1]);
    const mid = bids.length && asks.length ? (bids[0].px + asks[0].px) / 2 : null;
    return { coin, time: data?.time ?? now(), bids, asks, mid, spread: mid ? asks[0].px - bids[0].px : null };
  }

  async function candles(coin, interval = '15m', bars = 300) {
    const step = INTERVALS[interval];
    if (!step) throw new Error('Unknown interval');
    // Round the window to the interval so repeated requests share a cache entry.
    const endTime = Math.floor(now() / step) * step + step;
    const data = await info({ type: 'candleSnapshot', req: { coin, interval, startTime: endTime - bars * step, endTime } }, 15000);
    return (Array.isArray(data) ? data : []).map((c) => ({
      time: Math.floor(c.t / 1000),
      open: Number(c.o),
      high: Number(c.h),
      low: Number(c.l),
      close: Number(c.c),
      volume: Number(c.v)
    }));
  }

  async function trades(coin, limit = 40) {
    const data = await info({ type: 'recentTrades', coin }, 2000);
    return (Array.isArray(data) ? data : [])
      .map((t) => {
        const px = Number(t.px);
        const sz = Number(t.sz);
        return { coin, side: t.side === 'B' ? 'buy' : 'sell', px, sz, usd: px * sz, time: t.time, id: t.tid ?? t.hash ?? t.time + ':' + t.px };
      })
      .sort((a, b) => b.time - a.time)
      .slice(0, limit);
  }

  // The order book grouped into wider price steps (`sig` significant figures: 5 is the
  // finest, 2 the widest), which shows where the large resting orders are further out.
  async function depth(coin, sig = 3) {
    const n = [2, 3, 4, 5].includes(Number(sig)) ? Number(sig) : 3;
    const data = await info({ type: 'l2Book', coin, nSigFigs: n }, 2000);
    const side = (levels) => (levels || []).slice(0, 20).map((l) => ({ px: Number(l.px), sz: Number(l.sz) })).filter((l) => l.px > 0 && l.sz > 0);
    return { coin, sig: n, time: data?.time ?? now(), bids: side(data?.levels?.[0]), asks: side(data?.levels?.[1]) };
  }

  // Hourly funding for the past week, oldest first.
  async function fundingHistory(coin) {
    const hour = 3600000;
    const startTime = Math.floor(now() / hour) * hour - 7 * 24 * hour;
    const data = await info({ type: 'fundingHistory', coin, startTime }, 600000);
    return (Array.isArray(data) ? data : [])
      .map((f) => ({ time: Number(f.time), rate: Number(f.fundingRate) }))
      .filter((f) => Number.isFinite(f.time) && Number.isFinite(f.rate))
      .sort((a, b) => a.time - b.time);
  }

  // True for a market the exchange actually lists. Made-up names are refused before they
  // can each cost an upstream call.
  async function has(coin) {
    return (await markets()).some((m) => m.coin === coin);
  }

  const health = () => ({ ...seen, spentThisMinute: now() - windowStart >= 60000 ? 0 : spent, allowancePerMinute: weightPerMinute });

  return { markets, book, candles, trades, depth, fundingHistory, has, health };
}
