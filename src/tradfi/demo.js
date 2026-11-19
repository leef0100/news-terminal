// Demo data for the Stocks, Calendar and Private pages (`npm run demo`).
//
// Everything here is invented: the companies, their tickers, the indexes, the prices, the
// accounts, the filings and the fundraisings. Tickers are six letters long on purpose:
// no US-listed share has a ticker that long, so none of these can be mistaken for one.
// The names were checked against a web search on 2026-11-19 and six that turned out to
// belong to real firms (or sat one letter from one) were replaced; see TRADFI-SOURCES.md.
// The numbers are worked out from fixed seeds, so every request and every server agrees,
// and the accounts are simulated quarter by quarter so they add up the way real ones do
// (assets equal liabilities plus equity; four quarters sum to the year).

import { DAY, bad, hash, noise, pick, round, pct, isoDay, isWeekday, weekday, RANGES } from './util.js';
import { reach } from './prices.js';
import { shapeStatement } from './layout.js';

const SECTORS = {
  Technology: { gm: 0.62, rd: 0.16, sga: 0.2, capex: 0.05, inv: 0.05, growth: 0.14 },
  'Health Care': { gm: 0.66, rd: 0.19, sga: 0.26, capex: 0.04, inv: 0.2, growth: 0.09 },
  Financials: { gm: 0.71, rd: 0.01, sga: 0.4, capex: 0.02, inv: 0, growth: 0.06 },
  Consumer: { gm: 0.38, rd: 0.01, sga: 0.25, capex: 0.05, inv: 0.45, growth: 0.07 },
  Industrials: { gm: 0.31, rd: 0.04, sga: 0.14, capex: 0.06, inv: 0.5, growth: 0.05 },
  Energy: { gm: 0.34, rd: 0.005, sga: 0.08, capex: 0.14, inv: 0.2, growth: 0.04 },
  Materials: { gm: 0.28, rd: 0.02, sga: 0.1, capex: 0.09, inv: 0.55, growth: 0.04 },
  Utilities: { gm: 0.4, rd: 0, sga: 0.12, capex: 0.2, inv: 0.1, growth: 0.03 },
  'Real Estate': { gm: 0.64, rd: 0, sga: 0.18, capex: 0.22, inv: 0, growth: 0.05 },
  Communications: { gm: 0.55, rd: 0.07, sga: 0.24, capex: 0.12, inv: 0.04, growth: 0.06 }
};

// symbol, name, sector, industry, month the financial year ends (always the end of a calendar quarter)
const LIST = [
  ['QUILLN', 'Quilvexa Microsystems Inc.', 'Technology', 'Semiconductors', 12],
  ['VELQRX', 'Velquorix Cloudworks Corp.', 'Technology', 'Prepackaged software', 12],
  ['HEXALN', 'Hexaline Devices Inc.', 'Technology', 'Electronic computers', 9],
  ['BRYMOR', 'Brymoor Software Group', 'Technology', 'Prepackaged software', 6],
  ['ZEFRND', 'Zefrindo Networks Inc.', 'Technology', 'Computer communications equipment', 12],
  ['OKTRVN', 'Oktravane Data Systems Corp.', 'Technology', 'Data processing services', 12],
  ['ORLAVN', 'Orlavine Therapeutics Inc.', 'Health Care', 'Pharmaceutical preparations', 12],
  ['CASTBX', 'Castelbrix Biosciences Inc.', 'Health Care', 'Biological products', 12],
  ['MERWDL', 'Merrowdell Health Group', 'Health Care', 'Hospitals and medical services', 12],
  ['TYNDRX', 'Tyndrexa Medical Devices Corp.', 'Health Care', 'Surgical and medical instruments', 9],
  ['NORGAL', 'Norgale Bancorp', 'Financials', 'National commercial banks', 12],
  ['PELLRK', 'Pellam Rooke Financial Corp.', 'Financials', 'Security brokers and dealers', 12],
  ['HALVMH', 'Halvermoor Mutual Holdings', 'Financials', 'Life insurance', 12],
  ['DUNMCG', 'Dunmerrow Capital Group', 'Financials', 'Investment advice', 12],
  ['FENNKO', 'Fennikor Outfitters Inc.', 'Consumer', 'Apparel stores', 3],
  ['MAPLRT', 'Maplerett Foods Co.', 'Consumer', 'Food and kindred products', 12],
  ['SORVEL', 'Sorvella Home Brands', 'Consumer', 'Household furniture', 12],
  ['KESTRO', 'Kestroby Motors Corp.', 'Consumer', 'Motor vehicles', 12],
  ['WOLLMT', 'Wollamot Markets Inc.', 'Consumer', 'Grocery stores', 12],
  ['UMBRIQ', 'Umbriqua Leisure Group', 'Consumer', 'Hotels and motels', 12],
  ['GRIMSH', 'Grimshawe Industrial Corp.', 'Industrials', 'General industrial machinery', 12],
  ['TALVOR', 'Talvory Aerospace Inc.', 'Industrials', 'Aircraft parts', 12],
  ['OSTLER', 'Ostlerand Freight Lines', 'Industrials', 'Trucking', 12],
  ['BEXFRD', 'Bexforde Tooling Co.', 'Industrials', 'Machine tools', 6],
  ['RAVNRG', 'Ravenmoor Energy Corp.', 'Energy', 'Crude petroleum and natural gas', 12],
  ['PETRAX', 'Petraxis Midstream LP', 'Energy', 'Natural gas transmission', 12],
  ['SOLVYN', 'Solvynne Renewables Inc.', 'Energy', 'Electric services', 12],
  ['CALDRX', 'Calderix Oilfield Services', 'Energy', 'Oil and gas field services', 12],
  ['IRNVLE', 'Ironvalle Mining Corp.', 'Materials', 'Metal mining', 12],
  ['CHEMRA', 'Chemoraq Specialty Chemicals', 'Materials', 'Industrial chemicals', 12],
  ['TIMBRO', 'Timbroke Paper & Packaging', 'Materials', 'Paperboard containers', 9],
  ['LUMGRD', 'Lumengard Power Co.', 'Utilities', 'Electric services', 12],
  ['AQUAVR', 'Aquaverro Water Works', 'Utilities', 'Water supply', 12],
  ['NORGAS', 'Norgasse Gas & Light', 'Utilities', 'Natural gas distribution', 12],
  ['HAVNRT', 'Havenrowe Realty Trust', 'Real Estate', 'Real estate investment trusts', 12],
  ['STOWLD', 'Stowelden Logistics Properties', 'Real Estate', 'Real estate investment trusts', 12],
  ['PARKRW', 'Parkrowan Residential Trust', 'Real Estate', 'Real estate investment trusts', 12],
  ['VOXTEL', 'Voxtellan Communications', 'Communications', 'Telephone communications', 12],
  ['STRMIQ', 'Streamiqo Media Inc.', 'Communications', 'Cable and pay television', 12],
  ['PIXLWV', 'Pixelwaive Interactive', 'Communications', 'Services, video games', 3]
];

