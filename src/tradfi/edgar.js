// SEC EDGAR (no key): every listed company, its profile, filings and financial statements,
// plus the newest registration statements (the IPO pipeline) and Form D notices (private
// fundraising).
//
// The SEC asks automated readers to identify themselves with a contact address in the
// User-Agent and to stay under ten requests a second. The address comes from the
// SEC_USER_AGENT setting; without it this source is off, since an anonymous or invented
// identity is exactly what the SEC blocks. All calls share one budget set below the limit.

import { XMLParser } from 'fast-xml-parser';
import { bad, num } from './util.js';
import { buildStatements, latestDei } from './xbrl.js';

const WWW = 'https://www.sec.gov';
const DATA = 'https://data.sec.gov';
const HOUR = 3600000;
const pad10 = (cik) => String(cik).padStart(10, '0');
const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', removeNSPrefix: true, parseTagValue: false });

// Both of the SEC's ticker files, reduced to rows of [symbol, name, cik, exchange].
// company_tickers_exchange.json: { fields: ['cik','name','ticker','exchange'], data: [[...]] }
// company_tickers.json:          { "0": { cik_str, ticker, title }, ... } (no exchange)
// Both are listed largest company first, and that order is kept: it ranks search results.
export function parseTickers(body) {
  const rows = [];
  if (Array.isArray(body?.fields) && Array.isArray(body?.data)) {
    const at = (f) => body.fields.indexOf(f);
    const [c, n, t, x] = [at('cik'), at('name'), at('ticker'), at('exchange')];
    for (const r of body.data) rows.push([r[t], r[n], r[c], x >= 0 ? r[x] : null]);
  } else if (body && typeof body === 'object') {
    for (const r of Object.values(body)) rows.push([r?.ticker, r?.title, r?.cik_str, null]);
  }
  const out = [];
  const seen = new Set();
  for (const [ticker, name, cik, exchange] of rows) {
    const symbol = String(ticker || '').toUpperCase();
    if (!symbol || seen.has(symbol) || !Number.isInteger(Number(cik)) || typeof name !== 'string') continue;
    seen.add(symbol);
    out.push({ symbol, name, cik: Number(cik), exchange: exchange || null });
  }
  if (!out.length) throw new Error('SEC ticker file had no rows');
  return out;
}

// The "latest filings" Atom feed -> [{ form, company, cik, accession, filedAt, url }].
// Entry titles read "S-1 - Example Corp (0001234567) (Filer)".
export function parseCurrentFeed(text) {
  const doc = xml.parse(String(text || ''));
  const out = [];
  const seen = new Set();
  for (const e of [].concat(doc?.feed?.entry || [])) {
    const title = String(typeof e.title === 'object' ? e.title['#text'] : e.title || '');
    const m = /^(\S+(?:\s\S+)?) - (.+) \((\d{10})\) \(([^)]+)\)\s*$/.exec(title);
    if (!m) continue;
    const links = [].concat(e.link || []);
    const url = String(links[0]?.['@href'] || '');
    const text2 = String(typeof e.summary === 'object' ? e.summary['#text'] : e.summary || '') + ' ' + String(e.id || '');
    const accession = (/(\d{10}-\d{2}-\d{6})/.exec(text2) || /(\d{10}-\d{2}-\d{6})/.exec(url) || [])[1];
    const form = String([].concat(e.category || [])[0]?.['@term'] || m[1]);
    if (!accession || seen.has(accession) || !/^https:\/\/www\.sec\.gov\//.test(url)) continue;
    seen.add(accession);
    const filed = /Filed:<\/b>\s*(\d{4}-\d{2}-\d{2})/.exec(text2) || /Filed:\s*(\d{4}-\d{2}-\d{2})/.exec(text2.replace(/<[^>]+>/g, ''));
    out.push({ form, company: m[2].trim(), cik: Number(m[3]), role: m[4], accession, filedAt: filed ? filed[1] : String(e.updated || '').slice(0, 10) || null, updated: String(e.updated || '') || null, url });
  }
  return out;
}

