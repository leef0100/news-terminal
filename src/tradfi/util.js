// Small shared helpers for the stocks, calendar and private-markets module.

export const DAY = 86400000;

// A mistake in the request (unknown symbol, bad date). The router answers 400 for these
// and 502 for everything else.
export function bad(message) {
  const e = new Error(message);
  e.status = 400;
  return e;
}

export const SYMBOL_RE = /^[A-Z0-9.\-:]{1,12}$/;
export const RANGES = { '1m': 31, '6m': 183, '1y': 366, '5y': 1827 };

export const num = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

export const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
// 'YYYY-MM-DD' to the millisecond at which that UTC day starts; null if it is not a real date.
export function parseDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(s + 'T00:00:00Z');
  return Number.isFinite(ms) && isoDay(ms) === s ? ms : null;
}
// 0 is Sunday. The first day of 1970 was a Thursday.
export const weekday = (dayIndex) => (((dayIndex + 4) % 7) + 7) % 7;
export const isWeekday = (dayIndex) => { const w = weekday(dayIndex); return w >= 1 && w <= 5; };

// Repeatable noise: the same input always gives the same output, so demo data does not
// change between requests or between servers.
export function hash(n, seed) {
  let h = (Math.imul(n | 0, 374761393) + Math.imul(seed | 0, 668265263)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295 * 2 - 1;
}
export function noise(x, seed) {
  const i = Math.floor(x), f = x - i, u = f * f * (3 - 2 * f);
  return hash(i, seed) * (1 - u) + hash(i + 1, seed) * u;
}
// A repeatable value between lo and hi for a seed and a slot.
export const pick = (seed, slot, lo, hi) => lo + (hash(slot, seed) + 1) / 2 * (hi - lo);

export const round = (v, dp = 2) => (v === null || v === undefined || !Number.isFinite(v) ? null : Number(v.toFixed(dp)));
export const pct = (a, b) => (a !== null && b ? round(((a - b) / b) * 100, 2) : null);