const INDEXES = [
  ['DEMO500', 'Demo Large Cap 500', 5400, 901],
  ['DEMOTEC', 'Demo Technology 100', 18900, 902],
  ['DEMOSML', 'Demo Small Cap 2000', 2150, 903],
  ['DEMOIND', 'Demo Industrial Average', 39800, 904]
];

const EXCHANGES = ['Demo Main Board', 'Demo Growth Market'];
const HOUR = 3600000;
const OPEN = 14.5 * HOUR;   // sessions run 14:30 to 21:00 UTC on weekdays; the demo has no holidays
const CLOSE = 21 * HOUR;
const YEAR = 365.25 * DAY;
const ANCHOR = Date.UTC(2026, 0, 1);
const FIRST_SESSION = Date.UTC(2015, 0, 5) / DAY;
// Slow to fast: years-long trends down to minute-by-minute movement.
const LAYERS = [[400 * DAY, 0.3], [120 * DAY, 0.16], [30 * DAY, 0.09], [7 * DAY, 0.05], [DAY, 0.024], [6 * HOUR, 0.011], [HOUR, 0.005], [900000, 0.0025], [120000, 0.001]];

// Trading-day counter: weekdays since the Monday before 1 January 1970.
const weekdayCount = (d) => { const weeks = Math.floor((d + 3) / 7); const rest = ((d + 3) % 7 + 7) % 7; return weeks * 5 + Math.min(rest, 4); };
// The price path runs on a clock that only moves while the market is open, so a session
// opens where the last one closed, give or take a small step: without this each day's
// open landed wherever seventeen hours of noise had carried it and a daily chart looked
// like scattered dots. One session is 1.4 days on this clock (five a week make seven days,
// so trends keep their length), of which the last 2% is the overnight step.
const SESSION = 1.4 * DAY, OVERNIGHT = 0.02;
function marketClock(t) {
  const d = sessionDay(t);
  const part = Math.min(1, Math.max(0, (t - (d * DAY + OPEN)) / (CLOSE - OPEN)));
  return (weekdayCount(d) + part * (1 - OVERNIGHT)) * SESSION;
}
function pathAt(seed, tMs, scale = 1) {
  let sum = 0;
  for (let k = 0; k < LAYERS.length; k++) sum += LAYERS[k][1] * scale * noise(tMs / LAYERS[k][0], seed * 100 + k);
  return Math.exp(sum);
}

// The session a moment belongs to: today's if it has opened, otherwise the last one.
function sessionDay(t) {
  let d = Math.floor(t / DAY);
  if (t < d * DAY + OPEN) d -= 1;
  while (!isWeekday(d)) d -= 1;
  return d;
}
const prevSession = (d) => { d -= 1; while (!isWeekday(d)) d -= 1; return d; };

// --- The accounts -----------------------------------------------------------------------
// Each company is simulated a quarter at a time from 2018 in thousands of dollars, in whole
// numbers, so every total is exact. Calendar quarter index: year * 4 + (0..3).
const Q0 = 2018 * 4;
const quarterEnd = (cq) => Date.UTC(Math.floor(cq / 4), (cq % 4) * 3 + 3, 0);

