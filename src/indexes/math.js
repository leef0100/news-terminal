// The arithmetic behind every Halftone index. Nothing here fetches anything or knows what
// a company is: each function takes dated numbers and returns dated numbers, so the method
// written in config/indexes.json and docs/INDEX-METHODS.md can be checked line by line
// against test/indexes.test.js.
//
// Dates are ISO days ('2026-11-19'), which sort correctly as plain text. Nothing is rounded
// here; rounding happens once, where an answer is written.

const DAY = 86400000;
const finite = (v) => typeof v === 'number' && Number.isFinite(v);
export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
export const dayMs = (t) => Date.parse(t + 'T00:00:00Z');

// An equal-weighted index, rebalanced every day.
//
//   members: [{ id, points: [{ t, v }] }]   closing values, any order, gaps allowed
//
// On each day, every member that has a value that day AND an earlier value is "active". Its
// return is today's value over its own previous value (so after a gap, the whole move
// arrives on the day it comes back). The index moves by the plain average of the active
// members' returns. A member's first value only sets its starting point: it joins the
// average from its second value on. A day with fewer than `minActive` active members is
// left out (no point is made up for it) and the members' starting points are not moved, so
// their returns are picked up on the next day that counts.
//
// The index starts on the first day at least `minActive` members have a value, and is
// scaled so that it reads `base` on `baseDate` (or on its first day, if that is later; the
// date actually used is returned).
//
// `cum[id][i]` is how many index points member `id` has added since the start, up to day i.
// On any stretch of days the members' additions sum exactly to the index's own change.
export function equalWeighted(members, { baseDate = null, base = 100, minActive = 1 } = {}) {
  const maps = members.map((m) => {
    const map = new Map();
    for (const p of m.points || []) if (p && typeof p.t === 'string' && finite(p.v) && p.v > 0) map.set(p.t, p.v);
    return map;
  });
  const all = [...new Set(maps.flatMap((m) => [...m.keys()]))].sort();
  const prev = members.map(() => null);
  const running = members.map(() => 0);
  const days = [], levels = [], active = [], cum = members.map(() => []);
  let level = null;
  for (const t of all) {
    const here = maps.map((m) => m.get(t));
    if (level === null) {
      // Not started: wait for enough members to have a value on the same day.
      if (here.filter((v) => v !== undefined).length >= minActive) {
        level = 1;
        here.forEach((v, i) => { if (v !== undefined) prev[i] = v; });
        days.push(t); levels.push(level); active.push(0);
        cum.forEach((c) => c.push(0));
      } else here.forEach((v, i) => { if (v !== undefined) prev[i] = v; });
      continue;
    }
    const idx = [];
    here.forEach((v, i) => { if (v !== undefined && prev[i] !== null) idx.push(i); });
    if (idx.length < minActive) {
      // Too few to count. A member seen for the first time still gets its starting point.
      here.forEach((v, i) => { if (v !== undefined && prev[i] === null) prev[i] = v; });
      continue;
    }
    const before = level;
    let sum = 0;
    for (const i of idx) {
      const r = here[i] / prev[i] - 1;
      sum += r;
      running[i] += before * r / idx.length;
    }
    level = before * (1 + sum / idx.length);
    here.forEach((v, i) => { if (v !== undefined) prev[i] = v; });
    days.push(t); levels.push(level); active.push(idx.length);
    cum.forEach((c, i) => c.push(running[i]));
  }
  if (!days.length) return { days: [], levels: [], active: [], cum: Object.fromEntries(members.map((m) => [m.id, []])), baseDate: null, start: null };
  let at = baseDate ? days.findIndex((t) => t >= baseDate) : 0;
  if (at < 0) at = days.length - 1;
  const k = base / levels[at];
  return {
    days, levels: levels.map((v) => v * k), active,
    cum: Object.fromEntries(members.map((m, i) => [m.id, cum[i].map((v) => v * k)])),
    baseDate: days[at], start: days[0]
  };
}

// A fixed-weight index of a few components, each measured against its own value on the
// base date:  index = base x sum(weight x value / value on the base date).
// Only dates on which every component has a value are used. The base date is `baseT` if
// every component has it, otherwise the first date they all share (returned as `baseT`).
//   components: [{ id, weight, points: [{ t, v }] }]   weights are scaled to sum to 1
export function weightedRelatives(components, { baseT = null, base = 100 } = {}) {
  const maps = components.map((c) => new Map((c.points || []).filter((p) => p && finite(p.v) && p.v > 0).map((p) => [p.t, p.v])));
  const total = components.reduce((s, c) => s + c.weight, 0);
  const empty = { days: [], levels: [], parts: Object.fromEntries(components.map((c) => [c.id, []])), baseT: null, weights: {} };
  if (!components.length || !(total > 0)) return empty;
  const days = [...maps[0].keys()].filter((t) => maps.every((m) => m.has(t))).sort();
  if (!days.length) return empty;
  const b = baseT && days.includes(baseT) ? baseT : days[0];
  const w = components.map((c) => c.weight / total);
  // parts[id][i]: the index points that component supplies on day i; they sum to the level.
  const parts = components.map((c, i) => days.map((t) => base * w[i] * maps[i].get(t) / maps[i].get(b)));
  return {
    days, levels: days.map((_, d) => parts.reduce((s, p) => s + p[d], 0)),
    parts: Object.fromEntries(components.map((c, i) => [c.id, parts[i]])), baseT: b,
    weights: Object.fromEntries(components.map((c, i) => [c.id, w[i]]))
  };
}

