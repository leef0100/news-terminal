// Where the indexes' inputs come from when the server runs on real data.
//
// Each function below answers one question for the engine (engine.js) and always says how
// it went: 'ok' with dated figures, 'off' when a key or setting is missing (with the
// sentence the page shows), 'none' when the source is connected but has nothing for that
// name, or 'retry' when it failed just now. Nothing here returns a figure it did not read.
//
//   shares and filings   the stocks module's own backend (its caches, budgets and terms)
//   crypto               the Hyperliquid market client the crypto pages use
//   energy               US Energy Information Administration open data (EIA_KEY), or FRED
//                        (FRED_KEY) as a fallback
//   cloud prices         Microsoft's public Azure retail price list (no key), collected into
//                        a small dated store
//
// What was and was not verified about each is in docs/INDEX-METHODS.md.

import { createSource, ledger } from '../tradfi/source.js';
import { FRED_NOTICE } from '../tradfi/fred.js';
import { isoDay, monthlyMean } from './math.js';

const MIN = 60000, HOUR = 3600000, DAY = 86400000;
const clean = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v) => { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };
const words = (e) => String(e?.publicMessage || 'The source did not answer.');

// Keeps one answer per key for a time that depends on how it went, and shares a call that
// is already on its way.
function keeper(now, ttlOf) {
  const kept = new Map(), flying = new Map();
  return (key, build) => {
    const hit = kept.get(key);
    if (hit && now() - hit.at < ttlOf(hit.value)) return Promise.resolve(hit.value);
    if (flying.has(key)) return flying.get(key);
    const run = build().then((value) => { kept.delete(key); kept.set(key, { at: now(), value }); if (kept.size > 300) kept.delete(kept.keys().next().value); return value; }).finally(() => flying.delete(key));
    flying.set(key, run);
    return run;
  };
}
const TTL = { ok: 6 * HOUR, none: 10 * MIN, off: MIN, retry: 20000 };

function findRow(rows, key) {
  for (const r of rows || []) {
    if (r?.key === key) return r;
    const inner = findRow(r?.children, key);
    if (inner) return inner;
  }
  return null;
}

