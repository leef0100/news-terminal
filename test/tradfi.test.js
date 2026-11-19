// Stocks, calendar and private markets (`/api/tradfi`): demo data, the statement builder,
// the parsers, and the router end to end against stand-in upstreams. Nothing here touches
// the network: every upstream is a function returning a payload modelled on the documented
// shape of the real one (see docs/TRADFI-SOURCES.md for which shapes were seen live).
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTradfi } from '../src/tradfi/index.js';
import { buildStatements, findRow } from '../src/tradfi/xbrl.js';
import { parseTickers, parseCurrentFeed, parseFormD } from '../src/tradfi/edgar.js';
import { parseYieldFeed } from '../src/tradfi/treasury.js';
import { createSource } from '../src/tradfi/source.js';
import { createDemoBackend } from '../src/tradfi/demo.js';
import { fomcEvents } from '../src/tradfi/calendar.js';

const quiet = { warn() {}, log() {}, error() {} };
const NOW = Date.UTC(2026, 10, 19, 16, 0, 0); // a Thursday, mid-session

// The clock in these tests stands still, so the per-second SEC budget would never refill:
// it is opened wide here and tested on its own with a small one.
async function serve(options) {
  const tradfi = createTradfi({ log: quiet, ...options, tuning: { secPerSecond: 1000, secWaitMs: 0, ...(options.tuning || {}) } });
  const app = express();
  app.use('/api/tradfi', tradfi.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/tradfi${path}`);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { tradfi, get, close: () => new Promise((r) => server.close(r)) };
}

// ---------------------------------------------------------------------------------------
// A hand-built XBRL company-facts file for a company whose year ends on 31 December.
// What it exercises is noted beside each tag.
const fact = (start, end, val, filed, form, fy, fp, accn) => ({ ...(start ? { start } : {}), end, val, accn: accn || `0000000001-${filed.slice(2, 4)}-${filed.slice(5, 7)}${filed.slice(8)}`, fy, fp, form, filed });
const K23 = ['2024-02-15', '10-K', 2023, 'FY'], K24 = ['2025-02-14', '10-K', 2024, 'FY'];
const Q1 = ['2024-05-02', '10-Q', 2024, 'Q1'], Q2 = ['2024-08-01', '10-Q', 2024, 'Q2'], Q3 = ['2024-11-01', '10-Q', 2024, 'Q3'];
const Q1N = ['2025-05-01', '10-Q', 2025, 'Q1'], Q2N = ['2025-07-31', '10-Q', 2025, 'Q2'];
const FACTS = {
  cik: 1, entityName: 'Example Test Co',
  facts: {
    dei: { EntityCommonStockSharesOutstanding: { units: { shares: [fact(null, '2025-01-31', 50000000, ...K24), fact(null, '2025-07-25', 49000000, ...Q2N)] } } },
    'us-gaap': {
      // Older tag, used until 2023. The 2023 figure is restated a year later: 990 must win over 1000.
      Revenues: { units: { USD: [fact('2023-01-01', '2023-12-31', 1000, ...K23), fact('2023-01-01', '2023-12-31', 990, ...K24)] } },
      // Preferred tag from 2024. Q2 is reported both alone and year to date; Q3 only year to date.
      RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
        fact('2024-01-01', '2024-03-31', 250, ...Q1),
        fact('2024-04-01', '2024-06-30', 280, ...Q2), fact('2024-01-01', '2024-06-30', 530, ...Q2),
        fact('2024-01-01', '2024-09-30', 830, ...Q3),
        fact('2024-01-01', '2024-12-31', 1200, ...K24),
        // Next year's reports repeat last year's quarters as comparisons, labelled with the NEW year.
        fact('2024-01-01', '2024-03-31', 250, ...Q1N), fact('2025-01-01', '2025-03-31', 300, ...Q1N),
        fact('2025-04-01', '2025-06-30', 320, ...Q2N), fact('2025-01-01', '2025-06-30', 620, ...Q2N), fact('2024-01-01', '2024-06-30', 530, ...Q2N)
      ] } },
      // Second-choice tag for cost of revenue; there is no GrossProfit tag, so it is computed.
      CostOfGoodsAndServicesSold: { units: { USD: [fact('2024-01-01', '2024-12-31', 700, ...K24), fact('2024-01-01', '2024-03-31', 150, ...Q1)] } },
      // Quarters reported alone, never year to date: Q4 is the year less three quarters.
      OperatingIncomeLoss: { units: { USD: [
        fact('2024-01-01', '2024-03-31', 40, ...Q1), fact('2024-04-01', '2024-06-30', 50, ...Q2), fact('2024-07-01', '2024-09-30', 55, ...Q3), fact('2024-01-01', '2024-12-31', 200, ...K24)
      ] } },
      NetIncomeLoss: { units: { USD: [
        fact('2024-01-01', '2024-03-31', 20, ...Q1), fact('2024-04-01', '2024-06-30', 30, ...Q2), fact('2024-01-01', '2024-06-30', 50, ...Q2),
        fact('2024-07-01', '2024-09-30', 35, ...Q3), fact('2024-01-01', '2024-09-30', 85, ...Q3), fact('2024-01-01', '2024-12-31', 120, ...K24),
        fact('2023-01-01', '2023-12-31', 90, ...K23),
        // A malformed reading with no start date must never be taken for a year's profit.
        fact(null, '2024-12-31', 999, ...K24)
      ] } },
      EarningsPerShareDiluted: { units: { 'USD/shares': [
        fact('2024-01-01', '2024-03-31', 0.4, ...Q1), fact('2024-04-01', '2024-06-30', 0.6, ...Q2), fact('2024-07-01', '2024-09-30', 0.7, ...Q3),
        fact('2024-01-01', '2024-09-30', 1.7, ...Q3), fact('2024-01-01', '2024-12-31', 2.4, ...K24)
      ] } },
      // Cash flows are only ever reported for the year so far.
      NetCashProvidedByUsedInOperatingActivities: { units: { USD: [
        fact('2024-01-01', '2024-03-31', 30, ...Q1), fact('2024-01-01', '2024-06-30', 70, ...Q2), fact('2024-01-01', '2024-09-30', 120, ...Q3), fact('2024-01-01', '2024-12-31', 180, ...K24)
      ] } },
      PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [
        fact('2024-01-01', '2024-03-31', 10, ...Q1), fact('2024-01-01', '2024-06-30', 22, ...Q2), fact('2024-01-01', '2024-09-30', 33, ...Q3), fact('2024-01-01', '2024-12-31', 50, ...K24)
      ] } },
      // Balance sheet: readings on a day. One has a stray start date and must be ignored.
      Assets: { units: { USD: [
        fact(null, '2023-12-31', 4500, ...K23), fact(null, '2024-03-31', 4600, ...Q1), fact(null, '2024-09-30', 4900, ...Q3),
        fact(null, '2024-12-31', 5000, ...K24), fact(null, '2025-03-31', 5100, ...Q1N), fact(null, '2025-06-30', 5200, ...Q2N),
        fact('2024-01-01', '2024-12-31', 1, ...K24)
      ] } },
      LiabilitiesAndStockholdersEquity: { units: { USD: [fact(null, '2024-12-31', 5000, ...K24), fact(null, '2023-12-31', 4500, ...K23)] } },
      StockholdersEquity: { units: { USD: [fact(null, '2024-12-31', 2000, ...K24)] } }
      // No research and development, no inventory, no "Liabilities" tag at all.
    }
  }
};

test('statements from XBRL facts: fallbacks, restatements, derived quarters, missing tags, days versus spans', () => {
  const s = buildStatements(FACTS);
  assert.equal(s.reason, null);
  const A = s.annual, Q = s.quarterly;
  const a = (key) => findRow(A, key)?.values ?? null;
  const q = (key) => findRow(Q, key)?.values ?? null;

  // Years are named by the report that first carried them, newest first.
  assert.deepEqual(A.periods, ['FY2024', 'FY2023']);
  assert.deepEqual(A.periodEnds, ['2024-12-31', '2023-12-31']);
  // Preferred tag for 2024, older tag for 2023, and the restated 990 instead of the original 1000.
  assert.deepEqual(a('revenue'), [1200, 990]);
  assert.deepEqual(a('costOfRevenue'), [700, null]);
  // Computed (revenue less its cost) and marked as such; never invented where the cost is unknown.
  assert.deepEqual(a('grossProfit'), [500, null]);
  assert.deepEqual(findRow(A, 'grossProfit').derived, [true, false]);
  assert.deepEqual(a('operatingIncome'), [200, null]);
  // The reading with no start date (999) is not a year's profit.
  assert.deepEqual(a('netIncome'), [120, 90]);
  assert.deepEqual(a('epsDiluted'), [2.4, null]);
  assert.deepEqual(a('epsBasic'), [null, null]);
  // A tag the company never used leaves no row at all under its parent.
  assert.equal(findRow(A, 'researchAndDevelopment'), null);
  assert.equal(findRow(A, 'inventory'), null);
  // The balance sheet takes readings on the day, ignoring the stray one that covers a span.
  assert.deepEqual(a('totalAssets'), [5000, 4500]);
  assert.deepEqual(a('equity'), [2000, null]);
  // Liabilities are not tagged: worked out from the two totals where both are known.
  assert.deepEqual(a('totalLiabilities'), [3000, null]);
  assert.deepEqual(findRow(A, 'totalLiabilities').derived, [true, false]);
  assert.deepEqual(a('operatingCashFlow'), [180, null]);
  assert.deepEqual(a('capex'), [-50, null]);
  assert.deepEqual(a('freeCashFlow'), [130, null]);
  assert.equal(findRow(A, 'freeCashFlow').computed, true);

  // Quarters, newest first. FY2023 has only its year-end, so only that quarter's day is known.
  assert.deepEqual(Q.periods, ['Q2 FY2025', 'Q1 FY2025', 'Q4 FY2024', 'Q3 FY2024', 'Q2 FY2024', 'Q1 FY2024', 'Q4 FY2023']);
  assert.deepEqual(Q.periodEnds, ['2025-06-30', '2025-03-31', '2024-12-31', '2024-09-30', '2024-06-30', '2024-03-31', '2023-12-31']);
  // Q2 reported alone (280); Q3 from two year-to-date figures (830 - 530); Q4 from the year (1200 - 830).
  assert.deepEqual(q('revenue'), [320, 300, 370, 300, 280, 250, null]);
  assert.deepEqual(findRow(Q, 'revenue').derived, [false, false, true, true, false, false, false]);
  // Q4 as the year less three separately reported quarters: 200 - (40 + 50 + 55).
  assert.deepEqual(q('operatingIncome'), [null, null, 55, 55, 50, 40, null]);
  assert.deepEqual(findRow(Q, 'operatingIncome').derived, [false, false, true, false, false, false, false]);
  assert.deepEqual(q('netIncome'), [null, null, 35, 35, 30, 20, null]);
  // Per-share figures do not subtract, so the fourth quarter stays empty.
  assert.deepEqual(q('epsDiluted'), [null, null, null, 0.7, 0.6, 0.4, null]);
  // Cash flow by quarter, all from year-to-date figures after the first.
  assert.deepEqual(q('operatingCashFlow'), [null, null, 60, 50, 40, 30, null]);
  assert.deepEqual(findRow(Q, 'operatingCashFlow').derived, [false, false, true, true, true, false, false]);
  assert.deepEqual(q('capex'), [null, null, -17, -11, -12, -10, null]);
  assert.deepEqual(q('freeCashFlow'), [null, null, 43, 39, 28, 20, null]);
  // No reading on 30 June 2024, so that cell is empty; it is not borrowed from a neighbour.
  assert.deepEqual(q('totalAssets'), [5200, 5100, 5000, 4900, null, 4600, 4500]);
  assert.deepEqual(q('costOfRevenue'), [null, null, null, null, null, 150, null]);
  assert.deepEqual(q('grossProfit'), [null, null, null, null, null, 100, null]);
});

test('statements: IFRS filers and filers with nothing structured get a reason, not numbers', () => {
  const ifrs = buildStatements({ facts: { 'ifrs-full': { Revenue: { units: { USD: [fact('2024-01-01', '2024-12-31', 5, '2025-03-01', '20-F', 2024, 'FY')] } } } } });
  assert.equal(ifrs.annual, null);
  assert.match(ifrs.reason, /IFRS/);
  assert.equal(buildStatements({ facts: {} }).annual, null);
  // Quarterly reports only, no annual report yet: nothing to anchor a year on.
  const young = buildStatements({ facts: { 'us-gaap': { Revenues: { units: { USD: [fact('2025-01-01', '2025-03-31', 5, '2025-05-01', '10-Q', 2025, 'Q1')] } } } } });
  assert.equal(young.annual, null);
  assert.match(young.reason, /No annual report/);
});

// ---------------------------------------------------------------------------------------
const TICKERS = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [[1045810, 'NVIDIA CORP', 'NVDA', 'Nasdaq'], [1, 'Example Test Co', 'EXT', 'NYSE'], [2, 'Example Bank Holdings', 'EXB', 'NYSE'], [3, 'Northern Example Mining', 'NEM2', null]] };
const SUBMISSIONS = {
  cik: '1', name: 'Example Test Co', sic: '3571', sicDescription: 'Electronic Computers', tickers: ['EXT'], exchanges: ['NYSE'], fiscalYearEnd: '1231', stateOfIncorporation: 'DE',
  filings: { recent: {
    accessionNumber: ['0000000001-25-000031', '0000000001-25-000007'], filingDate: ['2025-07-31', '2025-02-14'], reportDate: ['2025-06-30', '2024-12-31'],
    form: ['10-Q', '10-K'], primaryDocument: ['ext-20250630.htm', 'ext-20241231.htm'], primaryDocDescription: ['10-Q', 'Annual report']
  } }
};
const entry = (form, name, cik, acc, filed) => `<entry><title>${form} - ${name} (${String(cik).padStart(10, '0')}) (Filer)</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${acc}-index.htm"/>
<summary type="html"> &lt;b&gt;Filed:&lt;/b&gt; ${filed} &lt;b&gt;AccNo:&lt;/b&gt; ${acc} &lt;b&gt;Size:&lt;/b&gt; 9 KB</summary>
<updated>${filed}T16:05:11-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="${form}"/>
<id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
const atom = (entries) => `<?xml version="1.0" encoding="ISO-8859-1" ?><feed xmlns="http://www.w3.org/2005/Atom"><title>Latest Filings</title>${entries.join('\n')}</feed>`;
const FEEDS = {
  'S-1': atom([entry('S-1', 'Fresh Example Inc', 900001, '0000900001-26-000001', '2026-11-18'), entry('S-1/A', 'Example Test Co', 1, '0000000001-26-000002', '2026-11-17'), entry('S-11', 'Example Property Trust', 900002, '0000900002-26-000003', '2026-11-17')]),
  'F-1': atom([entry('F-1', 'Overseas Example Ltd', 900003, '0000900003-26-000004', '2026-11-16')]),
  '424B4': atom([entry('424B4', 'Priced Example Corp', 900004, '0000900004-26-000005', '2026-11-18')]),
  RW: atom([entry('RW', 'Withdrawn Example Inc', 900005, '0000900005-26-000006', '2026-11-12')]),
  D: atom([entry('D', 'Example Robotics Fund LP', 900010, '0000900010-26-000010', '2026-11-19'), entry('D/A', 'Example Biotech Inc', 900011, '0000900011-26-000011', '2026-11-18'), entry('D', 'Example Late Stage LLC', 900012, '0000900012-26-000012', '2026-11-18')])
};
const formD = (type, name, state, industry, offered, sold, sale) => `<?xml version="1.0"?><edgarSubmission><schemaVersion>X0708</schemaVersion><submissionType>${type}</submissionType>
<primaryIssuer><cik>0000900010</cik><entityName>${name}</entityName><issuerAddress><street1>1 Example St</street1><city>Anytown</city><stateOrCountry>${state}</stateOrCountry></issuerAddress></primaryIssuer>
<offeringData><industryGroup><industryGroupType>${industry}</industryGroupType></industryGroup>
<typeOfFiling><newOrAmendment><isAmendment>false</isAmendment></newOrAmendment><dateOfFirstSale>${sale}</dateOfFirstSale></typeOfFiling>
<offeringSalesAmounts><totalOfferingAmount>${offered}</totalOfferingAmount><totalAmountSold>${sold}</totalAmountSold><totalRemaining>0</totalRemaining></offeringSalesAmounts></offeringData></edgarSubmission>`;
const FORM_D = {
  '000090001026000010': formD('D', 'Example Robotics Fund LP', 'DE', 'Pooled Investment Fund', 'Indefinite', '12500000', '<value>2026-11-05</value>'),
  '000090001126000011': formD('D/A', 'Example Biotech Inc', 'MA', 'Biotechnology', '30000000', '21000000', '<value>2026-10-01</value>')
  // The third filing's document is missing (404): it is listed without amounts.
};
const yieldEntry = (date, v) => `<entry><id>x</id><content type="application/xml"><m:properties><d:Id m:type="Edm.Int32">1</d:Id><d:NEW_DATE m:type="Edm.DateTime">${date}T00:00:00</d:NEW_DATE>
<d:BC_1MONTH m:type="Edm.Double">${v[0]}</d:BC_1MONTH><d:BC_1_5MONTH m:type="Edm.Double">${v[1]}</d:BC_1_5MONTH><d:BC_3MONTH m:type="Edm.Double">${v[2]}</d:BC_3MONTH>
<d:BC_2YEAR m:type="Edm.Double">${v[3]}</d:BC_2YEAR><d:BC_10YEAR m:type="Edm.Double">${v[4]}</d:BC_10YEAR><d:BC_30YEAR m:type="Edm.Double">${v[5]}</d:BC_30YEAR><d:BC_30YEARDISPLAY m:type="Edm.Double">${v[5]}</d:BC_30YEARDISPLAY></m:properties></content></entry>`;
const YIELDS = `<?xml version="1.0" encoding="utf-8"?><feed xmlns:d="http://schemas.microsoft.com/ado/2007/08/dataservices" xmlns:m="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata" xmlns="http://www.w3.org/2005/Atom">
${yieldEntry('2026-11-17', [4.02, 4.01, 3.98, 3.61, 4.12, 4.71])}${yieldEntry('2026-11-18', [4.03, 4.02, 3.97, 3.6, 4.15, 4.74])}</feed>`;
const HL_META = [
  { universe: [{ name: 'xyz:XYZ100', szDecimals: 4, maxLeverage: 20 }, { name: 'xyz:NVDA', szDecimals: 3, maxLeverage: 10 }, { name: 'xyz:TSLA', szDecimals: 3, maxLeverage: 10 }, { name: 'xyz:GOLD', szDecimals: 3, maxLeverage: 20 }, { name: 'xyz:OLD', isDelisted: true }] },
  [
    { funding: '0.00001', openInterest: '100', prevDayPx: '25000', dayNtlVlm: '90000000', premium: null, oraclePx: '25490', markPx: '25500', midPx: '25500', impactPxs: null, dayBaseVlm: '3500' },
    { funding: '0.00001', openInterest: '100', prevDayPx: '200', dayNtlVlm: '50000000', oraclePx: '189.9', markPx: '190', midPx: '190' },
    { funding: '0.00001', openInterest: '100', prevDayPx: '400', dayNtlVlm: '70000000', oraclePx: '420', markPx: '420', midPx: '420' },
    { funding: '0', openInterest: '1', prevDayPx: '4000', dayNtlVlm: '1', oraclePx: '4100', markPx: '4100' },
    { markPx: '1', prevDayPx: '1' }
  ]
];
const hlCandles = (n) => Array.from({ length: n }, (_, i) => ({ t: NOW - (n - i) * 86400000, T: NOW - (n - i) * 86400000 + 86399999, s: 'xyz:XYZ100', i: '1d', o: String(25000 + i), c: String(25010 + i), h: String(25020 + i), l: String(24990 + i), v: '12.5', n: 40 }));

// A stand-in for `fetch` covering every upstream. `fail` makes matching addresses fail.
function upstream({ fail = null, facts = FACTS } = {}) {
  const calls = [];
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
  const fn = async (url, init = {}) => {
    const u = String(url);
    calls.push(u + (init.body ? ' ' + init.body : ''));
    if (fn.fail && fn.fail.test(u)) return reply(503, {});
    if (u.includes('company_tickers_exchange.json')) return reply(200, TICKERS);
    if (u.includes('/submissions/CIK0000000001.json')) return reply(200, SUBMISSIONS);
    if (u.includes('/submissions/')) return reply(200, { ...SUBMISSIONS, name: 'Example Bank Holdings', filings: { recent: {} } });
    if (u.includes('/companyfacts/CIK0000000001.json')) return reply(200, facts);
    if (u.includes('/companyfacts/')) return reply(404, {});
    if (u.includes('browse-edgar')) return reply(200, FEEDS[decodeURIComponent(/type=([^&]+)/.exec(u)[1])] || atom([]));
    if (u.includes('primary_doc.xml')) { const doc = FORM_D[/\/(\d{18})\/primary_doc/.exec(u)[1]]; return doc ? reply(200, doc) : reply(404, ''); }
    if (u.includes('home.treasury.gov')) return reply(200, YIELDS);
    if (u.includes('api.hyperliquid.xyz')) {
      const body = JSON.parse(init.body);
      if (body.type === 'metaAndAssetCtxs' && body.dex === 'xyz') return reply(200, HL_META);
      if (body.type === 'candleSnapshot') return reply(200, hlCandles(20));
      return reply(422, {});
    }
    if (u.includes('finnhub.io/api/v1/quote')) return reply(200, /symbol=EXT/.test(u) ? { c: 101.5, d: 1.5, dp: 1.5, h: 102, l: 99.5, o: 100, pc: 100, t: Math.floor(NOW / 1000) - 30 } : { c: 0, d: null, dp: null, h: 0, l: 0, o: 0, pc: 0, t: 0 });
    if (u.includes('finnhub.io/api/v1/calendar/earnings')) return reply(200, { earningsCalendar: [{ date: '2026-11-24', epsActual: null, epsEstimate: 1.1, hour: 'amc', quarter: 3, revenueActual: null, revenueEstimate: 1e9, symbol: 'EXT', year: 2026 }, { date: '2026-11-25', hour: 'bmo', quarter: 3, symbol: 'ZZNOTLISTED', year: 2026 }] });
    if (u.includes('finnhub.io/api/v1/calendar/ipo')) return reply(200, { ipoCalendar: [{ date: '2026-11-27', exchange: 'NASDAQ Global', name: 'Fresh Example Inc', numberOfShares: 8000000, price: '14.00-16.00', status: 'expected', symbol: 'FRSH', totalSharesValue: 128000000 }] });
    if (u.includes('api.twelvedata.com/time_series')) return reply(200, { meta: { symbol: 'EXT', interval: '1day' }, values: [{ datetime: '2026-11-18', open: '100', high: '103', low: '99', close: '102', volume: '1200000' }, { datetime: '2026-11-17', open: '98', high: '101', low: '97', close: '100', volume: '900000' }], status: 'ok' });
    if (u.includes('stlouisfed.org/fred/series/observations')) return reply(200, { observations: [{ date: '2026-10-01', value: '.' }, { date: '2026-09-01', value: '3.0123' }, { date: '2026-08-01', value: '2.9' }] });
    if (u.includes('stlouisfed.org/fred/release/dates')) return reply(200, { release_dates: /release_id=10&/.test(u) ? [{ release_id: 10, date: '2026-12-10' }, { release_id: 10, date: '2026-11-13' }] : [] });
    if (u.includes('stlouisfed.org/fred/release?')) return reply(200, { releases: [{ id: Number(/release_id=(\d+)/.exec(u)[1]), name: /release_id=10&/.test(u) ? 'Consumer Price Index' : 'Another Release' }] });
    return reply(404, {});
  };
  fn.calls = calls;
  fn.fail = fail;
  return fn;
}
const UA = 'Example Firm ops@example.com';

test('parsers: SEC ticker files, the latest-filings feed, Form D, the Treasury feed', () => {
  assert.deepEqual(parseTickers(TICKERS)[0], { symbol: 'NVDA', name: 'NVIDIA CORP', cik: 1045810, exchange: 'Nasdaq' });
  // The older file has no exchange and a different layout.
  assert.deepEqual(parseTickers({ 0: { cik_str: 320193, ticker: 'aapl', title: 'Apple Inc.' } }), [{ symbol: 'AAPL', name: 'Apple Inc.', cik: 320193, exchange: null }]);
  assert.throws(() => parseTickers({}));

  const feed = parseCurrentFeed(FEEDS['S-1']);
  assert.equal(feed.length, 3);
  assert.deepEqual(feed[1], { form: 'S-1/A', company: 'Example Test Co', cik: 1, role: 'Filer', accession: '0000000001-26-000002', filedAt: '2026-11-17', updated: '2026-11-17T16:05:11-05:00', url: 'https://www.sec.gov/Archives/edgar/data/1/000000000126000002/0000000001-26-000002-index.htm' });
  assert.deepEqual(parseCurrentFeed('<feed></feed>'), []);
  // An error page or a block notice is a failure, never "no filings today".
  assert.throws(() => parseCurrentFeed('not xml at all'), /Not an SEC filings feed/);
  assert.throws(() => parseCurrentFeed('<!DOCTYPE html><html><body>Your Request Originates from an Undeclared Automated Tool</body></html>'), /Not a plain XML feed/);
  assert.throws(() => parseCurrentFeed('<html><body>Request Rate Threshold Exceeded</body></html>'), /Not an SEC filings feed/);

  assert.deepEqual(parseFormD(FORM_D['000090001026000010']), { form: 'D', issuer: 'Example Robotics Fund LP', state: 'DE', industry: 'Pooled Investment Fund', amountOffered: null, amountSold: 12500000, firstSale: '2026-11-05' });
  assert.equal(parseFormD(formD('D', 'X', 'NY', 'Other Technology', '5000', '0', '<yetToOccur>true</yetToOccur>')).firstSale, null);
  assert.throws(() => parseFormD('<html></html>'));

  const days = parseYieldFeed(YIELDS);
  assert.equal(days.length, 2);
  assert.equal(days[1].date, '2026-11-18');
  assert.deepEqual(days[1].points, [{ tenor: '1M', value: 4.03 }, { tenor: '1.5M', value: 4.02 }, { tenor: '3M', value: 3.97 }, { tenor: '2Y', value: 3.6 }, { tenor: '10Y', value: 4.15 }, { tenor: '30Y', value: 4.74 }]);
});

test('source: cache, coalescing, budget, brief failure cache, stale answers, health', async () => {
  let t = 1e12, n = 0, broken = false;
  const fetchImpl = async () => { n += 1; return broken ? { ok: false, status: 500 } : { ok: true, status: 200, json: async () => ({ n }) }; };
  const s = createSource({ name: 'Test', fetchImpl, now: () => t, budget: [{ max: 3, perMs: 1000 }] });
  // Five askers at once, one upstream call.
  const many = await Promise.all(Array.from({ length: 5 }, () => s.get('u1', { ttlMs: 1000 })));
  assert.equal(n, 1);
  assert.ok(many.every((r) => r.data.n === 1 && !r.stale));
  await s.get('u1', { ttlMs: 1000 });
  assert.equal(n, 1);
  // The budget: three calls in the window, the fourth is refused without reaching upstream.
  await s.get('u2'); await s.get('u3');
  await assert.rejects(s.get('u4'), /request limit/);
  assert.equal(n, 3);
  assert.equal(s.health().refused, 1);
  assert.equal(s.health().state, 'ok');
  // A new window opens; an expired answer is fetched again.
  t += 1500;
  assert.equal((await s.get('u1', { ttlMs: 1000 })).data.n, 4);
  // Upstream breaks: the saved answer stands in, marked stale, while it is young enough...
  broken = true; t += 1500;
  const old = await s.get('u1', { ttlMs: 1000, staleMs: 5000 });
  assert.deepEqual([old.data.n, old.stale], [4, true]);
  assert.equal(s.health().state, 'error');
  // ...and the failure is remembered for two seconds, so upstream is not asked again at once.
  const before = n;
  await s.get('u1', { ttlMs: 1000, staleMs: 5000 });
  assert.equal(n, before);
  // Too old to stand in: an honest error.
  t += 10000;
  await assert.rejects(s.get('u1', { ttlMs: 1000, staleMs: 5000 }), /HTTP 500/);
  broken = false; t += 3000;
  assert.equal((await s.get('u1', { ttlMs: 1000 })).stale, false);
  assert.equal(s.health().state, 'ok');
  // Switched off: says which setting turns it on.
  const off = createSource({ name: 'Off', enabled: false, offNote: 'Set EXAMPLE_KEY.' });
  assert.deepEqual(off.health(), { name: 'Off', state: 'off', note: 'Set EXAMPLE_KEY.', lastOk: null, lastError: null });
  await assert.rejects(off.get('x'), /not connected/);
});

// ---------------------------------------------------------------------------------------
const rowOf = (S, key) => findRow(S, key).values;
const DENY = ['apple', 'microsoft', 'nvidia', 'amazon', 'alphabet', 'google', 'meta platforms', 'tesla', 'berkshire', 'jpmorgan', 'exxon', 'walmart', 'visa', 'netflix', 'oracle', 'intel', 'pfizer', 'boeing', 'disney', 'coca-cola', 'nasdaq', 's&p', 'dow jones', 'russell', 'nyse', 'goldman', 'openai', 'spacex', 'stripe'];

test('demo: all eight endpoints, invented names only, accounts that add up', async () => {
  const svc = await serve({ demo: true, now: () => NOW });
  try {
    const text = [];
    const overview = await svc.get('/overview');
    assert.equal(overview.status, 200);
    assert.equal(overview.headers.get('cache-control'), 'public, max-age=0, s-maxage=15');
    assert.equal(overview.headers.get('cdn-cache-control'), 'public, s-maxage=15, stale-while-revalidate=15');
    const o = overview.body;
    assert.equal(o.demo, true);
    assert.equal(o.at, NOW);
    assert.deepEqual(o.sources.map((s) => s.state), ['ok']);
    assert.equal(o.indexes.length, 4);
    assert.ok(o.indexes.every((x) => /^Demo /.test(x.name) && x.spark.length === 30 && x.price > 0 && x.delayed === false));
    assert.equal(o.sectors.length, 10);
    for (const k of ['gainers', 'losers', 'active']) assert.equal(o.movers[k].length, 6);
    assert.ok(o.movers.gainers[0].changePct >= o.movers.gainers[5].changePct);
    assert.deepEqual(o.yields.points.map((p) => p.tenor), ['1M', '2M', '3M', '4M', '6M', '1Y', '2Y', '3Y', '5Y', '7Y', '10Y', '20Y', '30Y']);
    assert.equal(o.macro.length, 5);
    text.push(JSON.stringify(o));

    const symbols = createDemoBackend({ now: () => NOW }).symbols();
    assert.equal(symbols.length, 40);
    // Six letters: longer than any US-listed share's ticker, so none can be a real one.
    assert.ok(symbols.every((s) => /^[A-Z]{6}$/.test(s)));

    const search = await svc.get('/search?q=qui');
    assert.equal(search.body.results[0].symbol, 'QUILLN');
    assert.ok((await svc.get('/search?q=e')).body.results.length === 12);

    const quote = (await svc.get('/quote?symbols=quilln,DEMO500,QUILLN')).body;
    assert.deepEqual(quote.quotes.map((q) => q.symbol), ['QUILLN', 'DEMO500']);
    const q0 = quote.quotes[0];
    assert.ok(q0.low <= q0.price && q0.price <= q0.high && q0.marketCap > 0 && q0.asOf <= NOW);
    assert.equal(q0.changePct, Number(((q0.price - q0.previousClose) / q0.previousClose * 100).toFixed(2)));

    const candles = (await svc.get('/candles?symbol=QUILLN&range=5y')).body;
    assert.ok(candles.candles.length > 1250 && candles.candles.length < 1320);
    assert.ok(candles.candles.every((c, i, all) => c.low <= Math.min(c.open, c.close) && c.high >= Math.max(c.open, c.close) && (i === 0 || c.time > all[i - 1].time)));
    // The last candle is today's and agrees with the quote.
    assert.equal(candles.candles.at(-1).close, q0.price);
    assert.equal(new Date(candles.candles.at(-1).time * 1000).toISOString().slice(0, 10), '2026-11-19');
    assert.ok((await svc.get('/candles?symbol=QUILLN&range=1m')).body.candles.length <= 24);
    // The same request twice gives the same numbers.
    assert.deepEqual((await svc.get('/candles?symbol=QUILLN&range=5y')).body.candles, candles.candles);

    // Every company's accounts hold together, in every period shown.
    for (const symbol of symbols) {
      const c = (await svc.get('/company?symbol=' + symbol)).body;
      text.push(c.name, c.industry, ...c.filings.map((f) => f.title));
      assert.equal(c.statements.annual.periods.length, 5);
      assert.equal(c.statements.quarterly.periods.length, 8);
      assert.ok(c.filings.length >= 8 && c.filings.every((f) => f.url === null && f.filedAt <= '2026-11-19'));
      for (const S of [c.statements.annual, c.statements.quarterly]) {
        const v = (key) => rowOf(S, key);
        S.periods.forEach((_, i) => {
          assert.equal(v('revenue')[i] - v('costOfRevenue')[i], v('grossProfit')[i], symbol);
          assert.equal(v('researchAndDevelopment')[i] + v('sellingGeneralAdmin')[i], v('operatingExpenses')[i]);
          assert.equal(v('grossProfit')[i] - v('operatingExpenses')[i], v('operatingIncome')[i]);
          assert.equal(v('operatingIncome')[i] + v('otherIncomeExpense')[i], v('pretaxIncome')[i]);
          assert.equal(v('pretaxIncome')[i] - v('incomeTax')[i], v('netIncome')[i]);
          assert.equal(v('cash')[i] + v('receivables')[i] + v('inventory')[i] + v('otherCurrentAssets')[i], v('totalCurrentAssets')[i]);
          assert.equal(v('totalCurrentAssets')[i] + v('ppe')[i] + v('otherNonCurrentAssets')[i], v('totalAssets')[i]);
          assert.equal(v('payables')[i] + v('debtCurrent')[i] + v('otherCurrentLiabilities')[i], v('totalCurrentLiabilities')[i]);
          assert.equal(v('totalCurrentLiabilities')[i] + v('longTermDebt')[i] + v('otherNonCurrentLiabilities')[i], v('totalLiabilities')[i]);
          assert.equal(v('totalLiabilities')[i] + v('equity')[i], v('totalAssets')[i]);
          assert.equal(v('liabilitiesAndEquity')[i], v('totalAssets')[i]);
          assert.equal(v('capex')[i] + v('otherInvesting')[i], v('investingCashFlow')[i]);
          assert.equal(v('operatingCashFlow')[i] + v('investingCashFlow')[i] + v('financingCashFlow')[i], v('netChangeInCash')[i]);
          assert.equal(v('operatingCashFlow')[i] + v('capex')[i], v('freeCashFlow')[i]);
          assert.ok(v('cash')[i] > 0 && v('revenue')[i] > 0);
          assert.equal(v('epsBasic')[i], Number((v('netIncome')[i] / v('sharesBasic')[i]).toFixed(2)));
        });
        // Cash moves from one balance sheet to the next by exactly the period's net change.
        if (S === c.statements.quarterly) for (let i = 0; i < 7; i++) assert.equal(v('cash')[i] - v('cash')[i + 1], v('netChangeInCash')[i]);
        else for (let i = 0; i < 4; i++) assert.equal(v('cash')[i] - v('cash')[i + 1], v('netChangeInCash')[i]);
      }
      // Four quarters sum to the year, wherever all four of a year's quarters are on show.
      const A = c.statements.annual, Q = c.statements.quarterly;
      const fy = A.periods[0].slice(2);
      const idx = Q.periods.map((p, i) => (p.endsWith('FY' + fy) ? i : -1)).filter((i) => i >= 0);
      if (idx.length === 4) for (const key of ['revenue', 'netIncome', 'operatingCashFlow', 'capex', 'incomeTax']) assert.equal(idx.reduce((a, i) => a + rowOf(Q, key)[i], 0), rowOf(A, key)[0], symbol + ' ' + key);
      else assert.ok(idx.length < 4);
    }

    const cal = (await svc.get('/calendar?from=2026-11-19&to=2026-12-31')).body;
    assert.deepEqual([...new Set(cal.events.map((e) => e.kind))].sort(), ['central-bank', 'earnings', 'economic', 'ipo']);
    assert.ok(cal.events.every((e) => e.date >= '2026-11-19' && e.date <= '2026-12-31' && [1, 2, 3].includes(e.importance) && e.source === 'Demo data'));
    assert.ok(cal.events.filter((e) => e.kind === 'earnings').every((e) => symbols.includes(e.symbol)));
    assert.ok(new Set(cal.events.map((e) => e.date)).size >= 20);
    text.push(JSON.stringify(cal));

    const ipos = (await svc.get('/ipos')).body;
    assert.deepEqual([...new Set(ipos.pipeline.map((p) => p.status))].sort(), ['expected', 'filed', 'priced', 'withdrawn']);
    assert.ok(ipos.pipeline.filter((p) => p.status === 'expected').every((p) => p.expectedDate > '2026-11-19' && /^\$\d+\.00 - \$\d+\.00$/.test(p.priceRange)));
    const raises = (await svc.get('/private')).body.raises;
    assert.ok(raises.length >= 25 && raises.every((r) => r.issuer && r.industry && /^[A-Z]{2}$/.test(r.state) && (r.amountOffered === null || r.amountOffered >= r.amountSold)));
    assert.ok(raises.some((r) => r.amountOffered === null) && raises.some((r) => r.firstSale === null));
    text.push(JSON.stringify(ipos), JSON.stringify(raises));

    // Nothing in the demo borrows a real company's or index's name.
    const all = text.join(' ').toLowerCase();
    for (const name of DENY) assert.ok(!all.includes(name), 'demo mentions ' + name);
    assert.equal(svc.tradfi.health().sources[0].state, 'ok');
  } finally { await svc.close(); }
});

test('router: every bad parameter is a 400 that is never cached and costs no upstream call', async () => {
  const fetchImpl = upstream();
  const live = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl, now: () => NOW });
  const demo = await serve({ demo: true, now: () => NOW });
  try {
    const bad = ['/search', '/search?q=', '/search?q=' + 'x'.repeat(41), '/quote', '/quote?symbols=', '/quote?symbols=A B',
      '/quote?symbols=' + Array.from({ length: 21 }, (_, i) => 'S' + i).join(','), '/quote?symbols=TOOLONGSYMBOL1', '/quote?symbols=%3Cscript%3E', '/candles?symbol=EXT&range=2y', '/candles?range=1y',
      '/candles?symbol=EXT&range=1y&range=5y', '/company', '/company?symbol=__proto__', '/company?symbol=a&symbol=b', '/calendar?from=2026-13-01', '/calendar?from=2026-02-30&to=2026-03-05',
      '/calendar?from=2026-11-19&to=2026-11-18', '/calendar?from=2026-11-01&to=2026-12-17', '/calendar?from=nope', '/calendar?from=2020-01-01&to=2020-01-05'];
    for (const svc of [live, demo]) {
      for (const path of bad) {
        const r = await svc.get(path);
        assert.equal(r.status, 400, path);
        assert.equal(r.headers.get('cache-control'), 'no-store', path);
        assert.equal(typeof r.body.error, 'string');
      }
    }
    assert.equal(fetchImpl.calls.length, 0);
    // A well-formed symbol nobody lists is also a 400; finding that out costs one read of the
    // company list, which is then kept for a day.
    assert.equal((await demo.get('/company?symbol=NOSUCH')).status, 400);
    assert.equal((await demo.get('/quote?symbols=QUILLN,NOSUCH')).status, 400);
    assert.equal((await live.get('/company?symbol=NOSUCH')).status, 400);
    assert.equal((await live.get('/candles?symbol=NOSUCH')).status, 400);
    assert.equal((await live.get('/quote?symbols=HL:NOPE')).status, 400);
    assert.equal(fetchImpl.calls.filter((u) => u.includes('sec.gov')).length, 1);
    assert.equal((await live.get('/nothing')).status, 404);
    // 45 days exactly is allowed.
    assert.equal((await demo.get('/calendar?from=2026-11-01&to=2026-12-16')).status, 200);
  } finally { await live.close(); await demo.close(); }
});

