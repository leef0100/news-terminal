// Share and index prices.
//
// There is no official, free, real-time feed of US share prices: the exchanges license
// them. So prices come through small interchangeable providers, tried in order, and every
// quote says which one it came from and what kind of price it is. A customer with a licensed
// feed adds one more provider of the same shape:
//
//   { name, enabled, quote(symbol, led) -> quote fields or null, candles(symbol, range, led) -> { candles, delayed } or null }
//
// Providers here:
//   Finnhub      (FINNHUB_KEY)     quotes. Its free plan's display terms could not be checked;
//                                  see docs/TRADFI-SOURCES.md before showing it to customers.
//   Twelve Data  (TWELVEDATA_KEY)  daily history and quotes. Its free plan is licensed for
//                                  internal use only; showing it to customers needs a business plan.
//   Hyperliquid  (no key)          perpetual contracts on a few dozen large US shares and
//                                  indexes, traded round the clock on Hyperliquid. These are
//                                  NOT exchange prices: a perpetual tracks the share but trades
//                                  at its own price, and its "change" is over 24 hours, not
//                                  since the last close. Every such quote is marked `kind: 'perp'`.

import { DAY, RANGES, num, round, pct } from './util.js';

const HL_API = 'https://api.hyperliquid.xyz/info';
// Tickers that are unmistakably US shares. A perpetual is only ever shown as a share's price
// if its name is on this list, so a contract called GOLD or OIL can never be taken for the
// company with that ticker. Change it with HL_EQUITY_SYMBOLS.
export const HL_DEFAULT_EQUITIES = ['AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN', 'META', 'TSLA', 'AMD', 'NFLX', 'ORCL', 'AVGO', 'INTC', 'MU', 'PLTR', 'COIN', 'HOOD', 'MSTR', 'CRCL', 'TSM', 'BABA', 'COST', 'LLY', 'JPM', 'CRM', 'ADBE', 'UBER', 'SNOW', 'SHOP', 'RDDT', 'GME'];
export const HL_DEFAULT_INDEXES = ['XYZ100', 'SP500'];
const list = (v, fallback) => (typeof v === 'string' && v.trim() ? v.split(',').map((s) => s.trim().toUpperCase()).filter((s) => /^[A-Z0-9]{1,10}$/.test(s)) : fallback);

export function createHyperliquidPerps({ source, env = {}, now = Date.now }) {
  const dex = /^[a-z0-9]{1,12}$/.test(env.HL_EQUITY_DEX || '') ? env.HL_EQUITY_DEX : 'xyz';
  const equities = new Set(list(env.HL_EQUITY_SYMBOLS, HL_DEFAULT_EQUITIES));
  const indexes = list(env.HL_INDEX_PERPS, HL_DEFAULT_INDEXES);
  const post = (body, opts, led) => led.read(source, HL_API, { ...opts, key: JSON.stringify(body), init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } });

  // Every market on the venue: name without the venue prefix -> its latest figures.
  function universe(led) {
    return post({ type: 'metaAndAssetCtxs', dex }, {
      ttlMs: 10000, staleMs: 90000, cost: 20,
      transform: (d) => {
        const out = new Map();
        const ctxs = d?.[1] || [];
        (d?.[0]?.universe || []).forEach((u, i) => {
          const c = ctxs[i] || {};
          const mark = num(c.markPx), prev = num(c.prevDayPx);
          const full = String(u?.name || '');
          const short = full.includes(':') ? full.slice(full.indexOf(':') + 1) : full;
          if (!short || u.isDelisted || !(mark > 0)) return;
          out.set(short.toUpperCase(), { coin: full, mark, prev, volumeUsd: num(c.dayNtlVlm), oracle: num(c.oraclePx) });
        });
        return { at: now(), markets: out };
      }
    }, led);
  }

  const asQuote = (m, at) => ({
    price: m.mark, changePct: pct(m.mark, m.prev), previousClose: null, open: null, high: null, low: null, volume: null,
    volumeUsd: m.volumeUsd, asOf: at, delayed: false, kind: 'perp', changeBasis: '24h', source: `Hyperliquid perpetual (${m.coin})`
  });

  return {
    name: 'Hyperliquid perpetuals', enabled: source.enabled, dex,
    async quote(symbol, led) {
      if (!equities.has(symbol)) return null;
      const u = await universe(led);
      const m = u.markets.get(symbol);
      return m ? asQuote(m, u.at) : null;
    },
    // Index contracts the venue lists, under symbols of our own ("HL:XYZ100") so they can
    // never be confused with a share or with the index a contract is modelled on.
    async indexes(led) {
      const u = await universe(led);
      return indexes.filter((n) => u.markets.has(n)).map((n) => ({ symbol: 'HL:' + n, name: `${n} perpetual on Hyperliquid`, ...asQuote(u.markets.get(n), u.at) }));
    },
    async indexQuote(symbol, led) {
      const n = symbol.slice(3);
      if (!symbol.startsWith('HL:') || !indexes.includes(n)) return null;
      const u = await universe(led);
      const m = u.markets.get(n);
      return m ? { name: `${n} perpetual on Hyperliquid`, ...asQuote(m, u.at) } : null;
    },
    // Every share on the allow-list that the venue lists, for the movers table.
    async listed(led) {
      const u = await universe(led);
      return [...u.markets].filter(([n]) => equities.has(n)).map(([n, m]) => ({ symbol: n, ...asQuote(m, u.at) }));
    },
    async candles(symbol, range, led) {
      const n = symbol.startsWith('HL:') ? symbol.slice(3) : symbol;
      if (symbol.startsWith('HL:') ? !indexes.includes(n) : !equities.has(n)) return null;
      const u = await universe(led);
      const m = u.markets.get(n);
      if (!m) return null;
      // Rounded to the day so everyone asking within a day shares one upstream answer.
      const endTime = Math.floor(now() / DAY) * DAY + DAY;
      const days = RANGES[range];
      const rows = await post({ type: 'candleSnapshot', req: { coin: m.coin, interval: '1d', startTime: endTime - days * DAY, endTime } }, {
        ttlMs: 60000, staleMs: 600000, cost: 20 + Math.ceil(days / 60),
        transform: (d) => (Array.isArray(d) ? d : []).map((c) => ({ time: Math.floor(Number(c.t) / 1000), open: num(c.o), high: num(c.h), low: num(c.l), close: num(c.c), volume: num(c.v) }))
          .filter((c) => Number.isFinite(c.time) && c.open !== null && c.close !== null).sort((a, b) => a.time - b.time)
      }, led);
      return { candles: rows, delayed: false, interval: '1d', kind: 'perp', source: `Hyperliquid perpetual (${m.coin})` };
    }
  };
}