// Share prices and company filings, through the stocks module.
export function createMarketInputs({ tradfi, now = Date.now }) {
  const keepCloses = keeper(now, (v) => TTL[v.state]);
  const keepFilings = keeper(now, (v) => (v.state === 'ok' ? HOUR : TTL[v.state]));
  const missing = { state: 'off', note: 'The stocks module is not available to the indexes.', sources: [] };

  // Daily exchange closes for one share: { state, points: [{ t, v }], source, delayed, note, sources }.
  const closes = (symbol) => (!tradfi?.candles ? Promise.resolve({ ...missing, points: [] }) : keepCloses(symbol, async () => {
    let r;
    try {
      r = await tradfi.candles(symbol, '5y');
    } catch (e) {
      if (e?.status === 400) return { state: 'none', points: [], note: 'No listed company has this ticker in the SEC’s list.', sources: [] };
      return { state: 'retry', points: [], note: words(e), sources: [] };
    }
    const sources = Array.isArray(r?.sources) ? r.sources : [];
    const rows = Array.isArray(r?.candles) ? r.candles : [];
    if (rows.length && r.kind !== 'stock') {
      // No exchange closes are connected, but the share's perpetual contract is. Its daily
      // close (midnight UTC) is a real traded price, so the index is built from it and says
      // so plainly: a contract price that tracks the share, not the exchange's own close.
      const points = rows.map((c) => ({ t: isoDay(c.time * 1000), v: num(c.close) })).filter((p) => p.v > 0);
      return { state: 'ok', perp: true, points, source: 'Hyperliquid perpetual contracts', delayed: false, note: '', sources };
    }
    if (rows.length) {
      const points = rows.map((c) => ({ t: isoDay(c.time * 1000), v: num(c.close) })).filter((p) => p.v > 0);
      return { state: 'ok', points, source: String(r.source || 'Price source'), delayed: Boolean(r.delayed), note: '', sources };
    }
    // Perpetual contracts could not have been used whatever they answered, so their being
    // down is not what stands between this index and its prices.
    const usable = sources.filter((s) => !/perpetual/i.test(s.name));
    const failing = usable.find((s) => s.state === 'error');
    if (failing) return { state: 'retry', points: [], note: String(failing.note || 'The price source did not answer.'), sources: usable };
    const off = usable.filter((s) => s.state === 'off' && s.name !== 'Price history');
    // The reason that matters is the missing price source, not the missing company list.
    const named = off.filter((s) => !/^SEC/.test(s.name));
    if (off.length) return { state: 'off', points: [], note: (named.length ? named : off).map((s) => s.note).filter(Boolean).join(' ') || 'No price source is connected.', sources: off };
    return { state: 'none', points: [], note: 'The connected price source has no history for this ticker.', sources };
  }));

  // Quarterly capital expenditure and revenue from a company's SEC statements:
  // { state, name, quarters: [{ end, capex, revenue, derived }], note, sources }. Capital
  // expenditure is returned as a positive amount spent.
  const quarterly = (symbol) => (!tradfi?.company ? Promise.resolve({ ...missing, name: null, quarters: [] }) : keepFilings(symbol, async () => {
    let c;
    try {
      c = await tradfi.company(symbol);
    } catch (e) {
      if (e?.status === 400) return { state: 'none', name: null, quarters: [], note: 'No listed company has this ticker in the SEC’s list.', sources: [] };
      return { state: 'retry', name: null, quarters: [], note: words(e), sources: [] };
    }
    const sources = Array.isArray(c?.sources) ? c.sources : [];
    const q = c?.statements?.quarterly;
    if (!q) {
      const off = sources.find((s) => s.state === 'off');
      if (off) return { state: 'off', name: c?.name || null, quarters: [], note: String(off.note || 'SEC filings are not connected.'), sources };
      if (sources.some((s) => s.state === 'error')) return { state: 'retry', name: c?.name || null, quarters: [], note: 'The company’s financial statements could not be loaded just now.', sources };
      return { state: 'none', name: c?.name || null, quarters: [], note: String(c?.statementsNote || 'This filer has no quarterly statements in the SEC’s structured data.'), sources };
    }
    const capex = findRow(q.cashflow, 'capex'), revenue = findRow(q.income, 'revenue');
    const quarters = (q.periodEnds || []).map((end, i) => {
      const paid = num(capex?.values?.[i]), sold = num(revenue?.values?.[i]);
      return {
        end: String(end), label: String(q.periods?.[i] || ''),
        // The statement shows money paid out as a negative number.
        capex: paid !== null && paid <= 0 ? -paid : null, revenue: sold !== null && sold > 0 ? sold : null,
        derived: Boolean(capex?.derived?.[i])
      };
    }).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x.end));
    return { state: 'ok', name: c.name || null, quarters, note: '', sources };
  }));

  return { closes, quarterly };
}

// Daily closes of the named tokens' perpetual contracts on Hyperliquid. A token is used
// only if the venue lists a contract with exactly that name right now.
export function createCryptoInputs({ hl, now = Date.now }) {
  const keep = keeper(now, (v) => (v.state === 'ok' ? 10 * MIN : 20000));
  const NAME = 'Hyperliquid';
  const NOTE = 'Daily closes of perpetual contracts on Hyperliquid (midnight UTC). Contract prices, not spot prices.';
  return (def) => keep(def.id, async () => {
    if (!hl?.markets || !hl?.candles) return { state: 'off', note: 'The crypto market client is not available to the indexes.', listed: [], dropped: [], sources: [] };
    let listedNow;
    try {
      listedNow = new Set((await hl.markets()).map((m) => m.coin));
    } catch {
      return { state: 'retry', note: 'Hyperliquid did not answer.', listed: [], dropped: [], sources: [{ name: NAME, state: 'error', note: 'Did not answer.' }] };
    }
    const wanted = def.candidates.filter((c) => listedNow.has(c.coin));
    const dropped = def.candidates.filter((c) => !listedNow.has(c.coin)).map((c) => c.coin);
    const today = isoDay(now());
    let failed = 0;
    const listed = await Promise.all(wanted.map(async (c) => {
      try {
        const rows = await hl.candles(c.coin, '1d', def.days || 400);
        // The day still trading has no close yet.
        const points = rows.map((r) => ({ t: isoDay(r.time * 1000), v: num(r.close) })).filter((p) => p.v > 0 && p.t < today);
        return { coin: c.coin, points };
      } catch { failed += 1; return { coin: c.coin, points: [], failed: true }; }
    }));
    if (failed) return { state: 'retry', note: `Hyperliquid did not answer for ${failed} of ${wanted.length} tokens.`, listed: [], dropped, sources: [{ name: NAME, state: 'error', note: 'Did not answer for every token.' }] };
    return { state: 'ok', note: '', listed, dropped, sources: [{ name: NAME, state: 'ok', note: NOTE }] };
  });
}