function simulate(c, lastQ) {
  const s = SECTORS[c.sector];
  const seed = c.seed;
  const base = Math.exp(pick(seed, 1, Math.log(90e3), Math.log(8e6))); // revenue per quarter, $ thousands
  const growth = s.growth + pick(seed, 2, -0.03, 0.08);
  const gm0 = s.gm + pick(seed, 3, -0.06, 0.06);
  const rdPct = s.rd * pick(seed, 4, 0.7, 1.3);
  const sgaPct = s.sga * pick(seed, 5, 0.75, 1.15);
  const capexPct = s.capex * pick(seed, 6, 0.7, 1.3);
  const payout = pick(seed, 7, 0.1, 0.7);
  const arK = pick(seed, 8, 0.25, 0.6), invK = s.inv * pick(seed, 9, 0.6, 1.2), apK = pick(seed, 10, 0.25, 0.55);
  const season = [0.96, 1.0, 0.99, 1.05].map((v, i) => v + pick(seed, 20 + i, -0.03, 0.03));

  const rev0 = Math.round(base);
  const cogs0 = Math.round(rev0 * (1 - gm0));
  const st = {
    cash: Math.round(rev0 * pick(seed, 11, 0.4, 1.4)),
    ar: Math.round(rev0 * arK), inv: Math.round(cogs0 * invK), otherCur: Math.round(rev0 * 0.08),
    ppe: Math.round(rev0 * capexPct * pick(seed, 12, 22, 34)), otherNon: Math.round(rev0 * pick(seed, 13, 0.3, 1.6)),
    ap: Math.round(cogs0 * apK), debtCur: Math.round(rev0 * 0.05), otherCurL: Math.round(rev0 * 0.12),
    ltDebt: Math.round(rev0 * pick(seed, 14, 0.2, 2.2)), otherNonL: Math.round(rev0 * 0.15)
  };
  st.equity = st.cash + st.ar + st.inv + st.otherCur + st.ppe + st.otherNon - (st.ap + st.debtCur + st.otherCurL + st.ltDebt + st.otherNonL);
  const shares0 = c.shares;
  const out = new Map();
  for (let cq = Q0; cq <= lastQ; cq++) {
    const n = cq - Q0;
    const rev = Math.round(base * Math.pow(1 + growth, n / 4) * season[cq % 4] * (1 + 0.05 * noise(n / 3, seed * 7 + 1)));
    const gm = gm0 + 0.025 * noise(n / 5, seed * 7 + 2);
    const cogs = Math.round(rev * (1 - gm));
    const rd = Math.round(rev * rdPct * (1 + 0.06 * noise(n / 4, seed * 7 + 3)));
    const sga = Math.round(rev * sgaPct * (1 + 0.05 * noise(n / 4, seed * 7 + 4)));
    const gross = rev - cogs, opex = rd + sga, opInc = gross - opex;
    const other = Math.round(st.cash * 0.03 / 4) - Math.round((st.ltDebt + st.debtCur) * 0.055 / 4);
    const pretax = opInc + other;
    const tax = pretax > 0 ? Math.round(pretax * 0.21) : 0;
    const ni = pretax - tax;
    const da = Math.round(st.ppe * 0.025);
    const capex = Math.round(rev * capexPct);
    const otherInv = Math.round(rev * 0.012);
    const ar = Math.round(rev * arK), inv = Math.round(cogs * invK), ap = Math.round(cogs * apK);
    const cfo = ni + da - (ar - st.ar) - (inv - st.inv) + (ap - st.ap);
    const buyback = ni > 0 ? Math.round(ni * payout) : 0;
    // Borrow when cash would run low; pay debt down when there is plenty.
    let debtChange = 0;
    const cashBefore = st.cash + cfo - capex - otherInv - buyback;
    const floor = Math.round(rev * 0.2), plenty = Math.round(rev * 1.6);
    if (cashBefore < floor) debtChange = floor - cashBefore;
    else if (cashBefore > plenty && st.ltDebt > 0) debtChange = -Math.min(st.ltDebt, Math.round((cashBefore - plenty) / 2));
    const cfi = -capex - otherInv, cff = debtChange - buyback;
    const begin = st.cash;
    st.cash += cfo + cfi + cff;
    st.ar = ar; st.inv = inv; st.ap = ap;
    st.ppe += capex - da; st.otherNon += otherInv; st.ltDebt += debtChange; st.equity += ni - buyback;
    const curA = st.cash + st.ar + st.inv + st.otherCur, curL = st.ap + st.debtCur + st.otherCurL;
    const assets = curA + st.ppe + st.otherNon, liabilities = curL + st.ltDebt + st.otherNonL;
    const shares = Math.round(shares0 * Math.pow(1 - 0.004 * payout, n));
    const sharesDil = Math.round(shares * 1.014);
    const k = 1000;
    out.set(cq, {
      revenue: rev * k, costOfRevenue: cogs * k, grossProfit: gross * k, operatingExpenses: opex * k,
      researchAndDevelopment: rd * k, sellingGeneralAdmin: sga * k, operatingIncome: opInc * k,
      otherIncomeExpense: other * k, pretaxIncome: pretax * k, incomeTax: tax * k, netIncome: ni * k,
      sharesBasic: shares, sharesDiluted: sharesDil,
      cash: st.cash * k, receivables: st.ar * k, inventory: st.inv * k, otherCurrentAssets: st.otherCur * k, totalCurrentAssets: curA * k,
      ppe: st.ppe * k, otherNonCurrentAssets: st.otherNon * k, totalAssets: assets * k,
      payables: st.ap * k, debtCurrent: st.debtCur * k, otherCurrentLiabilities: st.otherCurL * k, totalCurrentLiabilities: curL * k,
      longTermDebt: st.ltDebt * k, otherNonCurrentLiabilities: st.otherNonL * k, totalLiabilities: liabilities * k,
      equity: st.equity * k, liabilitiesAndEquity: (liabilities + st.equity) * k,
      operatingCashFlow: cfo * k, capex: -capex * k, otherInvesting: -otherInv * k, investingCashFlow: cfi * k,
      financingCashFlow: cff * k, netChangeInCash: (st.cash - begin) * k, freeCashFlow: (cfo - capex) * k
    });
  }
  return out;
}

