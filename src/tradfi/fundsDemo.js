// Demo data for the Funds page and the company page's ownership block (`npm run demo`).
//
// The managers, the people and every filing here are invented. The managers hold the demo
// companies of demo.js; their tables are worked out from fixed seeds quarter by quarter and
// then put through the same arithmetic as real filings (summarise and compare in funds.js),
// so holdings, portfolio shares and quarter-over-quarter changes always agree with each
// other. Manager names were searched for on 2026-11-19 and none was found in use; see
// docs/TRADFI-SOURCES.md. CUSIPs begin with "DEMO", which no real CUSIP does.

import { DAY, bad, hash, noise, pick, round, isoDay, isWeekday } from './util.js';
import { summarise, meaningOf } from './funds.js';

// name, reported size in dollars, how selective (higher holds fewer companies), options, market maker
const MANAGERS = [
  ['Quorrimund Capital Partners', 38e9, -0.25, false, false],
  ['Marrowgate Securities', 96e9, -0.75, true, true],
  ['Tessalvane Asset Management', 21e9, -0.1, false, false],
  ['Brackenwold Quantitative Research', 54e9, -0.6, true, false],
  ['Thrysselby Family Office', 3.2e9, 0.35, false, false],
  ['Ostrevane Global Investors', 12e9, 0.1, false, false],
  ['Pellidrake Advisors', 7.5e9, 0.25, true, false],
  ['Zunderholt Capital', 1.4e9, 0.5, false, false]
];
const SURNAMES = ['Vellorin', 'Tarkwell', 'Osmyra', 'Quenbrix', 'Halcyra', 'Brindlow', 'Yarrowen', 'Zintara', 'Fawkrine', 'Lodestra', 'Mirevale', 'Corvanta'];
const INITIALS = ['A.', 'J.', 'M.', 'R.', 'S.'];
const ROLES = ['Chief Executive Officer', 'Chief Financial Officer', 'Director', 'Director', 'General Counsel'];
const CLOSE = 21 * 3600000;
const quarterEnd = (cq) => Date.UTC(Math.floor(cq / 4), (cq % 4) * 3 + 3, 0);

