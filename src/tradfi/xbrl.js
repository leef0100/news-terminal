// Financial statements from the SEC's XBRL "company facts" file.
//
// The file is every number a company has ever tagged, by accounting concept, with the dates
// each covers and the filing it came from. Turning that into statements is mostly a matter
// of refusing to guess:
//
//   - A concept can be tagged several ways (three or four tags mean "revenue"). Each row has
//     a list of tags in order of preference, and the first that has the period is used.
//   - A period is identified by its own dates, never by the `fy`/`fp` fields: those describe
//     the filing a number appeared in, so last year's comparison figures carry this year's
//     label. A year is a span of about 365 days from an annual report; a quarter is about 90.
//   - The same period is often reported again in later filings, sometimes restated. The most
//     recently filed value wins.
//   - Fourth quarters are rarely reported on their own, and cash-flow statements are only
//     ever reported for the year so far. A missing quarter is worked out as the difference
//     between two year-to-date figures (or the year minus three quarters) and marked derived.
//     Per-share figures and share counts do not add up that way, so they are left empty.
//   - Balance-sheet rows are readings on a day, matched to the period's last day exactly.
//   - Anything that cannot be tied to a period with confidence is null.

import { shapeStatement } from './layout.js';

const DAY = 86400000;
const ANNUAL_FORMS = new Set(['10-K', '10-K/A', '10-KT', '10-KT/A', '20-F', '20-F/A', '40-F', '40-F/A']);
const ms = (iso) => Date.parse(iso + 'T00:00:00Z');
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const NEAR = 5 * DAY; // how far apart two start dates may be and still mean the same start