test('live without keys: companies, statements, filings, pipeline, raises, yields and labelled perpetual prices', async () => {
  const fetchImpl = upstream();
  const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl, now: () => NOW });
  try {
    // The SEC is told who is asking, as it requires.
    const search = await svc.get('/search?q=example');
    assert.equal(search.headers.get('cache-control'), 'public, max-age=0, s-maxage=300');
    assert.deepEqual(search.body.results, [{ symbol: 'EXT', name: 'Example Test Co', exchange: 'NYSE' }, { symbol: 'EXB', name: 'Example Bank Holdings', exchange: 'NYSE' }, { symbol: 'NEM2', name: 'Northern Example Mining', exchange: null }]);
    assert.equal(search.body.demo, false);
    assert.deepEqual(search.body.sources.map((s) => [s.name, s.state]), [['SEC EDGAR', 'ok']]);
    assert.deepEqual((await svc.get('/search?q=nvda')).body.results.map((r) => r.symbol), ['NVDA']);

    const company = await svc.get('/company?symbol=ext');
    assert.equal(company.status, 200);
    assert.equal(company.headers.get('cdn-cache-control'), 'public, s-maxage=300, stale-while-revalidate=300');
    const c = company.body;
    assert.deepEqual([c.symbol, c.name, c.cik, c.exchange, c.industry, c.fiscalYearEnd], ['EXT', 'Example Test Co', '0000000001', 'NYSE', 'Electronic Computers', '12-31']);
    assert.deepEqual(c.statements.annual.periods, ['FY2024', 'FY2023']);
    assert.deepEqual(rowOf(c.statements.annual, 'revenue'), [1200, 990]);
    assert.deepEqual(rowOf(c.statements.quarterly, 'revenue'), [320, 300, 370, 300, 280, 250, null]);
    assert.deepEqual(c.filings[1], { form: '10-K', filedAt: '2025-02-14', title: 'Annual report', url: 'https://www.sec.gov/Archives/edgar/data/1/000000000125000007/ext-20241231.htm' });
    const facts = Object.fromEntries(c.facts.map((f) => [f.label, f]));
    assert.deepEqual(facts.Revenue, { label: 'Revenue', value: 1200, unit: 'USD', period: 'FY2024' });
    assert.deepEqual(facts['Shares outstanding'], { label: 'Shares outstanding', value: 49000000, unit: 'shares', period: '2025-07-25' });
    assert.equal(facts['Free cash flow (computed)'].value, 130);
    // A filer with no structured data: profile and filings, statements null with the reason.
    const bank = (await svc.get('/company?symbol=EXB')).body;
    assert.equal(bank.statements, null);
    assert.match(bank.statementsNote, /no financial data/);
    assert.equal(bank.name, 'Example Bank Holdings');

    // Prices: the perpetual for a share on the allow-list, clearly marked; nothing for the rest.
    const quotes = (await svc.get('/quote?symbols=NVDA,EXT,HL:XYZ100')).body;
    const [nvda, ext, idx] = quotes.quotes;
    assert.deepEqual([nvda.name, nvda.price, nvda.changePct, nvda.previousClose, nvda.kind, nvda.changeBasis, nvda.delayed, nvda.marketCap], ['NVIDIA CORP', 190, -5, null, 'perp', '24h', false, null]);
    assert.match(nvda.source, /Hyperliquid perpetual \(xyz:NVDA\)/);
    assert.deepEqual([ext.name, ext.price, ext.source, ext.delayed], ['Example Test Co', null, null, null]);
    assert.deepEqual([idx.price, idx.changePct, idx.kind], [25500, 2, 'perp']);
    const qs = Object.fromEntries(quotes.sources.map((s) => [s.name, s]));
    assert.equal(qs['Hyperliquid perpetuals'].state, 'ok');
    assert.match(qs['Hyperliquid perpetuals'].note, /Not the stock exchange/);
    assert.equal(qs['Share prices'].state, 'off');
    assert.match(qs.Finnhub.note, /FINNHUB_KEY/);
    // A contract called GOLD is never offered as the price of a share with that ticker.
    assert.ok(!fetchImpl.calls.some((u) => u.includes('xyz:GOLD')));

    const candles = (await svc.get('/candles?symbol=HL:XYZ100&range=1m')).body;
    assert.equal(candles.candles.length, 20);
    assert.deepEqual([candles.kind, candles.interval, candles.delayed], ['perp', '1d', false]);
    const none = await svc.get('/candles?symbol=EXT&range=1y');
    assert.equal(none.status, 200);
    assert.deepEqual(none.body.candles, []);
    assert.ok(none.body.sources.some((s) => s.name === 'Twelve Data' && s.state === 'off' && /TWELVEDATA_KEY/.test(s.note)));

    const overview = (await svc.get('/overview')).body;
    assert.deepEqual(overview.indexes.map((x) => [x.symbol, x.name, x.price, x.spark.length, x.kind]), [['HL:XYZ100', 'XYZ100 perpetual on Hyperliquid', 25500, 20, 'perp']]);
    assert.deepEqual(overview.sectors, []);
    assert.deepEqual(overview.movers.gainers.map((m) => [m.symbol, m.name, m.changePct]), [['TSLA', 'TSLA', 5]]);
    assert.deepEqual(overview.movers.losers.map((m) => m.symbol), ['NVDA']);
    assert.match(overview.movers.universe, /Not the whole market/);
    assert.equal(overview.yields.asOf, '2026-11-18');
    assert.equal(overview.yields.points.find((p) => p.tenor === '10Y').value, 4.15);
    assert.deepEqual(overview.macro, [{ id: 'UST10Y', name: '10-year Treasury yield (par curve)', value: 4.15, unit: '%', period: '2026-11-18', previous: 4.12 }]);
    const os = Object.fromEntries(overview.sources.map((s) => [s.name, s.state]));
    assert.deepEqual(os, { 'Hyperliquid perpetuals': 'ok', 'US Treasury': 'ok', FRED: 'off', 'Sector performance': 'off' });

    // The pipeline keeps only the forms it names (the S-11 the feed also returned is dropped).
    const ipos = (await svc.get('/ipos')).body;
    assert.deepEqual(ipos.pipeline.map((p) => [p.company, p.form, p.status, p.filedAt, p.alreadyListed, p.symbol]), [
      ['Fresh Example Inc', 'S-1', 'filed', '2026-11-18', false, null], ['Priced Example Corp', '424B4', 'priced', '2026-11-18', false, null],
      ['Example Test Co', 'S-1/A', 'filed', '2026-11-17', true, 'EXT'], ['Overseas Example Ltd', 'F-1', 'filed', '2026-11-16', false, null], ['Withdrawn Example Inc', 'RW', 'withdrawn', '2026-11-12', false, null]
    ]);
    assert.ok(ipos.pipeline.every((p) => p.expectedDate === null && p.priceRange === null && p.url.startsWith('https://www.sec.gov/Archives/edgar/data/')));
    assert.ok(ipos.sources.some((s) => s.name === 'Finnhub' && s.state === 'off'));

    const raises = await svc.get('/private');
    assert.equal(raises.headers.get('cache-control'), 'public, max-age=0, s-maxage=120');
    assert.deepEqual(raises.body.raises.map((r) => [r.issuer, r.form, r.industry, r.state, r.amountOffered, r.amountSold, r.firstSale, r.filedAt]), [
      ['Example Robotics Fund LP', 'D', 'Pooled Investment Fund', 'DE', null, 12500000, '2026-11-05', '2026-11-19'],
      ['Example Biotech Inc', 'D/A', 'Biotechnology', 'MA', 30000000, 21000000, '2026-10-01', '2026-11-18'],
      ['Example Late Stage LLC', 'D', null, null, null, null, null, '2026-11-18']
    ]);
    assert.match(raises.body.sources[0].note, /could not be read for 1/);
    // Asked again: the answer and every filing's detail come from memory.
    const before = fetchImpl.calls.length;
    await svc.get('/private'); await svc.get('/ipos'); await svc.get('/company?symbol=EXT'); await svc.get('/search?q=ex');
    assert.equal(fetchImpl.calls.length, before);

    // The calendar without keys: the Fed's published dates, and plain "not connected" for the rest.
    const cal = (await svc.get('/calendar?from=2026-11-19&to=2026-12-31')).body;
    assert.deepEqual(cal.events.map((e) => [e.date, e.kind, e.title]), [
      ['2026-12-09', 'central-bank', 'Federal Reserve policy decision (FOMC meeting ends)'], ['2026-12-30', 'central-bank', 'Federal Reserve meeting minutes']
    ]);
    assert.match(cal.events[0].detail, /Summary of Economic Projections/);
    assert.match(cal.events[1].detail, /Expected date/);
    assert.deepEqual(Object.fromEntries(cal.sources.map((s) => [s.name, s.state])), { 'Federal Reserve calendar': 'ok', FRED: 'off', Finnhub: 'off' });

    const health = Object.fromEntries(svc.tradfi.health().sources.map((s) => [s.name, s]));
    assert.deepEqual(Object.keys(health), ['SEC EDGAR', 'US Treasury', 'Hyperliquid perpetuals', 'Finnhub', 'Twelve Data', 'FRED', 'Federal Reserve calendar']);
    assert.deepEqual([health['SEC EDGAR'].state, health['SEC EDGAR'].lastOk, health['SEC EDGAR'].lastError], ['ok', NOW, null]);
    for (const [name, variable] of [['Finnhub', 'FINNHUB_KEY'], ['Twelve Data', 'TWELVEDATA_KEY'], ['FRED', 'FRED_KEY']]) {
      assert.equal(health[name].state, 'off');
      assert.ok(health[name].note.includes(variable));
    }
    assert.ok(fetchImpl.calls.every((u) => !u.includes('finnhub') && !u.includes('twelvedata') && !u.includes('stlouisfed')));
  } finally { await svc.close(); }
});

