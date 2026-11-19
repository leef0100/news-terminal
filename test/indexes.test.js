// Halftone indexes (`/api/indexes`): the arithmetic with exact numbers, "not connected"
// when inputs are missing, the collectors against stand-in upstreams, the router, and the
// demo's internal consistency. Nothing here touches the network: every upstream is a
// function returning a payload modelled on the documented shape of the real one (see
// docs/INDEX-METHODS.md for which shapes were seen live).
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { equalWeighted, weightedRelatives, calendarQuarter, quarterEnd, quarterTable, trailingFour, growth, rebase, monthlyMean, changeOver } from '../src/indexes/math.js';
import { createIndexes, loadConfig } from '../src/indexes/index.js';
import { createCloudPrices, createEnergyInputs, createMemoryStore, createCryptoInputs } from '../src/indexes/live.js';
import { createTradfi } from '../src/tradfi/index.js';

const quiet = { warn() {}, log() {}, error() {} };
const NOW = Date.UTC(2026, 10, 19, 16, 0, 0);
const near = (a, b, eps = 1e-9) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);
const pts = (start, values) => values.map((v, i) => (v === null ? null : { t: `2026-01-0${start + i}`, v })).filter(Boolean);
const json = (data, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: { get: () => null }, text: async () => JSON.stringify(data), json: async () => data });
const offline = async () => { throw new Error('no network in tests'); };