// Electricity and natural gas prices: the EIA when it has a key, FRED when only that has.
export function createEnergyInputs({ env = {}, fetchImpl = fetch, now = Date.now }) {
  const eiaKey = clean(env.EIA_KEY), fredKey = clean(env.FRED_KEY);
  const eia = createSource({
    name: 'US Energy Information Administration', fetchImpl, now, enabled: /^[A-Za-z0-9]{16,64}$/.test(eiaKey), timeoutMs: 12000,
    // The EIA asks for fewer than about 9,000 requests an hour and 5 a second; this uses two every six hours.
    budget: [{ max: 30, perMs: MIN }, { max: 4, perMs: 1000 }],
    note: 'Source: U.S. Energy Information Administration, open data.',
    offNote: eiaKey ? 'EIA_KEY should be the key from eia.gov/opendata (letters and digits).' : 'Set EIA_KEY (free, from eia.gov/opendata) for electricity and natural gas prices.'
  });
  const fred = createSource({
    name: 'FRED (energy prices)', fetchImpl, now, enabled: /^[a-z0-9]{32}$/.test(fredKey), budget: [{ max: 30, perMs: MIN }],
    note: FRED_NOTICE + ' Series used are produced by the Bureau of Labor Statistics and the Energy Information Administration.',
    offNote: fredKey ? 'FRED_KEY should be the 32-character key from fred.stlouisfed.org.' : 'Or set FRED_KEY to use FRED’s copies of these price series.'
  });
  const opts = { ttlMs: 6 * HOUR, staleMs: 3 * DAY, shared: true };

  function eiaUrl(spec, frequency, start) {
    const q = [`api_key=${encodeURIComponent(eiaKey)}`, `frequency=${frequency}`, `data[0]=${encodeURIComponent(spec.data)}`];
    for (const [k, v] of Object.entries(spec.facets || {})) q.push(`facets[${encodeURIComponent(k)}][]=${encodeURIComponent(v)}`);
    q.push(`start=${start}`, 'sort[0][column]=period', 'sort[0][direction]=asc', 'offset=0', 'length=5000');
    return `https://api.eia.gov/v2/${spec.route}/data/?${q.join('&')}`;
  }
  // Rows arrive as { period, <column>: "7.28", ... }: numbers as text, "NA" where there is none.
  const eiaRows = (column, shape) => (d) => (d?.response?.data || []).map((r) => ({ t: String(r?.period || ''), v: num(r?.[column]) })).filter((p) => shape.test(p.t) && p.v > 0);

  async function fromEia(def, start) {
    const led = ledger(now);
    const e = def.eia.electricity, g = def.eia.gas;
    const [power, gasDaily] = await Promise.all([
      led.tryRead(eia, eiaUrl(e, 'monthly', start.slice(0, 7)), { ...opts, key: 'eia:power', transform: eiaRows(e.data, /^\d{4}-\d{2}$/) }),
      led.tryRead(eia, eiaUrl(g, 'daily', start), { ...opts, key: 'eia:gas', transform: eiaRows(g.data, /^\d{4}-\d{2}-\d{2}$/) })
    ]);
    if (!power || !gasDaily) return { state: 'retry', note: 'The Energy Information Administration did not answer.', sources: led.list() };
    return {
      state: 'ok', note: '', variant: 'eia', sources: led.list(),
      electricity: { name: e.name, unit: e.unit, url: e.url, source: 'U.S. Energy Information Administration', points: power.map((p) => ({ t: p.t + '-01', v: p.v })) },
      gas: { name: g.name + ', monthly average of daily prices', unit: g.unit, url: g.url, source: 'U.S. Energy Information Administration', points: monthlyMean(gasDaily), latestDaily: gasDaily[gasDaily.length - 1] || null }
    };
  }

  async function fromFred(def, start) {
    const led = ledger(now);
    const read = (spec) => led.tryRead(fred, `https://api.stlouisfed.org/fred/series/observations?series_id=${encodeURIComponent(spec.series)}&api_key=${encodeURIComponent(fredKey)}&file_type=json&observation_start=${start}&sort_order=asc`, {
      ...opts, key: 'fred:' + spec.series,
      // Missing readings come as "."; they are skipped.
      transform: (d) => (d?.observations || []).map((o) => ({ t: String(o?.date || ''), v: num(o?.value) })).filter((p) => /^\d{4}-\d{2}-\d{2}$/.test(p.t) && p.v > 0)
    });
    const [power, gas] = await Promise.all([read(def.fred.electricity), read(def.fred.gas)]);
    led.off(eia.name, eia.offNote);
    if (!power || !gas) return { state: 'retry', note: 'FRED did not answer.', sources: led.list() };
    const month = (rows) => monthlyMean(rows);
    return {
      state: 'ok', note: '', variant: 'fred', sources: led.list(),
      electricity: { ...def.fred.electricity, source: 'FRED', points: month(power) },
      gas: { ...def.fred.gas, source: 'FRED', points: month(gas) }
    };
  }

  const keep = keeper(now, (v) => (v.state === 'ok' ? 30 * MIN : v.state === 'off' ? MIN : 20000));
  const energy = (def) => keep(def.id, async () => {
    const start = isoDay(Date.UTC(new Date(now()).getUTCFullYear() - (def.years || 5), 0, 1));
    if (eia.enabled) return fromEia(def, start);
    if (fred.enabled) return fromFred(def, start);
    return { state: 'off', note: eia.offNote + ' ' + fred.offNote, sources: [{ name: eia.name, state: 'off', note: eia.offNote }] };
  });
  return { energy, health: () => [eia.health(), fred.health()] };
}

