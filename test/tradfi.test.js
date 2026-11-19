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
  assert.deepEqual(parseCurrentFeed('not xml at all'), []);

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