test('live: the SEC is never called without a contact address', async () => {
  for (const env of [{}, { SEC_USER_AGENT: 'curl' }, { SEC_USER_AGENT: 'No Contact Given Here' }]) {
    const fetchImpl = upstream();
    const svc = await serve({ env: { ...env, HL_EQUITY_DEX: 'off' }, fetchImpl, now: () => NOW });
    try {
      const search = await svc.get('/search?q=example');
      assert.equal(search.status, 200);
      assert.deepEqual(search.body.results, []);
      assert.deepEqual(search.body.sources.map((s) => s.state), ['off']);
      assert.match(search.body.sources[0].note, /SEC_USER_AGENT/);
      const company = (await svc.get('/company?symbol=EXT')).body;
      assert.deepEqual([company.statements, company.filings, company.name], [null, [], null]);
      assert.deepEqual((await svc.get('/private')).body.raises, []);
      assert.deepEqual((await svc.get('/ipos')).body.pipeline, []);
      const overview = (await svc.get('/overview')).body;
      assert.deepEqual([overview.indexes, overview.movers], [[], null]);
      assert.ok(overview.sources.some((s) => s.name === 'Hyperliquid perpetuals' && s.state === 'off' && /HL_EQUITY_DEX/.test(s.note)));
      assert.ok(fetchImpl.calls.every((u) => u.includes('home.treasury.gov')));
      assert.equal(svc.tradfi.health().sources[0].state, 'off');
    } finally { await svc.close(); }
  }
});

