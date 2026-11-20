// What large managers and insiders reported to the SEC: Form 13F holdings, Forms 3/4/5
// (insider transactions) and Schedules 13D/13G (stakes above 5%).
//
// Everything is read from SEC EDGAR through the module's one SEC source, so the same
// User-Agent, cache, request budget and per-visitor share apply. What a 13F is and is not
// (quarterly, up to 45 days late, US-listed shares and some options only, no shorts) is said
// on the page; here the rules are about reading the filings correctly:
//   - a filing is read from its complete submission text file, which is named by the
//     accession number and holds every document with its type, so no file name is guessed;
//     the filing's index is the fallback;
//   - `value` was in thousands of dollars until the form changed on 3 January 2023 and is in
//     dollars since, decided by the filing date;
//   - an amendment either restates the whole table or adds holdings to it;
//   - rows of the same CUSIP and put/call are added together;
//   - quarter-over-quarter changes compare share counts, never values, so a price move is
//     not mistaken for a trade.
// See docs/TRADFI-SOURCES.md, section "Funds", for what was verified and how.

import { XMLParser } from 'fast-xml-parser';
import { bad, num, plainXml, round, SYMBOL_RE } from './util.js';
import { visitor } from './source.js';

const WWW = 'https://www.sec.gov';
const DATA = 'https://data.sec.gov';
const MIN = 60000, HOUR = 3600000;
const pad10 = (cik) => String(cik).padStart(10, '0');
const flat = (acc) => acc.replace(/-/g, '');
const ACC = /^\d{10}-\d{2}-\d{6}$/;
const xml = new XMLParser({ ignoreAttributes: true, removeNSPrefix: true, parseTagValue: false, htmlEntities: true });

// The managers tracked. Every number was checked against sec.gov on 2026-11-19 (a filing
// index or a filing title naming the filer under that number); `match` must appear in the
// name EDGAR returns, or the manager is shown as an error rather than under a wrong name.
export const MANAGERS = [
  ['1067983', 'Berkshire Hathaway', 'BERKSHIRE'],
  ['1423053', 'Citadel Advisors', 'CITADEL'],
  ['1595888', 'Jane Street Group', 'JANESTREET', true],
  ['1446194', 'Susquehanna International Group', 'SUSQUEHANNA', true],
  ['1350694', 'Bridgewater Associates', 'BRIDGEWATER'],
  ['1037389', 'Renaissance Technologies', 'RENAISSANCE'],
  ['1179392', 'Two Sigma Investments', 'TWOSIGMA'],
  ['1273087', 'Millennium Management', 'MILLENNIUM'],
  ['1603466', 'Point72 Asset Management', 'POINT72'],
  ['1009207', 'D. E. Shaw & Co.', 'SHAW'],
  ['1167557', 'AQR Capital Management', 'AQR'],
  ['1167483', 'Tiger Global Management', 'TIGERGLOBAL'],
  ['1135730', 'Coatue Management', 'COATUE'],
  ['1103804', 'Viking Global Investors', 'VIKING'],
  ['1061165', 'Lone Pine Capital', 'LONEPINE'],
  ['1336528', 'Pershing Square Capital Management', 'PERSHING'],
  ['1040273', 'Third Point', 'THIRDPOINT'],
  ['1791786', 'Elliott Investment Management', 'ELLIOTT'],
  ['1061768', 'Baupost Group', 'BAUPOST'],
  ['1656456', 'Appaloosa', 'APPALOOSA'],
  ['1536411', 'Duquesne Family Office', 'DUQUESNE'],
  ['1029160', 'Soros Fund Management', 'SOROS'],
  ['1079114', 'Greenlight Capital', 'GREENLIGHT'],
  ['923093', 'Tudor Investment Corp', 'TUDOR'],
  ['1649339', 'Scion Asset Management', 'SCION'],
  ['2045724', 'Situational Awareness LP', 'SITUATIONALAWARENESS']
].map(([cik, name, match, marketMaker]) => ({ id: pad10(cik), cik: Number(cik), name, match, marketMaker: Boolean(marketMaker) }));

// ---------------------------------------------------------------------------------------
// Reading filings
// ---------------------------------------------------------------------------------------

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const plain = (s) => String(s).replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]{2,5});/gi, (whole, e) => {
  if (e[0] !== '#') return Object.hasOwn(NAMED, e.toLowerCase()) ? NAMED[e.toLowerCase()] : whole;
  const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
  return code > 31 && code < 0x110000 ? String.fromCodePoint(code) : ' ';
}).replace(/\s+/g, ' ').trim();
const whole = (v) => { const s = String(v ?? '').replace(/[,\s]/g, ''); return /^\d+(\.\d+)?$/.test(s) ? Number(s) : null; };
const looksLikeWebPage = (s) => /<!DOCTYPE\s+html|<html[\s>]|<body[\s>]/i.test(s);

// Dollars per unit of `value` for a filing made on this date. The amended form took effect
// on 3 January 2023: values are "rounded to the nearest dollar" from then, thousands before.
export const VALUE_CHANGE = '2023-01-03';
export const valueScale = (filedAt) => (String(filedAt) >= VALUE_CHANGE ? 1 : 1000);

