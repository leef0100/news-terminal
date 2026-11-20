// Funds (`/api/tradfi/funds`, `/fund`, `/holders`, `/insiders`, `/insiders/latest`): the 13F
// and Form 4 readers, the arithmetic, the router and the demo. Nothing here touches the
// network: every upstream is a function returning a hand-built payload in the shape of the
// real one (docs/TRADFI-SOURCES.md, section "Funds", says which shapes were seen live).
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createTradfi } from '../src/tradfi/index.js';
import { createDemoBackend } from '../src/tradfi/demo.js';
import { MANAGERS, parseInfoTable, parseCover, splitSubmission, read13F, parseOwnership, compare, summarise, addTables, valueScale, nameKey, buildNameIndex, symbolFor, meaningOf } from '../src/tradfi/funds.js';

const quiet = { warn() {}, log() {}, error() {} };
const NOW = Date.UTC(2026, 10, 19, 16, 0, 0);
const UA = 'Example Firm ops@example.com';

async function serve(options) {
  const tradfi = createTradfi({ log: quiet, ...options, tuning: { secPerSecond: 1000, secWaitMs: 0, fundsWarm: false, ...(options.tuning || {}) } });
  const app = express();
  app.use('/api/tradfi', tradfi.router);
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const get = async (path) => {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/tradfi${path}`);
    return { status: res.status, headers: res.headers, body: await res.json() };
  };
  return { tradfi, get, close: async () => { tradfi.stop(); await new Promise((r) => server.close(r)); } };
}
const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, headers: new Headers(), text: async () => (typeof body === 'string' ? body : JSON.stringify(body)), json: async () => (typeof body === 'string' ? JSON.parse(body) : body) });

// ---------------------------------------------------------------------------------------
// Hand-built filings
// ---------------------------------------------------------------------------------------
// One row of an information table. `ns` writes the "ns1:" prefix that many real tables carry.
const row = (issuer, cusip, value, shares, { title = 'COM', putCall, type = 'SH', ns = '' } = {}) => `
<${ns}infoTable>
  <${ns}nameOfIssuer>${issuer}</${ns}nameOfIssuer><${ns}titleOfClass>${title}</${ns}titleOfClass>
  <${ns}cusip>${cusip}</${ns}cusip><${ns}value>${value}</${ns}value>
  <${ns}shrsOrPrnAmt><${ns}sshPrnamt>${shares}</${ns}sshPrnamt><${ns}sshPrnamtType>${type}</${ns}sshPrnamtType></${ns}shrsOrPrnAmt>
  ${putCall ? `<${ns}putCall>${putCall}</${ns}putCall>` : ''}
  <${ns}investmentDiscretion>SOLE</${ns}investmentDiscretion>
  <${ns}votingAuthority><${ns}Sole>${shares}</${ns}Sole><${ns}Shared>0</${ns}Shared><${ns}None>0</${ns}None></${ns}votingAuthority>
</${ns}infoTable>`;
const tableXml = (rows, ns = '') => `<?xml version="1.0" encoding="UTF-8"?>\n<${ns}informationTable xmlns${ns ? ':ns1' : ''}="http://www.sec.gov/edgar/document/thirteenf/informationtable">${rows.join('')}\n</${ns}informationTable>`;
const coverXml = ({ period = '12-31-2022', amendment, entries = 1, value = 1 } = {}) => `<?xml version="1.0" encoding="UTF-8"?>
<edgarSubmission xmlns="http://www.sec.gov/edgar/thirteenffiler" xmlns:com="http://www.sec.gov/edgar/common">
<headerData><submissionType>13F-HR${amendment ? '/A' : ''}</submissionType><filerInfo><periodOfReport>${period}</periodOfReport></filerInfo></headerData>
<formData><coverPage><reportCalendarOrQuarter>${period}</reportCalendarOrQuarter>
${amendment ? `<isAmendment>true</isAmendment><amendmentNo>1</amendmentNo><amendmentInfo><amendmentType>${amendment}</amendmentType></amendmentInfo>` : '<isAmendment>false</isAmendment>'}
<filingManager><name>Scion Asset Management, LLC</name></filingManager><reportType>13F HOLDINGS REPORT</reportType></coverPage>
<summaryPage><otherIncludedManagersCount>0</otherIncludedManagersCount><tableEntryTotal>${entries}</tableEntryTotal><tableValueTotal>${value}</tableValueTotal></summaryPage></formData></edgarSubmission>`;
// A complete submission text file: the header, then each document with its type.
const submission = ({ form, filed, period, cover, table }) => `<SEC-DOCUMENT>0000000000-00-000000.txt : ${filed.replace(/-/g, '')}
<SEC-HEADER>0000000000-00-000000.hdr.sgml : ${filed.replace(/-/g, '')}
ACCESSION NUMBER:\t\t0000000000-00-000000
CONFORMED SUBMISSION TYPE:\t${form}
PUBLIC DOCUMENT COUNT:\t\t2
CONFORMED PERIOD OF REPORT:\t${period.replace(/-/g, '')}
FILED AS OF DATE:\t\t${filed.replace(/-/g, '')}
</SEC-HEADER>
<DOCUMENT>
<TYPE>${form}
<SEQUENCE>1
<FILENAME>primary_doc.xml
<TEXT>
<XML>
${cover}
</XML>
</TEXT>
</DOCUMENT>
<DOCUMENT>
<TYPE>INFORMATION TABLE
<SEQUENCE>2
<FILENAME>some_name_nobody_could_guess.xml
<TEXT>
<XML>
${table}
</XML>
</TEXT>
</DOCUMENT>
</SEC-DOCUMENT>
`;

// Latest quarter, filed after 3 January 2023: values are dollars. A duplicate CUSIP, a put
// and a call on one share, a CUSIP that lost its leading zero, and a row that cannot be read.
const LATEST = tableXml([
  row('AAA INC', '111111111', 1000000, 10000, { ns: 'ns1:' }),
  row('AAA INC', '111111111', 500000, 5000, { ns: 'ns1:' }),
  row('BBB CORP', '222222222', 2000000, 40000, { ns: 'ns1:' }),
  row('BBB CORP', '222222222', 300000, 6000, { putCall: 'Put', ns: 'ns1:' }),
  row('BBB CORP', '222222222', 100000, 2000, { putCall: 'Call', ns: 'ns1:' }),
  row('CCC LTD', '333333333', 400000, 8000, { ns: 'ns1:' }),
  row('EEE CO &amp; SONS', '55555555', 250000, 1000, { ns: 'ns1:' }),
  row('NO CUSIP INC', '', 1, 1, { ns: 'ns1:' })
], 'ns1:');
// An amendment that adds holdings to it.
const ADDED = tableXml([row('DDD INC', '444444444', 600000, 3000), row('AAA INC', '111111111', 100000, 1000)]);
// The quarter before, filed in 2022: values are thousands of dollars. The original was wrong
// and a restatement replaced it.
const WRONG = tableXml([row('AAA INC', '111111111', 999, 999)]);
const RESTATED = tableXml([row('AAA INC', '111111111', 900, 10000), row('BBB CORP', '222222222', 2500, 50000), row('CCC LTD', '333333333', 400, 8000), row('FFF INC', '666666666', 700, 7000)]);

const SCION = MANAGERS.find((m) => m.name.startsWith('Scion'));
const ACC = { latest: '0001649339-23-000002', added: '0001649339-23-000005', wrong: '0001649339-22-000010', restated: '0001649339-22-000011' };
const SUBMISSIONS = {
  cik: '1649339', name: 'Scion Asset Management, LLC', formerNames: [],
  filings: { recent: {
    accessionNumber: [ACC.added, '0001649339-23-000003', ACC.latest, ACC.restated, ACC.wrong],
    form: ['13F-HR/A', 'SC 13G', '13F-HR', '13F-HR/A', '13F-HR'],
    filingDate: ['2023-03-01', '2023-02-14', '2023-02-14', '2022-11-20', '2022-11-14'],
    reportDate: ['2022-12-31', '', '2022-12-31', '2022-09-30', '2022-09-30'],
    primaryDocument: ['xslForm13F_X02/primary_doc.xml', 'a.htm', 'xslForm13F_X02/primary_doc.xml', 'xslForm13F_X01/primary_doc.xml', 'xslForm13F_X01/primary_doc.xml']
  } }
};
// Two companies share the name "CCC Ltd"; DDD has a second bare ticker; BBB has a preferred.
const TICKERS = { fields: ['cik', 'name', 'ticker', 'exchange'], data: [
  [1001, 'AAA Inc.', 'AAA', 'NYSE'], [1002, 'BBB Corp', 'BBB', 'NYSE'], [1002, 'BBB Corp', 'BBB-PA', 'NYSE'],
  [1003, 'CCC Ltd', 'CCC', 'Nasdaq'], [1004, 'CCC Ltd', 'CCCX', 'Nasdaq'], [1005, 'DDD Inc', 'DDD', 'Nasdaq'], [1005, 'DDD Inc', 'DDDW', 'Nasdaq'],
  [1006, 'EEE Co & Sons', 'EEE', 'NYSE'], [1007, 'Unheld Corp', 'UNH', 'NYSE']
] };
const dir = (acc) => `https://www.sec.gov/Archives/edgar/data/1649339/${acc.replace(/-/g, '')}/`;

function upstream(extra = {}) {
  const calls = [];
  const routes = {
    'https://data.sec.gov/submissions/CIK0001649339.json': () => reply(SUBMISSIONS),
    'https://www.sec.gov/files/company_tickers_exchange.json': () => reply(TICKERS),
    [dir(ACC.latest) + ACC.latest + '.txt']: () => reply(submission({ form: '13F-HR', filed: '2023-02-14', period: '2022-12-31', cover: coverXml({ entries: 8, value: 4550001 }), table: LATEST })),
    // The amendment's text file is missing, so its index is read to find the table.
    [dir(ACC.added) + ACC.added + '.txt']: () => reply('gone', 404),
    [dir(ACC.added) + 'index.json']: () => reply({ directory: { name: '/Archives/edgar/data/1649339/x', item: [{ name: 'primary_doc.xml', size: '2000' }, { name: 'q4additions.xml', size: '900' }, { name: ACC.added + '-index.htm', size: '' }] } }),
    [dir(ACC.added) + 'q4additions.xml']: () => reply(ADDED),
    [dir(ACC.added) + 'primary_doc.xml']: () => reply(coverXml({ amendment: 'NEW HOLDINGS' })),
    [dir(ACC.restated) + ACC.restated + '.txt']: () => reply(submission({ form: '13F-HR/A', filed: '2022-11-20', period: '2022-09-30', cover: coverXml({ period: '09-30-2022', amendment: 'RESTATEMENT' }), table: RESTATED })),
    [dir(ACC.wrong) + ACC.wrong + '.txt']: () => reply(submission({ form: '13F-HR', filed: '2022-11-14', period: '2022-09-30', cover: coverXml({ period: '09-30-2022' }), table: WRONG })),
    ...extra
  };
  const fetchImpl = async (url) => { calls.push(String(url)); return Object.hasOwn(routes, url) ? routes[url]() : reply('not found', 404); };
  return { fetchImpl, calls };
}

// ---------------------------------------------------------------------------------------
// Readers
// ---------------------------------------------------------------------------------------
test('13F table: rows of one CUSIP and put/call are added; puts and calls stay apart; prefixes are read', () => {
  const t = parseInfoTable(LATEST);
  assert.equal(t.rows, 8);
  assert.equal(t.skipped, 1);
  assert.equal(t.capped, false);
  const by = Object.fromEntries(t.positions.map((p) => [p.cusip + (p.putCall || ''), p]));
  assert.deepEqual(Object.keys(by).sort(), ['055555555', '111111111', '222222222', '222222222Call', '222222222Put', '333333333']);
  assert.deepEqual([by['111111111'].value, by['111111111'].shares, by['111111111'].rows], [1500000, 15000, 2]);
  assert.deepEqual([by['222222222'].shares, by['222222222Put'].shares, by['222222222Call'].shares], [40000, 6000, 2000]);
  assert.equal(by['055555555'].issuer, 'EEE CO & SONS');
  assert.equal(by['222222222Put'].putCall, 'Put');
  // The same table without a namespace prefix reads the same.
  assert.deepEqual(parseInfoTable(LATEST.replace(/ns1:/g, '')).positions, t.positions);
});

test('13F table: a table over the cap is cut and says so; principal amounts stay apart from shares', () => {
  const many = tableXml(Array.from({ length: 50 }, (_, i) => row('CO ' + i, String(100000000 + i), 10, 5)));
  const t = parseInfoTable(many, { maxRows: 20 });
  assert.deepEqual([t.rows, t.capped, t.positions.length], [20, true, 20]);
  const mixed = parseInfoTable(tableXml([row('X CORP', '777777777', 10, 100), row('X CORP', '777777777', 20, 5000, { title: 'NOTE 1.5% 2027', type: 'PRN' })]));
  assert.deepEqual(mixed.positions.map((p) => [p.unit, p.shares]), [['SH', 100], ['PRN', 5000]]);
});

test('13F table: malformed XML and a web page are failures, never an empty table', () => {
  assert.throws(() => parseInfoTable('<informationTable><infoTable><nameOfIssuer>X</nameOfIssuer><cusip>111'), /incomplete/);
  assert.throws(() => parseInfoTable(tableXml([row('A', '111111111', 1, 1)]).replace('</informationTable>', '')), /incomplete/);
  assert.throws(() => parseInfoTable('<!DOCTYPE html><html><body><h1>Request Rate Threshold Exceeded</h1></body></html>'), /web page/);
  assert.throws(() => parseInfoTable('<?xml version="1.0"?><!DOCTYPE x [<!ENTITY a "b">]><informationTable></informationTable>'), /plain/);
  assert.throws(() => parseInfoTable('<feed></feed>'), /Not a 13F information table/);
  assert.throws(() => splitSubmission('<html><body>Your Request Originates from an Undeclared Automated Tool</body></html>'), /web page/);
  assert.throws(() => read13F('just some words'), /Not an SEC submission/);
  // A table with no rows at all is a real thing (a manager with nothing to report).
  assert.deepEqual(parseInfoTable(tableXml([])).positions, []);
});

test('13F cover and submission file: period, amendment kind, stated totals, and where the table is', () => {
  assert.deepEqual(parseCover(coverXml({ amendment: 'RESTATEMENT', entries: 12, value: 345 })), { period: '2022-12-31', isAmendment: true, amendmentNo: 1, amendmentType: 'restatement', reportType: '13F HOLDINGS REPORT', entryTotal: 12, valueTotal: 345 });
  assert.equal(parseCover(coverXml({ amendment: 'NEW HOLDINGS' })).amendmentType, 'new holdings');
  assert.equal(parseCover(coverXml()).isAmendment, false);
  const text = submission({ form: '13F-HR', filed: '2023-02-14', period: '2022-12-31', cover: coverXml(), table: LATEST });
  const s = splitSubmission(text);
  assert.deepEqual([s.form, s.filedAt, s.period, s.docs.map((d) => d.type)], ['13F-HR', '2023-02-14', '2022-12-31', ['13F-HR', 'INFORMATION TABLE']]);
  const f = read13F(text);
  assert.equal(f.table.positions.length, 6);
  assert.equal(f.cover.period, '2022-12-31');
});

test('13F values: thousands until 3 January 2023, dollars from then, by filing date', () => {
  assert.equal(valueScale('2022-11-14'), 1000);
  assert.equal(valueScale('2023-01-02'), 1000);
  assert.equal(valueScale('2023-01-03'), 1);
  assert.equal(valueScale('2026-11-14'), 1);
});

test('changes are by share count: new, exits, increases and decreases, with exact numbers', () => {
  const p = (cusip, shares, value, putCall = null) => ({ issuer: cusip, titleOfClass: 'COM', cusip, putCall, unit: 'SH', value, shares, discretion: 'SOLE', rows: 1 });
  // Same shares at a higher value is no change; an option on a new name is not a new position.
  const then = [p('A', 100, 1000), p('B', 100, 1000), p('C', 100, 1000), p('D', 100, 1000), p('G', 400, 400)];
  const now = [p('A', 100, 5000), p('B', 150, 3000), p('C', 40, 800), p('E', 10, 70), p('F', 10, 90), p('G', 500, 600), p('Z', 999, 999, 'Call')];
  const c = compare(now, then);
  assert.deepEqual(c.counts, { new: 2, exits: 1, increases: 2, decreases: 1, unchanged: 1 });
  assert.deepEqual(c.new.map((r) => [r.cusip, r.shares, r.value]), [['F', 10, 90], ['E', 10, 70]]);
  assert.deepEqual(c.exits.map((r) => [r.cusip, r.previousShares, r.previousValue, r.shares]), [['D', 100, 1000, 0]]);
  // B: +50 shares at 20 each = 1000 of change; G: +100 at 1.2 = 120. B ranks first.
  assert.deepEqual(c.increases.map((r) => [r.cusip, r.sharesDelta, r.sharesChangePct]), [['B', 50, 50], ['G', 100, 25]]);
  assert.deepEqual(c.decreases.map((r) => [r.cusip, r.sharesDelta, r.sharesChangePct, r.shares, r.previousShares]), [['C', -60, -60, 40, 100]]);
  const s = summarise(now, then);
  assert.deepEqual(s.totals, { value: 10559, holdingsValue: 9560, optionsValue: 999, positions: 6, optionPositions: 1 });
  assert.deepEqual(s.holdings.map((h) => [h.cusip, h.pct, h.change]), [['A', 47.35, 'unchanged'], ['B', 28.41, 'increase'], ['C', 7.58, 'decrease'], ['G', 5.68, 'increase'], ['F', 0.85, 'new'], ['E', 0.66, 'new']]);
  assert.equal(summarise(now, null).changes, null);
  assert.deepEqual(addTables([[p('A', 1, 2)], [p('A', 3, 4), p('B', 5, 6)]]).map((x) => [x.cusip, x.shares, x.value]), [['A', 4, 6], ['B', 5, 6]]);
});

test('tickers: only an exact, unambiguous name match gets one; nothing is guessed', () => {
  assert.equal(nameKey('Berkshire Hathaway Inc. /DE/'), nameKey('BERKSHIRE HATHAWAY INC DEL'));
  assert.equal(nameKey('Amazon.com, Inc.'), 'AMAZON COM INC');
  assert.equal(nameKey('The Example Holdings Corporation'), 'EXAMPLE HLDGS CORP');
  const list = TICKERS.data.map(([cik, name, symbol]) => ({ cik, name, symbol }));
  const index = buildNameIndex(list);
  assert.equal(symbolFor(index, 'AAA INC', 'COM'), 'AAA');
  assert.equal(symbolFor(index, 'AAA INC', 'CL A'), 'AAA');                 // one ticker: any share class of it
  assert.equal(symbolFor(index, 'AAA INC', 'NOTE 2.0% 2030'), null);        // not a share
  assert.equal(symbolFor(index, 'AAA INC', 'COM', 'PRN'), null);
  assert.equal(symbolFor(index, 'BBB CORP', 'COM'), 'BBB');                 // the one ticker without a class suffix
  assert.equal(symbolFor(index, 'BBB CORP', 'PFD SER A'), null);
  assert.equal(symbolFor(index, 'BBB CORP', 'COM CL B'), null);
  assert.equal(symbolFor(index, 'CCC LTD', 'COM'), null);                   // two companies of that name
  assert.equal(symbolFor(index, 'DDD INC', 'COM'), null);                   // two bare tickers
  assert.equal(symbolFor(index, 'AAA INCOME FUND', 'COM'), null);
  assert.equal(symbolFor(index, 'AAA', 'COM'), null);
});

// ---------------------------------------------------------------------------------------
// The service, through the router
// ---------------------------------------------------------------------------------------
test('live /fund: both value conventions, a restatement, added holdings, the index fallback, exact figures', async () => {
  const up = upstream();
  const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl: up.fetchImpl, now: () => NOW });
  try {
    const r = await svc.get('/fund?id=1649339');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=0, s-maxage=300');
    assert.match(r.headers.get('cdn-cache-control'), /s-maxage=300/);
    const d = r.body;
    assert.deepEqual([d.demo, d.id, d.name, d.state, d.filerName], [false, '0001649339', 'Scion Asset Management', 'ready', 'Scion Asset Management, LLC']);
    assert.deepEqual([d.filing.period, d.filing.filedAt, d.filing.form, d.filing.amended, d.filing.valueUnit, d.filing.rows, d.filing.skipped, d.filing.capped], ['2022-12-31', '2023-03-01', '13F-HR', true, 'dollars', 10, 1, false]);
    assert.deepEqual(d.filing.parts.map((p) => [p.accession, p.role]), [[ACC.latest, 'original'], [ACC.added, 'new holdings']]);
    assert.equal(d.filing.url, `https://www.sec.gov/Archives/edgar/data/1649339/${ACC.latest.replace(/-/g, '')}/${ACC.latest}-index.htm`);
    assert.deepEqual(d.filing.stated, { entries: 8, value: 4550001 });
    assert.deepEqual([d.previous.period, d.previous.accession, d.previous.form], ['2022-09-30', ACC.restated, '13F-HR/A']);
    assert.deepEqual(d.totals, { value: 5250000, holdingsValue: 4850000, optionsValue: 400000, positions: 5, optionPositions: 2 });
    assert.deepEqual(d.holdings.map((h) => [h.issuer, h.cusip, h.symbol, h.value, h.shares, h.pct, h.previousShares, h.change]), [
      ['BBB CORP', '222222222', 'BBB', 2000000, 40000, 38.1, 50000, 'decrease'],
      ['AAA INC', '111111111', 'AAA', 1600000, 16000, 30.48, 10000, 'increase'],
      ['DDD INC', '444444444', null, 600000, 3000, 11.43, 0, 'new'],
      ['CCC LTD', '333333333', null, 400000, 8000, 7.62, 8000, 'unchanged'],
      ['EEE CO & SONS', '055555555', 'EEE', 250000, 1000, 4.76, 0, 'new']
    ]);
    assert.deepEqual(d.options.map((o) => [o.issuer, o.putCall, o.value, o.shares, o.pct, o.symbol]), [['BBB CORP', 'Put', 300000, 6000, 5.71, 'BBB'], ['BBB CORP', 'Call', 100000, 2000, 1.9, 'BBB']]);
    assert.deepEqual(d.changes.counts, { new: 2, exits: 1, increases: 1, decreases: 1, unchanged: 1 });
    assert.equal(d.changes.basis, 'shares');
    assert.deepEqual(d.changes.new.map((x) => [x.cusip, x.shares, x.value]), [['444444444', 3000, 600000], ['055555555', 1000, 250000]]);
    // The previous quarter was in thousands: 700 there is $700,000 here. The wrong original is never used.
    assert.deepEqual(d.changes.exits.map((x) => [x.issuer, x.previousShares, x.previousValue, x.shares, x.symbol]), [['FFF INC', 7000, 700000, 0, null]]);
    assert.deepEqual(d.changes.increases.map((x) => [x.cusip, x.shares, x.previousShares, x.sharesDelta, x.sharesChangePct, x.previousValue]), [['111111111', 16000, 10000, 6000, 60, 900000]]);
    assert.deepEqual(d.changes.decreases.map((x) => [x.cusip, x.shares, x.previousShares, x.sharesDelta, x.sharesChangePct, x.previousValue]), [['222222222', 40000, 50000, -10000, -20, 2500000]]);
    assert.ok(d.notes.some((n) => /amendment added holdings/.test(n)));
    assert.ok(d.notes.some((n) => /1 row was left out/.test(n)));
    assert.ok(d.notes.some((n) => /Options are listed apart/.test(n)));
    assert.deepEqual(d.sources.map((s) => [s.name, s.state]), [['SEC EDGAR', 'ok']]);
    assert.ok(!up.calls.some((u) => u.includes(ACC.wrong)), 'the restated original is not fetched');
    assert.ok(up.calls.includes(dir(ACC.added) + 'index.json') && up.calls.includes(dir(ACC.added) + 'q4additions.xml'));

    // A second request costs nothing upstream.
    const before = up.calls.length;
    await svc.get('/fund?id=0001649339');
    assert.equal(up.calls.length, before);

    // /holders reads only what is already held: no filing is fetched for the other managers.
    const h = await svc.get('/holders?symbol=AAA');
    assert.equal(h.status, 200);
    assert.equal(h.headers.get('cache-control'), 'public, max-age=0, s-maxage=60');
    assert.deepEqual([h.body.symbol, h.body.name, h.body.matched, h.body.tracked, h.body.loaded, h.body.pending], ['AAA', 'AAA Inc.', true, MANAGERS.length, 1, MANAGERS.length - 1]);
    assert.deepEqual(h.body.holders, [{ id: '0001649339', name: 'Scion Asset Management', marketMaker: false, period: '2022-12-31', filedAt: '2023-03-01', shares: 16000, value: 1600000, pct: 30.48, previousShares: 10000, change: 'increase' }]);
    assert.match(h.body.note, /1 of \d+ tracked managers/);
    assert.deepEqual((await svc.get('/holders?symbol=UNH')).body.holders, []);
    const ccc = (await svc.get('/holders?symbol=CCC')).body;
    assert.deepEqual([ccc.matched, ccc.holders.length], [false, 0]);
    assert.match(ccc.note, /could not be matched/);
    assert.equal(up.calls.length, before, 'holders never fetches');
    assert.equal((await svc.get('/holders?symbol=NOPE')).status, 400);

    // The list knows the one manager that has been read, and says the rest are loading.
    const list = await svc.get('/funds');
    assert.equal(list.headers.get('cache-control'), 'public, max-age=0, s-maxage=20');
    assert.equal(list.body.managers.length, MANAGERS.length);
    const mine = list.body.managers.find((m) => m.id === '0001649339');
    assert.deepEqual([mine.state, mine.period, mine.filedAt, mine.value, mine.positions, mine.optionPositions], ['ready', '2022-12-31', '2023-03-01', 5250000, 5, 2]);
    assert.ok(list.body.managers.filter((m) => m.id !== mine.id).every((m) => m.state === 'loading' && m.value === null));
    assert.equal(list.body.pending, MANAGERS.length - 1);
  } finally { await svc.close(); }
});