test('live: the SEC user agent is sent, and identical requests in flight share one upstream call', async () => {
  const seen = [];
  const inner = upstream();
  const fetchImpl = async (url, init) => { seen.push(init?.headers?.['user-agent']); await new Promise((r) => setTimeout(r, 20)); return inner(url, init); };
  const svc = await serve({ env: { SEC_USER_AGENT: UA, HL_EQUITY_DEX: 'off' }, fetchImpl, now: () => NOW });
  try {
    const answers = await Promise.all(Array.from({ length: 8 }, () => svc.get('/company?symbol=EXT')));
    assert.ok(answers.every((a) => a.status === 200 && a.body.name === 'Example Test Co'));
    // One read each of the company list, the profile and the facts, however many asked.
    assert.equal(inner.calls.length, 3);
    assert.ok(seen.every((ua) => ua === UA));
  } finally { await svc.close(); }
});

test('live: the budget holds whatever the traffic, upstream failures are 502, and old answers are labelled', async () => {
  let t = NOW;
  const fetchImpl = upstream();
  const svc = await serve({ env: { SEC_USER_AGENT: UA, HL_EQUITY_DEX: 'off' }, fetchImpl, now: () => t, tuning: { secPerSecond: 3, secWaitMs: 0 } });
  try {
    // Three SEC calls fit in this second: the company list, then one company's profile and facts.
    assert.equal((await svc.get('/company?symbol=EXT')).status, 200);
    assert.equal(fetchImpl.calls.length, 3);
    // A burst for other things in the same second is refused here, not passed on.
    const burst = await Promise.all([svc.get('/company?symbol=EXB'), svc.get('/private'), svc.get('/ipos'), svc.get('/company?symbol=NVDA')]);
    for (const r of burst) {
      assert.equal(r.status, 502);
      assert.equal(r.headers.get('cache-control'), 'public, max-age=0, s-maxage=2');
      assert.equal(typeof r.body.error, 'string');
    }
    assert.equal(fetchImpl.calls.length, 3);
    assert.ok(svc.tradfi.health().sources[0].refused >= 4);
    // What is already held is still served.
    assert.equal((await svc.get('/company?symbol=EXT')).status, 200);

    // Later the SEC goes down. The company page is served from the saved copy and says so.
    t += 20 * 60000;
    fetchImpl.fail = /sec\.gov/;
    const stale = await svc.get('/company?symbol=EXT');
    assert.equal(stale.status, 200);
    assert.deepEqual(rowOf(stale.body.statements.annual, 'revenue'), [1200, 990]);
    assert.match(stale.body.sources[0].note, /saved answer from 20 minutes ago/);
    assert.equal(svc.tradfi.health().sources[0].state, 'error');
    assert.match(svc.tradfi.health().sources[0].lastError, /HTTP 503/);
    // Something never fetched cannot be served: an honest 502, shared for two seconds.
    t += 5000;
    const down = await svc.get('/private');
    assert.equal(down.status, 502);
    assert.equal(down.headers.get('cdn-cache-control'), 'public, s-maxage=2');
    assert.ok(!/sec\.gov|503/.test(down.body.error));
    // Much later the saved copy is too old to show.
    t += 2 * 86400000;
    assert.equal((await svc.get('/company?symbol=EXT')).status, 502);
    // Recovery.
    fetchImpl.fail = null; t += 5000;
    assert.equal((await svc.get('/company?symbol=EXT')).status, 200);
    assert.equal(svc.tradfi.health().sources[0].state, 'ok');
  } finally { await svc.close(); }
});