// A dated store of collected prices. The default keeps them in memory, so history starts
// again with the server; an operator who wants it kept passes any object with these two
// methods (a file, a database, Redis) as `store` to createIndexes.
//   put(series, day, value)   one value per series per day; a later one that day replaces it
//   get(series)               [{ t, v }] oldest first (may be a promise)
export function createMemoryStore({ maxDays = 1500 } = {}) {
  const all = new Map();
  return {
    put(series, day, value) {
      const rows = all.get(series) || [];
      if (rows.length && rows[rows.length - 1].t === day) rows[rows.length - 1].v = value;
      else rows.push({ t: day, v: value });
      if (rows.length > maxDays) rows.shift();
      all.set(series, rows);
    },
    get: (series) => (all.get(series) || []).map((p) => ({ ...p }))
  };
}

// The hourly list price of each machine in the basket, from Microsoft's public retail
// price list, kept one a day.
export function createCloudPrices({ env = {}, fetchImpl = fetch, now = Date.now, store = createMemoryStore(), log = console }) {
  const on = clean(env.INDEXES_CLOUD_PRICES).toLowerCase() !== 'off';
  const source = createSource({
    name: 'Azure retail prices', fetchImpl, now, enabled: on, timeoutMs: 12000,
    // Microsoft publishes no limit for this service; a full collection is one call per machine,
    // made one after another.
    budget: [{ max: 30, perMs: MIN }],
    note: 'Pay-as-you-go list prices from Microsoft’s public Azure retail price list.',
    offNote: 'Turned off by INDEXES_CLOUD_PRICES=off.'
  });
  // What happened to each machine at the last collection: id -> { state, note, price }.
  const last = new Map();
  let firstDay = null, lastRun = null, lastOk = null, running = null, timer = null, kick = null;

  // The one price a machine has, or the reason there is not exactly one.
  function pick(items, item, region) {
    const rows = (Array.isArray(items) ? items : []).filter((r) => r && r.armSkuName === item.armSkuName && r.armRegionName === region && r.type === 'Consumption' &&
      r.currencyCode === 'USD' && r.unitOfMeasure === '1 Hour' && !/windows/i.test(String(r.productName)) && !/spot|low priority/i.test(String(r.meterName) + ' ' + String(r.skuName)));
    const prices = [...new Set(rows.map((r) => num(r.retailPrice)).filter((v) => v > 0))];
    if (prices.length === 1) return { state: 'ok', price: prices[0], note: '' };
    return { state: 'missing', price: null, note: prices.length ? `${prices.length} different prices matched this machine, so none was used.` : 'The price list returned no pay-as-you-go Linux price for this machine in this region.' };
  }

  function collect(def) {
    if (!on) return Promise.resolve();
    if (running) return running;
    running = (async () => {
      const region = def.source.region;
      const day = isoDay(now());
      let ok = 0;
      for (const item of def.basket) {
        const filter = `armSkuName eq '${item.armSkuName}' and armRegionName eq '${region}' and priceType eq 'Consumption'`;
        try {
          const r = await source.get(`${def.source.api}?$filter=${encodeURIComponent(filter)}`, { ttlMs: HOUR, shared: true, transform: (d) => pick(d?.Items, item, region) });
          last.set(item.id, r.data);
          if (r.data.state === 'ok') { await store.put(`${def.id}:${item.id}`, day, r.data.price); ok += 1; }
        } catch (e) {
          last.set(item.id, { state: 'error', price: null, note: words(e) });
        }
      }
      lastRun = now();
      if (ok) { lastOk = lastRun; firstDay = firstDay || day; }
    })().catch((e) => log.warn?.('[indexes] price collection failed: ' + (e?.message || e))).finally(() => { running = null; });
    return running;
  }

  // Starts collecting: once shortly after start-up, then every few hours. The timers never
  // keep the process alive.
  function start(def) {
    if (!on || timer) return;
    kick = setTimeout(() => collect(def), 1500);
    timer = setInterval(() => collect(def), Math.max(1, def.source.everyHours || 6) * HOUR);
    kick.unref?.(); timer.unref?.();
  }
  function stop() { clearTimeout(kick); clearInterval(timer); kick = timer = null; }

  async function prices(def) {
    const src = source.health();
    if (!on) return { state: 'off', note: source.offNote, items: [], started: null, sources: [{ name: source.name, state: 'off', note: source.offNote }] };
    const items = await Promise.all(def.basket.map(async (item) => {
      const points = await store.get(`${def.id}:${item.id}`);
      const seen = last.get(item.id);
      return { id: item.id, points, state: points.length ? 'ok' : seen ? seen.state : 'pending', note: seen && seen.state !== 'ok' ? seen.note : '' };
    }));
    const have = items.filter((i) => i.points.length).length;
    const started = items.flatMap((i) => i.points.slice(0, 1).map((p) => p.t)).sort()[0] || firstDay;
    if (!have) {
      // Nothing collected yet (the timer has not fired, or was not started): begin now, and
      // answer without waiting for it.
      if (lastRun === null && !running) collect(def);
      if (lastRun === null) return { state: 'pending', note: 'The first collection of prices has not finished yet.', items, started: null, sources: [{ name: source.name, state: 'ok', note: source.note }] };
      const failed = items.some((i) => i.state === 'error');
      return { state: failed ? 'error' : 'off', note: failed ? 'The Azure retail price list did not answer at the last collection.' : 'The price list answered, but no machine in the basket matched exactly one price. Check the machine names in config/indexes.json.', items, started: null, sources: [{ name: source.name, state: failed ? 'error' : 'ok', note: failed ? (src.lastError || 'Did not answer.') : source.note }] };
    }
    return { state: 'ok', note: '', items, started, lastRun, lastOk, sources: [{ name: source.name, state: src.state === 'error' ? 'error' : 'ok', note: src.state === 'error' ? 'The last collection failed; showing prices collected earlier.' : source.note }] };
  }

  return { prices, collect, start, stop, health: () => [source.health()] };
}