test('live /fund: a table over the cap shows no changes and says the table was cut', async () => {
  const up = upstream();
  const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl: up.fetchImpl, now: () => NOW, tuning: { fundRows: 3 } });
  try {
    const d = (await svc.get('/fund?id=1649339')).body;
    assert.equal(d.filing.capped, true);
    assert.equal(d.changes, null);
    assert.ok(d.holdings.every((h) => h.change === null));
    assert.ok(d.notes.some((n) => /very long: the first 5 rows were read/.test(n)));
  } finally { await svc.close(); }
});

test('live /fund: a web page or broken XML where a filing should be is a 502, with a plain message', async () => {
  for (const body of ['<!DOCTYPE html><html><body>Request Rate Threshold Exceeded</body></html>', submission({ form: '13F-HR', filed: '2023-02-14', period: '2022-12-31', cover: coverXml(), table: '<informationTable><infoTable><cusip>1' })]) {
    const up = upstream({ [dir(ACC.latest) + ACC.latest + '.txt']: () => reply(body), [dir(ACC.latest) + 'index.json']: () => reply('<html>blocked</html>') });
    const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl: up.fetchImpl, now: () => NOW });
    try {
      const r = await svc.get('/fund?id=1649339');
      assert.equal(r.status, 502);
      assert.match(r.headers.get('cache-control'), /s-maxage=2/);
      assert.match(r.body.error, /did not answer/);
      const list = (await svc.get('/funds')).body.managers.find((m) => m.id === '0001649339');
      assert.equal(list.state, 'error');
      assert.equal(list.value, null);
    } finally { await svc.close(); }
  }
});