const FLOWS = ['revenue', 'costOfRevenue', 'grossProfit', 'operatingExpenses', 'researchAndDevelopment', 'sellingGeneralAdmin', 'operatingIncome',
  'otherIncomeExpense', 'pretaxIncome', 'incomeTax', 'netIncome', 'operatingCashFlow', 'capex', 'otherInvesting', 'investingCashFlow',
  'financingCashFlow', 'netChangeInCash', 'freeCashFlow'];
const eps = (q) => ({ ...q, epsBasic: round(q.netIncome / q.sharesBasic, 2), epsDiluted: round(q.netIncome / q.sharesDiluted, 2) });
// A year is its four quarters added up; the balance sheet is the one at the year's end.
function yearOf(quarters) {
  const y = { ...quarters[3] };
  for (const key of FLOWS) y[key] = quarters.reduce((a, q) => a + q[key], 0);
  y.sharesBasic = Math.round(quarters.reduce((a, q) => a + q.sharesBasic, 0) / 4);
  y.sharesDiluted = Math.round(quarters.reduce((a, q) => a + q.sharesDiluted, 0) / 4);
  return eps(y);
}
const columns = (rows) => { const v = {}; for (const key of Object.keys(rows[0] || {})) v[key] = rows.map((r) => r[key]); return v; };

// Invented words for private issuers and companies planning to list.
const WORDS = ['Vellorin', 'Tarkwell', 'Osmyra', 'Quenbrix', 'Halcyra', 'Brindlow', 'Yarrowen', 'Zintara', 'Fawkrine', 'Lodestra', 'Mirevale', 'Corvanta',
  'Ebberly', 'Wrenlow', 'Sablemere', 'Thornquay', 'Ulvessa', 'Pendrovel', 'Glimmora', 'Kettlerow', 'Ashcombra', 'Juniprex', 'Rookhurlen', 'Daventrex',
  'Nimbrel', 'Islawood', 'Xanthorel', 'Varnholt', 'Emberlyn', 'Skellan', 'Orrinvale', 'Meadrick'];
const RAISE_KINDS = [['Labs Inc.', 'Other Technology'], ['Bio Inc.', 'Biotechnology'], ['Growth Fund II LP', 'Pooled Investment Fund'], ['Robotics Corp.', 'Other Technology'],
  ['Health Inc.', 'Other Health Care'], ['Property Partners LLC', 'Commercial'], ['Energy Holdings LLC', 'Other Energy'], ['Ventures III LP', 'Pooled Investment Fund'],
  ['Foods Inc.', 'Retailing'], ['Pay Inc.', 'Other Banking and Financial Services'], ['Aero Inc.', 'Manufacturing'], ['Residential REIT LLC', 'REITS and Finance']];
const STATES = ['CA', 'NY', 'TX', 'DE', 'MA', 'WA', 'FL', 'IL', 'CO', 'GA', 'NC', 'UT'];
const IPO_FORMS = [['S-1', 'filed'], ['S-1/A', 'expected'], ['F-1', 'filed'], ['424B4', 'priced'], ['S-1/A', 'expected'], ['RW', 'withdrawn'], ['S-1', 'filed'], ['F-1/A', 'expected'],
  ['424B4', 'priced'], ['S-1/A', 'expected'], ['S-1', 'filed'], ['S-1/A', 'expected'], ['RW', 'withdrawn'], ['S-1', 'filed']];
const IPO_KINDS = ['Technologies Inc.', 'Therapeutics Inc.', 'Holdings Ltd.', 'Financial Corp.', 'Brands Inc.', 'Energy Corp.', 'Software Inc.'];