test('live with keys: Finnhub quotes and calendars, Twelve Data history, FRED figures and release dates', async () => {
  const fetchImpl = upstream();
  const env = { SEC_USER_AGENT: UA, FINNHUB_KEY: 'fh-secret', TWELVEDATA_KEY: 'td-secret', FRED_KEY: 'abcdefghijklmnopqrstuvwxyz012345' };
  const svc = await serve({ env, fetchImpl, now: () => NOW });
  try {
    const quotes = (await svc.get('/quote?symbols=EXT,NVDA')).body;
    const [ext, nvda] = quotes.quotes;
    assert.deepEqual([ext.price, ext.changePct, ext.previousClose, ext.open, ext.high, ext.low, ext.kind, ext.source, ext.delayed, ext.asOf], [101.5, 1.5, 100, 100, 102, 99.5, 'stock', 'Finnhub', true, NOW - 30000]);
    // Finnhub has nothing for this one here, so the next provider answers and is named.
    assert.equal(nvda.kind, 'perp');

    const candles = (await svc.get('/candles?symbol=EXT&range=1y')).body;
    assert.deepEqual(candles.candles, [{ time: Date.UTC(2026, 10, 17) / 1000, open: 98, high: 101, low: 97, close: 100, volume: 900000 }, { time: Date.UTC(2026, 10, 18) / 1000, open: 100, high: 103, low: 99, close: 102, volume: 1200000 }]);
    assert.equal(candles.delayed, true);

    const overview = (await svc.get('/overview')).body;
    assert.equal(overview.macro.length, 5);
    // The "." reading is skipped; the latest real one and the one before it are shown.
    assert.deepEqual(overview.macro[0], { id: 'CPIAUCSL', name: 'Consumer prices, change from a year earlier', value: 3.01, unit: '%', period: '2026-09', previous: 2.9 });
    assert.match(overview.sources.find((s) => s.name === 'FRED').note, /not endorsed or certified by the Federal Reserve Bank of St\. Louis/);

    const cal = (await svc.get('/calendar?from=2026-11-19&to=2026-12-31')).body;
    const by = (kind) => cal.events.filter((e) => e.kind === kind);
    assert.deepEqual(by('economic').map((e) => [e.date, e.title, e.importance, e.source]), [['2026-12-10', 'Consumer Price Index', 3, 'FRED']]);
    // Only companies on the SEC's list are kept; the name comes from that list.
    assert.deepEqual(by('earnings').map((e) => [e.date, e.symbol, e.title, e.detail]), [['2026-11-24', 'EXT', 'Example Test Co reports results', 'After the market closes. Quarter 3 of 2026']]);
    assert.deepEqual(by('ipo').map((e) => [e.date, e.symbol, e.title, e.detail]), [['2026-11-27', 'FRSH', 'Fresh Example Inc: expected to list', 'Price 14.00-16.00 on NASDAQ Global']]);
    assert.equal(by('central-bank').length, 2);

    const ipos = (await svc.get('/ipos')).body.pipeline;
    assert.deepEqual(ipos.at(-1), { company: 'Fresh Example Inc', symbol: 'FRSH', exchange: 'NASDAQ Global', form: null, filedAt: null, expectedDate: '2026-11-27', priceRange: '14.00-16.00', status: 'expected', url: null, alreadyListed: false, source: 'Finnhub' });

    // Keys never appear in anything sent to the browser.
    const everything = JSON.stringify([quotes, candles, overview, cal, ipos, svc.tradfi.health()]);
    assert.ok(!/fh-secret|td-secret|abcdefghijklmnop/.test(everything));
    assert.ok(svc.tradfi.health().sources.every((s) => s.state === 'ok'));
  } finally { await svc.close(); }
});

test('live: a provider at its free-tier limit stops being called and the next one answers', async () => {
  const fetchImpl = upstream();
  const svc = await serve({ env: { FINNHUB_KEY: 'k', HL_EQUITY_DEX: 'off' }, fetchImpl, now: () => NOW, tuning: { finnhubPerMinute: 2 } });
  try {
    // No SEC list here, so symbols cannot be checked against it and names are blank.
    const r = (await svc.get('/quote?symbols=EXT,AAA,BBB,CCC')).body;
    assert.equal(fetchImpl.calls.filter((u) => u.includes('finnhub')).length, 2);
    assert.equal(r.quotes[0].price, 101.5);
    assert.deepEqual(r.quotes.slice(1).map((q) => q.price), [null, null, null]);
    assert.ok(r.sources.some((s) => s.name === 'Finnhub' && s.state === 'error' && /request limit/.test(s.note)));
  } finally { await svc.close(); }
});

test('Fed calendar: published dates only, and nothing invented past the end of the schedule', () => {
  const all = fomcEvents(Date.UTC(2026, 0, 1), Date.UTC(2026, 11, 31));
  assert.equal(all.filter((e) => /decision/.test(e.title)).length, 8);
  assert.deepEqual(all.filter((e) => /minutes/.test(e.title)).map((e) => e.date), ['2026-02-18', '2026-04-08', '2026-05-20', '2026-07-08', '2026-08-19', '2026-10-07', '2026-11-18', '2026-12-30']);
  assert.deepEqual(fomcEvents(Date.UTC(2029, 0, 1), Date.UTC(2029, 2, 1)), []);
});

// ---------------------------------------------------------------------------------------
// Review: harder statement cases. Each payload is hand-made and each expectation was worked
// out by hand from it.
const xf = (start, end, val, filed, form, fy, fp, extra = {}) => ({ ...(start ? { start } : {}), end, val, accn: `0000000002-${filed.slice(2, 4)}-${filed.slice(5, 7)}${filed.slice(8)}`, fy, fp, form, filed, ...extra });
const rowsOf = (S) => (key) => findRow(S, key)?.values ?? null;