test('live: a number that EDGAR lists under another name is an error, never shown under ours', async () => {
  const up = upstream({ 'https://data.sec.gov/submissions/CIK0001649339.json': () => reply({ ...SUBMISSIONS, name: 'Somebody Else Capital LP' }) });
  const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl: up.fetchImpl, now: () => NOW });
  try {
    assert.equal((await svc.get('/fund?id=1649339')).status, 502);
    const m = (await svc.get('/funds')).body.managers.find((x) => x.id === '0001649339');
    assert.equal(m.state, 'error');
    assert.match(m.note, /another name/);
  } finally { await svc.close(); }
});

test('live /funds: the tables are filled in the background, two managers at a time, and loading is said honestly', async () => {
  const up = upstream();
  let inFlight = 0, most = 0;
  const fetchImpl = async (url) => { inFlight += 1; most = Math.max(most, inFlight); await new Promise((r) => setTimeout(r, 2)); try { return await up.fetchImpl(url); } finally { inFlight -= 1; } };
  const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl, now: () => NOW, tuning: { fundsWarm: true, fundsGapMs: 1, secPerVisitor: 3 } });
  try {
    const first = (await svc.get('/funds')).body;
    assert.equal(first.tracked, MANAGERS.length);
    assert.ok(first.pending > 0 && first.managers.some((m) => m.state === 'loading'));
    assert.match(first.sources[0].note, /still being read/);
    let last;
    for (let i = 0; i < 200; i++) { last = (await svc.get('/funds')).body; if (!last.pending) break; await new Promise((r) => setTimeout(r, 10)); }
    assert.equal(last.pending, 0);
    // Only one manager has stand-in filings; the rest fail and say so. None is charged to the visitor (allowance 3).
    assert.deepEqual(last.managers.filter((m) => m.state === 'ready').map((m) => [m.name, m.value]), [['Scion Asset Management', 5250000]]);
    assert.ok(last.managers.filter((m) => m.state !== 'ready').every((m) => m.state === 'error' && m.note));
    assert.ok(most <= 2, 'at most two upstream calls at once, saw ' + most);
  } finally { await svc.close(); }
});

