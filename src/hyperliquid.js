// Hyperliquid public market data (no key needed): markets, order book, candles, trades.
// Every call goes through a short-lived cache so many browsers share one upstream request.

const API = 'https://api.hyperliquid.xyz/info';
export const INTERVALS = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
export const validCoin = (c) => typeof c === 'string' && /^[A-Za-z0-9:]{1,20}$/.test(c);

export function createHyperliquid({ fetchImpl = fetch, now = Date.now, timeoutMs = 6000 } = {}) {
  const cache = new Map();
  const inflight = new Map();

  async function info(body, ttlMs) {
    const key = JSON.stringify(body);
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.data;
    // Requests that arrive while one is already on its way share its answer.
    if (inflight.has(key)) return inflight.get(key);
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
      if (cache.size > 400) cache.delete(cache.keys().next().value);
      return data;
    })().finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  }

  async function markets() {
    const data = await info({ type: 'metaAndAssetCtxs' }, 5000);
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
    const data = await info({ type: 'candleSnapshot', req: { coin, interval, startTime: endTime - bars * step, endTime } }, 5000);
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

  return { markets, book, candles, trades };
}
