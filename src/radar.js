// Radar: one snapshot of how traders are positioned across venues.
// Everything here comes from public, keyless endpoints. Each venue is fetched on its own,
// so one being unreachable (some block certain regions) never takes the others down.
//
//   Binance      long/short account ratio, top-trader position ratio, funding, open interest
//   Bybit        long/short account ratio, funding, open interest
//   Hyperliquid  funding, open interest, large trades
//   Coinbase     spot price, used for the Coinbase premium
//   Papertrade   no public data feed is published, so it is listed as unavailable

const BINANCE = 'https://fapi.binance.com';
const BYBIT = 'https://api.bybit.com';
const COINBASE = 'https://api.exchange.coinbase.com';
export const RADAR_COINS = ['BTC', 'ETH', 'SOL', 'HYPE', 'XRP', 'DOGE'];

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

// Longs vs shorts as a plain statement, from the blended account ratio and funding.
export function readTilt(longPct, fundingAvg8h, from = []) {
  if (longPct == null) return { tilt: 'unknown', note: 'No positioning data from any venue right now.' };
  const pct = Math.round(longPct);
  const where = from.length ? ' on ' + from.join(' and ') : '';
  const paying = fundingAvg8h == null ? '' : fundingAvg8h > 0 ? ' Longs are paying funding.' : fundingAvg8h < 0 ? ' Shorts are paying funding.' : '';
  if (pct >= 65) return { tilt: 'long', note: `Crowded long: ${pct}% of accounts are long${where}.` + paying };
  if (pct <= 35) return { tilt: 'short', note: `Crowded short: ${100 - pct}% of accounts are short${where}.` + paying };
  if (pct >= 55) return { tilt: 'long', note: `Leaning long: ${pct}% of accounts are long${where}.` + paying };
  if (pct <= 45) return { tilt: 'short', note: `Leaning short: ${100 - pct}% of accounts are short${where}.` + paying };
  return { tilt: 'balanced', note: `Balanced: ${pct}% long, ${100 - pct}% short${where}.` + paying };
}