test('router: bad input is refused before anything is fetched; SEC off is said, not guessed', async () => {
  const up = upstream();
  const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl: up.fetchImpl, now: () => NOW });
  try {
    for (const path of ['/fund', '/fund?id=', '/fund?id=abc', '/fund?id=12345678901', '/fund?id=1649339&id=2', '/fund?id=-1', '/fund?id=7', '/holders', '/holders?symbol=bad!', '/insiders', '/insiders?symbol=' + 'A'.repeat(13)]) {
      const r = await svc.get(path);
      assert.equal(r.status, 400, path);
      assert.equal(r.headers.get('cache-control'), 'no-store');
      assert.ok(r.body.error);
    }
    assert.equal(up.calls.length, 0);
    assert.equal((await svc.get('/insiders/nothing')).status, 404);
  } finally { await svc.close(); }
  const off = await serve({ env: {}, fetchImpl: up.fetchImpl, now: () => NOW });
  try {
    const list = (await off.get('/funds')).body;
    assert.ok(list.managers.length === MANAGERS.length && list.managers.every((m) => m.state === 'off' && m.value === null));
    assert.deepEqual(list.sources.map((s) => s.state), ['off']);
    const one = (await off.get('/fund?id=1649339')).body;
    assert.deepEqual([one.state, one.holdings, one.changes], ['off', [], null]);
    assert.deepEqual((await off.get('/holders?symbol=AAA')).body.holders, []);
    assert.deepEqual((await off.get('/insiders?symbol=AAA')).body.transactions, []);
    assert.deepEqual((await off.get('/insiders/latest')).body.transactions, []);
    assert.equal(up.calls.length, 0);
  } finally { await off.close(); }
});