export function createFinnhub({ source, key }) {
  const API = 'https://finnhub.io/api/v1';
  return {
    name: 'Finnhub', enabled: source.enabled,
    async quote(symbol, led) {
      // The key travels in the address, as Finnhub documents; the cache key leaves it out.
      const q = await led.read(source, `${API}/quote?symbol=${encodeURIComponent(symbol)}&token=${key}`, { ttlMs: 20000, staleMs: 120000, key: 'quote:' + symbol });
      const price = num(q?.c), t = num(q?.t);
      // An unknown symbol comes back as all zeros.
      if (!(price > 0) || !(t > 0)) return null;
      return {
        price, changePct: num(q.dp) === null ? pct(price, num(q.pc)) : round(num(q.dp)), previousClose: num(q.pc), open: num(q.o) || null, high: num(q.h) || null, low: num(q.l) || null,
        // Finnhub does not state how fresh a free-plan quote is, so it is treated as delayed.
        volume: null, asOf: t * 1000, delayed: true, kind: 'stock', changeBasis: 'previous close', source: 'Finnhub'
      };
    },
    async candles() { return null; }, // daily history is a paid feature there
    earnings: (from, to, led) => led.read(source, `${API}/calendar/earnings?from=${from}&to=${to}&token=${key}`, {
      ttlMs: 3600000, staleMs: 86400000, key: `earnings:${from}:${to}`,
      transform: (d) => (d?.earningsCalendar || []).map((e) => ({ symbol: String(e.symbol || '').toUpperCase(), date: String(e.date || ''), hour: String(e.hour || ''), quarter: num(e.quarter), year: num(e.year), epsEstimate: num(e.epsEstimate) }))
        .filter((e) => e.symbol && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    }),
    ipos: (from, to, led) => led.read(source, `${API}/calendar/ipo?from=${from}&to=${to}&token=${key}`, {
      ttlMs: 3600000, staleMs: 86400000, key: `ipo:${from}:${to}`,
      transform: (d) => (d?.ipoCalendar || []).map((e) => ({
        company: String(e.name || ''), symbol: String(e.symbol || '').toUpperCase() || null, exchange: String(e.exchange || '') || null, date: String(e.date || ''),
        price: String(e.price || '') || null, status: ['expected', 'priced', 'filed', 'withdrawn'].includes(e.status) ? e.status : null
      })).filter((e) => e.company && e.status && /^\d{4}-\d{2}-\d{2}$/.test(e.date))
    })
  };
}

export function createTwelveData({ source, key }) {
  const API = 'https://api.twelvedata.com';
  const init = { headers: { authorization: 'apikey ' + key } };
  // Problems are reported inside a 200 answer: { code, message, status: 'error' }.
  const checked = (d) => { if (d?.status === 'error') throw new Error('Twelve Data error ' + (d.code || '')); return d; };
  return {
    name: 'Twelve Data', enabled: source.enabled,
    async quote(symbol, led) {
      const q = await led.read(source, `${API}/quote?symbol=${encodeURIComponent(symbol)}`, { ttlMs: 60000, staleMs: 300000, init, transform: (d) => (d?.code === 404 || d?.code === 400 ? null : checked(d)) });
      const price = num(q?.close);
      if (!q || !(price > 0)) return null;
      return {
        price, changePct: num(q.percent_change) === null ? pct(price, num(q.previous_close)) : round(num(q.percent_change)), previousClose: num(q.previous_close),
        open: num(q.open), high: num(q.high), low: num(q.low), volume: num(q.volume), asOf: num(q.timestamp) ? num(q.timestamp) * 1000 : null,
        // Without a timestamp there is no telling how old the price is, so it is not called live.
        delayed: !num(q.timestamp) || q.is_market_open === false, kind: 'stock', changeBasis: 'previous close', source: 'Twelve Data'
      };
    },
    async candles(symbol, range, led) {
      const size = Math.ceil(RANGES[range] * 5 / 7) + 5;
      const rows = await led.read(source, `${API}/time_series?symbol=${encodeURIComponent(symbol)}&interval=1day&outputsize=${size}`, {
        ttlMs: 900000, staleMs: 86400000, init,
        transform: (d) => (d?.code === 404 || d?.code === 400 ? null : (checked(d).values || []).map((v) => ({ time: Math.floor(Date.parse(String(v.datetime).slice(0, 10) + 'T00:00:00Z') / 1000), open: num(v.open), high: num(v.high), low: num(v.low), close: num(v.close), volume: num(v.volume) }))
          .filter((c) => Number.isFinite(c.time) && c.close !== null).sort((a, b) => a.time - b.time))
      });
      return rows ? { candles: rows, delayed: true, interval: '1d', kind: 'stock', source: 'Twelve Data (daily bars; the latest bar is the last completed or current session)' } : null;
    }
  };
}