// A 13F information table -> positions, one per CUSIP and put/call (and shares or principal).
// The text is scanned row by row and never built into a tree: the largest tables run to tens
// of thousands of rows and several megabytes. At most `maxRows` rows are read; `capped` says
// when the table was longer. `value` is as filed (see valueScale). Element names may carry a
// namespace prefix ("ns1:infoTable"); both forms occur in real filings.
export function parseInfoTable(text, { maxRows = 60000, from = 0, to = text.length } = {}) {
  const head = text.slice(from, Math.min(to, from + 4000));
  if (looksLikeWebPage(head)) throw new Error('The SEC sent a web page where a 13F information table was expected');
  if (/<!DOCTYPE|<!ENTITY/i.test(head)) throw new Error('Not a plain 13F information table');
  const rootAt = text.slice(from, to).search(/<(?:[\w.-]+:)?informationTable[\s>]/i);
  if (rootAt < 0) throw new Error('Not a 13F information table');
  const open = /<(?:[\w.-]+:)?infoTable[\s>]/gi, close = /<\/(?:[\w.-]+:)?infoTable\s*>/gi;
  const leaf = /<(?:[\w.-]+:)?([A-Za-z0-9]+)(?:\s[^>]*)?>([^<]*)<\//g;
  const byKey = new Map();
  let rows = 0, skipped = 0, capped = false, pos = from + rootAt;
  for (;;) {
    open.lastIndex = pos;
    const a = open.exec(text);
    if (!a || a.index >= to) break;
    if (rows >= maxRows) { capped = true; break; }
    close.lastIndex = a.index;
    const b = close.exec(text);
    if (!b || b.index >= to) throw new Error('The 13F information table is incomplete');
    const block = text.slice(a.index, b.index + 2);
    pos = b.index + b[0].length;
    rows += 1;
    const f = {};
    leaf.lastIndex = 0;
    for (let m = leaf.exec(block); m; m = leaf.exec(block)) { const k = m[1].toLowerCase(); if (!(k in f)) f[k] = m[2]; }
    let cusip = plain(f.cusip ?? '').toUpperCase().replace(/\s/g, '');
    const value = whole(f.value), shares = whole(f.sshprnamt);
    // A spreadsheet drops leading zeros from a CUSIP; they are put back. Anything else odd is left out.
    if (/^[0-9A-Z]{6,8}$/.test(cusip)) cusip = cusip.padStart(9, '0');
    if (!/^[0-9A-Z]{9}$/.test(cusip) || value === null || shares === null) { skipped += 1; continue; }
    const pc = /^put$/i.test(plain(f.putcall ?? '')) ? 'Put' : /^call$/i.test(plain(f.putcall ?? '')) ? 'Call' : null;
    const unit = /^prn$/i.test(plain(f.sshprnamttype ?? '')) ? 'PRN' : 'SH';
    const key = cusip + '|' + (pc || '') + '|' + unit;
    const discretion = plain(f.investmentdiscretion ?? '').toUpperCase().slice(0, 12);
    const hit = byKey.get(key);
    if (hit) {
      hit.value += value; hit.shares += shares; hit.rows += 1;
      if (discretion && !hit.discretion.split('/').includes(discretion) && hit.discretion.length < 24) hit.discretion += (hit.discretion ? '/' : '') + discretion;
    } else byKey.set(key, { issuer: plain(f.nameofissuer ?? '').slice(0, 120), titleOfClass: plain(f.titleofclass ?? '').slice(0, 60), cusip, putCall: pc, unit, value, shares, discretion, rows: 1 });
  }
  // A table cut short by the transfer has rows but no end: that is a failure, not a short table.
  if (!capped && !/<\/(?:[\w.-]+:)?informationTable\s*>/i.test(text.slice(Math.max(from, pos - 1), to))) throw new Error('The 13F information table is incomplete');
  return { positions: [...byKey.values()], rows, skipped, capped };
}

const leafOf = (text, name) => { const m = new RegExp('<(?:[\\w.-]+:)?' + name + '(?:\\s[^>]*)?>([^<]*)</', 'i').exec(text); return m ? plain(m[1]) : ''; };
const usDay = (s) => { const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s); return m ? `${m[3]}-${m[1]}-${m[2]}` : /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };

// The cover and summary pages of a 13F (primary_doc.xml): whether it is an amendment and of
// which kind, and the totals the manager states.
export function parseCover(text) {
  if (!/<(?:[\w.-]+:)?edgarSubmission[\s>]/i.test(text)) throw new Error('Not a 13F cover page');
  const type = leafOf(text, 'amendmentType').toUpperCase();
  const amended = /^(true|y|yes|1)$/i.test(leafOf(text, 'isAmendment'));
  return {
    period: usDay(leafOf(text, 'reportCalendarOrQuarter')) || usDay(leafOf(text, 'periodOfReport')),
    isAmendment: amended,
    amendmentNo: whole(leafOf(text, 'amendmentNo')),
    amendmentType: /RESTATE/.test(type) ? 'restatement' : /NEW/.test(type) ? 'new holdings' : null,
    reportType: leafOf(text, 'reportType').slice(0, 40) || null,
    entryTotal: whole(leafOf(text, 'tableEntryTotal')),
    valueTotal: whole(leafOf(text, 'tableValueTotal'))
  };
}

// A complete submission text file -> its header and where each document's text lies.
export function splitSubmission(text) {
  if (text.indexOf('<DOCUMENT>') < 0) throw new Error(looksLikeWebPage(text.slice(0, 4000)) ? 'The SEC sent a web page where a filing was expected' : 'Not an SEC submission file');
  const headEnd = text.indexOf('<DOCUMENT>');
  const header = text.slice(0, Math.min(headEnd, 20000));
  const day = (label) => { const m = new RegExp(label + ':\\s*(\\d{4})(\\d{2})(\\d{2})').exec(header); return m ? `${m[1]}-${m[2]}-${m[3]}` : null; };
  const docs = [];
  for (let at = headEnd; at >= 0 && docs.length < 60; at = text.indexOf('<DOCUMENT>', at + 10)) {
    const end = text.indexOf('</DOCUMENT>', at);
    const intro = text.slice(at, at + 600);
    const body = text.indexOf('<TEXT>', at);
    docs.push({
      type: (/<TYPE>([^\r\n<]*)/.exec(intro) || [])[1]?.trim() || '', filename: (/<FILENAME>([^\r\n<]*)/.exec(intro) || [])[1]?.trim() || '',
      start: body >= 0 && (end < 0 || body < end) ? body + 6 : at, end: end < 0 ? text.length : end, complete: end >= 0
    });
    if (end < 0) break;
  }
  return { form: (/CONFORMED SUBMISSION TYPE:\s*(\S+)/.exec(header) || [])[1] || null, filedAt: day('FILED AS OF DATE'), period: day('CONFORMED PERIOD OF REPORT'), docs };
}

// One 13F filing, from its complete submission text file: the cover and the table.
export function read13F(text, { maxRows } = {}) {
  const sub = splitSubmission(text);
  const coverDoc = sub.docs.find((d) => /^13F-HR/i.test(d.type));
  const tableDoc = sub.docs.find((d) => /^INFORMATION TABLE/i.test(d.type)) || sub.docs.find((d) => /<(?:[\w.-]+:)?informationTable[\s>]/i.test(text.slice(d.start, Math.min(d.end, d.start + 3000))));
  let cover = null;
  if (coverDoc) { try { cover = parseCover(text.slice(coverDoc.start, coverDoc.end)); } catch { /* an old filing with a text cover */ } }
  if (!tableDoc) return { form: sub.form, filedAt: sub.filedAt, period: sub.period, cover, table: null };
  if (!tableDoc.complete) throw new Error('The 13F filing is incomplete');
  return { form: sub.form, filedAt: sub.filedAt, period: sub.period, cover, table: parseInfoTable(text, { maxRows, from: tableDoc.start, to: tableDoc.end }) };
}