test('statements: a 52/53-week year ending in late September keeps its own quarters, labels and day-exact balance sheet', () => {
  // FY2023 runs 2022-09-25 to 2023-09-30 (53 weeks, 371 days); FY2024 2023-10-01 to 2024-09-28 (364 days).
  const K23 = ['2023-11-03', '10-K', 2023, 'FY'], K24 = ['2024-11-01', '10-K', 2024, 'FY'];
  const q1 = ['2024-02-02', '10-Q', 2024, 'Q1'], q2 = ['2024-05-03', '10-Q', 2024, 'Q2'], q3 = ['2024-08-02', '10-Q', 2024, 'Q3'], q1n = ['2025-01-31', '10-Q', 2025, 'Q1'];
  const facts = { facts: { 'us-gaap': {
    Revenues: { units: { USD: [
      xf('2022-09-25', '2023-09-30', 3830, ...K23), xf('2022-09-25', '2023-09-30', 3830, ...K24, { frame: 'CY2023' }),
      xf('2023-10-01', '2023-12-30', 1196, ...q1),
      // The same fy/fp carries a quarter, a half-year and (below) nine months.
      xf('2023-12-31', '2024-03-30', 908, ...q2), xf('2023-10-01', '2024-03-30', 2104, ...q2),
      xf('2024-03-31', '2024-06-29', 858, ...q3), xf('2023-10-01', '2024-06-29', 2962, ...q3),
      xf('2023-10-01', '2024-09-28', 3910, ...K24),
      // The same fact twice, once with a frame and once without: one value, not two.
      xf('2024-09-29', '2024-12-28', 1243, ...q1n), xf('2024-09-29', '2024-12-28', 1243, ...q1n, { frame: 'CY2024Q4' }), xf('2023-10-01', '2023-12-30', 1196, ...q1n)
    ] } },
    EarningsPerShareDiluted: { units: { 'USD/shares': [
      xf('2022-09-25', '2023-09-30', 6.13, ...K23), xf('2023-10-01', '2024-09-28', 6.08, ...K24), xf('2023-10-01', '2023-12-30', 2.18, ...q1),
      xf('2023-12-31', '2024-03-30', 1.53, ...q2), xf('2023-10-01', '2024-03-30', 3.71, ...q2), xf('2024-03-31', '2024-06-29', 1.40, ...q3), xf('2023-10-01', '2024-06-29', 5.11, ...q3)
    ] } },
    // Share counts are given for the first quarter alone, then only for the year so far.
    WeightedAverageNumberOfDilutedSharesOutstanding: { units: { shares: [
      xf('2022-09-25', '2023-09-30', 158e6, ...K23), xf('2023-10-01', '2024-09-28', 154e6, ...K24), xf('2023-10-01', '2023-12-30', 155e6, ...q1), xf('2023-10-01', '2024-03-30', 154.9e6, ...q2), xf('2023-10-01', '2024-06-29', 154.5e6, ...q3)
    ] } },
    Assets: { units: { USD: [
      xf(null, '2023-09-30', 3525, ...K23), xf(null, '2023-12-30', 3535, ...q1), xf(null, '2024-03-30', 3374, ...q2), xf(null, '2024-06-29', 3318, ...q3), xf(null, '2024-09-28', 3649, ...K24), xf(null, '2024-12-28', 3440, ...q1n),
      // A reading dated on the day the report was filed, and one at the calendar quarter end, belong to no period.
      xf(null, '2024-11-01', 9999, ...K24), xf(null, '2024-09-30', 8888, ...K24)
    ] } },
    NetCashProvidedByUsedInOperatingActivities: { units: { USD: [
      xf('2022-09-25', '2023-09-30', 1105, ...K23), xf('2023-10-01', '2023-12-30', 399, ...q1), xf('2023-10-01', '2024-03-30', 626, ...q2), xf('2023-10-01', '2024-06-29', 915, ...q3), xf('2023-10-01', '2024-09-28', 1182, ...K24)
    ] } },
    PaymentsToAcquirePropertyPlantAndEquipment: { units: { USD: [xf('2022-09-25', '2023-09-30', 110, ...K23), xf('2023-10-01', '2023-12-30', 24, ...q1), xf('2023-10-01', '2024-03-30', 44, ...q2), xf('2023-10-01', '2024-09-28', 94, ...K24)] } }
  } } };
  const s = buildStatements(facts);
  const a = rowsOf(s.annual), q = rowsOf(s.quarterly);
  assert.deepEqual(s.annual.periods, ['FY2024', 'FY2023']);
  assert.deepEqual(s.annual.periodEnds, ['2024-09-28', '2023-09-30']);
  assert.deepEqual(a('revenue'), [3910, 3830]);
  assert.deepEqual(a('totalAssets'), [3649, 3525]);
  assert.deepEqual(a('epsDiluted'), [6.08, 6.13]);
  assert.deepEqual(a('sharesDiluted'), [154e6, 158e6]);
  assert.deepEqual(a('capex'), [-94, -110]);
  assert.deepEqual(a('freeCashFlow'), [1088, 995]);
  // The quarter that ends in December is the FIRST quarter of the next financial year.
  assert.deepEqual(s.quarterly.periods, ['Q1 FY2025', 'Q4 FY2024', 'Q3 FY2024', 'Q2 FY2024', 'Q1 FY2024', 'Q4 FY2023']);
  assert.deepEqual(s.quarterly.periodEnds, ['2024-12-28', '2024-09-28', '2024-06-29', '2024-03-30', '2023-12-30', '2023-09-30']);
  // Q4 = 3910 - 2962 (the year less nine months), marked; the others as reported.
  assert.deepEqual(q('revenue'), [1243, 948, 858, 908, 1196, null]);
  assert.deepEqual(findRow(s.quarterly, 'revenue').derived, [false, true, false, false, false, false]);
  // Per-share figures: never 6.08 - 5.11 for the fourth quarter, never a year-to-date figure in a quarter's cell.
  assert.deepEqual(q('epsDiluted'), [null, null, 1.40, 1.53, 2.18, null]);
  assert.deepEqual(q('sharesDiluted'), [null, null, null, null, 155e6, null]);
  assert.deepEqual(q('totalAssets'), [3440, 3649, 3318, 3374, 3535, 3525]);
  assert.deepEqual(q('operatingCashFlow'), [null, 267, 289, 227, 399, null]);
  // Capital spending has no nine-month figure: Q3 and Q4 stay empty (94 - 44 would be two quarters).
  assert.deepEqual(q('capex'), [null, null, null, -20, -24, null]);
  assert.deepEqual(q('freeCashFlow'), [null, null, null, 207, 375, null]);
});

test('statements: a year ending in January takes the name the company gives it', () => {
  const facts = { facts: { 'us-gaap': { Revenues: { units: { USD: [
    xf('2023-01-29', '2024-02-03', 100, '2024-03-20', '10-K', 2023, 'FY'), xf('2024-02-04', '2025-02-01', 110, '2025-03-20', '10-K', 2024, 'FY'), xf('2023-01-29', '2024-02-03', 100, '2025-03-20', '10-K', 2024, 'FY'),
    xf('2025-02-02', '2025-05-03', 27, '2025-06-01', '10-Q', 2025, 'Q1'), xf('2024-02-04', '2024-05-04', 25, '2025-06-01', '10-Q', 2025, 'Q1')
  ] } } } } };
  const s = buildStatements(facts);
  assert.deepEqual(s.annual.periods, ['FY2024', 'FY2023']);   // not FY2025, though it ends in 2025
  assert.deepEqual(s.annual.periodEnds, ['2025-02-01', '2024-02-03']);
  assert.deepEqual(s.quarterly.periods.slice(0, 1), ['Q1 FY2025']);
  assert.deepEqual(s.quarterly.periodEnds.slice(0, 1), ['2025-05-03']);
});

test('statements: total revenue is not replaced by its customer-contract part, in the year or in a quarter', () => {
  const K = ['2025-03-01', '10-K', 2024, 'FY'];
  const facts = { facts: { 'us-gaap': {
    Revenues: { units: { USD: [xf('2024-01-01', '2024-12-31', 1000, ...K), xf('2023-01-01', '2023-12-31', 900, '2024-03-01', '10-K', 2023, 'FY')] } },
    // The narrower tag is the only one in the quarterly reports.
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [
      xf('2024-01-01', '2024-12-31', 800, ...K), xf('2024-01-01', '2024-03-31', 190, '2024-05-01', '10-Q', 2024, 'Q1'), xf('2024-01-01', '2024-06-30', 390, '2024-08-01', '10-Q', 2024, 'Q2'),
      xf('2025-01-01', '2025-03-31', 210, '2025-05-01', '10-Q', 2025, 'Q1')
    ] } },
    Assets: { units: { USD: [xf(null, '2024-12-31', 5, ...K), xf(null, '2024-03-31', 5, ...K), xf(null, '2024-06-30', 5, ...K), xf(null, '2025-03-31', 5, ...K)] } }
  } } };
  const s = buildStatements(facts);
  assert.deepEqual(rowsOf(s.annual)('revenue'), [1000, 900]);   // was 800
  // 190, 200 and 210 are contract revenue only: shown under "Revenue" they would understate it.
  assert.deepEqual(s.quarterly.periods, ['Q1 FY2025', 'Q4 FY2024', 'Q2 FY2024', 'Q1 FY2024', 'Q4 FY2023']);
  assert.deepEqual(rowsOf(s.quarterly)('revenue'), [null, null, null, null, null]);
});

test('statements: a change of tag between years leaves no hole and no double count; one inside a year is not bridged', () => {
  const facts = { facts: { 'us-gaap': {
    SalesRevenueNet: { units: { USD: [
      xf('2022-01-01', '2022-12-31', 700, '2023-02-20', '10-K', 2022, 'FY'), xf('2023-01-01', '2023-12-31', 800, '2024-02-20', '10-K', 2023, 'FY'),
      xf('2024-01-01', '2024-03-31', 210, '2024-05-01', '10-Q', 2024, 'Q1'), xf('2024-01-01', '2024-06-30', 430, '2024-08-01', '10-Q', 2024, 'Q2'), xf('2024-01-01', '2024-09-30', 660, '2024-11-01', '10-Q', 2024, 'Q3')
    ] } },
    // From the 2024 annual report on, a new tag; it repeats 2023 for comparison.
    RevenueFromContractWithCustomerExcludingAssessedTax: { units: { USD: [xf('2024-01-01', '2024-12-31', 900, '2025-02-20', '10-K', 2024, 'FY'), xf('2023-01-01', '2023-12-31', 800, '2025-02-20', '10-K', 2024, 'FY')] } },
    Assets: { units: { USD: [xf(null, '2024-12-31', 1, '2025-02-20', '10-K', 2024, 'FY')] } }
  } } };
  const s = buildStatements(facts);
  assert.deepEqual(s.annual.periods, ['FY2024', 'FY2023', 'FY2022']);
  assert.deepEqual(rowsOf(s.annual)('revenue'), [900, 800, 700]);
  assert.deepEqual(s.quarterly.periods.slice(0, 4), ['Q4 FY2024', 'Q3 FY2024', 'Q2 FY2024', 'Q1 FY2024']);
  // Q4 would need the year under one tag less nine months under another: left empty, not 240.
  assert.deepEqual(rowsOf(s.quarterly)('revenue').slice(0, 4), [null, 230, 220, 210]);
});

test('statements: a fourth quarter is never worked out when a quarter before it is missing', () => {
  const K = ['2025-02-14', '10-K', 2024, 'FY'];
  const facts = { facts: { 'us-gaap': {
    // Each quarter reported only on its own; the third is missing altogether.
    Revenues: { units: { USD: [xf('2024-01-01', '2024-12-31', 400, ...K), xf('2024-01-01', '2024-03-31', 90, '2024-05-01', '10-Q', 2024, 'Q1'), xf('2024-04-01', '2024-06-30', 100, '2024-08-01', '10-Q', 2024, 'Q2'), xf('2023-01-01', '2023-12-31', 360, '2024-02-14', '10-K', 2023, 'FY')] } },
    Assets: { units: { USD: [xf(null, '2024-12-31', 50, ...K)] } }
  } } };
  const s = buildStatements(facts);
  // The second quarter is found although no six-month figure marks its end.
  assert.deepEqual(s.quarterly.periods, ['Q4 FY2024', 'Q2 FY2024', 'Q1 FY2024', 'Q4 FY2023']);
  assert.deepEqual(rowsOf(s.quarterly)('revenue'), [null, 100, 90, null]);   // never 400 - 190 = 210
  assert.equal(findRow(s.quarterly, 'revenue').derived, undefined);
});

test('statements: a change of year-end shows each year under its own end date, without overlap', () => {
  const facts = { facts: { 'us-gaap': { Revenues: { units: { USD: [
    xf('2021-10-01', '2022-09-30', 300, '2022-11-20', '10-K', 2022, 'FY'), xf('2022-10-01', '2023-09-30', 330, '2023-11-20', '10-K', 2023, 'FY'),
    xf('2023-10-01', '2023-12-31', 90, '2024-02-20', '10-KT', 2023, 'FY'),                 // the three-month bridge
    xf('2024-01-01', '2024-12-31', 380, '2025-02-20', '10-K', 2024, 'FY'), xf('2023-01-01', '2023-12-31', 345, '2025-02-20', '10-K', 2024, 'FY'),   // 2023 recast to the new year-end
    xf('2024-01-01', '2024-03-31', 91, '2024-05-01', '10-Q', 2024, 'Q1')
  ] } } } } };
  const s = buildStatements(facts);
  // The recast calendar 2023 is kept and the overlapping year to September 2023 dropped: no month is counted twice.
  assert.deepEqual(s.annual.periods, ['FY2024', 'FY2023', 'FY2022']);
  assert.deepEqual(s.annual.periodEnds, ['2024-12-31', '2023-12-31', '2022-09-30']);
  assert.deepEqual(rowsOf(s.annual)('revenue'), [380, 345, 300]);
  // The bridge period is the last quarter of calendar 2023, as reported; it is not a year.
  const i = s.quarterly.periodEnds.indexOf('2023-12-31');
  assert.equal(s.quarterly.periods[i], 'Q4 FY2023');
  assert.equal(rowsOf(s.quarterly)('revenue')[i], 90);
});