// A Form D's primary_doc.xml -> the few facts shown. "Indefinite" amounts become null.
export function parseFormD(text) {
  const d = xml.parse(String(text || ''))?.edgarSubmission;
  if (!d) throw new Error('Not a Form D document');
  const o = d.offeringData || {};
  const sale = o.typeOfFiling?.dateOfFirstSale || {};
  const date = String(sale.value || '').slice(0, 10);
  const amounts = o.offeringSalesAmounts || {};
  const group = o.industryGroup || {};
  return {
    form: String(d.submissionType || 'D'),
    issuer: String(d.primaryIssuer?.entityName || '') || null,
    state: String(d.primaryIssuer?.issuerAddress?.stateOrCountry || '') || null,
    industry: [group.industryGroupType, group.investmentFundInfo?.investmentFundType].filter(Boolean).map(String).join(': ') || null,
    amountOffered: num(amounts.totalOfferingAmount),   // null when "Indefinite"
    amountSold: num(amounts.totalAmountSold),
    firstSale: /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : null
  };
}

const IPO_FORMS = { 'S-1': 'filed', 'S-1/A': 'filed', 'F-1': 'filed', 'F-1/A': 'filed', '424B4': 'priced', RW: 'withdrawn' };

export function createEdgar({ source, now = Date.now, formDDetails = 25 }) {
  // --- Companies --------------------------------------------------------------------------
  async function tickers(led) {
    const opts = { ttlMs: 24 * HOUR, staleMs: 7 * 24 * HOUR, transform: (body) => {
      const list = parseTickers(body);
      return { list, bySymbol: new Map(list.map((c, i) => [c.symbol, { ...c, rank: i }])), byCik: new Map(list.slice().reverse().map((c) => [c.cik, c])) };
    } };
    // The file with exchanges is preferred; the plain one stands in if it cannot be had.
    try { return await led.read(source, `${WWW}/files/company_tickers_exchange.json`, opts); } catch (e) {
      if (!source.enabled) throw e;
      return led.read(source, `${WWW}/files/company_tickers.json`, opts);
    }
  }

  async function search(q, led) {
    const { list } = await tickers(led);
    const needle = q.toUpperCase();
    const found = [];
    for (let i = 0; i < list.length; i++) {
      const c = list[i];
      const name = c.name.toUpperCase();
      const score = c.symbol === needle ? 0 : c.symbol.startsWith(needle) ? 1 : name.startsWith(needle) ? 2 : name.includes(needle) ? 3 : -1;
      if (score >= 0) found.push([score, i, c]);
    }
    found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return found.slice(0, 12).map(([, , c]) => ({ symbol: c.symbol, name: c.name, exchange: c.exchange }));
  }

  async function lookup(symbol, led) {
    const { bySymbol } = await tickers(led);
    const c = bySymbol.get(symbol);
    if (!c) throw bad('Unknown symbol');
    return c;
  }

  // Profile and recent filings, from the submissions file.
  function profile(cik, led) {
    return led.read(source, `${DATA}/submissions/CIK${pad10(cik)}.json`, {
      ttlMs: 600000, staleMs: 6 * HOUR,
      transform: (s) => {
        const r = s?.filings?.recent || {};
        const filings = [];
        for (let i = 0; i < (r.accessionNumber || []).length && filings.length < 40; i++) {
          const acc = String(r.accessionNumber[i]);
          const doc = String(r.primaryDocument?.[i] || '');
          filings.push({
            form: String(r.form?.[i] || ''), filedAt: String(r.filingDate?.[i] || ''),
            title: String(r.primaryDocDescription?.[i] || '') || String(r.form?.[i] || ''),
            url: `${WWW}/Archives/edgar/data/${Number(cik)}/${acc.replace(/-/g, '')}/${doc || acc + '-index.htm'}`
          });
        }
        const fye = String(s?.fiscalYearEnd || '');
        return {
          name: String(s?.name || ''), industry: String(s?.sicDescription || '') || null, sic: String(s?.sic || '') || null,
          exchange: [].concat(s?.exchanges || []).filter(Boolean)[0] || null,
          fiscalYearEnd: /^\d{4}$/.test(fye) ? fye.slice(0, 2) + '-' + fye.slice(2) : null,
          state: String(s?.stateOfIncorporation || '') || null, filings
        };
      }
    });
  }

  // Statements, worked out from the XBRL facts file the moment it arrives; the file itself
  // (often several megabytes) is not kept. A company with no such file gets null.
  function financials(cik, led) {
    return led.read(source, `${DATA}/api/xbrl/companyfacts/CIK${pad10(cik)}.json`, {
      ttlMs: HOUR, staleMs: 24 * HOUR, missing: [404], timeoutMs: 15000,
      transform: (facts) => ({
        ...buildStatements(facts),
        sharesOutstanding: latestDei(facts, 'EntityCommonStockSharesOutstanding', 'shares'),
        publicFloat: latestDei(facts, 'EntityPublicFloat', 'USD')
      })
    });
  }

  // --- Newest filings of a form, across all companies ---------------------------------------
  const feed = (type, led) => led.read(source, `${WWW}/cgi-bin/browse-edgar?action=getcurrent&type=${encodeURIComponent(type)}&company=&dateb=&owner=include&start=0&count=40&output=atom`, {
    ttlMs: 600000, staleMs: 2 * HOUR, as: 'text', transform: parseCurrentFeed
  });

  // New registration statements, final prospectuses and withdrawals. The feed matches form
  // names by their beginning, so "S-1" also brings S-11 and others; only the forms named in
  // IPO_FORMS are kept. A registration statement is not always a first listing (companies
  // already trading file them too), so each row says whether the filer already has a ticker.
  async function pipeline(led) {
    const lists = await Promise.all(['S-1', 'F-1', '424B4', 'RW'].map((t) => feed(t, led).catch(() => null)));
    if (lists.every((l) => l === null)) throw new Error('SEC filing feeds did not answer');
    const known = await tickers(led).then((t) => t.byCik).catch(() => new Map());
    const rows = [];
    const seen = new Set();
    for (const f of lists.flat().filter(Boolean)) {
      if (!Object.hasOwn(IPO_FORMS, f.form) || seen.has(f.accession)) continue;
      seen.add(f.accession);
      const listed = known.get(f.cik) || null;
      rows.push({
        company: f.company, symbol: listed?.symbol || null, exchange: listed?.exchange || null, form: f.form, filedAt: f.filedAt,
        expectedDate: null, priceRange: null, status: IPO_FORMS[f.form], url: f.url, alreadyListed: Boolean(listed), source: 'SEC EDGAR'
      });
    }
    return rows.sort((a, b) => String(b.filedAt).localeCompare(String(a.filedAt)));
  }

  // Form D notices. The feed gives who filed and when; amounts and industry are inside each
  // filing, so the newest few are opened, four at a time, and each is kept for a day (a
  // filing never changes). Later refreshes only open the ones not seen before.
  async function raises(led) {
    const entries = (await feed('D', led)).filter((f) => f.form === 'D' || f.form === 'D/A');
    const out = entries.map((f) => ({ issuer: f.company, industry: null, state: null, filedAt: f.filedAt, amountOffered: null, amountSold: null, firstSale: null, form: f.form, url: f.url, detail: false }));
    const todo = entries.slice(0, formDDetails).map((f, i) => [f, i]);
    let missed = 0;
    const worker = async () => {
      for (let job = todo.shift(); job; job = todo.shift()) {
        const [f, i] = job;
        try {
          const r = await source.get(`${WWW}/Archives/edgar/data/${f.cik}/${f.accession.replace(/-/g, '')}/primary_doc.xml`, { ttlMs: 24 * HOUR, as: 'text', transform: parseFormD, missing: [404] });
          if (r.data) Object.assign(out[i], { industry: r.data.industry, state: r.data.state, amountOffered: r.data.amountOffered, amountSold: r.data.amountSold, firstSale: r.data.firstSale, detail: true });
          else missed += 1;
        } catch { missed += 1; }
      }
    };
    await Promise.all([worker(), worker(), worker(), worker()]);
    if (missed) led.ok(source.name, `${source.note} Details could not be read for ${missed} of the newest filings; they are listed without amounts.`);
    return out;
  }

  return { tickers, search, lookup, profile, financials, pipeline, raises };
}