// ---------------------------------------------------------------------------------------
// From positions to an answer
// ---------------------------------------------------------------------------------------

const keyOf = (p) => p.cusip + '|' + (p.putCall || '') + '|' + p.unit;
// Several filings for one quarter (an original and amendments that add holdings), each
// already in dollars, as one table.
export function addTables(tables) {
  const byKey = new Map();
  for (const t of tables) for (const p of t) {
    const hit = byKey.get(keyOf(p));
    if (hit) { hit.value += p.value; hit.shares += p.shares; hit.rows += p.rows; } else byKey.set(keyOf(p), { ...p });
  }
  return [...byKey.values()];
}

const isShare = (p) => !p.putCall && p.unit === 'SH';
const price = (p) => (p.shares > 0 ? p.value / p.shares : 0);

// Latest against previous quarter, for plain share positions only, by share count. The
// largest increases and decreases are ranked by the change in shares valued at the latest
// quarter's reported price (value divided by shares), so a move in a small stock does not
// outrank one in a large stock merely for having more shares.
export function compare(latest, previous, { limit = 25 } = {}) {
  const now = new Map(latest.filter(isShare).map((p) => [p.cusip, p]));
  const then = new Map(previous.filter(isShare).map((p) => [p.cusip, p]));
  const row = (p, q) => {
    const shares = p ? p.shares : 0, was = q ? q.shares : 0;
    const base = p || q;
    return {
      issuer: base.issuer, titleOfClass: base.titleOfClass, cusip: base.cusip, shares, previousShares: was, sharesDelta: shares - was,
      sharesChangePct: was > 0 ? round((shares - was) / was * 100, 2) : null, value: p ? p.value : 0, previousValue: q ? q.value : 0
    };
  };
  const out = { new: [], exits: [], increases: [], decreases: [] };
  let unchanged = 0;
  for (const [cusip, p] of now) {
    const q = then.get(cusip);
    if (!q || q.shares === 0) out.new.push(row(p, null));
    else if (p.shares > q.shares) out.increases.push({ ...row(p, q), weight: (p.shares - q.shares) * price(p) });
    else if (p.shares < q.shares) out.decreases.push({ ...row(p, q), weight: (q.shares - p.shares) * price(p) });
    else unchanged += 1;
  }
  for (const [cusip, q] of then) if (!now.has(cusip) && q.shares > 0) out.exits.push(row(null, q));
  out.new.sort((a, b) => b.value - a.value || a.cusip.localeCompare(b.cusip));
  out.exits.sort((a, b) => b.previousValue - a.previousValue || a.cusip.localeCompare(b.cusip));
  for (const k of ['increases', 'decreases']) out[k].sort((a, b) => b.weight - a.weight || a.cusip.localeCompare(b.cusip));
  const counts = { new: out.new.length, exits: out.exits.length, increases: out.increases.length, decreases: out.decreases.length, unchanged };
  const cut = (list) => list.slice(0, limit).map(({ weight, ...r }) => r);
  return { basis: 'shares', counts, new: cut(out.new), exits: cut(out.exits), increases: cut(out.increases), decreases: cut(out.decreases) };
}

// The figures of one manager's latest quarter. `previous` is null when there is no earlier
// table to compare with, or when either table was cut short (the comparison would invent
// new positions and exits).
export function summarise(latest, previous, { top = 100, limit = 25 } = {}) {
  const total = latest.reduce((s, p) => s + p.value, 0);
  const share = (v) => (total > 0 ? round(v / total * 100, 2) : null);
  const then = previous ? new Map(previous.filter(isShare).map((p) => [p.cusip, p])) : null;
  const byValue = (a, b) => b.value - a.value || a.cusip.localeCompare(b.cusip) || String(a.putCall).localeCompare(String(b.putCall));
  const held = latest.filter((p) => !p.putCall).sort(byValue);
  const options = latest.filter((p) => p.putCall).sort(byValue);
  const holding = (p) => {
    const was = then && isShare(p) ? (then.get(p.cusip)?.shares ?? 0) : null;
    return {
      issuer: p.issuer, titleOfClass: p.titleOfClass, cusip: p.cusip, value: p.value, shares: p.shares, unit: p.unit, pct: share(p.value), discretion: p.discretion || null,
      previousShares: was, change: was === null ? null : was === 0 ? 'new' : p.shares > was ? 'increase' : p.shares < was ? 'decrease' : 'unchanged'
    };
  };
  return {
    totals: { value: total, holdingsValue: held.reduce((s, p) => s + p.value, 0), optionsValue: options.reduce((s, p) => s + p.value, 0), positions: held.length, optionPositions: options.length },
    holdings: held.slice(0, top).map(holding),
    options: options.slice(0, top).map((p) => ({ issuer: p.issuer, titleOfClass: p.titleOfClass, cusip: p.cusip, putCall: p.putCall, value: p.value, shares: p.shares, pct: share(p.value) })),
    changes: previous ? compare(latest, previous, { limit }) : null
  };
}

// ---------------------------------------------------------------------------------------
// Issuer names to tickers. The SEC publishes no CUSIP-to-ticker map, so a ticker is shown
// only when the issuer's name, normalised, is exactly the name of one company in the SEC's
// ticker file and the row is that company's ordinary share. Anything less is left unlinked.
// ---------------------------------------------------------------------------------------

