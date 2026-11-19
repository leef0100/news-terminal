// US Treasury daily par yield curve, from the Treasury's own XML feed (no key).
// One request returns a month of business days; the newest day is the curve shown.
// The Treasury publishes each day's figures after the market closes, so this is
// end-of-day data and is labelled with its date.

import { XMLParser } from 'fast-xml-parser';
import { num, plainXml } from './util.js';

const FEED = 'https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml';
// Feed field -> the label shown. The six-week bill (1.5 months) was added in 2025.
const TENORS = [['BC_1MONTH', '1M'], ['BC_1_5MONTH', '1.5M'], ['BC_2MONTH', '2M'], ['BC_3MONTH', '3M'], ['BC_4MONTH', '4M'], ['BC_6MONTH', '6M'],
  ['BC_1YEAR', '1Y'], ['BC_2YEAR', '2Y'], ['BC_3YEAR', '3Y'], ['BC_5YEAR', '5Y'], ['BC_7YEAR', '7Y'], ['BC_10YEAR', '10Y'], ['BC_20YEAR', '20Y'], ['BC_30YEAR', '30Y']];
const parser = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false });

// The feed's XML -> days, oldest first: [{ date: 'YYYY-MM-DD', points: [{ tenor, value }] }]
export function parseYieldFeed(xml) {
  const doc = parser.parse(plainXml(xml));
  // An error page is a failure; a real feed with no entries (the first days of a month) is not.
  if (!doc || (typeof doc.feed !== 'object' && doc.feed !== '')) throw new Error('Not a Treasury yield feed');
  const entries = [].concat(doc.feed?.entry || []);
  const days = [];
  for (const e of entries) {
    const p = e?.content?.properties;
    const date = String(p?.NEW_DATE || '').slice(0, 10);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) continue;
    const points = [];
    for (const [field, tenor] of TENORS) { const value = num(typeof p[field] === 'object' ? null : p[field]); if (value !== null) points.push({ tenor, value }); }
    if (points.length) days.push({ date, points });
  }
  return days.sort((a, b) => (a.date < b.date ? -1 : 1));
}

export function createTreasury({ source, now = Date.now }) {
  const monthUrl = (d) => `${FEED}?data=daily_treasury_yield_curve&field_tdr_date_value_month=${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  // The latest curve and the one before it. Early in a month there may be no day yet,
  // or only one, so last month is read too when needed.
  async function latest(led) {
    const opts = { ttlMs: 3600000, staleMs: 3 * 86400000, as: 'text', transform: parseYieldFeed };
    const d = new Date(now());
    let days = await led.read(source, monthUrl(d), opts);
    if (days.length < 2) {
      d.setUTCDate(0);
      const before = await led.tryRead(source, monthUrl(d), opts);
      // Oldest first, one entry a day (the two months can never overlap, but nothing relies on that).
      const have = new Set(days.map((x) => x.date));
      days = [...(before || []).filter((x) => !have.has(x.date)), ...days];
    }
    if (!days.length) return null;
    const last = days[days.length - 1];
    return { asOf: last.date, points: last.points, previous: days.length > 1 ? days[days.length - 2] : null };
  }
  return { latest };
}