// Row -> tags, most preferred first. `unit` is the XBRL unit the values are filed in.
export const CONCEPTS = {
  revenue: ['RevenueFromContractWithCustomerExcludingAssessedTax', 'Revenues', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax', 'SalesRevenueGoodsNet', 'RevenuesNetOfInterestExpense'],
  costOfRevenue: ['CostOfRevenue', 'CostOfGoodsAndServicesSold', 'CostOfGoodsSold', 'CostOfServices'],
  grossProfit: ['GrossProfit'],
  operatingExpenses: ['OperatingExpenses'],
  researchAndDevelopment: ['ResearchAndDevelopmentExpense', 'ResearchAndDevelopmentExpenseExcludingAcquiredInProcessCost'],
  sellingGeneralAdmin: ['SellingGeneralAndAdministrativeExpense'],
  operatingIncome: ['OperatingIncomeLoss'],
  otherIncomeExpense: ['NonoperatingIncomeExpense'],
  pretaxIncome: ['IncomeLossFromContinuingOperationsBeforeIncomeTaxesExtraordinaryItemsNoncontrollingInterest', 'IncomeLossFromContinuingOperationsBeforeIncomeTaxesMinorityInterestAndIncomeLossFromEquityMethodInvestments'],
  incomeTax: ['IncomeTaxExpenseBenefit'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  epsBasic: ['EarningsPerShareBasic', 'EarningsPerShareBasicAndDiluted'],
  epsDiluted: ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted'],
  sharesBasic: ['WeightedAverageNumberOfSharesOutstandingBasic', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'],
  sharesDiluted: ['WeightedAverageNumberOfDilutedSharesOutstanding', 'WeightedAverageNumberOfShareOutstandingBasicAndDiluted'],
  cash: ['CashAndCashEquivalentsAtCarryingValue', 'Cash'],
  receivables: ['AccountsReceivableNetCurrent', 'ReceivablesNetCurrent', 'AccountsNotesAndLoansReceivableNetCurrent'],
  inventory: ['InventoryNet'],
  totalCurrentAssets: ['AssetsCurrent'],
  ppe: ['PropertyPlantAndEquipmentNet', 'PropertyPlantAndEquipmentAndFinanceLeaseRightOfUseAssetAfterAccumulatedDepreciationAndAmortization'],
  totalAssets: ['Assets'],
  payables: ['AccountsPayableCurrent', 'AccountsPayableTradeCurrent', 'AccountsPayableAndAccruedLiabilitiesCurrent'],
  debtCurrent: ['LongTermDebtCurrent', 'LongTermDebtAndCapitalLeaseObligationsCurrent'],
  totalCurrentLiabilities: ['LiabilitiesCurrent'],
  longTermDebt: ['LongTermDebtNoncurrent', 'LongTermDebtAndCapitalLeaseObligations'],
  totalLiabilities: ['Liabilities'],
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  liabilitiesAndEquity: ['LiabilitiesAndStockholdersEquity'],
  operatingCashFlow: ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  investingCashFlow: ['NetCashProvidedByUsedInInvestingActivities', 'NetCashProvidedByUsedInInvestingActivitiesContinuingOperations'],
  financingCashFlow: ['NetCashProvidedByUsedInFinancingActivities', 'NetCashProvidedByUsedInFinancingActivitiesContinuingOperations'],
  netChangeInCash: ['CashCashEquivalentsRestrictedCashAndRestrictedCashEquivalentsPeriodIncreaseDecreaseIncludingExchangeRateEffect', 'CashAndCashEquivalentsPeriodIncreaseDecrease'],
  // Reported as a payment (a positive number); shown as cash going out (negative).
  capex: ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets']
};
const UNIT = { epsBasic: 'USD/shares', epsDiluted: 'USD/shares', sharesBasic: 'shares', sharesDiluted: 'shares' };
const INSTANT = new Set(['cash', 'receivables', 'inventory', 'totalCurrentAssets', 'ppe', 'totalAssets', 'payables', 'debtCurrent', 'totalCurrentLiabilities', 'longTermDebt', 'totalLiabilities', 'equity', 'liabilitiesAndEquity']);
// Rows that cannot be had by subtracting one period from another.
const NOT_ADDITIVE = new Set(['epsBasic', 'epsDiluted', 'sharesBasic', 'sharesDiluted']);
// Tags used only inside calculations below.
const EXTRA = {
  sellingAndMarketing: ['SellingAndMarketingExpense'],
  generalAndAdmin: ['GeneralAndAdministrativeExpense'],
  equityWithMinority: ['StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest']
};
// If a company reports any of these, part of what it owes sits outside both "liabilities"
// and "equity", so liabilities cannot be had by subtraction.
const BETWEEN = ['TemporaryEquityCarryingAmountAttributableToParent', 'TemporaryEquityCarryingAmountIncludingPortionAttributableToNoncontrollingInterests', 'RedeemableNoncontrollingInterestEquityCarryingAmount', 'MinorityInterest'];

export function buildStatements(companyFacts, { maxAnnual = 5, maxQuarterly = 8 } = {}) {
  const gaap = companyFacts?.facts?.['us-gaap'];
  if (!gaap || !Object.keys(gaap).length) {
    const ifrs = Boolean(companyFacts?.facts?.['ifrs-full']);
    return { annual: null, quarterly: null, reason: ifrs ? 'Statements are not available in this format: the company reports under international standards (IFRS), which are not mapped here.' : 'The company has filed no financial data in the SEC’s structured format.' };
  }

  // One tag's facts in one unit, with repeats of the same period reduced to the one filed last.
  const seriesCache = new Map();
  function series(tag, unit) {
    const id = tag + '|' + unit;
    if (seriesCache.has(id)) return seriesCache.get(id);
    const latest = new Map();
    for (const f of gaap[tag]?.units?.[unit] || []) {
      if (typeof f?.end !== 'string' || typeof f.val !== 'number' || !Number.isFinite(f.val)) continue;
      const key = (f.start || '') + '|' + f.end;
      let rec = latest.get(key);
      if (!rec) { rec = { start: f.start ? ms(f.start) : null, end: f.end, val: null, filed: '', accn: '', forms: new Set(), firstFiled: '9999', firstFy: null, firstForm: null }; latest.set(key, rec); }
      const filed = String(f.filed || ''), accn = String(f.accn || '');
      rec.forms.add(f.form);
      // The filing that first carried a period is the one whose financial year names it.
      if (filed < rec.firstFiled) { rec.firstFiled = filed; rec.firstFy = f.fy; rec.firstForm = f.form; }
      if (rec.val === null || filed > rec.filed || (filed === rec.filed && accn > rec.accn)) { rec.val = f.val; rec.filed = filed; rec.accn = accn; }
    }
    const byEnd = new Map();
    for (const f of latest.values()) {
      f.days = f.start === null ? 0 : Math.round((ms(f.end) - f.start) / DAY) + 1;
      if (!byEnd.has(f.end)) byEnd.set(f.end, []);
      byEnd.get(f.end).push(f);
    }
    seriesCache.set(id, byEnd);
    return byEnd;
  }

  const unitOf = (row) => UNIT[row] || 'USD';
  const instant = (tag, unit, end) => (series(tag, unit).get(end) || []).find((f) => f.start === null) || null;
  const span = (tag, unit, start, end, lo, hi) => (series(tag, unit).get(end) || []).find((f) => f.start !== null && Math.abs(f.start - start) <= NEAR && f.days >= lo && f.days <= hi) || null;

  // --- The company's calendar, from the periods it has actually reported -------------------
  const spans = new Map(); // start|end -> { start, end, days, count, annualForm, firstFiled, firstFy }
  for (const row of ['revenue', 'netIncome', 'operatingIncome', 'operatingCashFlow']) {
    for (const tag of CONCEPTS[row]) {
      for (const list of series(tag, 'USD').values()) {
        for (const f of list) {
          if (f.start === null) continue;
          const key = f.start + '|' + f.end;
          const s = spans.get(key) || { start: f.start, end: f.end, days: f.days, count: 0, annualForm: false, firstFiled: '9', firstFy: null };
          s.count += 1;
          if ([...f.forms].some((x) => ANNUAL_FORMS.has(x))) s.annualForm = true;
          if (f.firstFiled < s.firstFiled && ANNUAL_FORMS.has(f.firstForm)) { s.firstFiled = f.firstFiled; s.firstFy = f.firstFy; }
          spans.set(key, s);
        }
      }
    }
  }
  const all = [...spans.values()];
  const best = (list) => list.sort((a, b) => b.count - a.count)[0] || null;

  // Financial years: spans of about a year that appeared in an annual report, newest first.
  const yearByEnd = new Map();
  for (const s of all) {
    if (s.days < 350 || s.days > 380 || !s.annualForm) continue;
    const cur = yearByEnd.get(s.end);
    if (!cur || s.count > cur.count) yearByEnd.set(s.end, s);
  }
  const years = [];
  for (const s of [...yearByEnd.values()].sort((a, b) => (a.end < b.end ? 1 : -1))) {
    // A second "year" ending within months of one already taken is a change of year-end;
    // only the newer is kept.
    if (years.length && ms(years[years.length - 1].end) - ms(s.end) < 300 * DAY) continue;
    years.push({ start: s.start, end: s.end, firstFy: s.firstFy });
  }
  if (!years.length) return { annual: null, quarterly: null, reason: 'No annual report with structured financial data has been filed yet.' };
  // The newest year is named by the report that first carried it; older ones count back.
  const newestFy = Number.isInteger(years[0].firstFy) ? years[0].firstFy : Number(years[0].end.slice(0, 4));
  for (const y of years) y.fy = newestFy - Math.round((ms(years[0].end) - ms(y.end)) / (365.25 * DAY));
  // The year now under way, if anything has been reported for it.
  const openStart = ms(years[0].end) + DAY;
  const open = { start: openStart, end: null, fy: newestFy + 1 };
  const grid = all.some((s) => Math.abs(s.start - openStart) <= NEAR && s.days < 350) ? [open, ...years] : years.slice();

  // Quarter ends inside a year: where its year-to-date spans of about 3, 6 and 9 months stop.
  const BUCKET = [[80, 100], [170, 190], [260, 285]];
  for (const y of grid) {
    const mine = all.filter((s) => Math.abs(s.start - y.start) <= NEAR);
    y.q = BUCKET.map(([lo, hi]) => best(mine.filter((s) => s.days >= lo && s.days <= hi))?.end || null);
    y.q.push(y.end);
  }

  // --- Values -------------------------------------------------------------------------------
  // A flow for quarter k (1..4) of year y under one tag: reported directly, or the gap
  // between two year-to-date figures, or (the fourth) the year less the first three.
  function quarterFlow(tag, unit, y, k, additive) {
    const end = y.q[k - 1];
    if (!end) return null;
    const startOf = (j) => (j === 1 ? y.start : y.q[j - 2] ? ms(y.q[j - 2]) + DAY : null);
    const cum = (j) => (y.q[j - 1] ? span(tag, unit, y.start, y.q[j - 1], ...(j === 4 ? [350, 380] : BUCKET[j - 1])) : null);
    const st = startOf(k);
    const direct = st === null ? null : span(tag, unit, st, end, 80, 100);
    if (direct) return { val: direct.val, derived: false };
    if (!additive || k === 1) return null;
    const a = cum(k), b = cum(k - 1);
    if (a && b) return { val: a.val - b.val, derived: true };
    if (k === 4 && a) {
      let sum = 0;
      for (let j = 1; j <= 3; j++) { const q = quarterFlow(tag, unit, y, j, true); if (!q) return null; sum += q.val; }
      return { val: a.val - sum, derived: true };
    }
    return null;
  }
  const firstTag = (tags, fn) => { for (const tag of tags) { const v = fn(tag); if (v) return v; } return null; };

  function valueAt(tags, unit, period, isInstant, additive) {
    if (!period.end) return null;
    if (isInstant) { const f = firstTag(tags, (tag) => instant(tag, unit, period.end)); return f ? { val: f.val, derived: false } : null; }
    if (period.k === 0) { const f = firstTag(tags, (tag) => span(tag, unit, period.y.start, period.end, 350, 380)); return f ? { val: f.val, derived: false } : null; }
    return firstTag(tags, (tag) => quarterFlow(tag, unit, period.y, period.k, additive));
  }

  function table(periods) {
    const values = {}, derived = {};
    const cell = (tags, unit, p, isInstant, additive) => valueAt(tags, unit, p, isInstant, additive);
    for (const [row, tags] of Object.entries(CONCEPTS)) {
      const cells = periods.map((p) => cell(tags, unitOf(row), p, INSTANT.has(row), !NOT_ADDITIVE.has(row)));
      values[row] = cells.map((c) => (c ? c.val : null));
      derived[row] = cells.map((c) => Boolean(c?.derived));
    }
    const hasBetween = BETWEEN.some((tag) => gaap[tag]);
    periods.forEach((p, i) => {
      const set = (row, val, isDerived = true) => { values[row][i] = val; derived[row][i] = isDerived; };
      const v = (row) => values[row][i];
      // Gross profit, where the company gives revenue and its cost but not the difference.
      if (v('grossProfit') === null && v('revenue') !== null && v('costOfRevenue') !== null) set('grossProfit', v('revenue') - v('costOfRevenue'));
      // Selling and marketing plus general and administrative, where reported separately.
      if (v('sellingGeneralAdmin') === null) {
        const sm = cell(EXTRA.sellingAndMarketing, 'USD', p, false, true), ga = cell(EXTRA.generalAndAdmin, 'USD', p, false, true);
        if (sm && ga) set('sellingGeneralAdmin', sm.val + ga.val);
      }
      // Total liabilities, which many companies leave readers to work out. Only done when
      // total equity including outside shareholders is known and nothing sits in between.
      if (v('totalLiabilities') === null && v('liabilitiesAndEquity') !== null) {
        const whole = cell(EXTRA.equityWithMinority, 'USD', p, true, false);
        const equity = whole ? whole.val : (!hasBetween ? v('equity') : null);
        if (equity !== null && !BETWEEN.slice(0, 3).some((tag) => gaap[tag])) set('totalLiabilities', v('liabilitiesAndEquity') - equity);
      }
      const paid = v('capex');
      values.freeCashFlow = values.freeCashFlow || periods.map(() => null);
      derived.freeCashFlow = derived.freeCashFlow || periods.map(() => false);
      if (paid !== null) {
        values.capex[i] = -paid;
        if (v('operatingCashFlow') !== null) { values.freeCashFlow[i] = v('operatingCashFlow') - paid; derived.freeCashFlow[i] = derived.operatingCashFlow[i] || derived.capex[i]; }
      }
    });
    return { values, derived };
  }

  const annualPeriods = years.slice(0, maxAnnual).map((y) => ({ y, k: 0, end: y.end, label: 'FY' + y.fy }));
  const quarterPeriods = [];
  for (const y of grid) for (let k = 4; k >= 1; k--) if (y.q[k - 1]) quarterPeriods.push({ y, k, end: y.q[k - 1], label: `Q${k} FY${y.fy}` });
  // Leading quarters with nothing in them (a year-end whose report is not in yet) are dropped.
  const anchorRows = ['revenue', 'netIncome', 'totalAssets'];
  const filled = (p) => anchorRows.some((row) => valueAt(CONCEPTS[row], 'USD', p, INSTANT.has(row), true));
  while (quarterPeriods.length && !filled(quarterPeriods[0])) quarterPeriods.shift();
  quarterPeriods.length = Math.min(quarterPeriods.length, maxQuarterly);

  const shape = (periods) => {
    const t = table(periods);
    return shapeStatement(periods.map((p) => p.label), t.values, { derived: t.derived, dropEmpty: true, periodEnds: periods.map((p) => p.end) });
  };
  return { annual: shape(annualPeriods), quarterly: shape(quarterPeriods), reason: null };
}

// The latest reading of a "document and entity information" figure, such as shares outstanding.
export function latestDei(companyFacts, tag, unit) {
  let bestFact = null;
  for (const f of companyFacts?.facts?.dei?.[tag]?.units?.[unit] || []) {
    if (typeof f?.val !== 'number' || typeof f.end !== 'string') continue;
    if (!bestFact || f.end > bestFact.end || (f.end === bestFact.end && String(f.filed) > String(bestFact.filed))) bestFact = f;
  }
  return bestFact ? { value: bestFact.val, asOf: bestFact.end } : null;
}

// Finds a row (top level or child) in a shaped statement.
export function findRow(statement, key) {
  for (const part of ['income', 'balance', 'cashflow']) {
    for (const r of statement?.[part] || []) {
      if (r.key === key) return r;
      for (const c of r.children || []) if (c.key === key) return c;
    }
  }
  return null;
}