const SAME = { INCORPORATED: 'INC', CORPORATION: 'CORP', COMPANY: 'CO', LIMITED: 'LTD', HOLDINGS: 'HLDGS', HOLDING: 'HLDG', INTERNATIONAL: 'INTL' };
// The 13F list of securities adds the state to some names ("BERKSHIRE HATHAWAY INC DEL").
const TAIL = new Set(['DEL', 'NEW', 'MD', 'NEV']);
export function nameKey(name) {
  const s = String(name || '').toUpperCase().replace(/\s*\/[A-Z]{2,4}\/?\s*$/, '').replace(/&/g, ' AND ').replace(/[^A-Z0-9]+/g, ' ').trim().replace(/^THE /, '');
  const words = s.split(' ').map((w) => (Object.hasOwn(SAME, w) ? SAME[w] : w));
  while (words.length > 2 && TAIL.has(words[words.length - 1])) words.pop();
  return words.join(' ');
}
const NOT_SHARES = /\b(NOTE|NOTES|DEB|DEBT|BOND|PFD|PREF|PREFERRED|WT|WTS|WARRANT|WARRANTS|UNIT|UNITS|RIGHT|RIGHTS|RT)\b/;
const ORDINARY = /^(COM|COMMON|SHS|ORD|CAP STK|STOCK)\b/;
const titleKey = (t) => String(t || '').toUpperCase().replace(/[^A-Z0-9]+/g, ' ').trim();
// `list` is the SEC ticker file as rows of { symbol, name, cik }.
export function buildNameIndex(list) {
  const byName = new Map();   // name key -> Set of ciks
  const byCik = new Map();    // cik -> [symbols]
  for (const c of list) {
    const k = nameKey(c.name);
    if (!k) continue;
    if (!byName.has(k)) byName.set(k, new Set());
    byName.get(k).add(c.cik);
    if (!byCik.has(c.cik)) byCik.set(c.cik, []);
    byCik.get(c.cik).push(c.symbol);
  }
  const index = new Map();    // name key -> { symbol, ordinaryOnly }
  for (const [k, ciks] of byName) {
    if (ciks.size !== 1) continue;                        // two companies share the name: no match
    const symbols = byCik.get([...ciks][0]);
    if (symbols.length === 1) { index.set(k, { symbol: symbols[0], ordinaryOnly: false }); continue; }
    // Several tickers (other share classes, preferreds, warrants): only when exactly one has
    // no class suffix, and then only for a row titled as the ordinary share.
    const bare = symbols.filter((s) => !/[-.]/.test(s));
    if (bare.length === 1) index.set(k, { symbol: bare[0], ordinaryOnly: true });
  }
  return index;
}
export function symbolFor(index, issuer, titleOfClass, unit = 'SH') {
  if (!index || unit !== 'SH') return null;
  const hit = index.get(nameKey(issuer));
  if (!hit) return null;
  const t = titleKey(titleOfClass);
  if (NOT_SHARES.test(t)) return null;
  if (hit.ordinaryOnly && !(ORDINARY.test(t) && !/\b(CL|CLASS|SER|SERIES)\b/.test(t))) return null;
  return hit.symbol;
}

// ---------------------------------------------------------------------------------------
// Forms 3, 4 and 5
// ---------------------------------------------------------------------------------------

// The SEC's transaction codes, in plain words. `kind` groups them for the page's filter.
export const CODES = {
  P: ['purchase', 'Purchase (open market or private)'],
  S: ['sale', 'Sale (open market or private)'],
  A: ['award', 'Grant or award from the company'],
  M: ['exercise', 'Option exercise or conversion'],
  X: ['exercise', 'Option exercise'],
  O: ['exercise', 'Option exercise (out of the money)'],
  C: ['exercise', 'Conversion of a derivative'],
  F: ['tax', 'Shares withheld for tax or an exercise price'],
  G: ['gift', 'Gift'],
  D: ['other', 'Returned or sold to the company'],
  W: ['other', 'Inheritance'],
  L: ['other', 'Small acquisition'],
  I: ['other', 'Discretionary plan transaction'],
  U: ['other', 'Tendered in a change of control'],
  Z: ['other', 'Voting trust deposit or withdrawal'],
  E: ['other', 'Expiry of a short derivative position'],
  H: ['other', 'Expiry or cancellation of a derivative position'],
  K: ['other', 'Equity swap or similar'],
  J: ['other', 'Other acquisition or disposal (described in the filing)']
};
export const meaningOf = (code) => (Object.hasOwn(CODES, code) ? { kind: CODES[code][0], meaning: CODES[code][1] } : { kind: 'other', meaning: code ? `Code ${code} (see the filing)` : 'Not stated' });

const val = (x) => (x && typeof x === 'object' ? x.value : x);
const text = (x, max = 80) => { const v = val(x); return typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\s+/g, ' ').trim().slice(0, max) : ''; };
const flag = (x) => /^(1|true|y)$/i.test(text(x, 8));
const dayOf = (x) => { const s = text(x, 30).slice(0, 10); return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null; };
const list = (x) => [].concat(x ?? []).filter((v) => v && typeof v === 'object');

// An ownership document (Form 3, 4 or 5), alone or inside a complete submission text file.
export function parseOwnership(body) {
  const a = body.indexOf('<ownershipDocument'), b = body.indexOf('</ownershipDocument>');
  if (a < 0 || b < a) throw new Error(looksLikeWebPage(body.slice(0, 4000)) ? 'The SEC sent a web page where an ownership form was expected' : 'Not an ownership form');
  // A document type or entity declared just ahead of the form is refused along with the form.
  const d = xml.parse(plainXml(body.slice(Math.max(0, a - 2000), a).replace(/[^]*<XML>/i, '') + body.slice(a, b + 20), 2e6).slice(-(b + 20 - a)))?.ownershipDocument;
  if (!d || typeof d !== 'object') throw new Error('Not an ownership form');
  const owners = list(d.reportingOwner).map((o) => {
    const r = o.reportingOwnerRelationship || {};
    const roles = [];
    if (flag(r.isDirector)) roles.push('Director');
    if (flag(r.isOfficer)) roles.push(text(r.officerTitle, 60) || 'Officer');
    if (flag(r.isTenPercentOwner)) roles.push('10% owner');
    if (flag(r.isOther)) roles.push(text(r.otherText, 60) || 'Other');
    return { name: text(o.reportingOwnerId?.rptOwnerName, 100), role: roles.join(', ') || null };
  }).filter((o) => o.name);
  const symbol = text(d.issuer?.issuerTradingSymbol, 16).toUpperCase();
  const row = (t, derivative) => {
    const code = text(t.transactionCoding?.transactionCode, 2).toUpperCase();
    const amounts = t.transactionAmounts || {};
    const shares = num(val(amounts.transactionShares)), px = num(val(amounts.transactionPricePerShare));
    const ad = text(amounts.transactionAcquiredDisposedCode, 2).toUpperCase();
    const di = text(t.ownershipNature?.directOrIndirectOwnership, 2).toUpperCase();
    const under = t.underlyingSecurity || {};
    return {
      date: dayOf(t.transactionDate), code, ...meaningOf(code), acquired: ad === 'A' ? true : ad === 'D' ? false : null,
      shares, price: px, value: shares !== null && px !== null && px > 0 ? round(shares * px, 2) : null,
      sharesAfter: num(val(t.postTransactionAmounts?.sharesOwnedFollowingTransaction)),
      security: text(t.securityTitle, 80) || null, derivative, direct: di === 'D' ? true : di === 'I' ? false : null,
      underlying: derivative ? (text(under.underlyingSecurityTitle, 80) || null) : null, underlyingShares: derivative ? num(val(under.underlyingSecurityShares)) : null
    };
  };
  const transactions = list(d.nonDerivativeTable?.nonDerivativeTransaction).map((t) => row(t, false)).concat(list(d.derivativeTable?.derivativeTransaction).map((t) => row(t, true)));
  return {
    form: text(d.documentType, 6) || null, period: dayOf(d.periodOfReport),
    issuer: { cik: num(text(d.issuer?.issuerCik, 12)), name: text(d.issuer?.issuerName, 120) || null, symbol: SYMBOL_RE.test(symbol) ? symbol : null },
    owners, planned: flag(d.aff10b5One), transactions: transactions.slice(0, 60)
  };
}

