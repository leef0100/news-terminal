// Live data for `/api/tradfi`: puts the sources together into the answers the pages expect.
//
// Each part of an answer comes from one named source. A part whose source is switched off
// (a missing key or setting) or failing comes back null or empty, with the reason in the
// answer's `sources`, so the page can say "not connected" instead of showing a gap.
// See docs/TRADFI-SOURCES.md for what each source is, its limits and its terms.

import { DAY, bad, isoDay, round } from './util.js';
import { createSource, ledger, visitor } from './source.js';
import { createEdgar } from './edgar.js';
import { findRow } from './xbrl.js';
import { createTreasury } from './treasury.js';
import { createFred, FRED_NOTICE, RELEASES } from './fred.js';
import { createHyperliquidPerps, createFinnhub, createTwelveData } from './prices.js';
import { fomcEvents, fomcCoversUntil, FOMC_NOTE } from './calendar.js';
import { createFunds, createInsiders } from './funds.js';

const MIN = 60000;
const clean = (v) => (typeof v === 'string' ? v.trim() : '');

export function createLiveBackend({ env = {}, fetchImpl = fetch, now = Date.now, log = console, tuning = {} } = {}) {
  const base = { fetchImpl, now };
  // The SEC blocks callers that do not say who they are, so its sources stay off until an
  // operator has supplied a real contact; one is never made up here.
  const agent = clean(env.SEC_USER_AGENT);
  const agentOk = agent.length >= 8 && agent.length <= 200 && /^[\x20-\x7e]+$/.test(agent) && /\S+@\S+\.\S+/.test(agent);
  const sec = createSource({
    ...base, name: 'SEC EDGAR', enabled: agentOk, headers: { 'user-agent': agent, accept: 'application/json, application/atom+xml, text/xml, */*' },
    // The SEC allows ten requests a second; eight are used, and a call waits briefly for room.
    budget: [{ max: tuning.secPerSecond ?? 8, perMs: 1000 }], maxWaitMs: tuning.secWaitMs ?? 3000, maxEntries: 1500, timeoutMs: 10000,
    // One address may cause 60 new SEC lookups a minute (a company page is two); the SEC answers 403 or
    // 429 to a client it has blocked, and is then left alone for a minute.
    perVisitor: { max: tuning.secPerVisitor ?? 60, perMs: MIN }, pauseOn: [403, 429], pauseMs: 60000,
    note: 'Filings and financial data from the US Securities and Exchange Commission (EDGAR).',
    offNote: agent ? 'SEC_USER_AGENT must be a name with a contact email, for example "Example Firm ops@example.com".' : 'Set SEC_USER_AGENT to your firm’s name and a contact email (the SEC requires it) to turn on companies, statements, filings, the IPO pipeline and private fundraising.'
  });
  const treasurySource = createSource({ ...base, name: 'US Treasury', budget: [{ max: 20, perMs: MIN }], note: 'Daily par yield curve, published by the Treasury after each market close.' });
  const hlSource = createSource({
    ...base, name: 'Hyperliquid perpetuals', enabled: clean(env.HL_EQUITY_DEX).toLowerCase() !== 'off', timeoutMs: 6000,
    // This server is one address to Hyperliquid, whose limit is a weight of 1,200 a minute.
    // The crypto pages (src/hyperliquid.js) may spend up to 900 of that, so this stays at 260.
    budget: [{ max: tuning.hlWeightPerMinute ?? 260, perMs: MIN }], perVisitor: { max: tuning.hlPerVisitor ?? 160, perMs: MIN },
    note: 'Perpetual contract prices on Hyperliquid, which trade round the clock. Not the stock exchange’s price; the change shown is over 24 hours.',
    offNote: 'Turned off by HL_EQUITY_DEX=off.'
  });
  const finnhubKey = clean(env.FINNHUB_KEY), twelveKey = clean(env.TWELVEDATA_KEY), fredKey = clean(env.FRED_KEY);
  const finnhubSource = createSource({
    ...base, name: 'Finnhub', enabled: Boolean(finnhubKey), budget: [{ max: tuning.finnhubPerMinute ?? 50, perMs: MIN }, { max: 20, perMs: 1000 }], perVisitor: { max: tuning.finnhubPerVisitor ?? 30, perMs: MIN },
    note: 'Quotes and calendars from Finnhub. Quotes may be delayed.', offNote: 'Set FINNHUB_KEY for share quotes, earnings dates and expected IPO dates.'
  });
  const twelveSource = createSource({
    ...base, name: 'Twelve Data', enabled: Boolean(twelveKey), budget: [{ max: tuning.twelvePerMinute ?? 7, perMs: MIN }, { max: 750, perMs: DAY }], perVisitor: { max: tuning.twelvePerVisitor ?? 4, perMs: MIN },
    note: 'Daily price history and quotes from Twelve Data.', offNote: 'Set TWELVEDATA_KEY for daily price history (showing it to customers needs a Twelve Data business plan).'
  });
  const fredSource = createSource({
    ...base, name: 'FRED', enabled: /^[a-z0-9]{32}$/.test(fredKey), budget: [{ max: 60, perMs: MIN }],
    note: FRED_NOTICE, offNote: fredKey ? 'FRED_KEY should be the 32-character key from fred.stlouisfed.org.' : 'Set FRED_KEY for economic figures and the dates of data releases.'
  });

  const edgar = createEdgar({ source: sec, now, formDDetails: tuning.formDDetails ?? 25, formDWaitMs: tuning.formDWaitMs ?? 1500 });
  const funds = createFunds({ source: sec, edgar, now, log, tuning });
  const insiders = createInsiders({ source: sec, edgar, now, tuning });
  const treasury = createTreasury({ source: treasurySource, now });
  const fred = createFred({ source: fredSource, key: fredKey, now });
  const hl = createHyperliquidPerps({ source: hlSource, env, now });
  const finnhub = createFinnhub({ source: finnhubSource, key: finnhubKey });
  const twelve = createTwelveData({ source: twelveSource, key: twelveKey });
  // Tried in this order; the first to have the symbol answers. A licensed feed would be
  // added at the front.
  const quoteProviders = [finnhub, twelve, hl].filter((p) => p.enabled);
  const candleProviders = [twelve, hl].filter((p) => p.enabled);
  const PRICES_OFF = 'No connected price source covers this. Set FINNHUB_KEY or TWELVEDATA_KEY, or connect a licensed feed.';

  // Whole answers that are the same for everyone are built once and shared for a few seconds.
  // They are built on nobody's account (see `visitor` in source.js) unless `charged` is set:
  // whoever happens to ask first should not pay for an answer everyone gets.
  const memo = new Map();
  function once(key, ttlMs, build, { charged = false, keep = () => true } = {}) {
    const hit = memo.get(key);
    if (hit && (hit.pending || now() - hit.at < ttlMs)) return hit.pending || hit.value;
    const started = charged ? build() : visitor.exit(build);
    const pending = started.then((value) => {
      if (keep(value)) memo.set(key, { at: now(), value: Promise.resolve(value) }); else memo.delete(key);
      return value;
    }, (e) => { memo.delete(key); throw e; });
    memo.delete(key);
    memo.set(key, { pending });
    while (memo.size > 200) memo.delete(memo.keys().next().value);
    return pending;
  }
  const soft = async (led, fn) => { try { return await fn(); } catch (e) { if (e?.status === 400) throw e; log.warn?.('[tradfi] ' + (e?.message || e)); return null; } };

  // The company list, or null when the SEC is off or down (names are then left blank).
  const tickersOrNull = (led) => (sec.enabled ? edgar.tickers(led).catch(() => null) : (led.off(sec.name, sec.offNote), Promise.resolve(null)));

  async function known(symbol, led) {
    if (symbol.startsWith('HL:')) return { symbol, name: null, index: true };
    const t = await tickersOrNull(led);
    if (!t) return { symbol, name: null };
    const c = t.bySymbol.get(symbol);
    if (!c) throw bad('Unknown symbol');
    return c;
  }

  async function quoteOne(symbol, led) {
    const c = await known(symbol, led);
    const blank = { symbol, name: c.name, price: null, changePct: null, previousClose: null, open: null, high: null, low: null, volume: null, marketCap: null, asOf: null, delayed: null, kind: null, source: null };
    if (c.index) {
      const q = hl.enabled ? await soft(led, () => hl.indexQuote(symbol, led)) : null;
      if (!q) { if (!hl.enabled) led.off(hlSource.name, hlSource.offNote); throw bad('Unknown symbol'); }
      return { ...blank, ...q };
    }
    let failed = false;
    for (const p of quoteProviders) {
      const q = await soft(led, () => p.quote(symbol, led).catch((e) => { failed = true; throw e; }));
      if (q) return { ...blank, ...q };
    }
    // "Not connected" is only said when that is the reason; a source that failed says so itself.
    if (!failed) led.off('Share prices', PRICES_OFF);
    return blank;
  }

  return {
    overview: () => once('overview', 10000, async () => {
      const led = ledger(now);
      const [indexes, movers, yields, macro] = await Promise.all([
        hl.enabled ? soft(led, async () => {
          const rows = await hl.indexes(led);
          return Promise.all(rows.map(async (r) => {
            const c = await soft(led, () => hl.candles(r.symbol, '1m', led));
            return { symbol: r.symbol, name: r.name, price: r.price, changePct: r.changePct, spark: (c?.candles || []).map((x) => x.close), asOf: r.asOf, delayed: false, kind: 'perp', changeBasis: '24h', source: r.source };
          }));
        }) : (led.off(hlSource.name, hlSource.offNote), null),
        hl.enabled ? soft(led, async () => {
          const [rows, t] = await Promise.all([hl.listed(led), tickersOrNull(ledger(now))]);
          const slim = (q) => ({ symbol: q.symbol, name: t?.bySymbol.get(q.symbol)?.name || q.symbol, price: q.price, changePct: q.changePct, volume: null, volumeUsd: q.volumeUsd, kind: 'perp' });
          const moved = rows.filter((q) => q.changePct !== null).sort((a, b) => b.changePct - a.changePct);
          return {
            gainers: moved.filter((q) => q.changePct > 0).slice(0, 5).map(slim), losers: moved.filter((q) => q.changePct < 0).slice(-5).reverse().map(slim),
            active: rows.slice().sort((a, b) => (b.volumeUsd || 0) - (a.volumeUsd || 0)).slice(0, 5).map(slim),
            universe: `The ${rows.length} US shares that have a perpetual contract on Hyperliquid, by that contract’s 24-hour change. Not the whole market.`
          };
        }) : null,
        soft(led, () => treasury.latest(led)),
        fredSource.enabled ? soft(led, () => fred.macro(led)) : (led.off(fredSource.name, fredSource.offNote), null)
      ]);
      led.off('Sector performance', 'Not connected: no source with display rights is configured for sector moves.');
      // Without FRED the one economic figure an official keyless source gives is still shown.
      const rows = macro ? macro.slice() : [];
      if (yields && !rows.some((m) => m.id === 'DGS10')) {
        const ten = (pts) => pts?.find((p) => p.tenor === '10Y')?.value ?? null;
        if (ten(yields.points) !== null) rows.push({ id: 'UST10Y', name: '10-year Treasury yield (par curve)', value: ten(yields.points), unit: '%', period: yields.asOf, previous: ten(yields.previous?.points) });
      }
      if (!indexes && !movers && !yields && !rows.length && led.list().some((s) => s.state === 'error')) throw new Error('No overview source answered');
      return {
        indexes: indexes || [], sectors: [], movers: movers || null,
        yields: yields ? { asOf: yields.asOf, points: yields.points } : null, macro: rows, sources: led.list()
      };
    }),

    async search(q) {
      const led = ledger(now);
      if (!sec.enabled) { led.off(sec.name, sec.offNote); return { results: [], sources: led.list() }; }
      return { results: await edgar.search(q, led), sources: led.list() };
    },

    async quote(symbols) {
      const led = ledger(now);
      const quotes = await Promise.all(symbols.map((s) => quoteOne(s, led)));
      for (const p of [finnhubSource, twelveSource]) if (!p.enabled && quotes.some((q) => q.kind !== 'stock')) led.off(p.name, p.offNote);
      return { quotes, sources: led.list() };
    },

    async candles(symbol, range) {
      const led = ledger(now);
      const c = await known(symbol, led);
      for (const p of candleProviders) {
        if (c.index && p !== hl) continue;
        const r = await soft(led, () => p.candles(symbol, range, led));
        if (r && r.candles.length) return { symbol, ...r, sources: led.list() };
      }
      if (c.index) throw bad('Unknown symbol');
      if (!twelveSource.enabled) led.off(twelveSource.name, twelveSource.offNote);
      if (!led.list().some((s) => s.state === 'error')) led.off('Price history', 'No connected source has price history for this symbol.');
      return { symbol, interval: '1d', candles: [], delayed: null, kind: null, source: null, range, historyStart: null, capped: false, sources: led.list() };
    },

    async company(symbol) {
      const led = ledger(now);
      if (!sec.enabled) {
        led.off(sec.name, sec.offNote);
        return { symbol, name: null, cik: null, exchange: null, industry: null, fiscalYearEnd: null, facts: [], statements: null, filings: [], sources: led.list() };
      }
      const c = await edgar.lookup(symbol, led);
      // Two share classes of one company (two tickers, one SEC number) share the work but
      // each answer carries the ticker that was asked for.
      const shared = await once('company:' + c.cik, 60000, async () => {
        // The profile is required; the statements are a part that may be missing.
        const [profile, fin] = await Promise.all([edgar.profile(c.cik, led), soft(led, () => edgar.financials(c.cik, led))]);
        const statements = fin && fin.annual ? { annual: fin.annual, quarterly: fin.quarterly } : null;
        const statementsNote = fin === null ? (led.list().some((s) => s.state === 'error') ? 'Financial statements could not be loaded just now.' : 'This filer has no financial data in the SEC’s structured format (common for funds and some foreign companies).') : fin.reason;
        const facts = [];
        if (statements) {
          const a = statements.annual, fy = a.periods[0];
          const add = (label, key, unit = 'USD') => { const v = findRow(a, key)?.values[0]; if (v !== null && v !== undefined) facts.push({ label, value: v, unit, period: fy }); };
          add('Revenue', 'revenue'); add('Net income', 'netIncome'); add('Earnings per share, diluted', 'epsDiluted', 'USD/share');
          add('Total assets', 'totalAssets'); add('Shareholders’ equity', 'equity'); add('Free cash flow (computed)', 'freeCashFlow');
          const rev = findRow(a, 'revenue')?.values[0], gp = findRow(a, 'grossProfit')?.values[0];
          if (rev > 0 && gp !== null && gp !== undefined) facts.push({ label: 'Gross margin (computed)', value: round(gp / rev * 100, 1), unit: '%', period: fy });
        }
        if (fin?.sharesOutstanding) facts.push({ label: 'Shares outstanding', value: fin.sharesOutstanding.value, unit: 'shares', period: fin.sharesOutstanding.asOf });
        if (fin?.publicFloat) facts.push({ label: 'Public float', value: fin.publicFloat.value, unit: 'USD', period: fin.publicFloat.asOf });
        return {
          name: profile.name || c.name, cik: String(c.cik).padStart(10, '0'), industry: profile.industry, profileExchange: profile.exchange,
          fiscalYearEnd: profile.fiscalYearEnd, facts, statements, statementsNote: statementsNote || null, filings: profile.filings, sources: led.list()
        };
      }, { charged: true });
      const { profileExchange, ...rest } = shared;
      return { symbol: c.symbol, ...rest, exchange: c.exchange || profileExchange };
    },

    calendar: (fromMs, toMs) => once(`calendar:${fromMs}:${toMs}`, 60000, async () => {
      const led = ledger(now);
      const from = isoDay(fromMs), to = isoDay(toMs);
      const events = fomcEvents(fromMs, toMs);
      // Past the end of the published schedule nothing is known, and the answer says so.
      if (to > fomcCoversUntil()) led.error('Federal Reserve calendar', `The published meeting schedule held here ends on ${fomcCoversUntil()}; later dates are not shown.`);
      else led.ok('Federal Reserve calendar', FOMC_NOTE);

      // Finnhub is asked by whole calendar month, whatever days the viewer wants, so the
      // number of different questions it can be sent is small and every viewer shares them.
      const months = [];
      for (let m = new Date(Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), 1)); m.getTime() <= toMs; m = new Date(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 1))) {
        months.push([isoDay(m.getTime()), isoDay(Date.UTC(m.getUTCFullYear(), m.getUTCMonth() + 1, 0))]);
      }
      const byMonth = async (ask) => {
        const parts = await Promise.all(months.map(([a, b]) => soft(led, () => ask(a, b, led))));
        if (parts.every((p) => p === null)) return null;
        // Kept to the days asked for, and to one copy of each event should two months overlap.
        const seen = new Set();
        return parts.filter(Boolean).flat().filter((e) => {
          const id = `${e.date}|${e.symbol}|${e.company || ''}`;
          if (e.date < from || e.date > to || seen.has(id)) return false;
          seen.add(id);
          return true;
        });
      };
      const [releases, earnings, ipos, t] = await Promise.all([
        fredSource.enabled ? soft(led, () => fred.releaseDates(led)) : (led.off(fredSource.name, fredSource.offNote + ' Economic release dates are not connected.'), null),
        finnhubSource.enabled ? byMonth(finnhub.earnings) : null,
        finnhubSource.enabled ? byMonth(finnhub.ipos) : null,
        finnhubSource.enabled ? tickersOrNull(ledger(now)) : null
      ]);
      if (!finnhubSource.enabled) led.off(finnhubSource.name, finnhubSource.offNote + ' Earnings and IPO dates are not connected.');
      for (const r of releases || []) {
        if (r.date < from || r.date > to) continue;
        events.push({ date: r.date, time: null, kind: 'economic', title: r.name, symbol: null, detail: 'Scheduled data release, as listed by FRED. The publishing agency sets the time.', importance: RELEASES[r.id] || 1, source: 'FRED', url: `https://fred.stlouisfed.org/releases/calendar` });
      }
      const HOURS = { bmo: 'Before the market opens', amc: 'After the market closes', dmh: 'During market hours' };
      const reports = [];
      for (const e of earnings || []) {
        // Thousands of companies report in a season. With the SEC's list to hand, the largest
        // 1,500 by its ordering are kept and ranked; without it, everything is kept unranked.
        const c = t ? t.bySymbol.get(e.symbol) : null;
        if (t && (!c || c.rank >= 1500)) continue;
        reports.push({ date: e.date, time: null, kind: 'earnings', title: `${c?.name || e.symbol} reports results`, symbol: e.symbol, detail: [Object.hasOwn(HOURS, e.hour) ? HOURS[e.hour] : null, e.quarter && e.year ? `Quarter ${e.quarter} of ${e.year}` : null].filter(Boolean).join('. ') || null, importance: c ? (c.rank < 100 ? 3 : c.rank < 500 ? 2 : 1) : 1, source: 'Finnhub', url: null, rank: c ? c.rank : 1e9 });
      }
      reports.sort((a, b) => a.rank - b.rank);
      for (const r of reports.slice(0, 600)) { delete r.rank; events.push(r); }
      for (const p of ipos || []) {
        events.push({ date: p.date, time: null, kind: 'ipo', title: `${p.company}: ${p.status === 'priced' ? 'priced' : p.status === 'withdrawn' ? 'listing withdrawn' : 'expected to list'}`, symbol: p.symbol, detail: [p.price ? 'Price ' + p.price : null, p.exchange].filter(Boolean).join(' on ') || null, importance: 2, source: 'Finnhub', url: null });
      }
      events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : b.importance - a.importance));
      return { events, timezone: 'America/New_York', sources: led.list() };
    }),

    ipos: () => once('ipos', 60000, async () => {
      const led = ledger(now);
      const today = Math.floor(now() / DAY) * DAY;
      const [filed, dated] = await Promise.all([
        sec.enabled ? edgar.pipeline(led).catch((e) => { led.error(sec.name, e.publicMessage || 'Did not answer.'); return null; }) : (led.off(sec.name, sec.offNote), null),
        finnhubSource.enabled ? soft(led, () => finnhub.ipos(isoDay(today - 14 * DAY), isoDay(today + 60 * DAY), led)) : (led.off(finnhubSource.name, finnhubSource.offNote + ' Expected dates and price ranges are not connected.'), null)
      ]);
      // With nothing at all to show and something broken, say so plainly.
      if (!filed && !dated && led.list().some((s) => s.state === 'error')) throw new Error('No IPO source answered');
      const pipeline = (filed || []).slice();
      for (const p of dated || []) {
        pipeline.push({ company: p.company, symbol: p.symbol, exchange: p.exchange, form: null, filedAt: null, expectedDate: p.date, priceRange: p.price, status: p.status, url: null, alreadyListed: false, source: 'Finnhub' });
      }
      return { pipeline, sources: led.list() };
    }),

    private: () => once('private', 60000, async () => {
      const led = ledger(now);
      if (!sec.enabled) { led.off(sec.name, sec.offNote); return { raises: [], sources: led.list() }; }
      const r = await edgar.raises(led);
      return { raises: r.raises, detailsPending: r.detailsPending, sources: led.list() };
      // An answer that is still filling in is not kept: the next request gets what has arrived since.
    }, { keep: (v) => !v.detailsPending }),

    // ----- Funds: 13F holdings, insider transactions, stakes above 5% (see funds.js) -----
    async funds() { const led = ledger(now); return { ...(await funds.funds(led)), sources: led.list() }; },
    async fund(id) { const led = ledger(now); return { ...(await funds.fund(id, led)), sources: led.list() }; },
    holders: (symbol) => once('holders:' + symbol, 30000, async () => { const led = ledger(now); return { ...(await funds.holders(symbol, led)), sources: led.list() }; }, { keep: (v) => !v.pending }),
    async insiders(symbol) { const led = ledger(now); return { ...(await insiders.insiders(symbol, led)), sources: led.list() }; },
    insidersLatest: () => once('insiders:latest', 60000, async () => { const led = ledger(now); return { ...(await insiders.latest(led)), sources: led.list() }; }, { keep: (v) => !v.detailsPending }),

    health() {
      const fed = now() > Date.parse(fomcCoversUntil() + 'T00:00:00Z')
        ? { name: 'Federal Reserve calendar', state: 'error', note: 'The meeting schedule held in the code has run out and needs updating from the Fed’s page.', lastOk: null, lastError: 'Schedule out of date' }
        : { name: 'Federal Reserve calendar', state: 'ok', note: FOMC_NOTE, lastOk: null, lastError: null };
      return { sources: [sec, treasurySource, hlSource, finnhubSource, twelveSource, fredSource].map((s) => s.health()).concat(fed) };
    },
    stop() { memo.clear(); funds.stop(); }
  };
}