test('statements: figures in another currency are not shown as dollars', () => {
  const s = buildStatements({ facts: { 'us-gaap': {
    Revenues: { units: { CAD: [xf('2024-01-01', '2024-12-31', 100, '2025-03-01', '40-F', 2024, 'FY')] } },
    Assets: { units: { CAD: [xf(null, '2024-12-31', 500, '2025-03-01', '40-F', 2024, 'FY')] } }
  } } });
  assert.equal(s.annual, null);
  assert.equal(s.quarterly, null);
  assert.match(s.reason, /reports in CAD, not US dollars/);
  // A dollar filer with one stray figure in another currency is unaffected.
  const mixed = buildStatements({ facts: { 'us-gaap': { Revenues: { units: { USD: [xf('2024-01-01', '2024-12-31', 70, '2025-03-01', '10-K', 2024, 'FY')], EUR: [xf('2024-01-01', '2024-12-31', 999, '2025-03-01', '10-K', 2024, 'FY')] } } } } });
  assert.deepEqual(rowsOf(mixed.annual)('revenue'), [70]);
});

test('statements: a restatement filed later wins for the year, and quarters derived from it use the restated figures', () => {
  const facts = { facts: { 'us-gaap': { NetIncomeLoss: { units: { USD: [
    xf('2023-01-01', '2023-12-31', 100, '2024-02-15', '10-K', 2023, 'FY'),
    xf('2023-01-01', '2023-12-31', 80, '2024-09-01', '10-K/A', 2023, 'FY'),       // restated down
    xf('2023-01-01', '2023-12-31', 80, '2025-02-15', '10-K', 2024, 'FY'),
    xf('2023-01-01', '2023-09-30', 70, '2023-11-01', '10-Q', 2023, 'Q3'), xf('2023-01-01', '2023-09-30', 62, '2024-11-01', '10-Q', 2024, 'Q3'),   // nine months restated too
    xf('2023-01-01', '2023-06-30', 45, '2023-08-01', '10-Q', 2023, 'Q2'), xf('2023-01-01', '2023-03-31', 20, '2023-05-01', '10-Q', 2023, 'Q1'),
    xf('2024-01-01', '2024-12-31', 130, '2025-02-15', '10-K', 2024, 'FY')
  ] } } } } };
  const s = buildStatements(facts);
  assert.deepEqual(rowsOf(s.annual)('netIncome'), [130, 80]);
  const at = (end) => rowsOf(s.quarterly)('netIncome')[s.quarterly.periodEnds.indexOf(end)];
  assert.equal(at('2023-12-31'), 18);   // 80 - 62, both as restated; not 100 - 70 and not 80 - 70
  assert.equal(at('2023-09-30'), 17);   // 62 - 45
  assert.equal(at('2023-06-30'), 25);
  assert.equal(at('2023-03-31'), 20);
});

// ---------------------------------------------------------------------------------------
// Review: abuse, failure and fairness.
import { visitor, redact } from '../src/tradfi/source.js';
import { createLimiter, addressKey } from '../src/tradfi/index.js';
import { plainXml } from '../src/tradfi/util.js';

test('source: keys are stripped from errors, oversized and non-JSON answers fail, and a 429 is respected', async () => {
  assert.equal(redact('fetch failed https://finnhub.io/api/v1/quote?symbol=A&token=fh-secret'), 'fetch failed https://finnhub.io/api/v1/quote?symbol=A&token=[hidden]');
  assert.equal(redact('x?api_key=abc123&file_type=json'), 'x?api_key=[hidden]&file_type=json');

  let t = 1e12, mode = 'leak', n = 0;
  const stream = (text) => new Response(text, { status: 200 });
  const fetchImpl = async (url) => {
    n += 1;
    if (mode === 'leak') throw new TypeError(`request to ${url} failed`);
    if (mode === 'html') return stream('<!DOCTYPE html><html><body>Service unavailable</body></html>');
    if (mode === 'big') return stream('"' + 'x'.repeat(3000) + '"');
    if (mode === '429') return new Response('slow down', { status: 429, headers: { 'retry-after': '90' } });
    return stream('{"ok":true}');
  };
  const s = createSource({ name: 'Keyed', fetchImpl, now: () => t, maxBytes: 2000 });
  await assert.rejects(s.get('https://example.test/q?token=fh-secret'), (e) => !/fh-secret/.test(e.message) && /token=\[hidden\]/.test(e.message));
  assert.ok(!/fh-secret/.test(JSON.stringify(s.health())));
  // HTML where JSON was expected is a failure, not an empty answer.
  mode = 'html'; t += 3000;
  await assert.rejects(s.get('u-html'), /JSON|Unexpected/);
  // A body larger than the cap is not read to the end.
  mode = 'big'; t += 3000;
  await assert.rejects(s.get('u-big'), /sent more than/);
  mode = 'ok'; t += 3000;
  assert.deepEqual((await s.get('u-ok', { ttlMs: 1000 })).data, { ok: true });
  // 429 with Retry-After: nothing at all is asked of the service for those 90 seconds.
  mode = '429'; t += 3000;
  await assert.rejects(s.get('u-a'), /HTTP 429/);
  const before = n;
  mode = 'ok'; t += 60000;
  await assert.rejects(s.get('u-b'), /refusing requests for now \(HTTP 429\)/);
  assert.equal((await s.get('u-ok', { ttlMs: 1000, staleMs: 600000 })).stale, true);   // a saved answer still stands in
  assert.equal(n, before);
  assert.ok(s.health().pausedUntil > t);
  t += 31000;
  assert.deepEqual((await s.get('u-b')).data, { ok: true });
});

test('source: one visitor cannot spend the whole allowance, shared calls are charged to nobody, tables stay bounded', async () => {
  let t = 1e12, n = 0;
  const fetchImpl = async () => { n += 1; return { ok: true, status: 200, json: async () => ({ n }) }; };
  const s = createSource({ name: 'Fair', fetchImpl, now: () => t, budget: [{ max: 10, perMs: 60000 }], perVisitor: { max: 3, perMs: 60000 }, maxEntries: 50 });
  const as = (id, fn) => visitor.run({ id }, fn);
  await as('a', () => s.get('a1')); await as('a', () => s.get('a2')); await as('a', () => s.get('a3'));
  await assert.rejects(as('a', () => s.get('a4')), /Too many new lookups from one address/);
  assert.equal(n, 3);
  // Somebody else is not refused because of it, including for the very same thing.
  assert.equal((await as('b', () => s.get('a4'))).data.n, 4);
  // What is already held costs nothing, so the first visitor can still read it.
  assert.equal((await as('a', () => s.get('a4'))).data.n, 4);
  // A call that serves everyone is not charged to whoever triggered it.
  assert.equal((await as('a', () => s.get('fixed-file', { shared: true }))).data.n, 5);
  // The global budget still holds for everyone together.
  for (const id of ['c', 'd']) for (let i = 0; i < 3; i++) await as(id, () => s.get(`${id}${i}`).catch(() => null));
  assert.equal(n, 10);
  // Many addresses and many keys: the tables do not grow without end.
  t += 60000;
  const wide = createSource({ name: 'Wide', fetchImpl, now: () => t, perVisitor: { max: 1, perMs: 60000 }, maxEntries: 50 });
  for (let i = 0; i < 6000; i++) await as('v' + i, () => wide.get('k' + i));
  assert.ok(wide.size().cache <= 50 && wide.size().visitors <= 5000 && wide.size().inflight === 0, JSON.stringify(wide.size()));
});

test('router: a per-address limit answers 429 before any work, and addresses are grouped sensibly', async () => {
  assert.equal(addressKey('::ffff:203.0.113.9'), '203.0.113.9');
  assert.equal(addressKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd'), addressKey('2001:db8:1:2::1'));
  assert.notEqual(addressKey('2001:db8:1:2::1'), addressKey('2001:db8:1:3::1'));
  assert.equal(addressKey(undefined), 'unknown');
  let t = 0;
  const lim = createLimiter({ max: 5, perMs: 60000, now: () => t, maxAddresses: 100 });
  assert.deepEqual([lim.take('a', 3), lim.take('a', 2), lim.take('a', 1), lim.take('b', 5)], [0, 0, 60, 0]);
  t = 61000;
  assert.equal(lim.take('a', 1), 0);
  for (let i = 0; i < 1000; i++) lim.take('x' + i);
  assert.ok(lim.size() <= 100);

  const fetchImpl = upstream();
  const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl, now: () => NOW, tuning: { requestsPerMinute: 7 } });
  try {
    assert.equal((await svc.get('/company?symbol=EXT')).status, 200);    // weight 3
    assert.equal((await svc.get('/candles?symbol=NVDA')).status, 200);   // weight 3
    const calls = fetchImpl.calls.length;
    const r = await svc.get('/company?symbol=EXB');                      // would make 7 + 2
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('cache-control'), 'no-store');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.match(r.body.error, /Too many requests/);
    assert.equal(fetchImpl.calls.length, calls);
    assert.equal((await svc.get('/search?q=ex')).status, 200);           // a light request still fits
  } finally { await svc.close(); }
});

