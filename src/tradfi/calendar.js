// Federal Reserve policy meetings.
//
// The Federal Reserve publishes its meeting schedule a year or more ahead on one page
// (https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm). It changes a handful of
// times a year, so the dates are kept here as read from that page on the date below, and the
// answer says so. Dates are "tentative until confirmed at the meeting immediately preceding"
// in the Fed's words. When the table runs out, the calendar says it has no dates; it never
// extends the pattern by guessing.

import { DAY, isoDay } from './util.js';

export const FOMC_AS_OF = '2026-11-19';
export const FOMC_URL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
// [first day, last day, has economic projections, minutes release date if the Fed lists one]
export const FOMC_MEETINGS = [
  ['2026-01-27', '2026-01-28', false, '2026-02-18'],
  ['2026-03-17', '2026-03-18', true, '2026-04-08'],
  ['2026-04-28', '2026-04-29', false, '2026-05-20'],
  ['2026-06-16', '2026-06-17', true, '2026-07-08'],
  ['2026-07-28', '2026-07-29', false, '2026-08-19'],
  ['2026-09-15', '2026-09-16', true, '2026-10-07'],
  ['2026-10-27', '2026-10-28', false, '2026-11-18'],
  ['2026-12-08', '2026-12-09', true, null],
  ['2027-01-26', '2027-01-27', false, null],
  ['2027-03-16', '2027-03-17', false, null],
  ['2027-04-27', '2027-04-28', false, null],
  ['2027-06-08', '2027-06-09', false, null],
  ['2027-07-27', '2027-07-28', false, null],
  ['2027-09-14', '2027-09-15', false, null],
  ['2027-10-26', '2027-10-27', false, null],
  ['2027-11-16', '2027-11-17', false, null],
  ['2028-01-25', '2028-01-26', false, null]
];
export const FOMC_NOTE = `Meeting dates as published by the Federal Reserve, read on ${FOMC_AS_OF}. Dates are tentative until the Fed confirms them at the preceding meeting.`;

export function fomcEvents(fromMs, toMs) {
  const events = [];
  const inRange = (d) => { const t = Date.parse(d + 'T00:00:00Z'); return t >= fromMs && t <= toMs; };
  for (const [first, last, projections, minutes] of FOMC_MEETINGS) {
    if (inRange(last)) {
      events.push({
        date: last, time: null, kind: 'central-bank', title: 'Federal Reserve policy decision (FOMC meeting ends)', symbol: null,
        detail: `Two-day meeting, ${first} to ${last}.${projections ? ' Includes the Summary of Economic Projections.' : ''} Tentative until confirmed by the Fed.`,
        importance: 3, source: 'Federal Reserve', url: FOMC_URL
      });
    }
    // The Fed releases minutes three weeks after the decision; where it has not yet listed
    // the date, that rule gives it and the event says it is expected, not confirmed.
    const when = minutes || isoDay(Date.parse(last + 'T00:00:00Z') + 21 * DAY);
    if (inRange(when)) {
      events.push({
        date: when, time: null, kind: 'central-bank', title: 'Federal Reserve meeting minutes', symbol: null,
        detail: `Minutes of the ${first} to ${last} meeting.${minutes ? '' : ' Expected date: the Fed releases minutes three weeks after the decision.'}`,
        importance: 2, source: 'Federal Reserve', url: FOMC_URL
      });
    }
  }
  return events;
}
export const fomcCoversUntil = () => FOMC_MEETINGS[FOMC_MEETINGS.length - 1][1];
