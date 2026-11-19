// The rows of the three financial statements, in the order they are shown. Demo and live
// data both fill this one layout, so the page is built once.
//
// `flow` rows cover a span of time (a quarter or a year); the others are a reading on one
// day (the balance sheet). `computed` rows are worked out here, not reported by the company,
// and say so in their label.

const usd = (key, label, extra = {}) => ({ key, label, unit: 'USD', ...extra });

export const LAYOUT = {
  income: [
    usd('revenue', 'Revenue'),
    usd('costOfRevenue', 'Cost of revenue'),
    usd('grossProfit', 'Gross profit'),
    usd('operatingExpenses', 'Operating expenses', { children: [
      usd('researchAndDevelopment', 'Research and development'),
      usd('sellingGeneralAdmin', 'Selling, general and administrative')
    ] }),
    usd('operatingIncome', 'Operating income'),
    usd('otherIncomeExpense', 'Other income and expense, net', { optional: true }),
    usd('pretaxIncome', 'Income before tax'),
    usd('incomeTax', 'Income tax'),
    usd('netIncome', 'Net income'),
    { key: 'epsBasic', label: 'Earnings per share, basic', unit: 'USD/share' },
    { key: 'epsDiluted', label: 'Earnings per share, diluted', unit: 'USD/share' },
    { key: 'sharesBasic', label: 'Weighted average shares, basic', unit: 'shares' },
    { key: 'sharesDiluted', label: 'Weighted average shares, diluted', unit: 'shares' }
  ],
  balance: [
    usd('totalCurrentAssets', 'Total current assets', { children: [
      usd('cash', 'Cash and cash equivalents'),
      usd('receivables', 'Accounts receivable'),
      usd('inventory', 'Inventory'),
      usd('otherCurrentAssets', 'Other current assets')
    ] }),
    usd('ppe', 'Property, plant and equipment, net'),
    usd('otherNonCurrentAssets', 'Other long-term assets', { optional: true }),
    usd('totalAssets', 'Total assets'),
    usd('totalCurrentLiabilities', 'Total current liabilities', { children: [
      usd('payables', 'Accounts payable'),
      usd('debtCurrent', 'Current portion of long-term debt'),
      usd('otherCurrentLiabilities', 'Other current liabilities')
    ] }),
    usd('longTermDebt', 'Long-term debt, excluding current portion'),
    usd('otherNonCurrentLiabilities', 'Other long-term liabilities', { optional: true }),
    usd('totalLiabilities', 'Total liabilities'),
    usd('equity', 'Shareholders’ equity'),
    usd('liabilitiesAndEquity', 'Total liabilities and equity')
  ],
  cashflow: [
    usd('operatingCashFlow', 'Cash from operating activities'),
    usd('investingCashFlow', 'Cash from investing activities', { children: [
      usd('capex', 'Capital expenditure'),
      usd('otherInvesting', 'Other investing')
    ] }),
    usd('financingCashFlow', 'Cash from financing activities'),
    usd('netChangeInCash', 'Net change in cash', { optional: true }),
    usd('freeCashFlow', 'Free cash flow (computed: operating cash flow minus capital expenditure)', { computed: true })
  ]
};

export const ROW_KEYS = Object.values(LAYOUT).flatMap((rows) => rows.flatMap((r) => [r.key, ...(r.children || []).map((c) => c.key)]));

// Turns `values[key] = [one number or null per period]` into the statement the page expects.
// `derived[key]`, where given, marks the values that were worked out from others (a fourth
// quarter taken as the year minus three quarters). Child rows with nothing in them are left
// out when `dropEmpty` is set, so a company that does not report inventory has no blank line.
export function shapeStatement(periods, values, { derived = {}, labels = {}, dropEmpty = false, periodEnds = null } = {}) {
  const blank = periods.map(() => null);
  const row = (def) => {
    const out = { key: def.key, label: labels[def.key] || def.label, unit: def.unit, values: values[def.key] || blank.slice() };
    if (def.computed) out.computed = true;
    if (derived[def.key]?.some(Boolean)) out.derived = derived[def.key];
    if (def.children) {
      const kids = def.children.map(row).filter((k) => !dropEmpty || k.values.some((v) => v !== null));
      if (kids.length) out.children = kids;
    }
    return out;
  };
  const out = { periods };
  if (periodEnds) out.periodEnds = periodEnds;
  // Rows marked optional are residual lines that only some sources can fill.
  for (const [name, rows] of Object.entries(LAYOUT)) out[name] = rows.map(row).filter((r, i) => !(dropEmpty && rows[i].optional && r.values.every((v) => v === null)));
  return out;
}