// ---------------------------------------------------------------------------------------
// Forms 3, 4 and 5
// ---------------------------------------------------------------------------------------
const FORM4 = `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0508</schemaVersion><documentType>4</documentType><periodOfReport>2026-11-16</periodOfReport>
  <issuer><issuerCik>0000001001</issuerCik><issuerName>AAA Inc.</issuerName><issuerTradingSymbol>aaa</issuerTradingSymbol></issuer>
  <reportingOwner><reportingOwnerId><rptOwnerCik>0001999001</rptOwnerCik><rptOwnerName>Example Jane Q</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>true</isOfficer><isTenPercentOwner>0</isTenPercentOwner><isOther>0</isOther><officerTitle>Chief Financial Officer</officerTitle></reportingOwnerRelationship></reportingOwner>
  <reportingOwner><reportingOwnerId><rptOwnerCik>0001999002</rptOwnerCik><rptOwnerName>Example Family Trust</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>0</isDirector><isTenPercentOwner>1</isTenPercentOwner></reportingOwnerRelationship></reportingOwner>
  <aff10b5One>1</aff10b5One>
  <nonDerivativeTable>
    <nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-11-16</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>M</transactionCode><equitySwapInvolved>0</equitySwapInvolved></transactionCoding>
      <transactionAmounts><transactionShares><value>10000</value></transactionShares><transactionPricePerShare><value>12.50</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>60000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction>
    <nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-11-16</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>4000</value></transactionShares><transactionPricePerShare><value>101.255</value><footnoteId id="F1"/></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>56000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>I</value></directOrIndirectOwnership><natureOfOwnership><value>By trust</value></natureOfOwnership></ownershipNature></nonDerivativeTransaction>
    <nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-11-17</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>250</value></transactionShares><transactionPricePerShare><value>100</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>56250</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction>
    <nonDerivativeTransaction><securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-11-17</value></transactionDate>
      <transactionCoding><transactionCode>F</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>1200</value></transactionShares><transactionPricePerShare><footnoteId id="F2"/></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>55050</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></nonDerivativeTransaction>
    <nonDerivativeHolding><securityTitle><value>Common Stock</value></securityTitle><postTransactionAmounts><sharesOwnedFollowingTransaction><value>900</value></sharesOwnedFollowingTransaction></postTransactionAmounts></nonDerivativeHolding>
  </nonDerivativeTable>
  <derivativeTable>
    <derivativeTransaction><securityTitle><value>Stock Option (right to buy)</value></securityTitle><conversionOrExercisePrice><value>12.50</value></conversionOrExercisePrice><transactionDate><value>2026-11-16</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>M</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>10000</value></transactionShares><transactionPricePerShare><value>0</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <exerciseDate><footnoteId id="F3"/></exerciseDate><expirationDate><value>2030-01-15</value></expirationDate>
      <underlyingSecurity><underlyingSecurityTitle><value>Common Stock</value></underlyingSecurityTitle><underlyingSecurityShares><value>10000</value></underlyingSecurityShares></underlyingSecurity>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>5000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
      <ownershipNature><directOrIndirectOwnership><value>D</value></directOrIndirectOwnership></ownershipNature></derivativeTransaction>
  </derivativeTable>
  <footnotes><footnote id="F1">Weighted average price.</footnote></footnotes>
</ownershipDocument>`;
const form4Txt = (xmlText) => `<SEC-DOCUMENT>x.txt : 20261118\n<SEC-HEADER>\nCONFORMED SUBMISSION TYPE:\t4\nFILED AS OF DATE:\t\t20261118\n</SEC-HEADER>\n<DOCUMENT>\n<TYPE>4\n<SEQUENCE>1\n<FILENAME>wk-form4_1.xml\n<TEXT>\n<XML>\n${xmlText}\n</XML>\n</TEXT>\n</DOCUMENT>\n</SEC-DOCUMENT>\n`;