export function createDemoFunds({ companies, priceAt, now = Date.now, sources }) {
  const managers = MANAGERS.map(([name, size, cut, options, marketMaker], i) => ({ id: String(9800001 + i).padStart(10, '0'), name, size, cut, options, marketMaker, seed: 7000 + i * 31, i }));
  const byId = new Map(managers.map((m) => [m.id, m]));
  const bySymbol = new Map(companies.map((c, j) => [c.symbol, j]));
  const cusip = (j) => 'DEMO' + String(j).padStart(5, '0');
  const symbolOfCusip = new Map(companies.map((c, j) => [cusip(j), c.symbol]));
  // Filed some days inside the 45 allowed, and never on a weekend.
  const filedAt = (m, cq) => { let d = Math.floor(quarterEnd(cq) / DAY) + 45 - (m.i % 5); while (!isWeekday(d)) d -= 1; return d * DAY; };
  // The latest quarter this manager would have filed for by now.
  function lastQuarter(m, t) {
    const d = new Date(t);
    let cq = d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3) - 1;
    while (filedAt(m, cq) > t) cq -= 1;
    return cq;
  }
  const tables = new Map();
  function table(m, cq) {
    const key = m.id + ':' + cq;
    if (tables.has(key)) return tables.get(key);
    const at = quarterEnd(cq) + CLOSE;
    const rows = [];
    companies.forEach((c, j) => {
      const px = priceAt(c, at);
      const row = (putCall, shares) => rows.push({ issuer: c.name, titleOfClass: 'COM', cusip: cusip(j), putCall, unit: 'SH', value: Math.round(shares * px), shares, discretion: 'SOLE', rows: 1 });
      // Whether the share is held drifts slowly; its size moves in steps, so some quarters show no change.
      if (noise(cq / 2.5 + j * 0.61, m.seed + j * 3) > m.cut) {
        const step = Math.round((noise(cq / 1.7 + j * 0.23, m.seed + 500 + j) + 1) * 3) / 3;
        // Never more than a few percent of the company: a manager cannot hold more shares than exist.
        row(null, Math.max(100, Math.round(Math.min(m.size * pick(m.seed, j, 0.004, 0.06) / c.basePrice, c.shares * 0.03) * (0.4 + step) / 100) * 100));
      }
      if (m.options && hash(j, m.seed + 900) > 0.2) {
        const size = (slot) => Math.max(100, Math.round(Math.min(m.size * pick(m.seed + slot, j, 0.002, 0.02) / c.basePrice, c.shares * 0.01) * (1 + 0.5 * Math.round(noise(cq / 1.3 + j, m.seed + slot) * 2)) / 100) * 100);
        if (noise(cq / 2 + j * 0.4, m.seed + 910) > -0.4) row('Call', size(920));
        if (noise(cq / 2 + j * 0.7, m.seed + 930) > -0.2) row('Put', size(940));
      }
    });
    tables.set(key, rows);
    while (tables.size > 64) tables.delete(tables.keys().next().value);
    return rows;
  }
  function built(m, t) {
    const cq = lastQuarter(m, t);
    const latest = table(m, cq), previous = table(m, cq - 1);
    return {
      cq, latest, previous, sum: summarise(latest, previous),
      filing: { period: isoDay(quarterEnd(cq)), form: '13F-HR', filedAt: isoDay(filedAt(m, cq)), accession: null, url: null, amended: false, valueUnit: 'dollars', parts: [], rows: latest.length, skipped: 0, capped: false, stated: null },
      previousFiling: { period: isoDay(quarterEnd(cq - 1)), form: '13F-HR', filedAt: isoDay(filedAt(m, cq - 1)), accession: null, url: null, capped: false }
    };
  }
  const sym = (p) => ({ ...p, symbol: symbolOfCusip.get(p.cusip) || null });

  // ----- insiders: a running record per company, so "shares owned after" always follows on -----
  function insiderRows(c, j, t) {
    const today = Math.floor(t / DAY);
    const owner = (k) => `${INITIALS[k]} ${SURNAMES[(j * 5 + k) % SURNAMES.length]}`;
    const held = INITIALS.map((_, k) => Math.round(pick(4300 + j, k, 20000, 900000) / 100) * 100);
    const rows = [];
    for (let d = today - 150; d <= today; d++) {
      if (!isWeekday(d) || hash(d, 4100 + j * 7) < 0.8) continue;
      const k = Math.floor(pick(4200 + j, d, 0, 4.999)), r = pick(4250 + j, d, 0, 1);
      const px = round(priceAt(c, (d - 1) * DAY + CLOSE));
      const n = Math.round(pick(4270 + j, d, 500, 40000) / 100) * 100;
      const date = isoDay((isWeekday(d - 1) ? d - 1 : d) * DAY);
      const base = { form: '4', filedAt: isoDay(d * DAY), accession: null, url: null, detail: true, issuer: c.name, symbol: c.symbol, owner: owner(k), role: ROLES[k], moreOwners: 0, planned: false, date, direct: true };
      const put = (code, shares, price, acquired, extra = {}) => {
        if (!extra.derivative) held[k] = Math.max(0, held[k] + (acquired ? shares : -shares));
        rows.push({ ...base, code, ...meaningOf(code), acquired, shares, price, value: price ? round(shares * price, 2) : null, sharesAfter: extra.derivative ? Math.round(n * 1.5) : held[k], security: 'Common Stock', derivative: false, ...extra });
      };
      const sell = Math.min(n, Math.floor(held[k] / 2 / 100) * 100);
      if (r < 0.2) put('P', n, px, true);
      else if (r < 0.5) { if (sell > 0) put('S', sell, px, false, { planned: r < 0.35 }); }
      else if (r < 0.65) put('A', n, 0, true);
      else if (r < 0.8) {
        const strike = round(px * 0.55);
        put('M', n, strike, false, { derivative: true, security: 'Stock Option (right to buy)' });
        put('M', n, strike, true);
        put('S', n, px, false);
      } else if (r < 0.92) put('F', Math.min(Math.round(n * 0.4 / 100) * 100, held[k]), px, false);
      else put('G', Math.min(n, held[k]), 0, false);
    }
    return rows.reverse();
  }
  function stakesOf(j, t) {
    const out = [];
    const today = Math.floor(t / DAY);
    const add = (kind, amendment, ago) => out.push({
      form: 'SCHEDULE ' + kind + (amendment ? '/A' : ''), kind, amendment, filedAt: isoDay((today - ago) * DAY), url: null,
      title: (kind === '13D' ? 'Schedule 13D: a stake above 5% (the long form, for holders who may seek influence)' : 'Schedule 13G: a stake above 5% (the short form, for passive holders)') + (amendment ? ' (amendment)' : '')
    });
    if (j % 3 === 0) add('13G', false, 20 + (j % 40));
    if (j % 4 === 1) add('13G', true, 9 + (j % 30));
    if (j % 7 === 3) add('13D', j % 2 === 0, 4 + (j % 50));
    return out.sort((a, b) => b.filedAt.localeCompare(a.filedAt));
  }

  const row = (m, b) => ({
    id: m.id, name: m.name, marketMaker: m.marketMaker, state: 'ready', note: null, period: b.filing.period, filedAt: b.filing.filedAt, form: b.filing.form,
    value: b.sum.totals.value, positions: b.sum.totals.positions, optionPositions: b.sum.totals.optionPositions, url: null
  });

  return {
    async funds() {
      const t = now();
      return { managers: managers.map((m) => row(m, built(m, t))), tracked: managers.length, loaded: managers.length, pending: 0, sources: sources() };
    },
    async fund(id) {
      const m = byId.get(id);
      if (!m) throw bad('Unknown manager. Only the managers listed by /funds are tracked.');
      const b = built(m, now());
      const ch = b.sum.changes;
      const notes = ['Invented for the demo: this manager and its filings do not exist.', 'Changes compare share counts with the previous filing. A share split, a merger or a new CUSIP for the same company shows up as a change though nothing was traded.'];
      if (b.sum.totals.optionPositions) notes.push('Options are listed apart. Their value and share count describe the shares the options are written on, not what the options cost.');
      return {
        id: m.id, name: m.name, marketMaker: m.marketMaker, state: 'ready', filerName: m.name, filing: b.filing, previous: b.previousFiling, totals: b.sum.totals,
        holdings: b.sum.holdings.map(sym), options: b.sum.options.map(sym),
        changes: { basis: ch.basis, counts: ch.counts, new: ch.new.map(sym), exits: ch.exits.map(sym), increases: ch.increases.map(sym), decreases: ch.decreases.map(sym) },
        notes, sources: sources()
      };
    },
    async holders(symbol) {
      const j = bySymbol.get(symbol);
      if (j === undefined) throw bad('Unknown symbol');
      const t = now();
      const holders = [];
      for (const m of managers) {
        const b = built(m, t);
        const p = b.latest.find((x) => x.cusip === cusip(j) && !x.putCall);
        if (!p) continue;
        const was = b.previous.find((x) => x.cusip === cusip(j) && !x.putCall)?.shares ?? 0;
        holders.push({
          id: m.id, name: m.name, marketMaker: m.marketMaker, period: b.filing.period, filedAt: b.filing.filedAt, shares: p.shares, value: p.value,
          pct: round(p.value / b.sum.totals.value * 100, 2), previousShares: was, change: was === 0 ? 'new' : p.shares > was ? 'increase' : p.shares < was ? 'decrease' : 'unchanged'
        });
      }
      holders.sort((a, b) => b.value - a.value);
      return { symbol, name: companies[j].name, matched: true, holders, tracked: managers.length, loaded: managers.length, pending: 0, note: null, sources: sources() };
    },
    async insiders(symbol) {
      const j = bySymbol.get(symbol);
      if (j === undefined) throw bad('Unknown symbol');
      const c = companies[j], t = now();
      return { symbol, name: c.name, cik: c.cik, transactions: insiderRows(c, j, t).slice(0, 80), stakes: stakesOf(j, t), detailsPending: 0, sources: sources() };
    },
    async insidersLatest() {
      const t = now();
      const since = isoDay(t - 6 * DAY);
      const rows = companies.flatMap((c, j) => insiderRows(c, j, t).filter((r) => r.filedAt >= since));
      rows.sort((a, b) => b.filedAt.localeCompare(a.filedAt) || b.date.localeCompare(a.date) || a.issuer.localeCompare(b.issuer));
      return { transactions: rows.slice(0, 60), detailsPending: 0, sources: sources() };
    },
    managerIds: () => managers.map((m) => m.id)
  };
}
