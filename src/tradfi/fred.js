// FRED, the St. Louis Fed's data service (needs a free key, FRED_KEY): the headline economic
// figures and the dates of coming data releases.
//
// Only series produced by US government bodies are read here (Bureau of Labor Statistics,
// Bureau of Economic Analysis, the Federal Reserve Board). FRED also carries series owned by
// others, such as stock indexes, which its terms do not let us show; none are used.
// The terms ask for this notice wherever the data is shown, so it travels with every answer.

import { num } from './util.js';

export const FRED_NOTICE = 'This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis.';
const API = 'https://api.stlouisfed.org/fred';

// id, what it is, unit, FRED's own transformation (pc1 is the change from a year earlier, in %)
export const MACRO = [
  { id: 'CPIAUCSL', name: 'Consumer prices, change from a year earlier', unit: '%', units: 'pc1', period: 'month' },
  { id: 'UNRATE', name: 'Unemployment rate', unit: '%', units: 'lin', period: 'month' },
  { id: 'FEDFUNDS', name: 'Federal funds rate, monthly average', unit: '%', units: 'lin', period: 'month' },
  { id: 'A191RL1Q225SBEA', name: 'Real GDP, quarterly change at an annual rate', unit: '%', units: 'lin', period: 'quarter' },
  { id: 'DGS10', name: '10-year Treasury yield', unit: '%', units: 'lin', period: 'day' }
];
// FRED release id -> how much markets usually care (3 most). The name shown is the one FRED
// returns, so a wrong id here could only mislabel importance, never the event.
export const RELEASES = { 10: 3, 50: 3, 53: 3, 54: 3, 46: 2, 9: 2, 192: 2, 13: 2, 180: 1 };

const periodLabel = (date, kind) => (kind === 'month' ? date.slice(0, 7) : kind === 'quarter' ? `${date.slice(0, 4)} Q${Math.floor((Number(date.slice(5, 7)) - 1) / 3) + 1}` : date);

export function createFred({ source, key, now = Date.now }) {
  async function macro(led) {
    const rows = await Promise.all(MACRO.map(async (m) => {
      const url = `${API}/series/observations?series_id=${m.id}&api_key=${encodeURIComponent(key)}&file_type=json&sort_order=desc&limit=6&units=${m.units}`;
      // Missing readings come as "."; they are skipped.
      const obs = await led.tryRead(source, url, {
        ttlMs: 3600000, staleMs: 86400000, key: 'obs:' + m.id, shared: true,
        transform: (d) => (d?.observations || []).map((o) => ({ date: String(o.date), value: num(o.value) })).filter((o) => o.value !== null && /^\d{4}-\d{2}-\d{2}$/.test(o.date))
      });
      if (!obs || !obs.length) return null;
      return { id: m.id, name: m.name, value: Number(obs[0].value.toFixed(2)), unit: m.unit, period: periodLabel(obs[0].date, m.period), previous: obs[1] ? Number(obs[1].value.toFixed(2)) : null };
    }));
    return rows.filter(Boolean);
  }

  // Dates, past and still to come, of the releases in the table above. Each release is asked
  // about on its own (two small calls, kept for hours), which costs far less than paging
  // through the calendar of every release FRED tracks.
  async function releaseDates(led) {
    const year = new Date(now()).getUTCFullYear();
    const lists = await Promise.all(Object.keys(RELEASES).map(async (id) => {
      const name = await led.tryRead(source, `${API}/release?release_id=${id}&api_key=${encodeURIComponent(key)}&file_type=json`, {
        ttlMs: 86400000, staleMs: 7 * 86400000, key: 'release:' + id, shared: true,
        transform: (d) => { const n = d?.releases?.[0]?.name; return typeof n === 'string' && n ? n : null; }
      });
      if (!name) return [];
      const dates = await led.tryRead(source, `${API}/release/dates?release_id=${id}&api_key=${encodeURIComponent(key)}&file_type=json&realtime_start=${year}-01-01&include_release_dates_with_no_data=true&sort_order=desc&limit=200`, {
        ttlMs: 6 * 3600000, staleMs: 3 * 86400000, key: `dates:${id}:${year}`, shared: true,
        transform: (d) => (d?.release_dates || []).map((r) => String(r.date)).filter((x) => /^\d{4}-\d{2}-\d{2}$/.test(x))
      });
      return (dates || []).map((date) => ({ id: Number(id), name, date }));
    }));
    return lists.flat();
  }
  return { macro, releaseDates };
}