test('Form 4: several transactions and a derivative table, with plain meanings', () => {
  const d = parseOwnership(form4Txt(FORM4));
  assert.deepEqual([d.form, d.period, d.planned], ['4', '2026-11-16', true]);
  assert.deepEqual(d.issuer, { cik: 1001, name: 'AAA Inc.', symbol: 'AAA' });
  assert.deepEqual(d.owners, [{ name: 'Example Jane Q', role: 'Director, Chief Financial Officer' }, { name: 'Example Family Trust', role: '10% owner' }]);
  assert.deepEqual(d.transactions.map((t) => [t.date, t.code, t.kind, t.acquired, t.shares, t.price, t.value, t.sharesAfter, t.derivative, t.direct]), [
    ['2026-11-16', 'M', 'exercise', true, 10000, 12.5, 125000, 60000, false, true],
    ['2026-11-16', 'S', 'sale', false, 4000, 101.255, 405020, 56000, false, false],
    ['2026-11-17', 'P', 'purchase', true, 250, 100, 25000, 56250, false, true],
    ['2026-11-17', 'F', 'tax', false, 1200, null, null, 55050, false, true],
    ['2026-11-16', 'M', 'exercise', false, 10000, 0, null, 5000, true, true]
  ]);
  assert.equal(d.transactions[2].meaning, 'Purchase (open market or private)');
  assert.equal(d.transactions[3].meaning, 'Shares withheld for tax or an exercise price');
  assert.deepEqual([d.transactions[4].security, d.transactions[4].underlying, d.transactions[4].underlyingShares], ['Stock Option (right to buy)', 'Common Stock', 10000]);
  assert.deepEqual(meaningOf('G'), { kind: 'gift', meaning: 'Gift' });
  assert.deepEqual(meaningOf('Q'), { kind: 'other', meaning: 'Code Q (see the filing)' });
  assert.throws(() => parseOwnership('<html><body>Access denied</body></html>'), /web page/);
  assert.throws(() => parseOwnership('<ownershipDocument><issuer>'), /Not an ownership form/);
  assert.throws(() => parseOwnership('<!DOCTYPE x [<!ENTITY a "b">]><ownershipDocument>&a;</ownershipDocument>'), /plain XML/);
});

const CO_SUBS = { cik: '1001', name: 'AAA Inc.', sic: '3674', sicDescription: 'Semiconductors', exchanges: ['NYSE'], fiscalYearEnd: '1231', filings: { recent: {
  accessionNumber: ['0001999001-26-000007', '0001000000-26-000050', '0001999001-26-000006', '0001999009-26-000001', '0001999008-26-000002', '0001999001-26-000001', '0001999007-25-000009'],
  form: ['4', '10-Q', '4', 'SCHEDULE 13G', 'SC 13D/A', '3', '424B2'],
  filingDate: ['2026-11-18', '2026-11-05', '2026-11-03', '2026-10-30', '2026-10-02', '2026-09-01', '2026-08-01'],
  primaryDocument: ['xslF345X05/wk-form4_1.xml', 'q.htm', 'xslF345X05/wk-form4_0.xml', 'primary_doc.xml', 's.htm', 'xslF345X02/f3.xml', 'p.htm'],
  primaryDocDescription: ['FORM 4', '10-Q', 'FORM 4', '', '', 'FORM 3', '']
} } };
const coTxt = (acc) => `https://www.sec.gov/Archives/edgar/data/1001/${acc.replace(/-/g, '')}/${acc}.txt`;