test('live: one address cannot use up the SEC allowance; others are still served', async () => {
  const many = { fields: TICKERS.fields, data: TICKERS.data.concat(Array.from({ length: 30 }, (_, i) => [5000 + i, `Filler Company ${i}`, `FIL${i}`, 'NYSE'])) };
  const base = upstream();
  const fetchImpl = async (url, init) => (String(url).includes('company_tickers_exchange.json') ? { ok: true, status: 200, json: async () => many } : base(url, init));
  const tradfi = createTradfi({ log: quiet, env: { SEC_USER_AGENT: UA, HL_EQUITY_DEX: 'off' }, fetchImpl, now: () => NOW, tuning: { secPerSecond: 1000, secWaitMs: 0, secPerVisitor: 6 } });
  const app = express();
  app.set('trust proxy', true);
  app.use('/api/tradfi', tradfi.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const get = async (path, ip) => { const r = await fetch(`http://127.0.0.1:${server.address().port}/api/tradfi${path}`, { headers: { 'x-forwarded-for': ip } }); return { status: r.status, body: await r.json() }; };
  try {
    // Each new company is two SEC calls; the list of companies is shared and charged to nobody.
    for (let i = 0; i < 3; i++) assert.equal((await get(`/company?symbol=FIL${i}`, '198.51.100.7')).status, 200);
    const refused = await get('/company?symbol=FIL3', '198.51.100.7');
    assert.equal(refused.status, 429);
    assert.match(refused.body.error, /Too many new lookups from one address/);
    // Another address asks for the same company and gets it; then the first can read it from memory.
    assert.equal((await get('/company?symbol=FIL3', '203.0.113.50')).status, 200);
    assert.equal((await get('/company?symbol=FIL3', '198.51.100.7')).status, 200);
    assert.equal((await get('/company?symbol=FIL0', '198.51.100.7')).status, 200);
  } finally { await new Promise((r) => server.close(r)); }
});

test('live: two tickers of one company share the work and each answer names the ticker asked for', async () => {
  const two = { fields: TICKERS.fields, data: [[1, 'Example Test Co', 'EXT', 'NYSE'], [1, 'Example Test Co', 'EXT-B', 'NYSE']] };
  const base = upstream();
  const fetchImpl = async (url, init) => (String(url).includes('company_tickers_exchange.json') ? { ok: true, status: 200, json: async () => two } : base(url, init));
  const svc = await serve({ env: { SEC_USER_AGENT: UA, HL_EQUITY_DEX: 'off' }, fetchImpl, now: () => NOW });
  try {
    assert.equal((await svc.get('/company?symbol=EXT')).body.symbol, 'EXT');
    const n = base.calls.length;
    assert.equal((await svc.get('/company?symbol=EXT-B')).body.symbol, 'EXT-B');   // was "EXT"
    assert.equal((await svc.get('/company?symbol=EXT.B')).body.symbol, 'EXT-B');   // typed with a dot
    assert.equal(base.calls.length, n);
  } finally { await svc.close(); }
});

test('live: Form D details load in the background; a slow SEC does not hold the page', async () => {
  const base = upstream();
  let release;
  const gate = new Promise((r) => { release = r; });
  const fetchImpl = async (url, init) => { if (String(url).includes('primary_doc.xml')) await gate; return base(url, init); };
  const svc = await serve({ env: { SEC_USER_AGENT: UA, HL_EQUITY_DEX: 'off' }, fetchImpl, now: () => NOW, tuning: { formDWaitMs: 30 } });
  try {
    const started = Date.now();
    const first = await svc.get('/private');
    assert.ok(Date.now() - started < 1500);
    assert.equal(first.status, 200);
    assert.equal(first.body.raises.length, 3);
    assert.equal(first.body.detailsPending, 3);
    // Nothing is known about amounts yet, and nothing is made up: null with `detail: false`.
    assert.ok(first.body.raises.every((r) => r.detail === false && r.amountOffered === null && r.amountSold === null && r.industry === null));
    assert.match(first.body.sources[0].note, /still being read/);
    // Other requests are not held up, and asking again does not start the same work twice.
    assert.equal((await svc.get('/ipos')).status, 200);
    await svc.get('/private');
    assert.equal(base.calls.filter((u) => u.includes('primary_doc.xml')).length, 0);
    release();
    await new Promise((r) => setTimeout(r, 60));
    const done = (await svc.get('/private')).body;
    assert.equal(done.detailsPending, 0);
    assert.deepEqual(done.raises.map((r) => [r.detail, r.amountOffered, r.amountSold]), [[true, null, 12500000], [true, 30000000, 21000000], [false, null, null]]);
    assert.match(done.sources[0].note, /could not be read for 1 of the newest filings/);
    assert.equal(base.calls.filter((u) => u.includes('primary_doc.xml')).length, 3);
  } finally { await svc.close(); }
});

test('live: the SEC blocking us (403), HTML in place of a feed, and a foreign filer all say what happened', async () => {
  const base = upstream();
  let mode = 'ok';
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (mode === '403' && u.includes('sec.gov')) return { ok: false, status: 403, text: async () => '<html>Undeclared Automated Tool</html>', json: async () => { throw new SyntaxError('Unexpected token <'); } };
    if (mode === 'html' && u.includes('browse-edgar')) return { ok: true, status: 200, text: async () => '<html><body>Request Rate Threshold Exceeded</body></html>' };
    if (u.includes('/companyfacts/CIK0000000002.json')) return { ok: true, status: 200, json: async () => ({ facts: { 'ifrs-full': { Revenue: { units: { EUR: [] } } } } }) };
    return base(url, init);
  };
  let t = NOW;
  const svc = await serve({ env: { SEC_USER_AGENT: UA, HL_EQUITY_DEX: 'off' }, fetchImpl, now: () => t });
  try {
    // A foreign filer under IFRS: a company page with no statements and the reason.
    const foreign = (await svc.get('/company?symbol=EXB')).body;
    assert.equal(foreign.statements, null);
    assert.match(foreign.statementsNote, /international standards \(IFRS\)/);
    assert.deepEqual(foreign.facts, []);
    // A filer with no structured data at all (404 from the SEC).
    const none = (await svc.get('/company?symbol=NEM2')).body;
    assert.equal(none.statements, null);
    assert.match(none.statementsNote, /no financial data in the SEC’s structured format/);
    // An HTML page where the feed should be is an error, not an empty pipeline.
    mode = 'html';
    const ipos = await svc.get('/ipos');
    assert.equal(ipos.status, 502);
    const priv = await svc.get('/private');
    assert.equal(priv.status, 502);
    // Blocked: one refusal pauses every SEC call for a minute, and the Status page says why.
    mode = '403'; t += 5000;
    assert.equal((await svc.get('/company?symbol=NVDA')).status, 502);
    const calls = base.calls.length;
    t += 30000;
    const again = await svc.get('/company?symbol=NVDA');
    assert.equal(again.status, 502);
    assert.match(again.body.error, /refusing requests for now \(HTTP 403\)/);
    assert.equal(base.calls.length, calls);
    const h = svc.tradfi.health().sources[0];
    assert.equal(h.state, 'error');
    assert.match(h.lastError, /HTTP 403/);
    // Companies already read are still served from memory meanwhile.
    assert.equal((await svc.get('/company?symbol=EXB')).status, 200);
  } finally { await svc.close(); }
});

test('live: the calendar asks Finnhub by whole month, so no choice of days can multiply the calls', async () => {
  const fetchImpl = upstream();
  const svc = await serve({ env: { FINNHUB_KEY: 'fh-secret', HL_EQUITY_DEX: 'off' }, fetchImpl, now: () => NOW });
  try {
    const fh = () => fetchImpl.calls.filter((u) => u.includes('finnhub.io/api/v1/calendar'));
    await svc.get('/calendar?from=2026-11-19&to=2026-11-25');
    assert.deepEqual(fh().map((u) => /calendar\/(\w+)\?from=([\d-]+)&to=([\d-]+)/.exec(u).slice(1)).sort(), [['earnings', '2026-11-01', '2026-11-30'], ['ipo', '2026-11-01', '2026-11-30']]);
    for (let d = 1; d <= 28; d++) await svc.get(`/calendar?from=2026-11-${String(d).padStart(2, '0')}&to=2026-11-${String(Math.min(30, d + 2)).padStart(2, '0')}`);
    assert.equal(fh().length, 2);
    // Events outside the days asked for are not shown, though the month was fetched whole.
    const narrow = (await svc.get('/calendar?from=2026-11-25&to=2026-11-26')).body.events.filter((e) => e.kind === 'earnings' || e.kind === 'ipo');
    assert.deepEqual(narrow.map((e) => e.date), ['2026-11-25']);
    // An unexpected "hour" from upstream cannot pull text out of thin air.
    assert.ok(narrow.every((e) => !/function|native code/.test(String(e.detail))));
  } finally { await svc.close(); }
});

test('candles: range=max returns the longest history each source holds and says how far back it goes', async () => {
  const demo = await serve({ demo: true, now: () => NOW });
  try {
    const d = (await demo.get('/candles?symbol=QUILLN&range=max')).body;
    assert.equal(d.range, 'max');
    assert.equal(d.historyStart, '2015-01-05');
    assert.equal(d.capped, false);
    assert.equal(new Date(d.candles[0].time * 1000).toISOString().slice(0, 10), '2015-01-05');
    assert.ok(d.candles.length > 3000 && d.candles.length <= 5000);
    const five = (await demo.get('/candles?symbol=QUILLN&range=5y')).body;
    assert.deepEqual(d.candles.slice(-five.candles.length), five.candles);
    assert.equal((await demo.get('/candles?symbol=QUILLN&range=10y')).status, 400);
  } finally { await demo.close(); }

  const base = upstream();
  const bars = (n) => Array.from({ length: n }, (_, i) => ({ datetime: new Date(Date.UTC(2026, 10, 18) - i * 86400000).toISOString().slice(0, 10), open: '10', high: '11', low: '9', close: '10.5', volume: '100' }));
  const asked = [];
  const fetchImpl = async (url, init) => {
    if (!String(url).includes('api.twelvedata.com/time_series')) return base(url, init);
    asked.push(String(url));
    return { ok: true, status: 200, json: async () => ({ values: bars(5000), status: 'ok' }) };
  };
  const live = await serve({ env: { SEC_USER_AGENT: UA, TWELVEDATA_KEY: 'td-secret' }, fetchImpl, now: () => NOW });
  try {
    const td = (await live.get('/candles?symbol=EXT&range=max')).body;
    assert.match(asked[0], /outputsize=5000\b/);   // the most the source gives in one answer
    assert.equal(td.candles.length, 5000);
    assert.equal(td.capped, true);     // the source may hold more than one answer carries
    assert.equal(td.historyStart, td.candles.length ? new Date(td.candles[0].time * 1000).toISOString().slice(0, 10) : null);
    // A perpetual: asked for as far back as the venue serves, with the venue's own coin name.
    const hl = (await live.get('/candles?symbol=HL:XYZ100&range=max')).body;
    const sent = JSON.parse(base.calls.find((u) => u.includes('candleSnapshot') && u.includes('xyz:XYZ100')).split(' ').slice(1).join(' '));
    assert.equal(sent.req.coin, 'xyz:XYZ100');
    assert.equal(sent.req.interval, '1d');
    assert.equal(sent.req.endTime - sent.req.startTime, 5000 * 86400000);
    assert.deepEqual([hl.kind, hl.range, hl.capped, hl.candles.length], ['perp', 'max', false, 20]);
    assert.match(hl.source, /Hyperliquid perpetual \(xyz:XYZ100\)/);
  } finally { await live.close(); }
});

test('Twelve Data: the quote is timed by its last trade minute, never by when the daily bar opened', async () => {
  const base = upstream();
  const quote = { symbol: 'EXT', close: '102.5', previous_close: '100', percent_change: '2.5', open: '100.5', high: '103', low: '100', volume: '1200', timestamp: Math.floor(NOW / 1000) - 6 * 3600, last_quote_at: Math.floor(NOW / 1000) - 60, is_market_open: true };
  let body = quote;
  const fetchImpl = async (url, init) => (String(url).includes('api.twelvedata.com/quote') ? { ok: true, status: 200, json: async () => body } : base(url, init));
  let t = NOW;
  const svc = await serve({ env: { TWELVEDATA_KEY: 'td-secret', HL_EQUITY_DEX: 'off' }, fetchImpl, now: () => t });
  try {
    const q = (await svc.get('/quote?symbols=EXT')).body.quotes[0];
    assert.deepEqual([q.price, q.changePct, q.asOf, q.delayed, q.source], [102.5, 2.5, NOW - 60000, false, 'Twelve Data']);   // asOf was six hours early
    // With only the bar's opening time to go on, the age is unknown and the price is not called live.
    body = { ...quote, last_quote_at: undefined }; t += 10 * 60000;
    const q2 = (await svc.get('/quote?symbols=EXT')).body.quotes[0];
    assert.deepEqual([q2.asOf, q2.delayed], [null, true]);
  } finally { await svc.close(); }
});

test('XML from outside: document types and entity declarations are refused before parsing', () => {
  assert.throws(() => plainXml('<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;">]><feed>&lol2;</feed>'), /Not a plain XML feed/);
  assert.throws(() => parseYieldFeed('<!DOCTYPE feed [<!ENTITY a "aaaa">]><feed></feed>'));
  assert.throws(() => parseFormD('<!DOCTYPE x [<!ENTITY a "aaaa">]><edgarSubmission></edgarSubmission>'));
  assert.throws(() => plainXml('x'.repeat(5e6)), /too large/);
  assert.throws(() => parseYieldFeed('<html><body>Access denied</body></html>'), /Not a Treasury yield feed/);
  assert.deepEqual(parseYieldFeed('<feed></feed>'), []);
  // Deep nesting ends quickly with an error instead of running on.
  const started = Date.now();
  assert.throws(() => parseCurrentFeed('<feed>' + '<entry><title>'.repeat(20000) + '</feed>'));
  assert.ok(Date.now() - started < 2000);
});

test('demo: each session opens near the last close, and no invented name is a known real firm', async () => {
  const demo = createDemoBackend({ now: () => NOW });
  for (const symbol of ['QUILLN', 'NORGAL', 'DEMO500']) {
    const c = (await demo.candles(symbol, '1y')).candles;
    const gaps = c.slice(1).map((x, i) => Math.abs(x.open / c[i].close - 1));
    const bodies = c.map((x) => (x.high - x.low) / x.open);
    const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
    // Before: the average gap between a close and the next open was as large as the day's own range.
    assert.ok(Math.max(...gaps) < 0.02, `${symbol} largest gap ${Math.max(...gaps)}`);
    assert.ok(mean(gaps) < mean(bodies) / 4, `${symbol} gaps ${mean(gaps)} against ranges ${mean(bodies)}`);
  }
  // Names found to belong to real companies in a web search on 2026-11-19, or one letter from one.
  const REAL = ['vantrix', 'ardent', 'tindra', 'quillon', 'zephra', 'oktavo', 'okta', 'fawkner', 'xanthera', 'quenby', 'pendrake', 'rookhurst', 'daventree'];
  const names = [];
  for (const s of demo.symbols()) names.push((await demo.company(s)).name, s);
  for (const p of (await demo.ipos()).pipeline) names.push(p.company, p.symbol || '');
  for (const r of (await demo.private()).raises) names.push(r.issuer);
  for (const n of names) for (const real of REAL) assert.ok(!new RegExp(`\\b${real}\\b`, 'i').test(n), `${n} uses the real name ${real}`);
});