const ECONOMIC = [
  // title, detail, importance, time (US Eastern), rule(dayIndex, date) -> true on the days it is released
  ['Jobs report (demo)', 'Payrolls and the unemployment rate for the previous month', 3, '08:30', (d, dt) => weekday(d) === 5 && dt.getUTCDate() <= 7],
  ['Consumer prices (demo)', 'Consumer price index for the previous month', 3, '08:30', (d, dt) => weekday(d) === 3 && dt.getUTCDate() >= 8 && dt.getUTCDate() <= 14],
  ['Producer prices (demo)', 'Producer price index for the previous month', 2, '08:30', (d, dt) => weekday(d) === 4 && dt.getUTCDate() >= 8 && dt.getUTCDate() <= 14],
  ['Retail sales (demo)', 'Retail and food services sales for the previous month', 2, '08:30', (d, dt) => weekday(d) === 2 && dt.getUTCDate() >= 15 && dt.getUTCDate() <= 21],
  ['Economic output (demo)', 'Gross domestic product, latest estimate', 3, '08:30', (d, dt) => weekday(d) === 4 && dt.getUTCDate() >= 22 && dt.getUTCDate() <= 28],
  ['Jobless claims (demo)', 'New claims for unemployment insurance, weekly', 1, '08:30', (d) => weekday(d) === 4],
  ['Consumer confidence (demo)', 'Monthly survey of households', 1, '10:00', (d, dt) => weekday(d) === 2 && dt.getUTCDate() >= 22 && dt.getUTCDate() <= 28]
];