test('live /insiders: a company’s Form 4 transactions and its 13D/13G filings', async () => {
  const up = upstream({
    'https://data.sec.gov/submissions/CIK0000001001.json': () => reply(CO_SUBS),
    [coTxt('0001999001-26-000007')]: () => reply(form4Txt(FORM4)),
    [coTxt('0001999001-26-000006')]: () => reply('<html><body>Request Rate Threshold Exceeded</body></html>')
  });
  const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl: up.fetchImpl, now: () => NOW });
  try {
    const r = await svc.get('/insiders?symbol=AAA');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=0, s-maxage=120');
    const d = r.body;
    assert.deepEqual([d.symbol, d.name, d.cik], ['AAA', 'AAA Inc.', '0000001001']);
    // Five rows from the filing that was read; one row each for the filing that could not be and the Form 3.
    assert.equal(d.transactions.length, 7);
    const read = d.transactions.filter((t) => t.detail);
    assert.deepEqual(read.map((t) => [t.date, t.code, t.shares, t.owner, t.role, t.moreOwners, t.symbol, t.planned]), [
      ['2026-11-17', 'P', 250, 'Example Jane Q', 'Director, Chief Financial Officer', 1, 'AAA', true],
      ['2026-11-17', 'F', 1200, 'Example Jane Q', 'Director, Chief Financial Officer', 1, 'AAA', true],
      ['2026-11-16', 'M', 10000, 'Example Jane Q', 'Director, Chief Financial Officer', 1, 'AAA', true],
      ['2026-11-16', 'S', 4000, 'Example Jane Q', 'Director, Chief Financial Officer', 1, 'AAA', true],
      ['2026-11-16', 'M', 10000, 'Example Jane Q', 'Director, Chief Financial Officer', 1, 'AAA', true]
    ]);
    assert.ok(read.every((t) => t.url === 'https://www.sec.gov/Archives/edgar/data/1001/000199900126000007/0001999001-26-000007-index.htm' && t.filedAt === '2026-11-18'));
    assert.deepEqual(d.transactions.filter((t) => !t.detail).map((t) => [t.form, t.filedAt, t.shares, t.meaning]), [['4', '2026-11-03', null, null], ['3', '2026-09-01', null, null]]);
    assert.deepEqual(d.stakes.map((s) => [s.form, s.kind, s.amendment, s.filedAt]), [['SCHEDULE 13G', '13G', false, '2026-10-30'], ['SC 13D/A', '13D', true, '2026-10-02']]);
    assert.equal(d.stakes[0].url, 'https://www.sec.gov/Archives/edgar/data/1001/000199900926000001/0001999009-26-000001-index.htm');
    assert.match(d.sources[0].note, /1 of the newest filings could not be opened/);
    // The company page reads the same submissions file: one fetch serves both.
    const before = up.calls.length;
    await svc.get('/company?symbol=AAA');
    assert.equal(up.calls.filter((u) => u.includes('submissions/CIK0000001001')).length, 1);
    assert.ok(up.calls.length - before <= 1);
    assert.equal((await svc.get('/insiders?symbol=ZZZZ')).status, 400);
  } finally { await svc.close(); }
});

test('live /insiders: one address cannot spend the SEC allowance; it is told to slow down', async () => {
  const up = upstream({ 'https://data.sec.gov/submissions/CIK0000001001.json': () => reply(CO_SUBS), [coTxt('0001999001-26-000007')]: () => reply(form4Txt(FORM4)) });
  const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl: up.fetchImpl, now: () => NOW, tuning: { secPerVisitor: 2 } });
  try {
    const d = (await svc.get('/insiders?symbol=AAA')).body;   // the ticker list is shared; submissions and one filing are this visitor's two
    assert.equal(d.transactions.filter((t) => t.detail).length, 5);
    assert.match(d.sources[0].note, /too many new lookups/);
    assert.equal(up.calls.filter((u) => u.endsWith('.txt')).length, 1);
  } finally { await svc.close(); }
});

const entry = (form, company, cik, role, acc, filed) => `<entry><title>${form} - ${company} (${String(cik).padStart(10, '0')}) (${role})</title>
<link rel="alternate" type="text/html" href="https://www.sec.gov/Archives/edgar/data/${cik}/${acc.replace(/-/g, '')}/${acc}-index.htm"/>
<summary type="html">&lt;b&gt;Filed:&lt;/b&gt; ${filed} &lt;b&gt;AccNo:&lt;/b&gt; ${acc} &lt;b&gt;Size:&lt;/b&gt; 5 KB</summary>
<updated>${filed}T16:30:00-05:00</updated><category scheme="https://www.sec.gov/" label="form type" term="${form}"/><id>urn:tag:sec.gov,2008:accession-number=${acc}</id></entry>`;
const FEED = `<?xml version="1.0" encoding="ISO-8859-1" ?><feed xmlns="http://www.w3.org/2005/Atom"><title>Latest Filings</title>
${entry('4', 'Example Jane Q', 1999001, 'Reporting', '0001999001-26-000007', '2026-11-18')}
${entry('4', 'AAA Inc.', 1001, 'Issuer', '0001999001-26-000007', '2026-11-18')}
${entry('424B2', 'Some Bank', 1999005, 'Filer', '0001999005-26-000100', '2026-11-18')}
${entry('4', 'Unlisted Widgets LLC', 1999020, 'Issuer', '0001999021-26-000003', '2026-11-18')}
${entry('4', 'Never Opens Corp', 1999030, 'Issuer', '0001999031-26-000004', '2026-11-17')}
</feed>`;

test('live /insiders/latest: the newest Form 4 filings, read in the background; tickers only where the SEC lists them', async () => {
  const unlisted = FORM4.replace('0000001001', '0001999020').replace('AAA Inc.', 'Unlisted Widgets LLC').replace('<issuerTradingSymbol>aaa', '<issuerTradingSymbol>AAA');
  let feedUrl = '';
  const up = upstream({
    'https://www.sec.gov/Archives/edgar/data/1999001/000199900126000007/0001999001-26-000007.txt': () => reply(form4Txt(FORM4)),
    'https://www.sec.gov/Archives/edgar/data/1999020/000199902126000003/0001999021-26-000003.txt': () => reply(form4Txt(unlisted))
  });
  const fetchImpl = async (url) => { if (String(url).includes('browse-edgar')) { feedUrl = String(url); return reply(FEED); } return up.fetchImpl(url); };
  const svc = await serve({ env: { SEC_USER_AGENT: UA }, fetchImpl, now: () => NOW, tuning: { insiderWaitMs: 2000 } });
  try {
    const r = await svc.get('/insiders/latest');
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'public, max-age=0, s-maxage=30');
    assert.match(feedUrl, /action=getcurrent&type=4&.*owner=only&.*count=100&output=atom/);
    const t = r.body.transactions;
    assert.equal(r.body.detailsPending, 0);
    // Five rows each from the two filings read, one row for the one that could not be; the prospectus is not an insider filing.
    assert.deepEqual(t.map((x) => x.accession).filter((a, i, all) => all.indexOf(a) === i), ['0001999001-26-000007', '0001999021-26-000003', '0001999031-26-000004']);
    assert.deepEqual(t.filter((x) => x.accession === '0001999001-26-000007').map((x) => [x.issuer, x.symbol, x.owner, x.code]), [['AAA Inc.', 'AAA', 'Example Jane Q', 'M'], ['AAA Inc.', 'AAA', 'Example Jane Q', 'S'], ['AAA Inc.', 'AAA', 'Example Jane Q', 'P'], ['AAA Inc.', 'AAA', 'Example Jane Q', 'F'], ['AAA Inc.', 'AAA', 'Example Jane Q', 'M']]);
    // The form claims the ticker AAA, but the SEC lists AAA for another company: no link.
    assert.ok(t.filter((x) => x.accession === '0001999021-26-000003').every((x) => x.issuer === 'Unlisted Widgets LLC' && x.symbol === null));
    const unread = t.find((x) => x.accession === '0001999031-26-000004');
    assert.deepEqual([unread.detail, unread.issuer, unread.shares, unread.meaning], [false, 'Never Opens Corp', null, null]);
    assert.match(r.body.sources[0].note, /1 could not be opened/);
  } finally { await svc.close(); }
});