// ---------------------------------------------------------------------------------------
// The live service
// ---------------------------------------------------------------------------------------

const NOTE_13F = 'Form 13F holdings as filed with the SEC. Quarterly, up to 45 days after quarter end.';
const OPTION_NOTE = 'Options are listed apart. Their value and share count describe the shares the options are written on, not what the options cost.';

export function createFunds({ source, edgar, now = Date.now, log = console, tuning = {} }) {
  const maxRows = tuning.fundRows ?? 60000;
  const parallel = tuning.fundsParallel ?? 2, gapMs = tuning.fundsGapMs ?? 1500;
  const freshMs = tuning.fundsFreshMs ?? 6 * HOUR, retryMs = tuning.fundsRetryMs ?? 2 * MIN;
  const sleep = tuning.sleep || ((ms) => new Promise((r) => { const t = setTimeout(r, ms); t.unref?.(); }));
  const byId = new Map(MANAGERS.map((m) => [m.id, m]));
  const store = new Map();      // manager id -> { state: 'ready'|'none'|'error', at, ... }
  const building = new Map();   // manager id -> promise
  let warming = null, stopped = false;

  const filingUrl = (cik, acc) => `${WWW}/Archives/edgar/data/${cik}/${flat(acc)}/${acc}-index.htm`;
  const BIG = { ttlMs: 7 * 24 * HOUR, as: 'text', timeoutMs: 30000, maxBytes: (tuning.fundMaxMb ?? 64) * 1024 * 1024 };

  // The manager's 13F filings, newest first, from its submissions file.
  const filingsOf = (m) => source.get(`${DATA}/submissions/CIK${m.id}.json`, {
    key: 'funds:13f:' + m.id, ttlMs: 30 * MIN, staleMs: 24 * HOUR, maxBytes: 16 * 1024 * 1024,
    transform: (s) => {
      const r = s?.filings?.recent || {};
      const out = [];
      let notices = 0;
      for (let i = 0; i < (r.accessionNumber || []).length && out.length < 24; i++) {
        const form = String(r.form?.[i] || ''), acc = String(r.accessionNumber[i]);
        if (/^13F-NT/.test(form)) notices += 1;
        const period = String(r.reportDate?.[i] || '').slice(0, 10), filedAt = String(r.filingDate?.[i] || '').slice(0, 10);
        if (!/^13F-HR(\/A)?$/.test(form) || !ACC.test(acc) || !/^\d{4}-\d{2}-\d{2}$/.test(period) || !/^\d{4}-\d{2}-\d{2}$/.test(filedAt)) continue;
        out.push({ form, accession: acc, period, filedAt });
      }
      return { name: String(s?.name || '').slice(0, 120), former: [].concat(s?.formerNames || []).map((f) => String(f?.name || '')), filings: out, notices };
    }
  }).then((r) => r.data);

  // One filing's cover and table. The complete submission text file is tried first; if it
  // cannot be used, the filing's own index says which file is the table.
  async function filing(m, f) {
    let got = null;
    try {
      got = (await source.get(`${WWW}/Archives/edgar/data/${m.cik}/${flat(f.accession)}/${f.accession}.txt`, { ...BIG, missing: [404], transform: (t) => read13F(t, { maxRows }) })).data;
    } catch (e) { if (e?.status === 429 || e?.publicMessage) throw e; }
    if (got?.table) return got;
    const dir = `${WWW}/Archives/edgar/data/${m.cik}/${flat(f.accession)}/`;
    const names = (await source.get(dir + 'index.json', { ttlMs: 7 * 24 * HOUR, transform: (j) => [].concat(j?.directory?.item || []).map((x) => ({ name: String(x?.name || ''), size: Number(x?.size) || 0 })).filter((x) => /^[\w.\-]+\.xml$/i.test(x.name) && !x.name.includes('..')) })).data;
    const tables = names.filter((x) => !/^primary_doc\.xml$/i.test(x.name)).sort((a, b) => (/info|table|13f/i.test(b.name) - /info|table|13f/i.test(a.name)) || b.size - a.size);
    if (!tables.length) throw new Error('No information table is listed in the 13F filing');
    const table = (await source.get(dir + tables[0].name, { ...BIG, transform: (t) => parseInfoTable(t, { maxRows }) })).data;
    let cover = got?.cover || null;
    if (!cover && /\/A$/.test(f.form) && names.some((x) => /^primary_doc\.xml$/i.test(x.name))) {
      cover = (await source.get(dir + 'primary_doc.xml', { ttlMs: 7 * 24 * HOUR, as: 'text', transform: parseCover }).catch(() => null))?.data || null;
    }
    return { form: f.form, filedAt: f.filedAt, period: f.period, cover, table };
  }

  // Everything a manager filed for one quarter, as one table in dollars. The newest
  // restatement replaces what came before it; amendments that add holdings are added on.
  async function quarter(m, filings) {
    const asc = filings.slice().sort((a, b) => a.filedAt.localeCompare(b.filedAt) || a.accession.localeCompare(b.accession));
    const amendments = asc.filter((f) => /\/A$/.test(f.form)).slice(-3);
    const original = asc.find((f) => !/\/A$/.test(f.form)) || null;
    const read = new Map();
    const notes = [];
    for (const f of amendments) {
      try { read.set(f.accession, await filing(m, f)); } catch (e) {
        if (e?.status === 429) throw e;
        notes.push(`An amendment filed on ${f.filedAt} could not be read and is not included.`);
      }
    }
    const typed = amendments.filter((f) => read.has(f.accession)).map((f) => ({ f, kind: read.get(f.accession).cover?.amendmentType || null }));
    for (const t of typed) if (!t.kind) notes.push(`An amendment filed on ${t.f.filedAt} does not say whether it restates the table or adds to it, and is not included.`);
    const restated = typed.filter((t) => t.kind === 'restatement').pop() || null;
    let base = restated ? restated.f : original;
    if (!base) {
      // Only amendments that add holdings are on file for this quarter: shown as far as they go.
      if (!typed.some((t) => t.kind === 'new holdings')) throw new Error('No readable 13F table for the quarter');
      notes.push('Only amendments adding holdings were found for this quarter; the original filing is not in the recent list, so the table is partial.');
    }
    if (base && !read.has(base.accession)) read.set(base.accession, await filing(m, base));
    const parts = [];
    if (base) parts.push({ f: base, role: restated ? 'restatement' : 'original' });
    for (const t of typed) if (t.kind === 'new holdings' && (!base || t.f.filedAt > base.filedAt || (t.f.filedAt === base.filedAt && t.f.accession > base.accession))) parts.push({ f: t.f, role: 'new holdings' });
    const tables = parts.map(({ f }) => { const k = valueScale(f.filedAt); return read.get(f.accession).table.positions.map((p) => ({ ...p, value: p.value * k })); });
    const got = parts.map(({ f }) => read.get(f.accession).table);
    const last = parts[parts.length - 1].f, first = parts[0].f;
    return {
      period: first.period, form: first.form, filedAt: last.filedAt, accession: first.accession, url: filingUrl(m.cik, first.accession),
      amended: parts.length > 1 || Boolean(restated), valueUnit: valueScale(first.filedAt) === 1 ? 'dollars' : 'thousands',
      parts: parts.map(({ f, role }) => ({ form: f.form, filedAt: f.filedAt, accession: f.accession, role, url: filingUrl(m.cik, f.accession) })),
      rows: got.reduce((s, t) => s + t.rows, 0), skipped: got.reduce((s, t) => s + t.skipped, 0), capped: got.some((t) => t.capped),
      stated: read.get(first.accession).cover ? { entries: read.get(first.accession).cover.entryTotal, value: read.get(first.accession).cover.valueTotal === null ? null : read.get(first.accession).cover.valueTotal * valueScale(first.filedAt) } : null,
      positions: parts.length === 1 ? tables[0] : addTables(tables), notes
    };
  }

  async function build(m) {
    const subs = await filingsOf(m);
    const edgarName = [subs.name, ...subs.former].join(' ').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!edgarName.includes(m.match)) throw Object.assign(new Error(`EDGAR lists number ${m.id} under another name (${subs.name})`), { wrongName: true });
    if (!subs.filings.length) {
      return { state: 'none', at: now(), filerName: subs.name, note: subs.notices ? 'This manager files 13F notices only: its holdings are reported by another manager.' : 'No 13F holdings report is among this manager’s recent filings.' };
    }
    const periods = [...new Set(subs.filings.map((f) => f.period))].sort().reverse();
    const of = (period) => subs.filings.filter((f) => f.period === period);
    const latest = await quarter(m, of(periods[0]));
    const notes = latest.notes.slice();
    let previous = null;
    if (periods[1]) {
      try { previous = await quarter(m, of(periods[1])); } catch (e) {
        if (e?.status === 429) throw e;
        notes.push('The previous quarter’s filing could not be read, so changes are not shown.');
      }
    } else notes.push('No earlier 13F is among this manager’s recent filings, so changes are not shown.');
    const comparable = Boolean(previous) && !latest.capped && !previous.capped;
    if (latest.capped) notes.push(`This table is very long: the first ${latest.rows.toLocaleString('en-US')} rows were read and the rest left out, so totals are understated and changes are not shown.`);
    else if (previous?.capped) notes.push('The previous quarter’s table was too long to read in full, so changes are not shown.');
    if (previous) notes.push(...previous.notes.map((n) => 'Previous quarter: ' + n));
    if (latest.amended) notes.push(latest.parts.some((p) => p.role === 'restatement') ? 'This quarter’s table was restated by an amendment; the restated table is shown.' : 'An amendment added holdings to this quarter’s table; they are included.');
    if (latest.skipped) notes.push(`${latest.skipped} ${latest.skipped === 1 ? 'row was' : 'rows were'} left out because the CUSIP, value or amount could not be read.`);
    if (previous && comparable) {
      const gap = (Date.parse(latest.period) - Date.parse(previous.period)) / 86400000;
      if (gap > 100) notes.push(`The filing before this one is for ${previous.period}, more than a quarter earlier; changes are measured against it.`);
      notes.push('Changes compare share counts with the previous filing. A share split, a merger or a new CUSIP for the same company shows up as a change though nothing was traded.');
    }
    const sum = summarise(latest.positions, comparable ? previous.positions : null);
    if (sum.totals.optionPositions) notes.push(OPTION_NOTE);
    if (latest.valueUnit === 'thousands') notes.push('This filing predates 3 January 2023, when values were reported in thousands of dollars; they are shown here in dollars.');
    // What /holders needs, kept small: plain share positions by issuer name.
    const names = new Map();
    const then = comparable ? new Map(previous.positions.filter(isShare).map((p) => [p.cusip, p.shares])) : null;
    for (const p of latest.positions) {
      if (!isShare(p)) continue;
      const k = nameKey(p.issuer);
      if (!names.has(k)) names.set(k, []);
      names.get(k).push({ titleOfClass: p.titleOfClass, shares: p.shares, value: p.value, previousShares: then ? (then.get(p.cusip) ?? 0) : null });
    }
    const strip = ({ positions, notes: _n, ...rest }) => rest;
    return { state: 'ready', at: now(), filerName: subs.name, filing: strip(latest), previous: previous ? (({ period, form, filedAt, accession, url, capped }) => ({ period, form, filedAt, accession, url, capped }))(previous) : null, ...sum, notes, names };
  }

  const stale = (m) => { const e = store.get(m.id); return !e || now() - e.at > (e.state === 'error' ? retryMs : freshMs); };
  function ensure(m) {
    if (building.has(m.id)) return building.get(m.id);
    const job = build(m).then((entry) => { store.set(m.id, entry); return entry; }, (e) => {
      // A visitor's own allowance running out says nothing about the manager.
      if (e?.status !== 429) {
        const old = store.get(m.id);
        if (old?.state === 'ready') store.set(m.id, { ...old, at: now() - freshMs + retryMs, refreshFailed: true });
        else store.set(m.id, { state: 'error', at: now(), note: e?.wrongName ? String(e.message) : (e?.publicMessage || 'The filing could not be read from the SEC just now.') });
        log.warn?.(`[tradfi] 13F for ${m.name} failed: ${e?.message || e}`);
      }
      throw e;
    }).finally(() => building.delete(m.id));
    building.set(m.id, job);
    return job;
  }
  // Fills the tables in slowly, a couple of managers at a time, on nobody's account.
  function warm() {
    if (warming || stopped || tuning.fundsWarm === false || !source.enabled) return;
    const todo = MANAGERS.filter(stale);
    if (!todo.length) return;
    const worker = async () => {
      for (let m = todo.shift(); m && !stopped; m = todo.shift()) {
        if (stale(m)) await ensure(m).catch(() => {});
        if (todo.length && !stopped) await sleep(gapMs);
      }
    };
    warming = visitor.exit(() => Promise.all(Array.from({ length: parallel }, worker))).catch(() => {}).finally(() => { warming = null; });
  }

  async function nameIndex(led) {
    const t = await edgar.tickers(led).catch(() => null);
    if (!t) return null;
    if (!t.nameIndex) Object.defineProperty(t, 'nameIndex', { value: buildNameIndex(t.list), enumerable: false });
    return t.nameIndex;
  }
  const secOff = (led) => { led.off(source.name, source.offNote); };
  const row = (m, e) => ({
    id: m.id, name: m.name, marketMaker: m.marketMaker, state: !e ? 'loading' : e.state, note: e && e.state !== 'ready' ? e.note : null,
    period: e?.filing?.period ?? null, filedAt: e?.filing?.filedAt ?? null, form: e?.filing?.form ?? null,
    value: e?.totals?.value ?? null, positions: e?.totals?.positions ?? null, optionPositions: e?.totals?.optionPositions ?? null, url: e?.filing?.url ?? null
  });
  const counts = () => { const loaded = MANAGERS.filter((m) => store.has(m.id)).length; return { tracked: MANAGERS.length, loaded, pending: MANAGERS.length - loaded }; };

  return {
    async funds(led) {
      if (!source.enabled) { secOff(led); return { managers: MANAGERS.map((m) => ({ ...row(m, null), state: 'off' })), tracked: MANAGERS.length, loaded: 0, pending: 0 }; }
      warm();
      const c = counts();
      led.ok(source.name, NOTE_13F + (c.pending ? ` ${c.pending} of ${c.tracked} managers’ filings are still being read.` : ''));
      return { managers: MANAGERS.map((m) => row(m, store.get(m.id))), ...c };
    },

    async fund(id, led) {
      const m = byId.get(id);
      if (!m) throw bad('Unknown manager. Only the managers listed by /funds are tracked.');
      const empty = { id: m.id, name: m.name, marketMaker: m.marketMaker, filerName: null, filing: null, previous: null, totals: null, holdings: [], options: [], changes: null, notes: [] };
      if (!source.enabled) { secOff(led); return { ...empty, state: 'off' }; }
      warm();
      let e = store.get(m.id);
      if (!e || e.state === 'error' || stale(m)) {
        try { e = await ensure(m); } catch (err) {
          e = store.get(m.id);
          if (e?.state !== 'ready') { led.error(source.name, err?.publicMessage || 'Did not answer.'); throw err; }
        }
      }
      if (e.state !== 'ready') { led.ok(source.name, NOTE_13F); return { ...empty, state: e.state, filerName: e.filerName || null, notes: [e.note] }; }
      const index = await nameIndex(led);
      led.ok(source.name, NOTE_13F + (e.refreshFailed ? ' The SEC could not be reached for a fresh copy just now; this is the saved one.' : ''));
      const sym = (p) => ({ ...p, symbol: symbolFor(index, p.issuer, p.titleOfClass, p.unit || 'SH') });
      const ch = e.changes;
      return {
        id: m.id, name: m.name, marketMaker: m.marketMaker, state: 'ready', filerName: e.filerName, filing: e.filing, previous: e.previous, totals: e.totals,
        holdings: e.holdings.map(sym), options: e.options.map(sym),
        changes: ch ? { basis: ch.basis, counts: ch.counts, new: ch.new.map(sym), exits: ch.exits.map(sym), increases: ch.increases.map(sym), decreases: ch.decreases.map(sym) } : null,
        notes: e.notes.concat(index ? [] : ['Tickers are not shown: the SEC’s company list could not be loaded.'])
      };
    },

    // Which tracked managers reported the share, from the tables already read. Never fetches a filing.
    async holders(symbol, led) {
      if (!source.enabled) { secOff(led); return { symbol, name: null, matched: false, holders: [], tracked: MANAGERS.length, loaded: 0, pending: 0, note: null }; }
      const c = await edgar.lookup(symbol, led);
      warm();
      const index = await nameIndex(led);
      const key = nameKey(c.name), hit = index?.get(key);
      const matched = Boolean(hit) && hit.symbol === c.symbol;
      const holders = [];
      if (matched) {
        for (const m of MANAGERS) {
          const e = store.get(m.id);
          const rows = e?.state === 'ready' ? (e.names.get(key) || []).filter((r) => symbolFor(index, c.name, r.titleOfClass) === c.symbol) : [];
          if (!rows.length) continue;
          const shares = rows.reduce((s, r) => s + r.shares, 0), value = rows.reduce((s, r) => s + r.value, 0);
          const was = rows[0].previousShares === null ? null : rows.reduce((s, r) => s + r.previousShares, 0);
          holders.push({
            id: m.id, name: m.name, marketMaker: m.marketMaker, period: e.filing.period, filedAt: e.filing.filedAt, shares, value,
            pct: e.totals.value > 0 ? round(value / e.totals.value * 100, 2) : null, previousShares: was,
            change: was === null ? null : was === 0 ? 'new' : shares > was ? 'increase' : shares < was ? 'decrease' : 'unchanged'
          });
        }
        holders.sort((a, b) => b.value - a.value);
      }
      const n = counts();
      led.ok(source.name, NOTE_13F);
      return {
        symbol: c.symbol, name: c.name, matched, holders, ...n,
        note: !matched ? '13F filings identify a security by CUSIP and issuer name, not by ticker, and this company’s name could not be matched to them with certainty, so no holders are listed.'
          : n.pending ? `${n.loaded} of ${n.tracked} tracked managers’ filings have been read so far; the rest are still loading.` : null
      };
    },

    warm,
    stop() { stopped = true; store.clear(); },
    size: () => ({ store: store.size, building: building.size })
  };
}