async function serve(options) {
  const indexes = createIndexes({ log: quiet, now: () => NOW, fetchImpl: offline, autoCollect: false, ...options });
  const app = express();
  app.use('/api/indexes', indexes.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/indexes${path}`);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { indexes, get, close: () => { indexes.stop(); return new Promise((r) => server.close(r)); } };
}

// ---------------------------------------------------------------------------------------
test('equal weighting: the index moves by the plain average of the members’ returns', () => {
  const r = equalWeighted([{ id: 'A', points: pts(1, [100, 110, 121]) }, { id: 'B', points: pts(1, [50, 50, 55]) }]);
  assert.deepEqual(r.days, ['2026-01-01', '2026-01-02', '2026-01-03']);
  // Day 2: +10% and 0% average +5%. Day 3: +10% and +10%.
  near(r.levels[0], 100); near(r.levels[1], 105); near(r.levels[2], 115.5);
  assert.deepEqual(r.active, [0, 2, 2]);
  // A added 5 points on day 2 and 5.25 on day 3; B added 0 and 5.25. Together: the index's 15.5.
  near(r.cum.A[2], 10.25); near(r.cum.B[2], 5.25);
  near(r.cum.A[2] + r.cum.B[2], r.levels[2] - r.levels[0]);
  assert.equal(r.baseDate, '2026-01-01');
});

test('rebasing: 100 on the base date, or on the first day if the base date is earlier', () => {
  const members = [{ id: 'A', points: pts(1, [100, 110, 121]) }, { id: 'B', points: pts(1, [50, 50, 55]) }];
  const r = equalWeighted(members, { baseDate: '2026-01-02' });
  near(r.levels[1], 100); near(r.levels[0], 100 / 1.05); near(r.levels[2], 110);
  // Contributions are scaled with the index, so they still add up to its move.
  near(r.cum.A[2] + r.cum.B[2], r.levels[2] - r.levels[0]);
  assert.equal(r.baseDate, '2026-01-02');
  assert.equal(equalWeighted(members, { baseDate: '2020-06-01' }).baseDate, '2026-01-01');
  near(equalWeighted(members, { baseDate: '2020-06-01', base: 1000 }).levels[2], 1155);
  near(rebase([null, 4, 5, null, 8])[4], 200);
  assert.equal(rebase([null, 4, 5])[0], null);
});

test('a constituent with missing days is left out, and its whole move arrives when it returns', () => {
  const r = equalWeighted([{ id: 'A', points: pts(1, [100, 110, 121]) }, { id: 'B', points: pts(1, [50, null, 55]) }]);
  // Day 2: only A (+10%). Day 3: A +10% and B 55/50 = +10% since its last close.
  near(r.levels[1], 110); near(r.levels[2], 121);
  assert.deepEqual(r.active, [0, 1, 2]);
  near(r.cum.B[1], 0); near(r.cum.B[2], 110 * 0.1 / 2);
  // With a floor of two active members the thin day is not shown at all, and nothing is lost:
  // on day 3 both are measured from day 1 (A +21%, B +10%).
  const strict = equalWeighted([{ id: 'A', points: pts(1, [100, 110, 121]) }, { id: 'B', points: pts(1, [50, null, 55]) }], { minActive: 2 });
  assert.deepEqual(strict.days, ['2026-01-01', '2026-01-03']);
  near(strict.levels[1], 100 * (1 + (0.21 + 0.10) / 2));
  // Values that are not prices are ignored.
  near(equalWeighted([{ id: 'A', points: [{ t: '2026-01-01', v: 10 }, { t: '2026-01-02', v: 0 }, { t: '2026-01-03', v: NaN }, { t: '2026-01-04', v: 11 }] }]).levels[1], 110);
});

test('a constituent that starts later joins from its second day', () => {
  const r = equalWeighted([{ id: 'A', points: pts(1, [100, 100, 110, 110]) }, { id: 'B', points: pts(1, [200, 200, 220, 242]) }, { id: 'C', points: pts(2, [10, 12, 12]) }]);
  // Day 2: C has only its starting point. Day 3: +10%, +10%, +20% average +13.33%. Day 4: 0, +10%, 0.
  assert.deepEqual(r.active, [0, 2, 3, 3]);
  near(r.levels[1], 100); near(r.levels[2], 100 * (1 + 0.4 / 3)); near(r.levels[3], r.levels[2] * (1 + 0.1 / 3));
  near(r.cum.C[1], 0); near(r.cum.C[2], 100 * 0.2 / 3);
  near(r.cum.A[3] + r.cum.B[3] + r.cum.C[3], r.levels[3] - 100);
  // The index waits for enough members before it starts.
  const late = equalWeighted([{ id: 'A', points: pts(1, [100, 100, 110]) }, { id: 'C', points: pts(2, [10, 12]) }], { minActive: 2 });
  assert.equal(late.start, '2026-01-02');
  near(late.levels[1], 115);
  assert.deepEqual(equalWeighted([], {}).days, []);
});

test('fixed-weight relatives: each component against its own base value', () => {
  const r = weightedRelatives([
    { id: 'power', weight: 0.5, points: [{ t: '2023-01-01', v: 8 }, { t: '2023-02-01', v: 8.8 }, { t: '2023-03-01', v: 8 }] },
    { id: 'gas', weight: 0.5, points: [{ t: '2023-01-01', v: 4 }, { t: '2023-02-01', v: 3 }, { t: '2023-04-01', v: 9 }] }
  ], { baseT: '2023-01-01' });
  // Only the months both have. February: half of 1.10 plus half of 0.75.
  assert.deepEqual(r.days, ['2023-01-01', '2023-02-01']);
  near(r.levels[0], 100); near(r.levels[1], 92.5);
  near(r.parts.power[1], 55); near(r.parts.gas[1], 37.5);
  // Weights are scaled to sum to one; a base date that is not there falls back to the first shared one.
  const other = weightedRelatives([{ id: 'a', weight: 3, points: [{ t: 'x1', v: 2 }, { t: 'x2', v: 4 }] }, { id: 'b', weight: 1, points: [{ t: 'x1', v: 5 }, { t: 'x2', v: 5 }] }], { baseT: 'x0' });
  assert.equal(other.baseT, 'x1'); near(other.levels[1], 175); near(other.weights.a, 0.75);
  assert.deepEqual(weightedRelatives([{ id: 'a', weight: 1, points: [] }]).days, []);
});

test('quarters are placed in the calendar quarter that holds the middle of the period', () => {
  assert.equal(calendarQuarter('2026-09-30'), '2026-Q3');
  assert.equal(calendarQuarter('2026-08-31'), '2026-Q3'); // June to August
  assert.equal(calendarQuarter('2026-11-30'), '2026-Q4'); // September to November
  assert.equal(calendarQuarter('2026-10-26'), '2026-Q3'); // August to October
  assert.equal(calendarQuarter('2026-01-25'), '2025-Q4'); // November to January
  assert.equal(calendarQuarter('not a date'), null);
  assert.equal(quarterEnd('2026-Q3'), '2026-09-30'); assert.equal(quarterEnd('2025-Q4'), '2025-12-31'); assert.equal(quarterEnd('2026-Q1'), '2026-03-31');
});

test('capital spending: totals only when every company reported, trailing four quarters, year over year', () => {
  const ends = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31', '2026-06-30', '2026-09-30'];
  const offEnds = ['2025-02-28', '2025-05-31', '2025-08-31', '2025-11-30', '2026-02-28', '2026-05-31'];
  const t = quarterTable([
    { id: 'A', quarters: ends.map((end, i) => ({ end, value: [10, 12, 14, 16, 18, 20, 22][i] })) },
    { id: 'B', quarters: offEnds.map((end, i) => ({ end, value: [1, 2, 3, 4, 5, 6][i] })) }
  ]);
  assert.deepEqual(t.quarters, ['2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3']);
  assert.deepEqual(t.values.B, [1, 2, 3, 4, 5, 6, null]);
  // B has not reported the last quarter, so it has no total: 22 alone would look like a collapse.
  assert.deepEqual(t.totals, [11, 14, 17, 20, 23, 26, null]);
  const trailing = trailingFour(t.totals);
  assert.deepEqual(trailing, [null, null, null, 62, 74, 86, null]);
  const yoy = growth(t.totals, 4);
  assert.equal(yoy[3], null);
  near(yoy[4], (23 / 11 - 1) * 100); near(yoy[5], (26 / 14 - 1) * 100);
  assert.equal(yoy[6], null);
  assert.deepEqual(rebase(trailing).map((v) => (v === null ? null : Number(v.toFixed(4)))), [null, null, null, 100, 119.3548, 138.7097, null]);
  // A gap inside a company's history is kept as a gap, and breaks the trailing sums that span it.
  const gap = quarterTable([{ id: 'A', quarters: [{ end: '2025-03-31', value: 1 }, { end: '2025-09-30', value: 3 }, { end: '2025-12-31', value: 4 }, { end: '2026-03-31', value: 5 }, { end: '2026-06-30', value: 6 }] }]);
  assert.deepEqual(gap.values.A, [1, null, 3, 4, 5, 6]);
  assert.deepEqual(trailingFour(gap.values.A), [null, null, null, null, null, 18]);
  assert.deepEqual(growth([0, 1, 2, 3, 4], 4), [null, null, null, null, null]); // growth from nothing is not a percentage
});

test('monthly averages and changes over a period', () => {
  assert.deepEqual(monthlyMean([{ t: '2026-01-02', v: 2 }, { t: '2026-01-05', v: 4 }, { t: '2026-02-02', v: 3 }, { t: '2026-02-03', v: null }]), [{ t: '2026-01-01', v: 3, n: 2 }, { t: '2026-02-01', v: 3, n: 1 }]);
  const daily = [{ t: '2025-11-19', v: 80 }, { t: '2026-10-19', v: 100 }, { t: '2026-11-18', v: 108 }, { t: '2026-11-19', v: 110 }];
  near(changeOver(daily, 30), 10); near(changeOver(daily, 365), 37.5);
  // Not quoted when the history does not reach, or the nearest earlier point is too old.
  assert.equal(changeOver(daily.slice(1), 365), null);
  assert.equal(changeOver([{ t: '2025-06-01', v: 50 }, { t: '2026-11-19', v: 100 }], 365), null);
  assert.equal(changeOver([{ t: '2026-11-19', v: 100 }], 30), null);
});

// ---------------------------------------------------------------------------------------
test('with nothing connected every index says why, and none has a value except the dated price table', async () => {
  const tradfi = createTradfi({ env: {}, fetchImpl: offline, log: quiet, now: () => NOW });
  const s = await serve({ env: { INDEXES_CLOUD_PRICES: 'off' }, tradfi: tradfi.backend, hl: null });
  try {
    const r = await s.get('/');
    assert.equal(r.status, 200);
    assert.equal(r.body.demo, false);
    assert.equal(r.body.label, 'Halftone index, not an official benchmark');
    const by = Object.fromEntries(r.body.indexes.map((i) => [i.id, i]));
    assert.deepEqual(Object.keys(by), ['inference', 'gpu-demand', 'energy', 'compute', 'data-center', 'capex', 'semis', 'ai-crypto']);
    for (const id of ['gpu-demand', 'energy', 'compute', 'data-center', 'capex', 'semis', 'ai-crypto']) {
      assert.equal(by[id].state, 'off', id);
      assert.equal(by[id].value, null, id);
      assert.deepEqual(by[id].spark, [], id);
      assert.match(by[id].note, /^Not connected: /, id);
    }
    assert.match(by.capex.note, /SEC_USER_AGENT/);
    assert.match(by.energy.note, /EIA_KEY/); assert.match(by.energy.note, /FRED_KEY/);
    assert.match(by['data-center'].note, /TWELVEDATA_KEY/);
    assert.match(by.compute.note, /INDEXES_CLOUD_PRICES/);
    // The one index that needs no key is a dated, hand-entered table, and says so.
    assert.equal(by.inference.state, 'ok');
    assert.equal(by.inference.value, 100);
    assert.match(by.inference.note, /Published list prices as of 2026-11-19/);
    assert.ok(r.body.sources.some((x) => x.name === 'SEC EDGAR' && x.state === 'off'));

    const one = await s.get('/series?id=semis&range=1y');
    assert.equal(one.status, 200);
    assert.equal(one.body.state, 'off');
    assert.deepEqual(one.body.series, []);
    assert.equal(one.body.value, null);
    assert.ok(one.body.constituents.length === 10 && one.body.constituents.every((c) => c.state === 'missing' && c.contributionPts === null && c.weightPct === null));
    assert.ok(one.body.method.length >= 3 && one.body.limits.length >= 2);

    const capex = await s.get('/capex');
    assert.equal(capex.status, 200);
    assert.equal(capex.body.state, 'off');
    assert.deepEqual(capex.body.quarters, []);
    assert.ok(capex.body.companies.every((c) => c.state === 'missing'));

    const inf = (await s.get('/series?id=inference&range=max')).body;
    assert.equal(inf.series.length, 1);
    const table = inf.tables[0];
    assert.match(table.title, /Published list prices as of 2026-11-19/);
    assert.ok(table.rows.length >= 6 && table.rows.every((row) => /^https:\/\//.test(row[5].url) && row[2] > 0 && row[3] > 0));
    // Three parts input, one part output: $2 in and $10 out is $4.
    const row = table.rows.find((x) => x[2] === 2 && x[3] === 10);
    assert.equal(row[4], 4);
    assert.deepEqual(s.indexes.health().sources.map((x) => [x.name, x.state]), [['US Energy Information Administration', 'off'], ['FRED (energy prices)', 'off'], ['Azure retail prices', 'off']]);
  } finally { await s.close(); tradfi.stop(); }
});

test('share baskets use exchange closes only, wait for every constituent, and drop what has no price', async () => {
  const closes = (k) => ({ interval: '1d', kind: 'stock', source: 'Test feed', delayed: false, candles: [100, 110, 121].map((c, i) => ({ time: Date.UTC(2026, 10, 16 + i) / 1000, close: c * k })), sources: [{ name: 'Test feed', state: 'ok', note: '' }] });
  const config = loadConfig();
  const basket = config.indexes.find((d) => d.id === 'semis');
  basket.constituents = ['AAA', 'BBB', 'CCC', 'DDD'].map((symbol) => ({ symbol, name: symbol + ' Inc.', reason: 'Test.' }));
  basket.minConstituents = 2; basket.baseDate = '2026-11-16';
  let mode = 'limited';
  const tradfi = {
    async candles(symbol) {
      if (symbol === 'DDD') throw Object.assign(new Error('Unknown symbol'), { status: 400 });
      if (symbol === 'CCC' && mode === 'limited') return { candles: [], sources: [{ name: 'Test feed', state: 'error', note: 'Test feed is at its request limit. Try again shortly.' }] };
      if (symbol === 'CCC') return { ...closes(1), kind: 'perp', source: 'Hyperliquid perpetual (xyz:CCC)' };
      return closes(symbol === 'AAA' ? 1 : 2);
    },
    async company() { return { statements: null, sources: [{ name: 'SEC EDGAR', state: 'off', note: 'Set SEC_USER_AGENT.' }] }; }
  };
  let clock = NOW;
  const s = await serve({ env: { INDEXES_CLOUD_PRICES: 'off' }, tradfi, hl: null, config, now: () => clock });
  try {
    // One constituent could not be read yet: no value is shown from the other two.
    let r = (await s.get('/series?id=semis&range=max')).body;
    assert.equal(r.state, 'pending');
    assert.match(r.note, /2 of 4 companies so far/);
    assert.deepEqual(r.series, []);
    // Later it turns out only a perpetual is connected for it, and one ticker is unknown: both are left out and named.
    mode = 'perp'; clock += 60000;
    r = (await s.get('/series?id=semis&range=max')).body;
    assert.equal(r.state, 'ok');
    assert.match(r.note, /Left out for lack of prices: CCC, DDD/);
    assert.deepEqual(r.series.map((p) => [p.t, p.v, p.r]), [['2026-11-16', 100, 100], ['2026-11-17', 110, 110], ['2026-11-18', 121, 121]]);
    assert.equal(r.changePct, 21);
    const by = Object.fromEntries(r.constituents.map((c) => [c.id, c]));
    assert.equal(by.AAA.contributionPts, 10.5); assert.equal(by.BBB.contributionPts, 10.5); assert.equal(by.AAA.weightPct, 50);
    assert.equal(by.CCC.state, 'missing'); assert.match(by.CCC.note, /perpetual/); assert.equal(by.CCC.contributionPts, null);
    assert.match(by.DDD.note, /No listed company has this ticker/);
    assert.equal(r.inputs[0].source, 'Test feed'); assert.equal(r.inputs[0].asOf, '2026-11-18');
    assert.equal(r.change.d1, 10);
    // A shorter range is rebased to its own start, and contributions follow it.
    const short = (await s.get('/series?id=semis&range=1m')).body;
    assert.equal(short.series.length, 3);
  } finally { await s.close(); }
});

test('capital spending and GPU demand from SEC statements, by calendar quarter', async () => {
  const ends = ['2026-09-30', '2026-06-30', '2026-03-31', '2025-12-31', '2025-09-30', '2025-06-30', '2025-03-31', '2024-12-31'];
  const company = (name, capex, revenue, periodEnds = ends) => ({
    name, sources: [{ name: 'SEC EDGAR', state: 'ok', note: '' }],
    statements: { quarterly: { periods: periodEnds.map((_, i) => 'Q' + i), periodEnds, income: [{ key: 'revenue', values: revenue }], cashflow: [{ key: 'operatingCashFlow', values: [], children: [{ key: 'capex', values: capex.map((v) => (v === null ? null : -v)), derived: capex.map((_, i) => i === 3) }] }] } }
  });
  const flat = (v) => ends.map(() => v);
  const book = {
    // newest first, as the stocks module returns them
    MSFT: company('Microsoft Corp', [80, 70, 60, 50, 40, 35, 30, 25], flat(100)),
    GOOGL: company('Alphabet Inc.', [20, 20, 20, 20, 20, 20, 20, 20], flat(100)),
    AMZN: company('Amazon.com Inc', flat(10), flat(100)), META: company('Meta Platforms', flat(10), flat(100)),
    // A year that ends in May: the quarter to 31 August counts as the third calendar quarter.
    ORCL: company('Oracle Corp', flat(5), flat(100), ['2026-08-31', '2026-05-31', '2026-02-28', '2025-11-30', '2025-08-31', '2025-05-31', '2025-02-28', '2024-11-30']),
    NVDA: company('NVIDIA', flat(1), [60, 50, 40, 30, 20, 20, 20, 20]), AMD: company('AMD', flat(1), flat(10)), AVGO: company('Broadcom', flat(1), flat(10)), MU: company('Micron', flat(1), flat(10))
  };
  const tradfi = { async company(symbol) { return { symbol, ...book[symbol] }; }, async candles() { return { candles: [], sources: [{ name: 'Twelve Data', state: 'off', note: 'Set TWELVEDATA_KEY.' }] }; } };
  const s = await serve({ env: { INDEXES_CLOUD_PRICES: 'off' }, tradfi, hl: null });
  try {
    const c = (await s.get('/capex')).body;
    assert.equal(c.state, 'ok');
    assert.deepEqual(c.quarters, ['2024-Q4', '2025-Q1', '2025-Q2', '2025-Q3', '2025-Q4', '2026-Q1', '2026-Q2', '2026-Q3']);
    assert.deepEqual(c.values.MSFT, [25, 30, 35, 40, 50, 60, 70, 80]);
    assert.deepEqual(c.values.ORCL, [5, 5, 5, 5, 5, 5, 5, 5]);
    assert.deepEqual(c.totals, [70, 75, 80, 85, 95, 105, 115, 125]);
    assert.deepEqual(c.trailing, [null, null, null, 310, 335, 365, 400, 440]);
    assert.deepEqual(c.yoy.slice(0, 4), [null, null, null, null]);
    assert.equal(c.yoy[4], Number(((95 / 70 - 1) * 100).toFixed(2)));
    assert.equal(c.yoy[7], Number(((125 / 85 - 1) * 100).toFixed(2)));
    assert.equal(c.companyYoy.MSFT[7], 100);
    assert.equal(c.trailingYoy[7], Number(((440 / 310 - 1) * 100).toFixed(2)));
    assert.deepEqual(c.index, [null, null, null, 100, 108.06, 117.74, 129.03, 141.94]);
    assert.equal(c.derived.MSFT[4], true); assert.equal(c.derived.MSFT[3], false);
    assert.equal(c.companies[0].name, 'Microsoft Corp');

    const ix = (await s.get('/series?id=capex&range=max')).body;
    assert.equal(ix.state, 'ok'); assert.equal(ix.frequency, 'quarterly');
    assert.deepEqual(ix.series.map((p) => [p.t, p.v]), [['2025-09-30', 100], ['2025-12-31', 108.0645], ['2026-03-31', 117.7419], ['2026-06-30', 129.0323], ['2026-09-30', 141.9355]]);
    assert.equal(ix.change.y1, 41.94); assert.equal(ix.change.d1, null);
    // Contributions add up to the index's move; only Microsoft's spending changed.
    const sum = ix.constituents.reduce((a, x) => a + x.contributionPts, 0);
    assert.ok(Math.abs(sum - ix.changePct) < 0.03);
    assert.equal(ix.constituents.find((x) => x.id === 'MSFT').contributionPts, 41.94);
    assert.equal(ix.constituents.find((x) => x.id === 'ORCL').contributionPts, 0);

    // GPU demand: chip makers' trailing revenue 200, 210, 230, 260, 300; capex as above; half each.
    const g = (await s.get('/series?id=gpu-demand&range=max')).body;
    assert.equal(g.state, 'ok');
    assert.deepEqual(g.series.map((p) => p.v), [100, Number(((210 / 200 + 335 / 310) * 50).toFixed(4)), Number(((230 / 200 + 365 / 310) * 50).toFixed(4)), Number(((260 / 200 + 400 / 310) * 50).toFixed(4)), Number(((300 / 200 + 440 / 310) * 50).toFixed(4))]);
    assert.deepEqual(g.constituents.map((x) => [x.id, x.weightPct]), [['suppliers', 50], ['buyers', 50]]);
    assert.equal(g.constituents[0].contributionPts, 25);
    assert.match(g.limits.join(' '), /Total company revenue, not data-center revenue/);

    // One company without figures: the table is kept, but no total and so no index.
    book.META = { name: 'Meta Platforms', statements: null, statementsNote: 'No structured data.', sources: [{ name: 'SEC EDGAR', state: 'ok', note: '' }] };
    s.indexes.engine.clear();
    const s2 = await serve({ env: { INDEXES_CLOUD_PRICES: 'off' }, tradfi, hl: null });
    try {
      const c2 = (await s2.get('/capex')).body;
      assert.ok(c2.totals.every((v) => v === null));
      assert.equal(c2.companies.find((x) => x.symbol === 'META').state, 'missing');
      const i2 = (await s2.get('/series?id=capex')).body;
      assert.equal(i2.state, 'off'); assert.match(i2.note, /none for META/); assert.equal(i2.value, null);
    } finally { await s2.close(); }
  } finally { await s.close(); }
});

test('energy index from the EIA’s documented answer shape, and from FRED when only that has a key', async () => {
  const asked = [];
  const fetchImpl = async (url) => {
    asked.push(String(url));
    const u = new URL(url);
    if (u.hostname === 'api.eia.gov' && u.pathname === '/v2/electricity/retail-sales/data/') {
      assert.equal(u.searchParams.get('facets[sectorid][]'), 'IND'); assert.equal(u.searchParams.get('facets[stateid][]'), 'US'); assert.equal(u.searchParams.get('data[0]'), 'price'); assert.equal(u.searchParams.get('frequency'), 'monthly');
      return json({ response: { total: 3, data: [{ period: '2023-01', stateid: 'US', sectorid: 'IND', price: '8.00', 'price-units': 'cents per kilowatt-hour' }, { period: '2023-02', price: '8.80' }, { period: '2023-03', price: null }] } });
    }
    if (u.hostname === 'api.eia.gov' && u.pathname === '/v2/natural-gas/pri/fut/data/') {
      assert.equal(u.searchParams.get('facets[series][]'), 'RNGWHHD'); assert.equal(u.searchParams.get('frequency'), 'daily');
      return json({ response: { data: [{ period: '2023-01-03', series: 'RNGWHHD', value: '3.00', units: '$/MMBTU' }, { period: '2023-01-04', value: '5.00' }, { period: '2023-02-01', value: '3.00' }, { period: '2023-02-02', value: 'NA' }, { period: '2023-03-01', value: '2.00' }] } });
    }
    if (u.hostname === 'api.stlouisfed.org') {
      const id = u.searchParams.get('series_id');
      return json({ observations: id === 'WPU0543' ? [{ date: '2023-01-01', value: '200.0' }, { date: '2023-02-01', value: '210.0' }] : [{ date: '2023-01-01', value: '4.00' }, { date: '2023-02-01', value: '.' }, { date: '2023-02-01', value: '3.00' }] });
    }
    return json({}, 404);
  };
  const s = await serve({ env: { EIA_KEY: 'abcdefghijklmnop1234', INDEXES_CLOUD_PRICES: 'off' }, fetchImpl });
  try {
    const r = (await s.get('/series?id=energy&range=max')).body;
    assert.equal(r.state, 'ok'); assert.equal(r.frequency, 'monthly');
    // January: power 8, gas (3+5)/2 = 4. February: power 8.8 (+10%), gas 3 (-25%): 100 x (1.10 + 0.75) / 2.
    assert.deepEqual(r.series.map((p) => [p.t, p.v]), [['2023-01-01', 100], ['2023-02-01', 92.5]]);
    assert.deepEqual(r.constituents.map((c) => [c.id, c.weightPct, c.contributionPts]), [['electricity', 50, 5], ['gas', 50, -12.5]]);
    assert.equal(r.base.t, '2023-01-01');
    assert.match(r.inputs[0].source, /Energy Information Administration/);
    assert.equal(r.facts[0].value, 2);
    assert.ok(asked.every((u) => !u.includes('stlouisfed')));
    assert.ok(!JSON.stringify(r).includes('abcdefghijklmnop1234'), 'the key never reaches a client');
    assert.equal(s.indexes.health().sources[0].state, 'ok');
  } finally { await s.close(); }
  const f = await serve({ env: { FRED_KEY: 'a'.repeat(32), INDEXES_CLOUD_PRICES: 'off' }, fetchImpl });
  try {
    const r = (await f.get('/series?id=energy&range=max')).body;
    assert.equal(r.state, 'ok');
    assert.deepEqual(r.series.map((p) => p.v), [100, Number(((210 / 200 + 3 / 4) * 50).toFixed(4))]);
    assert.match(r.note, /producer price index, not a price in cents/);
    assert.ok(r.sources.some((x) => /FRED/.test(x.name) && /not endorsed or certified/.test(x.note)));
  } finally { await f.close(); }
  // A failing source is an error, not a guess.
  const down = await serve({ env: { EIA_KEY: 'abcdefghijklmnop1234', INDEXES_CLOUD_PRICES: 'off' }, fetchImpl: async () => json({}, 500) });
  try {
    const r = await down.get('/series?id=energy');
    assert.equal(r.status, 502);
    assert.match(r.headers.get('cache-control'), /s-maxage=2/);
    assert.equal((await down.get('/')).body.indexes.find((i) => i.id === 'energy').state, 'error');
  } finally { await down.close(); }
});

test('cloud prices: one unambiguous list price per machine per day, history from the first collection', async () => {
  const def = loadConfig().indexes.find((d) => d.id === 'compute');
  const row = (armSkuName, retailPrice, extra = {}) => ({ currencyCode: 'USD', retailPrice, unitPrice: retailPrice, armRegionName: 'eastus', productName: 'Virtual Machines Test Series', skuName: 'X', meterName: 'X', serviceName: 'Virtual Machines', unitOfMeasure: '1 Hour', type: 'Consumption', armSkuName, ...extra });
  let h100 = 6.98, clock = NOW;
  const filters = [];
  const fetchImpl = async (url) => {
    const u = new URL(url);
    assert.equal(u.origin + u.pathname, 'https://prices.azure.com/api/retail/prices');
    const filter = u.searchParams.get('$filter');
    filters.push(filter);
    const sku = /armSkuName eq '([^']+)'/.exec(filter)[1];
    if (sku === 'Standard_NC40ads_H100_v5') return json({ Items: [row(sku, h100), row(sku, 12.5, { productName: 'Virtual Machines Test Series Windows' }), row(sku, 1.2, { meterName: 'X Spot' }), row(sku, 0.9, { skuName: 'X Low Priority' }), row(sku, 3, { type: 'Reservation' })], NextPageLink: null });
    if (sku === 'Standard_ND96isr_H100_v5') return json({ Items: [row(sku, 98.32)] });
    if (sku === 'Standard_NC24ads_A100_v4') return json({ Items: [row(sku, 3.67), row(sku, 3.67)] });
    if (sku === 'Standard_NC4as_T4_v3') return json({ Items: [row(sku, 0.5), row(sku, 0.6)] });       // two different prices: not used
    if (sku === 'Standard_D8s_v5') return json({ Items: [] });                                         // not in the list
    if (sku === 'Standard_D8as_v5') return json({}, 500);
    return json({ Items: [row(sku, 0.308, { armRegionName: 'westus' })] });                            // wrong region
  };
  const store = createMemoryStore();
  const cloud = createCloudPrices({ env: {}, fetchImpl, now: () => clock, store, log: quiet });
  assert.equal((await cloud.prices(def)).state, 'pending');
  await cloud.collect(def);
  assert.match(filters[0], /^armSkuName eq 'Standard_NC40ads_H100_v5' and armRegionName eq 'eastus' and priceType eq 'Consumption'$/);
  let r = await cloud.prices(def);
  assert.equal(r.state, 'ok'); assert.equal(r.started, '2026-11-19');
  const by = () => Object.fromEntries(r.items.map((i) => [i.id, i]));
  assert.deepEqual(by()['nc40ads-h100'].points, [{ t: '2026-11-19', v: 6.98 }]);
  assert.deepEqual(by()['nc24ads-a100'].points, [{ t: '2026-11-19', v: 3.67 }]);
  assert.match(by()['nc4as-t4'].note, /2 different prices matched/);
  assert.match(by()['d8s-v5'].note, /returned no pay-as-you-go Linux price/);
  assert.equal(by()['d8as-v5'].state, 'error');
  assert.equal(by()['d8ps-v5'].state, 'missing');
  // A second collection the same day replaces the day's price; the next day adds a point.
  clock += 7 * 3600000; h100 = 6.5;
  await cloud.collect(def);
  r = await cloud.prices(def);
  assert.deepEqual(by()['nc40ads-h100'].points, [{ t: '2026-11-19', v: 6.5 }]);
  clock += 24 * 3600000; h100 = 5.85;
  await cloud.collect(def);
  r = await cloud.prices(def);
  assert.deepEqual(by()['nc40ads-h100'].points, [{ t: '2026-11-19', v: 6.5 }, { t: '2026-11-20', v: 5.85 }]);
  cloud.stop();

  // Through the router: three machines priced, one of them 10% cheaper, so the index falls a third of that.
  const s = await serve({ env: {}, fetchImpl, store, now: () => clock });
  try {
    await s.indexes.collect();
    const ix = (await s.get('/series?id=compute&range=max')).body;
    assert.equal(ix.state, 'ok');
    assert.deepEqual(ix.series.map((p) => [p.t, p.v]), [['2026-11-19', 100], ['2026-11-20', Number((100 * (1 - 0.1 / 3)).toFixed(4))]]);
    assert.match(ix.history, /History starts on 2026-11-19, the day this server first collected prices/);
    assert.equal(ix.constituents.find((c) => c.id === 'nc40ads-h100').contributionPts, -3.33);
    assert.equal(ix.constituents.filter((c) => c.state === 'missing').length, 4);
    assert.equal(ix.tables[0].rows.length, 7);
  } finally { await s.close(); }
  // Turned off, or with nothing matching, there is no index.
  const off = createCloudPrices({ env: { INDEXES_CLOUD_PRICES: 'off' }, fetchImpl, now: () => clock, log: quiet });
  assert.equal((await off.prices(def)).state, 'off');
  const none = createCloudPrices({ env: {}, fetchImpl: async () => json({ Items: [] }), now: () => clock, log: quiet });
  await none.collect(def);
  r = await none.prices(def);
  assert.equal(r.state, 'off'); assert.match(r.note, /no machine in the basket matched exactly one price/);
  none.stop();
});

test('the crypto basket uses only tokens the venue lists when it is built', async () => {
  const def = loadConfig().indexes.find((d) => d.id === 'ai-crypto');
  const day = (n) => Date.UTC(2026, 10, n) / 1000;
  const hl = {
    async markets() { return [{ coin: 'TAO' }, { coin: 'RENDER' }, { coin: 'FET' }, { coin: 'BTC' }]; },
    async candles(coin, interval, bars) {
      assert.equal(interval, '1d'); assert.equal(bars, 400);
      const k = { TAO: 100, RENDER: 10, FET: 1 }[coin];
      // The last candle is today's, still trading.
      return [[16, 1], [17, coin === 'TAO' ? 1.3 : 1], [18, coin === 'TAO' ? 1.3 : 1.15], [19, 9]].map(([d, m]) => ({ time: day(d), close: k * m }));
    }
  };
  const inputs = await createCryptoInputs({ hl, now: () => NOW })(def);
  assert.deepEqual(inputs.listed.map((l) => l.coin), ['TAO', 'RENDER', 'FET']);
  assert.deepEqual(inputs.dropped, ['IO', 'GRASS', 'VIRTUAL', 'AIXBT', 'NEAR']);
  assert.ok(inputs.listed.every((l) => l.points.length === 3 && l.points[2].t === '2026-11-18'));
  const s = await serve({ env: { INDEXES_CLOUD_PRICES: 'off' }, hl });
  try {
    const r = (await s.get('/series?id=ai-crypto&range=max')).body;
    assert.equal(r.state, 'ok');
    assert.deepEqual(r.series.map((p) => p.v), [100, 110, 121]);
    assert.match(r.note, /Not listed on Hyperliquid when this was built, so left out: IO, GRASS, VIRTUAL, AIXBT, NEAR/);
    assert.equal(r.constituents.find((c) => c.id === 'IO').state, 'missing');
    assert.equal(r.constituents.find((c) => c.id === 'TAO').weightPct, 33.3);
  } finally { await s.close(); }
  // Two listed tokens are not a basket.
  const few = await serve({ env: { INDEXES_CLOUD_PRICES: 'off' }, hl: { ...hl, markets: async () => [{ coin: 'TAO' }, { coin: 'FET' }] } });
  try {
    const r = (await few.get('/series?id=ai-crypto')).body;
    assert.equal(r.state, 'off'); assert.match(r.note, /2 of the 8 named tokens/); assert.deepEqual(r.series, []);
  } finally { await few.close(); }
});

// ---------------------------------------------------------------------------------------
test('router: parameters are checked before anything is spent, and answers carry cache headers', async () => {
  let calls = 0;
  const tradfi = { async candles() { calls++; return { candles: [], sources: [] }; }, async company() { calls++; return { statements: null, sources: [] }; } };
  const s = await serve({ env: { INDEXES_CLOUD_PRICES: 'off' }, tradfi, tuning: { requestsPerMinute: 40 } });
  try {
    for (const path of ['/series', '/series?id=', '/series?id=nope', '/series?id=capex&range=2y', '/series?id=capex&id=semis', '/series?id=' + 'a'.repeat(60), '/series?id=__proto__', '/series?id=capex&range=']) {
      const r = await s.get(path);
      assert.equal(r.status, 400, path);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.equal(typeof r.body.error, 'string');
    }
    assert.match((await s.get('/series?id=nope')).body.error, /id must be one of inference, gpu-demand, energy, compute, data-center, capex, semis, ai-crypto/);
    assert.equal(calls, 0, 'a bad request costs nothing upstream');
    const r = await s.get('/');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=0, s-maxage=60');
    assert.equal(r.headers.get('cdn-cache-control'), 'public, s-maxage=60, stale-while-revalidate=60');
    assert.equal(r.body.at, NOW); assert.equal(r.body.demo, false); assert.ok(Array.isArray(r.body.sources));
    assert.equal((await s.get('/capex')).headers.get('cache-control'), 'public, max-age=0, s-maxage=300');
    assert.equal((await s.get('/series?id=capex')).body.range, '1y');
    assert.equal((await s.get('/nothing')).status, 404);
    // One address cannot ask without end.
    let limited = null;
    for (let i = 0; i < 40 && !limited; i++) { const x = await s.get('/'); if (x.status === 429) limited = x; }
    assert.ok(limited); assert.equal(limited.headers.get('cache-control'), 'no-store'); assert.ok(Number(limited.headers.get('retry-after')) > 0);
  } finally { await s.close(); }
});

test('demo: every index is present, labelled as invented, and adds up', async () => {
  const tradfi = createTradfi({ demo: true, now: () => NOW });
  const s = await serve({ demo: true, tradfi: tradfi.backend });
  try {
    const list = (await s.get('/')).body;
    assert.equal(list.demo, true);
    assert.match(list.label, /not an official benchmark\. Demo: invented figures/);
    assert.equal(list.indexes.length, 8);
    const symbols = new Set(tradfi.backend.symbols());
    for (const i of list.indexes) {
      assert.equal(i.state, 'ok', i.id);
      assert.ok(i.value > 0 && i.spark.length >= 2 && /^\d{4}-\d{2}-\d{2}$/.test(i.asOf), i.id);
      const d = (await s.get(`/series?id=${i.id}&range=max`)).body;
      assert.equal(Number(d.series[d.series.length - 1].v.toFixed(2)), i.value, i.id);
      assert.equal(d.series[0].r, 100, i.id);
      // Contributions add up to the index's move over the period (rounded to two places each).
      const counted = d.constituents.filter((c) => c.contributionPts !== null);
      assert.ok(counted.length >= 2, i.id);
      assert.ok(Math.abs(counted.reduce((a, c) => a + c.contributionPts, 0) - d.changePct) < 0.01 * counted.length + 0.01, `${i.id}: contributions sum to the change`);
      assert.ok(d.sources.every((x) => x.name === 'Demo data'), i.id);
      assert.match(d.methodNote, /^Demo: /);
      assert.ok(d.method.length >= 3 && d.limits.length >= 3 && d.inputs.length >= 1, i.id);
      // Share constituents are the stocks demo's invented companies, never real tickers.
      for (const c of d.constituents) if (c.link) assert.ok(symbols.has(c.id), c.id);
      assert.ok(!JSON.stringify(d.constituents).match(/NVDA|Microsoft|Azure|OpenAI|Anthropic|Bittensor/), i.id);
    }
    const c = (await s.get('/capex')).body;
    assert.equal(c.quarters.length, 8);
    for (let q = 0; q < 8; q++) assert.equal(c.totals[q], c.companies.reduce((a, x) => a + c.values[x.symbol][q], 0));
    for (let q = 3; q < 8; q++) assert.equal(c.trailing[q], c.totals[q] + c.totals[q - 1] + c.totals[q - 2] + c.totals[q - 3]);
    assert.equal(c.yoy[7], Number(((c.totals[7] / c.totals[3] - 1) * 100).toFixed(2)));
    const ix = (await s.get('/series?id=capex&range=max')).body;
    assert.deepEqual(ix.series.map((p) => Number(p.v.toFixed(2))), c.index.slice(3));
    // The same answer twice: the demo does not move between requests.
    assert.deepEqual((await s.get('/series?id=energy&range=max')).body.series, (await s.get('/series?id=energy&range=max')).body.series);
    // A token that is not listed and a machine without a price are shown as missing, not filled in.
    assert.equal((await s.get('/series?id=ai-crypto')).body.constituents.find((x) => x.id === 'DGONE').state, 'missing');
    assert.equal((await s.get('/series?id=compute')).body.constituents.find((x) => x.id === 'c8b').latest, null);
    assert.deepEqual(s.indexes.health().sources.map((x) => Object.keys(x)), [['name', 'state', 'note', 'lastOk', 'lastError']]);
  } finally { await s.close(); tradfi.stop(); }
});

test('the published config names every constituent with a reason, and every curated price with a link', () => {
  const config = loadConfig();
  assert.match(config.label, /^Halftone index, not an official benchmark$/);
  for (const d of config.indexes) {
    assert.ok(d.method.length >= 3 && d.limits.length >= 2 && d.summary && d.meaning, d.id);
    for (const c of d.constituents || d.companies || d.suppliers || d.candidates || d.basket || []) assert.ok((c.symbol || c.coin || c.armSkuName) && c.name && c.reason, d.id);
    for (const snap of d.snapshots || []) {
      assert.match(snap.asOf, /^\d{4}-\d{2}-\d{2}$/);
      for (const r of snap.rows) assert.ok(/^https:\/\//.test(r.url) && r.input > 0 && r.output >= r.input && r.provider && r.model, r.model);
    }
  }
});
