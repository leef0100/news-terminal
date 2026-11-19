// Builds each Halftone index from its inputs.
//
// The engine knows the methods (config/indexes.json says which one each index uses and with
// what) and nothing about where figures come from: it asks `providers` (live.js or demo.js)
// and each provider says 'ok', 'off', 'none' or 'retry'. An index whose inputs are missing
// comes out with state 'off' and the reason; one still being read is 'pending'; one whose
// source is failing is 'error'. In none of those cases is a value produced.
//
// Every built index has the same shape, so the router and the page treat them alike:
//   points   [{ t, v }]                the index, oldest first
//   members  [{ id, name, track, points, ... }]   `track[i]` lines up with `points[i]`; a
//            member's contribution between two dates is the change in its track, as a share
//            of the index at the first date. The contributions always sum to the index's move.

import { equalWeighted, weightedRelatives, quarterTable, trailingFour, growth, quarterEnd, calendarQuarter, changeOver, dayMs } from './math.js';

export const RANGES = { '1m': 31, '6m': 183, '1y': 366, '5y': 1827, max: null };
const DAY = 86400000, MIN = 60000;
const round = (v, dp = 2) => (typeof v === 'number' && Number.isFinite(v) ? Number(v.toFixed(dp)) : null);
const last = (a) => (a.length ? a[a.length - 1] : null);

// One row per source name; a failure is never hidden by a later success.
function mergeSources(lists) {
  const rows = new Map();
  for (const s of lists.flat()) {
    if (!s || !s.name) continue;
    const prev = rows.get(s.name);
    if (!prev || (s.state === 'error' && prev.state !== 'error') || (s.state === 'off' && prev.state === 'ok')) rows.set(s.name, { name: String(s.name), state: s.state, note: String(s.note || '') });
  }
  return [...rows.values()];
}

