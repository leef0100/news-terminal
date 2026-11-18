// Demo stand-in for the exchange APIs (`npm run demo`). It answers the same URLs with
// responses in the same shape as the real services, so the real parsing code runs.
// Every number here is invented.

const BASE = { BTC: 82400, ETH: 2510, SOL: 108, HYPE: 31, XRP: 1.92, DOGE: 0.142 };
const LONG = { BTC: 0.58, ETH: 0.69, SOL: 0.44, HYPE: 0.72, XRP: 0.33, DOGE: 0.61 };
const FUND = { BTC: 0.0001, ETH: 0.00018, SOL: -0.00006, HYPE: 0.00041, XRP: -0.00021, DOGE: 0.00009 };
const OI = { BTC: 9.1e9, ETH: 5.2e9, SOL: 1.9e9, HYPE: 1.1e9, XRP: 7.4e8, DOGE: 5.1e8 };

// Smooth, repeatable price path: the same moment always gives the same price.
function priceAt(coin, tMs) {
  const base = BASE[coin] || 1;
  const x = tMs / 60000;
  return base * (1 + 0.018 * Math.sin(x / 97) + 0.009 * Math.sin(x / 23 + 1.3) + 0.004 * Math.sin(x / 5.1 + 0.4));
}
const wobble = (seed, amp) => Math.sin(seed * 12.9898) * amp;
const json = (data) => ({ ok: true, status: 200, json: async () => data });

export function demoMarketFetch(now = Date.now) {
  return async (url, init = {}) => {
    const u = String(url);
    const t = now();
    const coinOf = (re) => (u.match(re) || [])[1];

    if (u.includes('/fapi/v1/premiumIndex')) {
      return json(Object.keys(BASE).map((c) => ({ symbol: c + 'USDT', markPrice: String(priceAt(c, t)), lastFundingRate: String(FUND[c]) })));
    }
    if (u.includes('LongShort')) {
      const c = coinOf(/symbol=([A-Z]+)USDT/);
      const long = Math.min(0.9, Math.max(0.1, (LONG[c] ?? 0.5) + (u.includes('top') ? -0.07 : 0) + wobble(Math.floor(t / 60000), 0.01)));
      return json([{ symbol: c + 'USDT', longAccount: long.toFixed(4), shortAccount: (1 - long).toFixed(4), longShortRatio: (long / (1 - long)).toFixed(4), timestamp: t }]);
    }
    if (u.includes('/fapi/v1/openInterest')) {
      const c = coinOf(/symbol=([A-Z]+)USDT/);
      return json({ symbol: c + 'USDT', openInterest: String((OI[c] || 1e8) / priceAt(c, t)) });
    }
    if (u.includes('/v5/market/tickers')) {
      return json({ retCode: 0, result: { list: Object.keys(BASE).map((c) => ({ symbol: c + 'USDT', lastPrice: String(priceAt(c, t)), fundingRate: String(FUND[c] * 1.2), openInterestValue: String((OI[c] || 1e8) * 0.55) })) } });
    }
    if (u.includes('/v5/market/account-ratio')) {
      const c = coinOf(/symbol=([A-Z]+)USDT/);
      const long = Math.min(0.9, Math.max(0.1, (LONG[c] ?? 0.5) + 0.03));
      return json({ retCode: 0, result: { list: [{ symbol: c + 'USDT', buyRatio: long.toFixed(4), sellRatio: (1 - long).toFixed(4), timestamp: String(t) }] } });
    }
    if (u.includes('/products/')) {
      const c = coinOf(/products\/([A-Z]+)-USD/);
      return json({ price: String(priceAt(c, t) * 1.0004), time: new Date(t).toISOString() });
    }

    // Hyperliquid: one URL, the request body says what is wanted.
    const body = JSON.parse(init.body || '{}');
    const coins = Object.keys(BASE);
    if (body.type === 'metaAndAssetCtxs') {
      return json([
        { universe: coins.map((name) => ({ name, szDecimals: 3, maxLeverage: name === 'BTC' ? 40 : 20 })) },
        coins.map((c) => {
          const mark = priceAt(c, t);
          return {
            markPx: String(mark), oraclePx: String(mark * 0.9998), prevDayPx: String(priceAt(c, t - 86400000)),
            funding: String(FUND[c] / 8), openInterest: String(((OI[c] || 1e8) * 0.3) / mark), dayNtlVlm: String((OI[c] || 1e8) * 0.8)
          };
        })
      ]);
    }
    if (body.type === 'l2Book') {
      const mid = priceAt(body.coin, t);
      const tick = mid * 0.00012;
      const side = (dir) => Array.from({ length: 20 }, (_, i) => ({ px: (mid + dir * tick * (i + 0.5)).toPrecision(7), sz: (((OI[body.coin] || 1e8) / mid) * 0.00002 * (1 + i * 0.35 + Math.abs(wobble(i + Math.floor(t / 1500), 1)))).toFixed(4), n: 3 + i }));
      return json({ coin: body.coin, time: t, levels: [side(-1), side(1)] });
    }
    if (body.type === 'candleSnapshot') {
      const { coin, interval, startTime, endTime } = body.req;
      const step = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 }[interval] || 9e5;
      const out = [];
      for (let s = Math.ceil(startTime / step) * step; s < Math.min(endTime, t); s += step) {
        const o = priceAt(coin, s), c = priceAt(coin, Math.min(s + step, t));
        const pad = Math.abs(wobble(s / step, 0.0016)) * o;
        out.push({ t: s, T: s + step - 1, s: coin, i: interval, o: String(o), c: String(c), h: String(Math.max(o, c) + pad), l: String(Math.min(o, c) - pad), v: String(1000 + Math.abs(wobble(s / step + 7, 900))), n: 100 });
      }
      return json(out);
    }
    if (body.type === 'recentTrades') {
      const mid = priceAt(body.coin, t);
      const bucket = Math.floor(t / 4000);
      return json(Array.from({ length: 24 }, (_, i) => {
        const k = bucket - i;
        const big = k % 7 === 0;
        const usd = big ? 300000 + Math.abs(wobble(k, 900000)) : 2000 + Math.abs(wobble(k, 40000));
        return { coin: body.coin, side: wobble(k + 3, 1) > 0 ? 'B' : 'A', px: mid.toPrecision(7), sz: (usd / mid).toFixed(4), time: k * 4000, tid: k };
      }));
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