// ---------------------------------------------------------------------------------------
// Insider transactions and large stakes, live
// ---------------------------------------------------------------------------------------

export function createInsiders({ source, edgar, now = Date.now, tuning = {} }) {
  const perCompany = tuning.insiderDetails ?? 10, latestCount = tuning.insiderLatest ?? 30, waitMs = tuning.insiderWaitMs ?? 1500;
  const details = new Map();   // accession -> { at, data } ; data undefined = could not be read just now, null = no XML
  const keep = (acc, data) => { details.delete(acc); details.set(acc, { at: now(), data }); if (details.size > 3000) details.delete(details.keys().next().value); };
  const known = (acc) => { const d = details.get(acc); return d && (d.data !== undefined || now() - d.at < MIN) ? d : null; };
  const url = (cik, acc) => `${WWW}/Archives/edgar/data/${Number(cik)}/${flat(acc)}/${acc}.txt`;
  const page = (cik, acc) => `${WWW}/Archives/edgar/data/${Number(cik)}/${flat(acc)}/${acc}-index.htm`;
  async function detail(cik, acc) {
    const hit = known(acc);
    if (hit) return hit.data;
    let data;
    try {
      data = (await source.get(url(cik, acc), { ttlMs: 24 * HOUR, as: 'text', missing: [404], maxBytes: 2 * 1024 * 1024, transform: parseOwnership })).data;
    } catch (e) { if (e?.status === 429) throw e; }
    keep(acc, data);
    return data;
  }
  const NOTE = 'Insider transactions (Forms 3, 4 and 5) and stakes above 5% (Schedules 13D and 13G) as filed with the SEC.';

  // One filing -> the rows shown. A filing whose document was not read is one row saying so.
  function rowsOf(f, d, tickers) {
    const base = { form: f.form, filedAt: f.filedAt, accession: f.accession, url: f.url };
    if (!d) return [{ ...base, detail: false, issuer: f.issuer ?? null, symbol: f.symbol ?? null, owner: f.owner ?? null, role: null, date: null, code: null, kind: null, meaning: null, acquired: null, shares: null, price: null, value: null, sharesAfter: null, security: null, derivative: null, direct: null, planned: null, moreOwners: 0 }];
    // A ticker is linked only when the SEC's own list has it for this same company.
    const listed = d.issuer.symbol && tickers?.bySymbol.get(d.issuer.symbol);
    const symbol = f.symbol ?? (listed && listed.cik === d.issuer.cik ? listed.symbol : null);
    const who = { issuer: f.issuer ?? d.issuer.name, symbol, owner: d.owners[0]?.name ?? null, role: d.owners[0]?.role ?? null, moreOwners: Math.max(0, d.owners.length - 1), planned: d.planned };
    return d.transactions.map(({ underlying, underlyingShares, ...t }) => ({ ...base, form: d.form || f.form, detail: true, ...who, ...t }));
  }
  const newest = (a, b) => String(b.date || b.filedAt).localeCompare(String(a.date || a.filedAt)) || String(b.filedAt).localeCompare(String(a.filedAt));

  // The market-wide list reads each filing in the background, four at a time.
  let filling = null;
  function fill(entries) {
    if (filling) return filling;
    const todo = entries.filter((f) => !known(f.accession));
    if (!todo.length) return null;
    const worker = async () => { for (let f = todo.shift(); f; f = todo.shift()) await detail(f.cik, f.accession).catch(() => {}); };
    filling = visitor.exit(() => Promise.all([worker(), worker(), worker(), worker()])).catch(() => {}).finally(() => { filling = null; });
    return filling;
  }

  return {
    async insiders(symbol, led) {
      if (!source.enabled) { led.off(source.name, source.offNote); return { symbol, name: null, cik: null, transactions: [], stakes: [], detailsPending: 0 }; }
      const c = await edgar.lookup(symbol, led);
      const profile = await edgar.profile(c.cik, led);
      const filings = (profile.insiderFilings || []).map((f) => ({ ...f, url: page(c.cik, f.accession), issuer: profile.name || c.name, symbol: c.symbol }));
      const head = filings.filter((f) => /^4/.test(f.form)).slice(0, perCompany);
      const todo = head.slice();
      let refused = false;
      const worker = async () => { for (let f = todo.shift(); f && !refused; f = todo.shift()) await detail(c.cik, f.accession).catch(() => { refused = true; }); };
      await Promise.all([worker(), worker(), worker(), worker()]);
      const read = new Set(head.map((f) => f.accession));
      const transactions = filings.slice(0, 40).flatMap((f) => rowsOf(f, read.has(f.accession) ? details.get(f.accession)?.data : null, null)).sort(newest).slice(0, 80);
      const unread = head.filter((f) => !details.get(f.accession)?.data).length;
      led.ok(source.name, NOTE + (refused ? ' Some filings were not opened: too many new lookups from one address in the last minute.' : unread ? ` ${unread} of the newest filings could not be opened and are listed without details.` : '') + (filings.length > head.length ? ` Only the newest ${head.length} Form 4 filings are opened; older ones are listed without details.` : ''));
      return { symbol: c.symbol, name: profile.name || c.name, cik: pad10(c.cik), transactions, stakes: profile.stakeFilings || [], detailsPending: 0 };
    },

    async latest(led) {
      if (!source.enabled) { led.off(source.name, source.offNote); return { transactions: [], detailsPending: 0 }; }
      const entries = (await edgar.feed('4', led, { count: 100, owner: 'only' })).filter((f) => f.form === '4' || f.form === '4/A').slice(0, latestCount);
      const job = fill(entries);
      if (job) { let timer; await Promise.race([job, new Promise((r) => { timer = setTimeout(r, waitMs); timer.unref?.(); })]); clearTimeout(timer); }
      const tickers = await edgar.tickers(led).catch(() => null);
      // The feed names one party to the filing: the company, or the person reporting.
      const rows = entries.flatMap((f) => rowsOf({ form: f.form, filedAt: f.filedAt, accession: f.accession, url: f.url, issuer: /issuer/i.test(f.role) ? f.company : null, owner: /report/i.test(f.role) ? f.company : null }, details.get(f.accession)?.data, tickers).slice(0, 8));
      const pending = entries.filter((f) => !details.has(f.accession)).length;
      const missed = entries.filter((f) => details.has(f.accession) && !details.get(f.accession).data).length;
      led.ok(source.name, NOTE + (pending ? ` ${pending} of the newest filings are still being read and will fill in shortly.` : '') + (missed ? ` ${missed} could not be opened and are listed without details.` : ''));
      return { transactions: rows, detailsPending: pending };
    }
  };
}