// The calendar quarter a company's reporting quarter is counted in: the one that holds the
// middle of the period (45 days before its last day). A quarter ending 31 August (June to
// August) is 'Q3'; one ending 26 October (August to October) is 'Q3' too; one ending
// 30 November is 'Q4'.
export function calendarQuarter(periodEnd) {
  const ms = dayMs(periodEnd);
  if (!Number.isFinite(ms)) return null;
  const mid = new Date(ms - 45 * DAY);
  return `${mid.getUTCFullYear()}-Q${Math.floor(mid.getUTCMonth() / 3) + 1}`;
}
export function quarterEnd(q) {
  const m = /^(\d{4})-Q([1-4])$/.exec(q);
  return m ? isoDay(Date.UTC(Number(m[1]), Number(m[2]) * 3, 0)) : null;
}
const nextQuarter = (q) => { const y = Number(q.slice(0, 4)), n = Number(q.slice(6)); return n === 4 ? `${y + 1}-Q1` : `${y}-Q${n + 1}`; };

// Lines companies up by calendar quarter.
//   rows: [{ id, quarters: [{ end: 'YYYY-MM-DD', value }] }]
// Returns every quarter from the earliest to the latest any company has, oldest first, each
// company's figures on that grid (null where it has none), and a total that exists only for
// quarters in which every company has a figure: a total with a company missing would look
// like a fall in spending that never happened.
export function quarterTable(rows) {
  const byRow = rows.map((r) => {
    const map = new Map();
    for (const q of r.quarters || []) {
      const key = calendarQuarter(q.end);
      if (key && finite(q.value) && !map.has(key)) map.set(key, q.value);
    }
    return map;
  });
  const keys = [...new Set(byRow.flatMap((m) => [...m.keys()]))].sort();
  if (!keys.length) return { quarters: [], values: Object.fromEntries(rows.map((r) => [r.id, []])), totals: [] };
  const quarters = [];
  for (let q = keys[0]; q <= keys[keys.length - 1]; q = nextQuarter(q)) quarters.push(q);
  const values = byRow.map((m) => quarters.map((q) => (m.has(q) ? m.get(q) : null)));
  const totals = quarters.map((_, i) => (values.every((v) => v[i] !== null) ? values.reduce((s, v) => s + v[i], 0) : null));
  return { quarters, values: Object.fromEntries(rows.map((r, i) => [r.id, values[i]])), totals };
}

// The sum of each quarter and the three before it; null until four in a row are known.
export const trailingFour = (values) => values.map((_, i) => {
  if (i < 3) return null;
  const four = values.slice(i - 3, i + 1);
  return four.every(finite) ? four.reduce((s, v) => s + v, 0) : null;
});

// Change from `lag` places earlier, in percent; null when either figure is missing or the
// earlier one is not positive (a percentage of nothing means nothing).
export const growth = (values, lag = 4) => values.map((v, i) => {
  const was = values[i - lag];
  return i >= lag && finite(v) && finite(was) && was > 0 ? (v / was - 1) * 100 : null;
});

// Rebases to `base` at the first value that exists; nulls stay null.
export function rebase(values, base = 100) {
  const first = values.find(finite);
  return values.map((v) => (finite(v) && first > 0 ? v / first * base : null));
}

// Daily points averaged by calendar month: [{ t: 'YYYY-MM-01', v, n }].
export function monthlyMean(points) {
  const by = new Map();
  for (const p of points || []) {
    if (!p || !finite(p.v) || typeof p.t !== 'string') continue;
    const k = p.t.slice(0, 7);
    const m = by.get(k) || { sum: 0, n: 0 };
    m.sum += p.v; m.n += 1;
    by.set(k, m);
  }
  return [...by].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, m]) => ({ t: k + '-01', v: m.sum / m.n, n: m.n }));
}

// The move, in percent, from the last point at or before `days` days ahead of the latest
// one. Null when the series does not reach back that far, or when the nearest earlier point
// is more than `slack` days older than asked for (a 1-year change is not quoted off a point
// from 16 months ago).
export function changeOver(points, days, slack = 7) {
  if (!points || points.length < 2) return null;
  const last = points[points.length - 1];
  const want = dayMs(last.t) - days * DAY;
  let hit = null;
  for (let i = points.length - 2; i >= 0; i--) if (dayMs(points[i].t) <= want) { hit = points[i]; break; }
  if (!hit || want - dayMs(hit.t) > slack * DAY || !(hit.v > 0)) return null;
  return (last.v / hit.v - 1) * 100;
}