export function createRadar({ fetchImpl = fetch, hl, now = Date.now, coins = RADAR_COINS, ttlMs = 20000, bigTradeUsd = 250000, timeoutMs = 6000 } = {}) {
  let cached = null;
  let pending = null;

  async function getJson(url) {
    const res = await fetchImpl(url, { headers: { accept: 'application/json', 'user-agent': 'radar/0.1' }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // How often each Binance market settles funding. Markets not listed settle every 8 hours.
  // Asked for once an hour; if it cannot be read, the last answer (or 8 hours) is used.
  let intervalCache = { at: 0, map: Object.create(null) };
  async function binanceIntervals() {
    if (now() - intervalCache.at < 3600000) return intervalCache.map;
    try {
      const rows = await getJson(`${BINANCE}/fapi/v1/fundingInfo`);
      const map = Object.create(null);
      for (const r of Array.isArray(rows) ? rows : []) {
        const h = num(r.fundingIntervalHours);
        if (typeof r.symbol === 'string' && h > 0) map[r.symbol] = h;
      }
      intervalCache = { at: now(), map };
    } catch {
      intervalCache = { at: now() - 3300000, map: intervalCache.map }; // try again in five minutes
    }
    return intervalCache.map;
  }

  // Runs a venue's calls; the venue is "ok" if any call worked, and keeps the first error.
  async function venue(tasks) {
    const settled = await Promise.allSettled(tasks.map((t) => t()));
    const failed = settled.find((s) => s.status === 'rejected');
    return {
      ok: settled.some((s) => s.status === 'fulfilled'),
      error: failed ? String(failed.reason?.message || failed.reason) : null,
      partial: Boolean(failed) && settled.some((s) => s.status === 'fulfilled')
    };
  }

  async function build() {
    // No prototype, so a symbol named "constructor" or "__proto__" can only miss.
    const byCoin = Object.assign(Object.create(null), Object.fromEntries(coins.map((c) => [c, { coin: c, price: null, positioning: [], funding: [], openInterest: [], coinbasePremiumPct: null }])));
    const bigTrades = [];
    const spot = Object.create(null);

    const binance = venue([
      async () => {
        const intervals = await binanceIntervals();
        const all = await getJson(`${BINANCE}/fapi/v1/premiumIndex`);
        for (const row of Array.isArray(all) ? all : []) {
          const coin = String(row.symbol || '').replace(/USDT$/, '');
          const slot = byCoin[coin];
          if (!slot || !String(row.symbol).endsWith('USDT')) continue;
          slot.binanceMark = num(row.markPrice);
          const rate = num(row.lastFundingRate);
          // Binance settles funding every 8 hours on most markets and every 4 (or 1) on
          // others. The rate is per settlement, so it is put on an 8-hour footing to compare.
          const hours = intervals[row.symbol] || 8;
          if (rate != null) slot.funding.push({ venue: 'Binance', rate8h: rate * 8 / hours, intervalHours: hours });
        }
      },
      ...coins.flatMap((coin) => [
        async () => {
          const d = await getJson(`${BINANCE}/futures/data/globalLongShortAccountRatio?symbol=${coin}USDT&period=5m&limit=1`);
          const long = num(d?.[0]?.longAccount);
          if (long != null) byCoin[coin].positioning.push({ venue: 'Binance', label: 'All accounts', longPct: long * 100 });
        },
        async () => {
          const d = await getJson(`${BINANCE}/futures/data/topLongShortPositionRatio?symbol=${coin}USDT&period=5m&limit=1`);
          const long = num(d?.[0]?.longAccount);
          if (long != null) byCoin[coin].positioning.push({ venue: 'Binance', label: 'Top traders, by position size', longPct: long * 100, top: true });
        },
        async () => {
          const d = await getJson(`${BINANCE}/fapi/v1/openInterest?symbol=${coin}USDT`);
          const contracts = num(d?.openInterest);
          if (contracts != null) byCoin[coin].binanceOi = contracts;
        }
      ])
    ]);

    const bybit = venue([
      async () => {
        const d = await getJson(`${BYBIT}/v5/market/tickers?category=linear`);
        for (const row of d?.result?.list || []) {
          const coin = String(row.symbol || '').replace(/USDT$/, '');
          const slot = byCoin[coin];
          if (!slot || !String(row.symbol).endsWith('USDT')) continue;
          const rate = num(row.fundingRate);
          const hours = num(row.fundingIntervalHour) > 0 ? num(row.fundingIntervalHour) : 8;
          if (rate != null) slot.funding.push({ venue: 'Bybit', rate8h: rate * 8 / hours, intervalHours: hours });
          const oi = num(row.openInterestValue);
          if (oi != null) slot.openInterest.push({ venue: 'Bybit', usd: oi });
        }
      },
      ...coins.map((coin) => async () => {
        const d = await getJson(`${BYBIT}/v5/market/account-ratio?category=linear&symbol=${coin}USDT&period=5min&limit=1`);
        const long = num(d?.result?.list?.[0]?.buyRatio);
        if (long != null) byCoin[coin].positioning.push({ venue: 'Bybit', label: 'All accounts', longPct: long * 100 });
      })
    ]);

    const hyperliquid = venue([
      async () => {
        for (const m of await hl.markets()) {
          const slot = byCoin[m.coin];
          if (!slot) continue;
          slot.price = m.mark;
          // Hyperliquid funding is hourly; show it on the same 8-hour basis as the others.
          slot.funding.push({ venue: 'Hyperliquid', rate8h: m.fundingHourly * 8, intervalHours: 1 });
          slot.openInterest.push({ venue: 'Hyperliquid', usd: m.openInterestUsd });
        }
      },
      // Trades cost the most against the exchange's allowance, so only the three biggest
      // markets are watched for large ones.
      ...coins.slice(0, 3).map((coin) => async () => {
        for (const t of await hl.trades(coin)) if (t.usd >= bigTradeUsd) bigTrades.push({ ...t, venue: 'Hyperliquid' });
      })
    ]);

    const coinbase = venue(
      ['BTC', 'ETH', 'SOL'].filter((c) => coins.includes(c)).map((coin) => async () => {
        const d = await getJson(`${COINBASE}/products/${coin}-USD/ticker`);
        const px = num(d?.price);
        if (px != null) spot[coin] = px;
      })
    );

    const [b, y, h, c] = await Promise.all([binance, bybit, hyperliquid, coinbase]);

    const out = coins.map((coin) => {
      const s = byCoin[coin];
      if (s.binanceOi != null && (s.binanceMark || s.price)) s.openInterest.push({ venue: 'Binance', usd: s.binanceOi * (s.binanceMark || s.price) });
      if (s.price == null) s.price = s.binanceMark ?? spot[coin] ?? null;
      const perp = s.binanceMark ?? s.price;
      if (spot[coin] != null && perp) s.coinbasePremiumPct = ((spot[coin] - perp) / perp) * 100;
      const crowd = s.positioning.filter((p) => !p.top);
      const blended = crowd.length ? crowd.reduce((a, p) => a + p.longPct, 0) / crowd.length : null;
      const fundingAvg = s.funding.length ? s.funding.reduce((a, f) => a + f.rate8h, 0) / s.funding.length : null;
      const from = [...new Set(crowd.map((p) => p.venue))];
      const read = readTilt(blended, fundingAvg, from);
      // Coinbase spot against a futures price: the gap includes the futures' own premium.
      const premiumVs = spot[coin] != null && perp ? (s.binanceMark != null ? 'Binance futures' : 'Hyperliquid') : null;
      return {
        coin,
        price: s.price,
        positioning: s.positioning.map((p) => ({ ...p, longPct: +p.longPct.toFixed(2), shortPct: +(100 - p.longPct).toFixed(2) })),
        blendedLongPct: blended == null ? null : +blended.toFixed(2),
        // Which venues the figure above is built from: it changes meaning when one is missing.
        blendedFrom: from,
        openInterestFrom: s.openInterest.map((o) => o.venue),
        coinbasePremiumVs: premiumVs,
        tilt: read.tilt,
        note: read.note,
        // 8-hour rate x 3 per day x 365 = yearly rate, shown as a percentage.
        funding: s.funding.map((f) => ({ ...f, annualPct: +(f.rate8h * 3 * 365 * 100).toFixed(2) })),
        openInterest: s.openInterest.sort((x, z) => z.usd - x.usd),
        openInterestUsd: s.openInterest.reduce((a, o) => a + o.usd, 0),
        coinbasePremiumPct: s.coinbasePremiumPct == null ? null : +s.coinbasePremiumPct.toFixed(4)
      };
    });

    bigTrades.sort((a, z) => z.time - a.time);
    return {
      at: now(),
      bigTradeUsd,
      venues: [
        { name: 'Binance', ...b },
        { name: 'Bybit', ...y },
        { name: 'Hyperliquid', ...h },
        { name: 'Coinbase', ...c },
        { name: 'Papertrade', ok: false, partial: false, error: 'No public data feed is published' }
      ],
      coins: out,
      bigTrades: bigTrades.slice(0, 40)
    };
  }

  async function snapshot() {
    if (cached && now() - cached.at < ttlMs) return cached;
    if (!pending) {
      pending = build()
        .then((s) => (cached = s))
        .finally(() => (pending = null));
    }
    return pending;
  }

  return { snapshot };
}