// ---------------------------------------------------------------------------------------
// Demo
// ---------------------------------------------------------------------------------------
test('demo: invented managers whose holdings, totals, changes, holders and insiders agree with each other', async () => {
  const b = createDemoBackend({ now: () => NOW });
  const list = await b.funds();
  assert.ok(list.managers.length >= 6 && list.pending === 0);
  const real = new Set(MANAGERS.map((m) => m.name.toLowerCase()));
  const symbols = new Set(b.symbols());
  for (const m of list.managers) {
    assert.ok(!real.has(m.name.toLowerCase()) && /^00098\d{5}$/.test(m.id), m.name);
    assert.equal(m.url, null);
    const d = await b.fund(m.id);
    assert.deepEqual([d.totals.value, d.totals.positions, d.filing.period, d.filing.filedAt], [m.value, m.positions, m.period, m.filedAt]);
    assert.equal(d.filing.period, '2026-09-30');
    assert.ok(d.filing.filedAt > d.filing.period && d.filing.filedAt <= '2026-11-14' && ![0, 6].includes(new Date(d.filing.filedAt + 'T00:00:00Z').getUTCDay()));
    assert.match(d.notes[0], /Invented for the demo/);
    const sum = (rows) => rows.reduce((s, r) => s + r.value, 0);
    assert.equal(sum(d.holdings), d.totals.holdingsValue);
    assert.equal(sum(d.options), d.totals.optionsValue);
    assert.equal(d.totals.holdingsValue + d.totals.optionsValue, d.totals.value);
    assert.ok(Math.abs(d.holdings.concat(d.options).reduce((s, r) => s + r.pct, 0) - 100) < 0.5);
    assert.ok(d.holdings.every((h) => symbols.has(h.symbol) && h.cusip.startsWith('DEMO') && h.shares > 0));
    // Every change list agrees with the holdings table.
    const held = new Map(d.holdings.map((h) => [h.cusip, h]));
    const c = d.changes;
    assert.equal(c.counts.new + c.counts.increases + c.counts.decreases + c.counts.unchanged, d.totals.positions);
    for (const r of c.new) assert.deepEqual([held.get(r.cusip).change, r.previousShares, held.get(r.cusip).shares], ['new', 0, r.shares]);
    for (const r of c.increases) assert.ok(held.get(r.cusip).change === 'increase' && r.sharesDelta === r.shares - r.previousShares && r.sharesDelta > 0 && held.get(r.cusip).previousShares === r.previousShares);
    for (const r of c.decreases) assert.ok(held.get(r.cusip).change === 'decrease' && r.sharesDelta === r.shares - r.previousShares && r.sharesDelta < 0);
    for (const r of c.exits) assert.ok(!held.has(r.cusip) && r.shares === 0 && r.previousShares > 0);
    assert.equal(d.holdings.filter((h) => h.change === 'new').length, c.counts.new);
  }
  assert.ok(list.managers.some((m) => m.marketMaker) && list.managers.some((m) => m.optionPositions > 0));
  // A company's holders are exactly the managers whose table lists it, with the same figures.
  const symbol = b.symbols()[0];
  const h = await b.holders(symbol);
  let expected = 0;
  for (const m of list.managers) {
    const row = (await b.fund(m.id)).holdings.find((x) => x.symbol === symbol);
    if (!row) { assert.ok(!h.holders.some((x) => x.id === m.id)); continue; }
    expected += 1;
    const mine = h.holders.find((x) => x.id === m.id);
    assert.deepEqual([mine.shares, mine.value, mine.pct, mine.change, mine.previousShares], [row.shares, row.value, row.pct, row.change, row.previousShares]);
  }
  assert.equal(h.holders.length, expected);
  await assert.rejects(() => b.holders('AAPL'), /Unknown symbol/);
  await assert.rejects(() => b.fund('0001067983'), /Unknown manager/);

  // Insiders: each person's "owned after" follows from the row before it.
  const ins = await b.insiders(symbol);
  assert.ok(ins.transactions.length > 3 && ins.transactions.every((t) => t.url === null && t.symbol === symbol && t.detail === true && t.meaning));
  const last = new Map();
  for (const t of ins.transactions.slice().reverse()) {
    if (t.derivative) continue;
    if (last.has(t.owner)) assert.equal(t.sharesAfter, last.get(t.owner) + (t.acquired ? t.shares : -t.shares), `${t.owner} ${t.date} ${t.code}`);
    last.set(t.owner, t.sharesAfter);
  }
  const latest = await b.insidersLatest();
  assert.ok(latest.transactions.length > 5 && latest.transactions.some((t) => t.kind === 'purchase'));
  assert.ok(latest.transactions.every((t, i, all) => i === 0 || all[i - 1].filedAt >= t.filedAt));
  assert.deepEqual(await b.fund(list.managers[0].id), await b.fund(list.managers[0].id));
});

test('demo router: the Funds routes answer with demo, at, sources and cache headers', async () => {
  const svc = await serve({ demo: true, now: () => NOW });
  try {
    const list = await svc.get('/funds');
    assert.deepEqual([list.status, list.body.demo, list.body.at, list.body.sources[0].name], [200, true, NOW, 'Demo data']);
    const id = list.body.managers[0].id;
    for (const path of ['/fund?id=' + id, '/fund?id=' + Number(id), '/holders?symbol=QUILLN', '/insiders?symbol=QUILLN', '/insiders/latest']) {
      const r = await svc.get(path);
      assert.equal(r.status, 200, path);
      assert.ok(r.body.demo === true && r.body.at === NOW && Array.isArray(r.body.sources), path);
      assert.match(r.headers.get('cache-control'), /^public, max-age=0, s-maxage=\d+$/);
    }
    assert.equal((await svc.get('/fund?id=1649339')).status, 400);     // a real manager's number is not in the demo
    assert.equal((await svc.get('/holders?symbol=AAPL')).status, 400);
    assert.equal((await svc.get('/insiders?symbol=AAPL')).status, 400);
  } finally { await svc.close(); }
});