export function createEngine({ config, providers, now = Date.now, demo = false }) {
  const defs = config.indexes;
  const byId = new Map(defs.map((d) => [d.id, d]));
  // In the demo every input is invented, and is named as such wherever a source is shown.
  const FILINGS = demo ? { source: 'Demo data', url: null } : { source: 'SEC EDGAR, company financial statements', url: 'https://www.sec.gov/edgar/search/' };
  const VENUE = demo ? 'Demo data' : 'Hyperliquid';
  const label = demo ? 'Halftone index, not an official benchmark. Demo: invented figures.' : config.label;

  // A built index is kept for a while that depends on how it came out, and one build serves
  // everyone who asks while it is under way.
  const kept = new Map(), flying = new Map();
  const HOLD = { ok: 5 * MIN, off: MIN, pending: 15000, error: 15000 };
  function once(key, build, holdOf = (v) => HOLD[v.state] ?? MIN) {
    const hit = kept.get(key);
    if (hit && now() - hit.at < holdOf(hit.value)) return Promise.resolve(hit.value);
    if (flying.has(key)) return flying.get(key);
    const run = build().then((value) => { kept.set(key, { at: now(), value }); return value; }).finally(() => flying.delete(key));
    flying.set(key, run);
    return run;
  }

  const shell = (def, extra) => ({
    id: def.id, kind: def.kind, name: def.name, meaning: def.meaning, summary: def.summary, label,
    method: def.method || [], limits: def.limits || [], unit: 'index', methodNote: def.methodNote || '',
    state: 'off', note: '', frequency: 'daily', base: null, points: [], members: [], facts: [], tables: [], inputs: [], history: '', sources: [], ...extra
  });
  const stop = (def, state, note, extra = {}) => shell(def, { state, note, ...extra });

  // ----- equal-weighted baskets of shares -----
  async function basket(def) {
    const read = await Promise.all(def.constituents.map((c) => providers.closes(c.symbol)));
    const sources = mergeSources(read.map((r) => r.sources || []));
    const ok = read.filter((r) => r.state === 'ok').length, n = read.length;
    const membersOf = (res) => def.constituents.map((c, i) => {
      const r = read[i], pts = r.points || [];
      return {
        id: c.symbol, name: c.name, reason: c.reason, link: '#stocks/' + c.symbol, state: r.state === 'ok' ? 'ok' : r.state === 'retry' ? 'pending' : 'missing',
        note: r.state === 'ok' ? (r.delayed ? 'Delayed prices.' : '') : r.note, points: pts, track: res ? res.cum[c.symbol] : [],
        latest: pts.length ? { value: last(pts).v, unit: 'USD', asOf: last(pts).t } : null, from: pts.length ? pts[0].t : null
      };
    });
    const frame = { frequency: 'daily', sources };
    if (read.every((r) => r.state === 'off')) return stop(def, 'off', 'Not connected: ' + (read[0]?.note || 'no source of exchange closing prices is connected.'), { ...frame, members: membersOf(null) });
    const waiting = read.filter((r) => r.state === 'retry');
    if (waiting.length) {
      // A price source with a small allowance is read a few companies at a time.
      return stop(def, ok ? 'pending' : 'error', ok ? `Reading prices: ${ok} of ${n} companies so far. The rest follow as the price source’s allowance permits.` : 'The price source did not answer: ' + waiting[0].note, { ...frame, members: membersOf(null) });
    }
    if (ok < def.minConstituents) {
      const why = read.find((r) => r.state !== 'ok')?.note || '';
      return stop(def, 'off', `Not connected: ${ok} of ${n} companies have exchange closing prices from a connected source, and at least ${def.minConstituents} are needed. ${why}`.trim(), { ...frame, members: membersOf(null) });
    }
    const usable = def.constituents.map((c, i) => ({ id: c.symbol, points: read[i].state === 'ok' ? read[i].points : [] }));
    const res = equalWeighted(usable, { baseDate: def.baseDate, minActive: def.minConstituents });
    if (res.days.length < 2) return stop(def, 'off', 'Not connected: the price history read does not hold two days on which enough companies traded.', { ...frame, members: membersOf(null) });
    const names = [...new Set(read.filter((r) => r.state === 'ok').map((r) => r.source))];
    const dropped = def.constituents.filter((_, i) => read[i].state !== 'ok').map((c) => c.symbol);
    return shell(def, {
      ...frame, state: 'ok', points: res.days.map((t, i) => ({ t, v: res.levels[i] })), base: { t: res.baseDate, value: 100 },
      note: dropped.length ? `Left out for lack of prices: ${dropped.join(', ')}.` : '',
      members: membersOf(res), weightNote: `Equal weight: each of the ${last(res.active)} companies priced on the latest day counts ${round(100 / last(res.active), 1)}%.`, memberWeight: 100 / last(res.active),
      history: res.baseDate === def.baseDate ? `100 on ${def.baseDate}.` : `The base date in the method is ${def.baseDate}, but the price history read starts later, so the index is 100 on ${res.baseDate}.`,
      inputs: [{ name: `Daily closing prices of ${ok} companies`, source: names.join(', '), url: null, from: res.start, asOf: last(res.days), note: read.some((r) => r.delayed) ? 'Prices may be delayed.' : '' }]
    });
  }

  // ----- the crypto basket -----
  async function crypto(def) {
    const r = await providers.crypto(def);
    const frame = { frequency: 'daily', sources: r.sources || [] };
    if (r.state === 'off') return stop(def, 'off', 'Not connected: ' + r.note, frame);
    if (r.state !== 'ok') return stop(def, 'error', r.note, frame);
    const have = r.listed.filter((l) => l.points.length >= 2);
    const droppedNote = r.dropped.length ? `Not listed on ${VENUE === 'Demo data' ? 'the venue' : VENUE} when this was built, so left out: ${r.dropped.join(', ')}.` : '';
    if (have.length < def.minConstituents) return stop(def, 'off', `Not connected: ${have.length} of the ${def.candidates.length} named tokens are listed on Hyperliquid with a price history, and at least ${def.minConstituents} are needed. ${droppedNote}`.trim(), frame);
    const res = equalWeighted(have.map((l) => ({ id: l.coin, points: l.points })), { minActive: def.minConstituents });
    if (res.days.length < 2) return stop(def, 'off', 'Not connected: too little price history to build the basket.', frame);
    const info = new Map(def.candidates.map((c) => [c.coin, c]));
    const got = new Map(have.map((l) => [l.coin, l]));
    return shell(def, {
      ...frame, state: 'ok', note: droppedNote, points: res.days.map((t, i) => ({ t, v: res.levels[i] })), base: { t: res.baseDate, value: 100 },
      members: def.candidates.map((c) => {
        const l = got.get(c.coin);
        return {
          id: c.coin, name: info.get(c.coin).name, reason: c.reason, state: l ? 'ok' : 'missing', note: l ? '' : 'Not listed on Hyperliquid, or no price history yet.',
          points: l ? l.points : [], track: l ? res.cum[c.coin] : [], latest: l ? { value: last(l.points).v, unit: 'USD', asOf: last(l.points).t } : null, from: l ? l.points[0].t : null
        };
      }),
      weightNote: `Equal weight: each of the ${last(res.active)} tokens priced on the latest day counts ${round(100 / last(res.active), 1)}%.`, memberWeight: 100 / last(res.active),
      history: `100 on ${res.baseDate}, the first day of the window read on which at least ${def.minConstituents} tokens had a price.`,
      inputs: [{ name: `Daily closes of ${have.length} perpetual contracts`, source: VENUE, url: null, from: res.start, asOf: last(res.days), note: 'Contract prices, not spot prices. The day still trading is left out.' }]
    });
  }

  // ----- company quarters: the capital spending tracker and the demand index -----
  const quartersOf = (list, field) => once('q:' + field + ':' + list.map((c) => c.symbol).join(','), async () => {
    const read = await Promise.all(list.map((c) => providers.quarterly(c.symbol)));
    const table = quarterTable(list.map((c, i) => ({ id: c.symbol, quarters: read[i].quarters.map((q) => ({ end: q.end, value: q[field] })) })));
    const state = read.every((r) => r.state === 'off') ? 'off' : read.some((r) => r.state === 'retry') ? 'error' : table.quarters.length ? 'ok' : 'off';
    return { state, read, table, list, sources: mergeSources(read.map((r) => r.sources || [])) };
  }, (v) => (v.state === 'ok' ? 10 * MIN : v.state === 'off' ? MIN : 15000));

  async function tracker(def) {
    const q = await quartersOf(def.companies, 'capex');
    const { table, read } = q;
    const companies = def.companies.map((c, i) => ({
      symbol: c.symbol, name: read[i].name || c.name, reason: c.reason, state: read[i].state === 'ok' && table.values[c.symbol].some((v) => v !== null) ? 'ok' : read[i].state === 'retry' ? 'error' : 'missing',
      note: read[i].state === 'ok' ? (table.values[c.symbol].some((v) => v !== null) ? '' : 'No capital expenditure figure in its quarterly statements.') : read[i].note
    }));
    const note = q.state === 'off' ? 'Not connected: ' + (read[0]?.note || 'SEC filings are not connected.') : q.state === 'error' ? 'A company’s filings could not be read just now: ' + (read.find((r) => r.state === 'retry')?.note || '') : '';
    const trailing = trailingFour(table.totals);
    const firstTrailing = trailing.find((v) => v !== null) ?? null;
    // Which figures were worked out from year-to-date totals, on the same grid as the values.
    const derived = Object.fromEntries(def.companies.map((c, i) => {
      const by = new Map(read[i].quarters.map((x) => [x.end, x.derived]));
      const ends = new Map(read[i].quarters.map((x) => [calendarQuarter(x.end), x.end]));
      return [c.symbol, table.quarters.map((k) => Boolean(by.get(ends.get(k))))];
    }));
    return {
      state: q.state, note, companies, quarters: table.quarters, quarterEnds: table.quarters.map(quarterEnd), values: table.values, derived,
      totals: table.totals, yoy: growth(table.totals, 4), companyYoy: Object.fromEntries(def.companies.map((c) => [c.symbol, growth(table.values[c.symbol], 4)])),
      trailing, trailingYoy: growth(trailing, 4), index: trailing.map((v) => (v !== null && firstTrailing > 0 ? v / firstTrailing * 100 : null)), sources: q.sources
    };
  }

  const money = (v) => (v === null ? null : round(v, 0));
  async function capex(def) {
    const t = await tracker(def);
    const frame = { frequency: 'quarterly', sources: t.sources };
    if (t.state === 'off') return stop(def, 'off', t.note, frame);
    if (t.state === 'error') return stop(def, 'error', t.note, frame);
    const at = t.quarters.map((_, i) => i).filter((i) => t.index[i] !== null);
    const lacking = t.companies.filter((c) => c.state !== 'ok').map((c) => c.symbol);
    if (!at.length) return stop(def, 'off', `Not connected: no run of four quarters has a figure from every company${lacking.length ? ` (none for ${lacking.join(', ')})` : ''}. The quarterly table is still shown.`, frame);
    const first = t.trailing[at[0]];
    const members = def.companies.map((c) => {
      const own = trailingFour(t.values[c.symbol]);
      const pts = t.quarters.map((k, i) => ({ t: quarterEnd(k), v: t.values[c.symbol][i] })).filter((p) => p.v !== null);
      return {
        id: c.symbol, name: t.companies.find((x) => x.symbol === c.symbol).name, reason: c.reason, link: '#stocks/' + c.symbol, state: 'ok', note: '',
        points: at.map((i) => ({ t: t.quarterEnds[i], v: own[i] })), track: at.map((i) => own[i] / first * 100),
        latest: pts.length ? { value: last(pts).v, unit: 'USD', asOf: last(pts).t, what: 'latest quarter' } : null, from: pts.length ? pts[0].t : null,
        weight: own[last(at)] / t.trailing[last(at)] * 100
      };
    });
    const li = last(at), latestQ = t.totals.map((v, i) => (v !== null ? i : -1)).filter((i) => i >= 0).pop();
    return shell(def, {
      ...frame, state: 'ok', points: at.map((i) => ({ t: t.quarterEnds[i], v: t.index[i] })), base: { t: t.quarterEnds[at[0]], value: 100 }, members,
      weightNote: 'Weight is each company’s share of the latest trailing-four-quarter total.',
      history: `100 for the four quarters ending ${t.quarters[at[0]]}, the first run of four quarters every company has reported in the SEC statements read.`,
      facts: [
        { label: `Total, ${t.quarters[latestQ]}`, value: money(t.totals[latestQ]), unit: 'USD' },
        { label: 'Change from a year earlier', value: round(t.yoy[latestQ]), unit: '%' },
        { label: `Trailing four quarters to ${t.quarters[li]}`, value: money(t.trailing[li]), unit: 'USD' }
      ],
      inputs: [{ name: `Quarterly capital expenditure of ${def.companies.length} companies`, ...FILINGS, from: t.quarterEnds[0], asOf: last(t.quarterEnds), note: 'Cash paid for property and equipment, from each company’s cash-flow statement.' }]
    });
  }

  async function demand(def) {
    const buyersDef = byId.get(def.buyersFrom);
    const [s, b] = await Promise.all([quartersOf(def.suppliers, 'revenue'), quartersOf(buyersDef.companies, 'capex')]);
    const frame = { frequency: 'quarterly', sources: mergeSources([s.sources, b.sources]) };
    if (s.state === 'off' && b.state === 'off') return stop(def, 'off', 'Not connected: ' + (s.read[0]?.note || 'SEC filings are not connected.'), frame);
    if (s.state === 'error' || b.state === 'error') return stop(def, 'error', 'A company’s filings could not be read just now.', frame);
    const side = (q) => { const tr = trailingFour(q.table.totals); return q.table.quarters.map((k, i) => ({ t: quarterEnd(k), v: tr[i] })).filter((p) => p.v !== null); };
    const sp = side(s), bp = side(b);
    const res = weightedRelatives([{ id: 'suppliers', weight: def.weights.suppliers, points: sp }, { id: 'buyers', weight: def.weights.buyers, points: bp }]);
    if (!res.days.length) {
      const lacking = [...s.list.filter((_, i) => s.read[i].state !== 'ok'), ...b.list.filter((_, i) => b.read[i].state !== 'ok')].map((c) => c.symbol);
      return stop(def, 'off', `Not connected: no quarter has four trailing quarters of figures from every company on both sides${lacking.length ? ` (none for ${lacking.join(', ')})` : ''}.`, frame);
    }
    const pick = (pts) => res.days.map((t) => pts.find((p) => p.t === t));
    const member = (id, name, reason, pts) => ({
      id, name, reason, state: 'ok', note: '', points: pick(pts), track: res.parts[id], weight: res.weights[id] * 100,
      latest: { value: last(pick(pts)).v, unit: 'USD', asOf: last(res.days), what: 'trailing four quarters' }, from: res.days[0]
    });
    const rows = (q, field) => q.list.map((c, i) => {
      const vals = q.table.values[c.symbol], tr = trailingFour(vals), k = tr.map((v, j) => (v !== null ? j : -1)).filter((j) => j >= 0).pop();
      return [c.symbol, q.read[i].name || c.name, c.reason, k === undefined ? null : round(tr[k], 0), k === undefined ? null : q.table.quarters[k]];
    });
    const cols = [{ label: 'Ticker', kind: 'text' }, { label: 'Company', kind: 'text' }, { label: 'Why it is here', kind: 'text' }, { label: 'Trailing four quarters', kind: 'usd' }, { label: 'To', kind: 'text' }];
    return shell(def, {
      ...frame, state: 'ok', points: res.days.map((t, i) => ({ t, v: res.levels[i] })), base: { t: res.baseT, value: 100 },
      members: [
        member('suppliers', `Chip makers’ revenue (${def.suppliers.map((c) => c.symbol).join(', ')})`, 'Total revenue, trailing four quarters. Whole-company revenue, not data-center revenue.', sp),
        member('buyers', `Buyers’ capital spending (${buyersDef.companies.map((c) => c.symbol).join(', ')})`, 'Capital expenditure, trailing four quarters, from the AI capital spending tracker.', bp)
      ],
      weightNote: 'Fixed weights: half each, measured against the base quarter.',
      history: `100 for the four quarters ending ${res.baseT}, the first quarter both sides have four reported quarters behind them.`,
      tables: [
        { title: 'Chip makers: total revenue', columns: cols, rows: rows(s, 'revenue'), note: 'Whole-company revenue as filed with the SEC. The SEC’s company data does not carry revenue by segment.' },
        { title: 'Buyers: capital expenditure', columns: cols, rows: rows(b, 'capex'), note: 'See the AI capital spending tracker for every quarter.' }
      ],
      inputs: [
        { name: `Quarterly revenue of ${def.suppliers.length} chip makers`, ...FILINGS, from: quarterEnd(s.table.quarters[0]), asOf: quarterEnd(last(s.table.quarters)), note: '' },
        { name: `Quarterly capital expenditure of ${buyersDef.companies.length} buyers`, ...FILINGS, from: quarterEnd(b.table.quarters[0]), asOf: quarterEnd(last(b.table.quarters)), note: '' }
      ]
    });
  }

  // ----- energy -----
  async function energy(def) {
    const r = await providers.energy(def);
    const frame = { frequency: 'monthly', sources: r.sources || [] };
    if (r.state === 'off') return stop(def, 'off', 'Not connected: ' + r.note, frame);
    if (r.state !== 'ok') return stop(def, 'error', r.note, frame);
    const baseT = def.baseMonth + '-01';
    const res = weightedRelatives([{ id: 'electricity', weight: def.weights.electricity, points: r.electricity.points }, { id: 'gas', weight: def.weights.gas, points: r.gas.points }], { baseT });
    if (res.days.length < 2) return stop(def, 'off', 'Not connected: the source returned no month for which both electricity and gas prices exist.', frame);
    const member = (id, part) => {
      const pts = res.days.map((t) => part.points.find((p) => p.t === t));
      return { id, name: part.name, reason: id === 'electricity' ? 'What industrial customers pay for power.' : 'The fuel that sets the price of much US electricity.', state: 'ok', note: '', points: pts, track: res.parts[id], weight: res.weights[id] * 100, latest: { value: last(pts).v, unit: part.unit, asOf: last(res.days), month: true }, from: res.days[0] };
    };
    const input = (part) => ({ name: part.name, source: part.source, url: part.url || null, from: part.points[0]?.t || null, asOf: last(part.points)?.t || null, note: part.unit });
    return shell(def, {
      ...frame, state: 'ok', points: res.days.map((t, i) => ({ t, v: res.levels[i] })), base: { t: res.baseT, value: 100 },
      note: r.variant === 'fred' ? 'Using FRED’s series: the electricity input is a producer price index, not a price in cents per kilowatt-hour. Set EIA_KEY for the price itself.' : '',
      members: [member('electricity', r.electricity), member('gas', r.gas)], weightNote: 'Fixed weights: half each, measured against the base month.',
      history: res.baseT === baseT ? `100 in ${def.baseMonth}.` : `The base month in the method is ${def.baseMonth}, which the data read does not include, so the index is 100 in ${res.baseT.slice(0, 7)}.`,
      facts: r.gas.latestDaily ? [{ label: `Henry Hub spot, ${r.gas.latestDaily.t}`, value: round(r.gas.latestDaily.v), unit: r.gas.unit }] : [],
      inputs: [input(r.electricity), input(r.gas)]
    });
  }

  // ----- collected cloud prices -----
  async function prices(def) {
    const r = await providers.prices(def);
    const frame = { frequency: 'daily', sources: r.sources || [], unitNote: def.unit };
    if (r.state === 'off') return stop(def, 'off', 'Not connected: ' + r.note, frame);
    if (r.state !== 'ok') return stop(def, r.state === 'pending' ? 'pending' : 'error', r.note, frame);
    const got = new Map(r.items.map((i) => [i.id, i]));
    const have = r.items.filter((i) => i.points.length);
    const res = equalWeighted(have.map((i) => ({ id: i.id, points: i.points })), { minActive: def.minConstituents });
    const members = def.basket.map((m) => {
      const i = got.get(m.id) || { points: [], state: 'pending', note: '' };
      return {
        id: m.id, name: m.name, reason: m.reason, group: m.group, state: i.points.length ? 'ok' : 'missing', note: i.points.length ? '' : (i.note || 'No price collected yet.'),
        points: i.points, track: res.days.length && res.cum[m.id] ? res.cum[m.id] : [], latest: i.points.length ? { value: last(i.points).v, unit: def.unit, asOf: last(i.points).t } : null, from: i.points[0]?.t || null
      };
    });
    const table = {
      title: `List prices${last(res.days) ? ' on ' + last(res.days) : ''}`,
      columns: [{ label: 'Machine', kind: 'text' }, { label: 'Kind', kind: 'text' }, { label: 'USD per hour', kind: 'price' }, { label: 'Priced on', kind: 'text' }],
      rows: members.map((m) => [m.name, m.group || '', m.latest ? m.latest.value : null, m.latest ? m.latest.asOf : m.note]),
      note: `Pay-as-you-go, Linux, region ${def.source.region}.`
    };
    const since = `History starts on ${r.started}, the day this server first collected prices. Nothing earlier is filled in${demo ? ' (demo: the history shown is invented)' : ''}.`;
    if (have.length < def.minConstituents || !res.days.length) {
      return stop(def, 'off', `Not connected: ${have.length} of ${def.basket.length} machines have a collected price, and at least ${def.minConstituents} are needed.`, { ...frame, members, tables: [table], history: since });
    }
    const gpus = members.filter((m) => m.group === 'GPU' && m.latest);
    return shell(def, {
      ...frame, state: 'ok', points: res.days.map((t, i) => ({ t, v: res.levels[i] })), base: { t: res.baseDate, value: 100 }, members,
      note: res.days.length < 2 ? 'Only one day of prices has been collected so far, so there is no change to show yet.' : members.some((m) => m.state !== 'ok') ? `Not found in the price list, so left out: ${members.filter((m) => m.state !== 'ok').map((m) => m.name).join('; ')}.` : '',
      weightNote: `Equal weight: each of the ${have.length} machines with a price counts ${round(100 / have.length, 1)}%.`, memberWeight: 100 / have.length,
      history: since, tables: [table],
      facts: gpus.length ? [{ label: `Average of the ${gpus.length} GPU machines`, value: round(gpus.reduce((s, m) => s + m.latest.value, 0) / gpus.length, 3), unit: def.unit }] : [],
      inputs: [{ name: `Hourly list prices of ${have.length} machines`, source: def.source.name, url: def.source.docs, from: res.start, asOf: last(res.days), note: `Collected by this server every ${def.source.everyHours} hours.` }]
    });
  }

  // ----- the dated table of model prices -----
  async function table(def) {
    const snaps = (providers.snapshots ? await providers.snapshots(def) : def.snapshots || [])
      .filter((s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s.asOf) && Array.isArray(s.rows)).slice().sort((a, b) => (a.asOf < b.asOf ? -1 : 1));
    const frame = { frequency: 'irregular', sources: [{ name: demo ? 'Demo data' : 'Published list prices (entered by hand)', state: snaps.length ? 'ok' : 'off', note: demo ? 'Invented for the demo. Not real providers or prices.' : snaps.length ? `A dated table in config/indexes.json, read from each provider’s own pricing page. Latest: ${last(snaps).asOf}.` : 'No dated price table has been entered in config/indexes.json.' }] };
    if (!snaps.length) return stop(def, 'off', 'Not connected: no dated table of published prices has been entered in config/indexes.json. No provider offers its list prices as an official machine-readable feed.', frame);
    const wi = def.blend.input, wo = def.blend.output;
    const blend = (row) => (wi * row.input + wo * row.output) / (wi + wo);
    const valid = (row) => row && typeof row.model === 'string' && row.input > 0 && row.output > 0 && Number.isFinite(row.input + row.output);
    const series = new Map();
    for (const s of snaps) for (const row of s.rows.filter(valid)) {
      const id = row.provider + ' ' + row.model;
      if (!series.has(id)) series.set(id, { id, provider: row.provider, model: row.model, points: [] });
      series.get(id).points.push({ t: s.asOf, v: blend(row) });
    }
    const all = [...series.values()];
    const res = equalWeighted(all, { minActive: def.minConstituents });
    const latest = last(snaps), rows = latest.rows.filter(valid);
    if (!res.days.length) return stop(def, 'off', `Not connected: the price table lists ${rows.length} models and at least ${def.minConstituents} are needed.`, frame);
    const inLatest = new Set(rows.map((r) => r.provider + ' ' + r.model));
    return shell(def, {
      ...frame, state: 'ok', points: res.days.map((t, i) => ({ t, v: res.levels[i] })), base: { t: res.baseDate, value: 100 }, unitNote: def.unit,
      note: snaps.length < 2 ? `Published list prices as of ${latest.asOf}. One dated table has been entered, so there is no change to show yet.` : `Published list prices as of ${latest.asOf}.`,
      members: all.filter((m) => inLatest.has(m.id)).map((m) => ({
        id: m.id, name: m.model, reason: m.provider, group: m.provider, state: 'ok', note: '', points: m.points, track: res.cum[m.id],
        latest: { value: last(m.points).v, unit: def.unit, asOf: last(m.points).t, what: 'blended' }, from: m.points[0].t
      })),
      weightNote: `Equal weight: each of the ${rows.length} models in the latest table counts ${round(100 / rows.length, 1)}%.`, memberWeight: 100 / rows.length,
      history: `100 on ${res.baseDate}, the date of the first table entered. ${snaps.length} dated ${snaps.length === 1 ? 'table' : 'tables'} so far${demo ? ' (demo: invented)' : ''}.`,
      facts: [{ label: `Average blended price, ${rows.length} models`, value: round(rows.reduce((s, r) => s + blend(r), 0) / rows.length, 3), unit: def.unit }],
      tables: [{
        title: `Published list prices as of ${latest.asOf}`,
        columns: [{ label: 'Provider', kind: 'text' }, { label: 'Model', kind: 'text' }, { label: 'Input, USD per 1M tokens', kind: 'price' }, { label: 'Output, USD per 1M tokens', kind: 'price' }, { label: `Blended ${wi}:${wo}`, kind: 'price' }, { label: 'Source', kind: 'link' }],
        rows: rows.map((r) => [r.provider, r.model, r.input, r.output, round(blend(r), 4), r.url ? { text: 'Price page', url: r.url } : null]),
        note: latest.note || ''
      }],
      inputs: [...new Map(rows.map((r) => [r.provider, r])).values()].map((r) => ({ name: `${r.provider} list prices`, source: demo ? 'Demo data' : `${r.provider} pricing page`, url: r.url || null, from: snaps[0].asOf, asOf: latest.asOf, note: demo ? 'Invented for the demo.' : 'Entered by hand from the published page.' }))
    });
  }

  const BUILD = { basket, crypto, capex, demand, energy, prices, table };
  // Never throws: a build that breaks is an index in error, not a broken page.
  const build = (id) => once('ix:' + id, async () => {
    const def = byId.get(id);
    try {
      return await BUILD[def.kind](def);
    } catch (e) {
      return stop(def, 'error', 'This index could not be built just now.', { frequency: 'daily', broke: String(e?.message || e) });
    }
  });

  // ----- what the router sends -----
  function changes(ix) {
    const p = ix.points;
    if (p.length < 2) return { d1: null, m1: null, y1: null, previous: null };
    const prev = p[p.length - 2];
    const previous = { pct: round((last(p).v / prev.v - 1) * 100), since: prev.t };
    if (ix.frequency === 'daily') return { d1: dayMs(last(p).t) - dayMs(prev.t) <= 5 * DAY ? previous.pct : null, m1: round(changeOver(p, 30, 7)), y1: round(changeOver(p, 365, 7)), previous };
    if (ix.frequency === 'monthly') return { d1: null, m1: round(changeOver(p, 28, 5)), y1: round(changeOver(p, 365, 7)), previous };
    if (ix.frequency === 'quarterly') return { d1: null, m1: null, y1: round(changeOver(p, 365, 10)), previous };
    return { d1: null, m1: round(changeOver(p, 30, 7)), y1: round(changeOver(p, 365, 7)), previous };
  }
  function spark(points, n = 60) {
    if (points.length <= n) return points.map((p) => round(p.v));
    const out = [];
    for (let i = 0; i < n; i++) out.push(round(points[Math.round(i * (points.length - 1) / (n - 1))].v));
    return out;
  }
  const summary = (ix) => ({
    id: ix.id, name: ix.name, meaning: ix.meaning, label: ix.label, state: ix.state, note: ix.note, frequency: ix.frequency,
    value: ix.points.length ? round(last(ix.points).v) : null, change: changes(ix), spark: spark(ix.points),
    asOf: ix.points.length ? last(ix.points).t : null, base: ix.base, method: ix.summary
  });

  async function list() {
    const built = await Promise.all(defs.map((d) => build(d.id)));
    return { label, indexes: built.map(summary), sources: mergeSources(built.map((b) => b.sources)), failed: built.every((b) => b.state === 'error') };
  }

  async function series(id, range) {
    const ix = await build(id);
    const days = RANGES[range];
    const p = ix.points;
    const cut = p.length && days ? dayMs(last(p).t) - days * DAY : -Infinity;
    let from = p.findIndex((x) => dayMs(x.t) >= cut);
    if (from < 0) from = 0;
    const shown = p.slice(from);
    const v0 = shown.length ? shown[0].v : null;
    const end = p.length - 1;
    const constituents = ix.members.map((m) => {
      const inRange = m.points.filter((x) => x && shown.length && x.t >= shown[0].t);
      const counted = m.state === 'ok' && m.track.length === p.length && v0 > 0;
      return {
        id: m.id, name: m.name, reason: m.reason, group: m.group || null, link: m.link || null, state: m.state, note: m.note,
        weightPct: m.state === 'ok' ? round(m.weight ?? ix.memberWeight, 1) : null,
        latest: m.latest ? { ...m.latest, value: round(m.latest.value, m.latest.unit === 'USD' && Math.abs(m.latest.value) >= 1e6 ? 0 : 4) } : null,
        changePct: inRange.length >= 2 ? round((last(inRange).v / inRange[0].v - 1) * 100) : null,
        contributionPts: counted && shown.length >= 2 ? round((m.track[end] - m.track[from]) / v0 * 100) : null, from: m.from
      };
    });
    return {
      id: ix.id, kind: ix.kind, name: ix.name, meaning: ix.meaning, label: ix.label, summary: ix.summary, state: ix.state, note: ix.note, frequency: ix.frequency,
      range, base: ix.base, asOf: shown.length ? last(shown).t : null, from: shown.length ? shown[0].t : null, value: shown.length ? round(last(shown).v) : null,
      changePct: shown.length >= 2 ? round((last(shown).v / v0 - 1) * 100) : null, change: changes(ix),
      // `v` is the index on its own base; `r` is the same line set to 100 at the start of the range asked for.
      series: shown.map((x) => ({ t: x.t, v: round(x.v, 4), r: round(x.v / v0 * 100, 4) })),
      constituents, weightNote: ix.weightNote || '', unitNote: ix.unitNote || null, history: ix.history, facts: ix.facts, tables: ix.tables, inputs: ix.inputs,
      method: ix.method, methodNote: ix.methodNote, limits: ix.limits, sources: ix.sources, failed: ix.state === 'error'
    };
  }

  async function capexAnswer() {
    const def = defs.find((d) => d.kind === 'capex');
    const t = await tracker(def);
    const r0 = (a) => a.map((v) => (v === null ? null : round(v, 0)));
    const r2 = (a) => a.map((v) => round(v));
    return {
      id: def.id, name: def.name, meaning: def.meaning, label, state: t.state, note: t.note, unit: 'USD', companies: t.companies,
      quarters: t.quarters, quarterEnds: t.quarterEnds, values: Object.fromEntries(Object.entries(t.values).map(([k, v]) => [k, r0(v)])), derived: t.derived,
      totals: r0(t.totals), yoy: r2(t.yoy), companyYoy: Object.fromEntries(Object.entries(t.companyYoy).map(([k, v]) => [k, r2(v)])),
      trailing: r0(t.trailing), trailingYoy: r2(t.trailingYoy), index: r2(t.index), method: def.method, methodNote: def.methodNote || '', limits: def.limits, sources: t.sources, failed: t.state === 'error'
    };
  }

  return { ids: () => defs.map((d) => d.id), has: (id) => byId.has(id), list, series, capex: capexAnswer, clear() { kept.clear(); } };
}