export function createDemoBackend({ now = Date.now } = {}) {
  const companies = LIST.map(([symbol, name, sector, industry, fyMonth], i) => {
    const seed = 1000 + i * 17;
    const c = { symbol, name, sector, industry, fyMonth, seed, cik: String(9900001 + i).padStart(10, '0'), exchange: EXCHANGES[i % 5 === 4 ? 1 : 0] };
    c.basePrice = Math.exp(pick(seed, 30, Math.log(9), Math.log(520)));
    c.drift = pick(seed, 31, -0.04, 0.16);
    c.shares = 1; // placeholder so the first run can size the company
    return c;
  });
  // Share counts are chosen so that market value is a sensible multiple of what the company
  // earns (or of its sales, when it earns nothing).
  for (const c of companies) {
    const probe = simulate({ ...c, shares: 1e6 }, 2025 * 4 + 3);
    const year = [0, 1, 2, 3].map((k) => probe.get(2025 * 4 + k));
    const ni = year.reduce((a, q) => a + q.netIncome, 0), rev = year.reduce((a, q) => a + q.revenue, 0);
    const value = ni > rev * 0.02 ? ni * pick(c.seed, 32, 13, 34) : rev * pick(c.seed, 33, 1.2, 4);
    c.shares = Math.max(1e6, Math.round(value / c.basePrice / 1000) * 1000);
  }
  const bySymbol = new Map(companies.map((c) => [c.symbol, c]));
  const indexes = INDEXES.map(([symbol, name, basePrice, seed]) => ({ symbol, name, basePrice, seed, drift: 0.07, index: true }));
  const indexBySymbol = new Map(indexes.map((x) => [x.symbol, x]));
  const src = (name, note) => [{ name, state: 'ok', note }];
  const DEMO = 'Demo data';
  const NOTE = 'Invented for the demo. Not real companies, prices or filings.';

  const priceAt = (c, t) => c.basePrice * Math.exp(c.drift * (t - ANCHOR) / YEAR) * pathAt(c.seed, marketClock(t), c.index ? 0.3 : 1);

  // One day's candle. Today's runs only as far as the present moment.
  function dayCandle(c, d, t) {
    const from = d * DAY + OPEN, to = Math.min(d * DAY + CLOSE, Math.max(t, from));
    const open = priceAt(c, from), close = priceAt(c, to);
    let high = Math.max(open, close), low = Math.min(open, close);
    for (let k = 1; k < 13; k++) { const p = priceAt(c, from + (to - from) * k / 13); if (p > high) high = p; if (p < low) low = p; }
    const part = (to - from) / (CLOSE - OPEN);
    const volume = c.index ? 0 : Math.round(c.shares * 0.004 * part * (0.6 + ((high - low) / open) * 30 + Math.abs(hash(d, c.seed + 5)) * 0.7));
    return { time: d * 86400, open: round(open), high: round(high), low: round(low), close: round(close), volume };
  }

  function quoteOf(c, t) {
    const d = sessionDay(t);
    const today = dayCandle(c, d, t);
    const previousClose = round(priceAt(c, prevSession(d) * DAY + CLOSE));
    return {
      symbol: c.symbol, name: c.name, price: today.close, changePct: pct(today.close, previousClose), previousClose,
      open: today.open, high: today.high, low: today.low, volume: c.index ? null : today.volume,
      marketCap: c.index ? null : Math.round(today.close * c.shares), asOf: Math.min(t, d * DAY + CLOSE), delayed: false
    };
  }

  // Calendar quarter -> the company's own financial year and quarter.
  function fiscal(c, cq) {
    const endQ = Math.ceil(c.fyMonth / 3) - 1;            // calendar quarter (0..3) in which the year ends
    const year = Math.floor(cq / 4), q = cq % 4;
    const fq = ((q - endQ - 1 + 8) % 4) + 1;
    const fy = q > endQ ? year + 1 : year;
    return { fy, fq };
  }
  // The latest quarter a company would have reported by now (results come out some weeks after it ends).
  const lastReported = (t) => { const d = new Date(t - 40 * DAY); return d.getUTCFullYear() * 4 + Math.floor(d.getUTCMonth() / 3) - 1; };

  const accounts = new Map();
  function accountsOf(c, t) {
    const lastQ = lastReported(t);
    const hit = accounts.get(c.symbol);
    if (hit && hit.lastQ === lastQ) return hit;
    const sim = simulate(c, lastQ);
    const quarters = [];
    for (let cq = lastQ; cq > lastQ - 8; cq--) quarters.push({ cq, ...fiscal(c, cq), data: eps(sim.get(cq)) });
    // The latest complete financial year is the latest quarter that is a fourth quarter.
    let endCq = lastQ;
    while (fiscal(c, endCq).fq !== 4) endCq -= 1;
    const years = [];
    for (let k = 0; k < 5; k++) {
      const e = endCq - k * 4;
      years.push({ cq: e, fy: fiscal(c, e).fy, data: yearOf([3, 2, 1, 0].map((b) => sim.get(e - b))) });
    }
    const ttm = yearOf([3, 2, 1, 0].map((b) => sim.get(lastQ - b)));
    const out = { lastQ, quarters, years, ttm, latest: sim.get(lastQ) };
    accounts.set(c.symbol, out);
    return out;
  }

  function statements(c, t) {
    const a = accountsOf(c, t);
    return {
      annual: shapeStatement(a.years.map((y) => 'FY' + y.fy), columns(a.years.map((y) => y.data)), { periodEnds: a.years.map((y) => isoDay(quarterEnd(y.cq))) }),
      quarterly: shapeStatement(a.quarters.map((q) => `Q${q.fq} FY${q.fy}`), columns(a.quarters.map((q) => q.data)), { periodEnds: a.quarters.map((q) => isoDay(quarterEnd(q.cq))) })
    };
  }

  function filingsOf(c, t) {
    const a = accountsOf(c, t);
    const out = [];
    for (let cq = a.lastQ; cq > a.lastQ - 10; cq--) {
      const { fy, fq } = fiscal(c, cq);
      const end = quarterEnd(cq);
      const lag = 24 + Math.round(pick(c.seed, 40 + (cq % 4), 0, 12));
      out.push({ form: '8-K', filedAt: isoDay(end + lag * DAY), title: `Results for the ${fq === 4 ? 'fourth quarter and full year' : 'quarter ' + fq + ' of'} ${fq === 4 ? fy : 'financial year ' + fy} (demo)`, url: null });
      out.push(fq === 4
        ? { form: '10-K', filedAt: isoDay(end + (lag + 21) * DAY), title: `Annual report for financial year ${fy} (demo)`, url: null }
        : { form: '10-Q', filedAt: isoDay(end + (lag + 6) * DAY), title: `Quarterly report for quarter ${fq} of financial year ${fy} (demo)`, url: null });
    }
    return out.filter((f) => Date.parse(f.filedAt) <= t).sort((x, y) => (x.filedAt < y.filedAt ? 1 : -1)).slice(0, 16);
  }

  function find(symbol) {
    const c = bySymbol.get(symbol) || indexBySymbol.get(symbol);
    if (!c) throw bad('Unknown symbol');
    return c;
  }


  function pipeline(t) {
    const today = Math.floor(t / DAY);
    return IPO_FORMS.map(([form, status], i) => {
      const filed = today - 1 - Math.round(pick(700 + i, 1, 0, 34));
      let expected = null;
      if (status === 'expected') { expected = today + 2 + Math.round(pick(700 + i, 2, 0, 30)); while (!isWeekday(expected)) expected += 1; }
      if (status === 'priced') expected = filed;
      const low = Math.round(pick(700 + i, 3, 9, 38));
      const word = WORDS[(i * 5 + 3) % WORDS.length];
      return {
        company: `${word} ${IPO_KINDS[i % IPO_KINDS.length]}`, symbol: status === 'withdrawn' ? null : (word.slice(0, 5) + 'X').toUpperCase(),
        exchange: status === 'withdrawn' ? null : EXCHANGES[i % 2], form, filedAt: isoDay(filed * DAY),
        expectedDate: expected === null ? null : isoDay(expected * DAY),
        priceRange: status === 'expected' ? `$${low}.00 - $${low + 2}.00` : status === 'priced' ? `$${low + 1}.00` : null,
        status, url: null
      };
    }).sort((x, y) => (x.filedAt < y.filedAt ? 1 : -1));
  }

  return {
    async overview() {
      const t = now();
      const d = sessionDay(t);
      const quotes = companies.map((c) => ({ ...quoteOf(c, t), sector: c.sector }));
      const slim = (q) => ({ symbol: q.symbol, name: q.name, price: q.price, changePct: q.changePct, volume: q.volume });
      const byChange = quotes.slice().sort((a, b) => b.changePct - a.changePct);
      const sectors = Object.keys(SECTORS).map((name) => {
        const rows = quotes.filter((q) => q.sector === name);
        return { name, changePct: round(rows.reduce((a, q) => a + q.changePct, 0) / rows.length) };
      }).sort((a, b) => b.changePct - a.changePct);
      const curve = [['1M', 4.21], ['2M', 4.19], ['3M', 4.16], ['4M', 4.12], ['6M', 4.05], ['1Y', 3.92], ['2Y', 3.78], ['3Y', 3.76], ['5Y', 3.88], ['7Y', 4.04], ['10Y', 4.22], ['20Y', 4.71], ['30Y', 4.79]];
      const month = (back) => { const m = new Date(t); m.setUTCDate(1); m.setUTCMonth(m.getUTCMonth() - back); return m.toISOString().slice(0, 7); };
      return {
        indexes: indexes.map((x) => {
          const q = quoteOf(x, t);
          const spark = [];
          for (let k = 0, day = d; k < 30; k++, day = prevSession(day)) spark.unshift(dayCandle(x, day, t).close);
          return { symbol: x.symbol, name: x.name, price: q.price, changePct: q.changePct, spark, asOf: q.asOf, delayed: false };
        }),
        sectors,
        movers: {
          gainers: byChange.slice(0, 6).map(slim),
          losers: byChange.slice(-6).reverse().map(slim),
          active: quotes.slice().sort((a, b) => b.volume * b.price - a.volume * a.price).slice(0, 6).map(slim)
        },
        yields: { asOf: isoDay(prevSession(d) * DAY), points: curve.map(([tenor, v], i) => ({ tenor, value: round(v + 0.06 * noise(d / 9, 800 + i)) })) },
        macro: [
          { id: 'DEMO-CPI', name: 'Consumer prices, change over a year', value: 2.8, unit: '%', period: month(1), previous: 2.9 },
          { id: 'DEMO-UNEMP', name: 'Unemployment rate', value: 4.3, unit: '%', period: month(1), previous: 4.2 },
          { id: 'DEMO-RATE', name: 'Central bank policy rate', value: 4.0, unit: '%', period: month(0), previous: 4.25 },
          { id: 'DEMO-GDP', name: 'Economic output, annualised quarterly growth', value: 2.1, unit: '%', period: `${new Date(t - 100 * DAY).getUTCFullYear()} Q${Math.floor(new Date(t - 100 * DAY).getUTCMonth() / 3) + 1}`, previous: 1.7 },
          { id: 'DEMO-10Y', name: '10-year government bond yield', value: round(4.22 + 0.06 * noise(d / 9, 810)), unit: '%', period: isoDay(prevSession(d) * DAY), previous: round(4.22 + 0.06 * noise(prevSession(d) / 9, 810)) }
        ],
        sources: src(DEMO, NOTE)
      };
    },

    async search(q) {
      const needle = q.toUpperCase();
      const scored = [];
      for (const c of companies) {
        const name = c.name.toUpperCase();
        const score = c.symbol === needle ? 0 : c.symbol.startsWith(needle) ? 1 : name.startsWith(needle) ? 2 : name.includes(needle) || c.symbol.includes(needle) ? 3 : -1;
        if (score >= 0) scored.push([score, c]);
      }
      scored.sort((a, b) => a[0] - b[0] || (a[1].symbol < b[1].symbol ? -1 : 1));
      return { results: scored.slice(0, 12).map(([, c]) => ({ symbol: c.symbol, name: c.name, exchange: c.exchange })), sources: src(DEMO, NOTE) };
    },

    async quote(symbols) {
      const t = now();
      return { quotes: symbols.map((s) => quoteOf(find(s), t)), sources: src(DEMO, NOTE) };
    },

    async candles(symbol, range) {
      const c = find(symbol);
      const t = now();
      const last = sessionDay(t);
      const candles = [];
      // "max" runs from the first session the demo market has: Monday 5 January 2015.
      const first = RANGES[range] ? last - RANGES[range] : FIRST_SESSION;
      for (let d = Math.max(first, FIRST_SESSION); d <= last; d++) if (isWeekday(d)) candles.push(dayCandle(c, d, t));
      return { symbol, interval: '1d', candles, delayed: false, kind: 'stock', source: DEMO, ...reach(candles, range), sources: src(DEMO, NOTE) };
    },

    async company(symbol) {
      const c = bySymbol.get(symbol);
      if (!c) throw bad('Unknown symbol');
      const t = now();
      const a = accountsOf(c, t);
      const q = quoteOf(c, t);
      const ttmLabel = 'Last four quarters';
      const facts = [
        { label: 'Market value', value: q.marketCap, unit: 'USD', period: 'Now' },
        { label: 'Revenue', value: a.ttm.revenue, unit: 'USD', period: ttmLabel },
        { label: 'Net income', value: a.ttm.netIncome, unit: 'USD', period: ttmLabel },
        { label: 'Earnings per share, diluted', value: a.ttm.epsDiluted, unit: 'USD/share', period: ttmLabel },
        { label: 'Price to earnings (computed)', value: a.ttm.epsDiluted > 0 ? round(q.price / a.ttm.epsDiluted, 1) : null, unit: 'ratio', period: ttmLabel },
        { label: 'Gross margin (computed)', value: round(a.ttm.grossProfit / a.ttm.revenue * 100, 1), unit: '%', period: ttmLabel },
        { label: 'Free cash flow (computed)', value: a.ttm.freeCashFlow, unit: 'USD', period: ttmLabel },
        { label: 'Shares outstanding', value: a.latest.sharesBasic, unit: 'shares', period: a.quarters[0] ? `Q${a.quarters[0].fq} FY${a.quarters[0].fy}` : null },
        { label: 'Employees', value: Math.round(a.ttm.revenue / pick(c.seed, 50, 240000, 900000) / 10) * 10, unit: 'people', period: 'FY' + a.years[0].fy }
      ];
      return {
        symbol: c.symbol, name: c.name, cik: c.cik, exchange: c.exchange, industry: c.industry, sector: c.sector,
        fiscalYearEnd: String(c.fyMonth).padStart(2, '0') + '-' + String(new Date(Date.UTC(2025, c.fyMonth, 0)).getUTCDate()).padStart(2, '0'),
        facts, statements: statements(c, t), filings: filingsOf(c, t), sources: src(DEMO, NOTE)
      };
    },

    async calendar(fromMs, toMs) {
      const t = now();
      const events = [];
      const ipos = pipeline(t).filter((p) => p.status === 'expected');
      for (let ms = fromMs; ms <= toMs; ms += DAY) {
        const d = Math.floor(ms / DAY), date = isoDay(ms), dt = new Date(ms);
        if (!isWeekday(d)) continue;
        const wd = weekdayCount(d);
        companies.forEach((c, i) => {
          if ((wd + i * 13) % 65 !== 0) return;
          const early = i % 3 !== 0;
          events.push({ date, time: early ? '07:00' : '16:10', kind: 'earnings', title: `${c.name} reports results`, symbol: c.symbol, detail: early ? 'Before the market opens' : 'After the market closes', importance: c.shares * c.basePrice > 4e10 ? 3 : c.shares * c.basePrice > 5e9 ? 2 : 1, source: DEMO, url: null });
        });
        for (const [title, detail, importance, time, rule] of ECONOMIC) {
          if (rule(d, dt)) events.push({ date, time, kind: 'economic', title, symbol: null, detail, importance, source: DEMO, url: null });
        }
        const week = Math.floor((d + 3) / 7);
        if (weekday(d) === 3 && week % 6 === 0) events.push({ date, time: '14:00', kind: 'central-bank', title: 'Central bank rate decision (demo)', symbol: null, detail: 'Policy statement, followed by a press conference at 14:30', importance: 3, source: DEMO, url: null });
        if (weekday(d) === 3 && week % 6 === 3) events.push({ date, time: '14:00', kind: 'central-bank', title: 'Central bank meeting minutes (demo)', symbol: null, detail: 'Minutes of the previous policy meeting', importance: 2, source: DEMO, url: null });
        if (weekday(d) === 2 && week % 3 === 1) events.push({ date, time: '13:00', kind: 'central-bank', title: 'Central bank governor speaks (demo)', symbol: null, detail: 'Remarks on the economic outlook', importance: 1, source: DEMO, url: null });
        for (const p of ipos) {
          if (p.expectedDate === date) events.push({ date, time: null, kind: 'ipo', title: `${p.company} expected to list`, symbol: p.symbol, detail: `${p.priceRange} on ${p.exchange}`, importance: 2, source: DEMO, url: null });
        }
      }
      events.sort((a, b) => (a.date + (a.time || '99')) < (b.date + (b.time || '99')) ? -1 : 1);
      return { events, timezone: 'America/New_York', sources: src(DEMO, NOTE) };
    },

    async ipos() {
      return { pipeline: pipeline(now()), sources: src(DEMO, NOTE) };
    },

    async private() {
      const t = now();
      const today = Math.floor(t / DAY);
      const raises = WORDS.map((word, i) => {
        const [suffix, industry] = RAISE_KINDS[(i * 7 + 2) % RAISE_KINDS.length];
        const filed = today - Math.floor(i * 0.9) - (i % 3 === 0 ? 0 : 1);
        const fund = industry === 'Pooled Investment Fund';
        const offered = fund && i % 2 === 0 ? null : Math.round(Math.exp(pick(600 + i, 1, Math.log(4e5), Math.log(4e8))) / 1e4) * 1e4;
        const sold = Math.round((offered ?? 6e7) * pick(600 + i, 2, 0.1, 1) / 1e4) * 1e4;
        return {
          issuer: `${word} ${suffix}`, industry, state: STATES[(i * 5 + 1) % STATES.length], filedAt: isoDay(filed * DAY),
          amountOffered: offered, amountSold: i % 9 === 4 ? 0 : sold, firstSale: i % 9 === 4 ? null : isoDay((filed - 3 - Math.round(pick(600 + i, 3, 0, 11))) * DAY),
          form: i % 4 === 3 ? 'D/A' : 'D', url: null
        };
      });
      return { raises, sources: src(DEMO, NOTE) };
    },

    health: () => ({ sources: [{ name: DEMO, state: 'ok', note: NOTE, lastOk: now(), lastError: null }] }),
    stop() {},
    // For tests.
    symbols: () => companies.map((c) => c.symbol)
  };
}
