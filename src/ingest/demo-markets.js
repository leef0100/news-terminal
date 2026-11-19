// Demo stand-in for the exchange APIs (`npm run demo`). It answers the same URLs with
// responses in the same shape as the real services, so the real parsing code runs.
// Every number here is invented.

const BASE = { BTC: 82400, ETH: 2510, SOL: 108, HYPE: 31, XRP: 1.92, DOGE: 0.142 };
const LONG = { BTC: 0.58, ETH: 0.69, SOL: 0.44, HYPE: 0.72, XRP: 0.33, DOGE: 0.61 };
const FUND = { BTC: 0.0001, ETH: 0.00018, SOL: -0.00006, HYPE: 0.00041, XRP: -0.00021, DOGE: 0.00009 };
const OI = { BTC: 9.1e9, ETH: 5.2e9, SOL: 1.9e9, HYPE: 1.1e9, XRP: 7.4e8, DOGE: 5.1e8 };

// Repeatable price path: the same moment always gives the same price, so candles of
// every size agree with each other. Built from layers of smooth noise, slow to fast,
// which gives trends, pullbacks and ranges that look like a market instead of a wave.
function hash(n, seed) {
  let h = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1;
}
function noise(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u;
}
const MIN = 60000;
const LAYERS = [[43200 * MIN, 0.11], [10080 * MIN, 0.06], [1440 * MIN, 0.032], [360 * MIN, 0.016], [60 * MIN, 0.008], [15 * MIN, 0.004], [3 * MIN, 0.002], [0.5 * MIN, 0.0008]];
const SEED = { BTC: 11, ETH: 23, SOL: 37, HYPE: 41, XRP: 53, DOGE: 67 };
function priceAt(coin, tMs) {
  const seed = SEED[coin] || 5;
  let sum = 0;
  for (let k = 0; k < LAYERS.length; k++) sum += LAYERS[k][1] * noise(tMs / LAYERS[k][0], seed * 100 + k);
  return (BASE[coin] || 1) * Math.exp(sum);
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
    if (body.type === 'fundingHistory') {
      const hour = 3600000;
      const out = [];
      for (let h = Math.ceil(body.startTime / hour) * hour; h <= t; h += hour) {
        const base = (FUND[body.coin] || 0.0001) / 8;
        out.push({ coin: body.coin, fundingRate: String(base * (1 + 0.9 * Math.sin(h / hour / 9)) + wobble(h / hour, base * 0.4)), premium: '0', time: h });
      }
      return json(out);
    }
    if (body.type === 'l2Book') {
      const mid = priceAt(body.coin, t);
      // Wider price steps when the book is asked for in fewer significant figures.
      const tick = body.nSigFigs ? Math.pow(10, Math.floor(Math.log10(mid)) - (body.nSigFigs - 1)) : mid * 0.00012;
      if (body.nSigFigs) {
        const snap = (dir) => Array.from({ length: 20 }, (_, i) => {
          const px = (dir < 0 ? Math.floor(mid / tick) - i : Math.ceil(mid / tick) + i) * tick;
          // Two levels on each side are made much larger, to stand in for resting "walls".
          const big = (i === 6 || i === 13) ? 6 : 1;
          return { px: String(Number(px.toPrecision(8))), sz: (((OI[body.coin] || 1e8) / mid) * 0.0004 * big * (1 + Math.abs(wobble(i * 3 + dir, 0.6)))).toFixed(4), n: 5 + i };
        });
        return json({ coin: body.coin, time: t, levels: [snap(-1), snap(1)] });
      }
      const side = (dir) => Array.from({ length: 20 }, (_, i) => ({ px: (mid + dir * tick * (i + 0.5)).toPrecision(7), sz: (((OI[body.coin] || 1e8) / mid) * 0.00002 * (1 + i * 0.35 + Math.abs(wobble(i + Math.floor(t / 1500), 1)))).toFixed(4), n: 3 + i }));
      return json({ coin: body.coin, time: t, levels: [side(-1), side(1)] });
    }
    if (body.type === 'candleSnapshot') {
      const { coin, interval, startTime, endTime } = body.req;
      const step = { '5m': 3e5, '15m': 9e5, '1h': 36e5, '4h': 144e5, '1d': 864e5 }[interval] || 9e5;
      const out = [];
      for (let s = Math.ceil(startTime / step) * step; s < Math.min(endTime, t); s += step) {
        const end = Math.min(s + step, t);
        const o = priceAt(coin, s), c = priceAt(coin, end);
        // High and low come from walking the same path inside the candle.
        let h = Math.max(o, c), l = Math.min(o, c);
        for (let k = 1; k < 16; k++) { const p = priceAt(coin, s + (end - s) * k / 16); if (p > h) h = p; if (p < l) l = p; }
        // Busier candles trade more.
        const v = (OI[coin] || 1e8) / o * (step / 864e5) * 0.25 * (0.5 + (h - l) / o * 120 + Math.abs(wobble(s / step, 0.4)));
        out.push({ t: s, T: s + step - 1, s: coin, i: interval, o: String(o), c: String(c), h: String(h), l: String(l), v: v.toFixed(3), n: 100 });
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
        const at = priceAt(body.coin, k * 4000);
        return { coin: body.coin, side: hash(k, 7) > 0 ? 'B' : 'A', px: at.toPrecision(7), sz: (usd / at).toFixed(4), time: k * 4000, tid: k };
      }));
    }
    return { ok: false, status: 404, json: async () => ({}) };
  };
}
