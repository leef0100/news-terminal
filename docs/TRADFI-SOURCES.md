# Stocks, calendar and private markets: sources

What `/api/tradfi` draws on, how each source is called, its limits and terms, and, for every
item, whether it was **seen live**, **read in documentation**, or **not checked**. The build
shell has no internet access; checks were made on 2026-11-19 with a web-fetch tool that would
only open pages surfaced by a search, so several live endpoints could not be opened at all.
Anything marked *from memory* was coded from prior knowledge of the format and must be
confirmed against one real response before it is shown to a customer.

Code: `src/tradfi/` (`index.js` router, `live.js` assembly, `source.js` cache and budget,
`edgar.js`, `xbrl.js`, `treasury.js`, `fred.js`, `prices.js`, `calendar.js`, `demo.js`).

## Settings

| Variable | Unlocks | Without it |
|---|---|---|
| `SEC_USER_AGENT` | Everything from the SEC: search, company profile, statements, filings, IPO pipeline, Form D raises. Must be a name plus contact email, e.g. `Example Firm ops@example.com`. | SEC source is `off`. The SEC blocks unidentified clients, and a contact is never invented. |
| `FINNHUB_KEY` | Share quotes, earnings dates, expected IPO dates and price ranges. | Those parts are "not connected". |
| `TWELVEDATA_KEY` | Daily price history for any US share; quotes when Finnhub is absent. | No history except Hyperliquid perpetuals. |
| `FRED_KEY` | Macro figures (CPI, unemployment, fed funds, GDP, 10-year) and economic release dates. | Macro shows only the 10-year yield from the Treasury; no economic events. |
| `HL_EQUITY_DEX` | Which Hyperliquid builder venue to read equity and index perpetuals from. Default `xyz`. `off` disables it. | (on by default, no key) |
| `HL_EQUITY_SYMBOLS` | Comma list of share tickers a perpetual may stand in for. Default: 30 large US shares (see `prices.js`). | default list |
| `HL_INDEX_PERPS` | Comma list of index contracts to show. Default `XYZ100,SP500`; ones the venue does not list are skipped. | default list |

No key at all still gives: the Treasury yield curve, the Fed meeting calendar and Hyperliquid
perpetual prices. With `SEC_USER_AGENT` (free, no sign-up) everything from EDGAR is added.

## 1. SEC EDGAR (chosen; official, public domain, no key)

Rules, read at <https://www.sec.gov/os/accessing-edgar-data>: at most 10 requests a second;
declare a User-Agent of the form "Sample Company Name AdminContact@domain.com"; download only
what is needed; no crawling. The data APIs need no key and do not support CORS, so they must be
called from the server (<https://www.sec.gov/page/sec-api-documentation>). EDGAR content is US
government work with no display restriction stated on those pages.

Our budget: 8 requests a second across every SEC call, enforced in `source.js`; a call waits up
to 3 seconds for room, then fails honestly.

| What | URL | Fields relied on | Kept for | Status |
|---|---|---|---|---|
| Company list (search, symbol to CIK) | `https://www.sec.gov/files/company_tickers_exchange.json`, falling back to `.../company_tickers.json` | exchange file: `fields: [cik,name,ticker,exchange]`, `data: [[...]]`; plain file: `{"0": {cik_str, ticker, title}}`. Order (largest first) ranks search results and earnings importance. | 1 day (stale up to 7) | Plain file **seen live** (first rows AAPL, MSFT, NVDA). Exchange file's shape **from memory**; URL confirmed in SEC documentation. |
| Profile and filings | `https://data.sec.gov/submissions/CIK##########.json` | `name`, `sic`, `sicDescription`, `exchanges`, `fiscalYearEnd` (MMDD), `filings.recent.{accessionNumber, filingDate, form, primaryDocument, primaryDocDescription}` (parallel arrays) | 10 min (stale 6 h) | URL pattern **read in documentation**; field names **from memory**. |
| Financial facts | `https://data.sec.gov/api/xbrl/companyfacts/CIK##########.json` | `facts['us-gaap'][Tag].units[unit][] = {start?, end, val, accn, fy, fp, form, filed, frame?}`; `facts.dei.EntityCommonStockSharesOutstanding`, `EntityPublicFloat` | 1 hour (stale 1 day); only the derived statements are kept, never the multi-megabyte file | URL pattern **read in documentation**; fact shape **from memory**. 404 is treated as "no structured data". |
| Filing links | `https://www.sec.gov/Archives/edgar/data/{cik}/{accession without dashes}/{primaryDocument}` | | | Path layout **read in documentation**. |
| Newest filings by form (IPO pipeline, Form D) | `https://www.sec.gov/cgi-bin/browse-edgar?action=getcurrent&type={S-1,F-1,424B4,RW,D}&company=&dateb=&owner=include&start=0&count=40&output=atom` | entry `title` ("S-1 - Name (0001234567) (Filer)"), `link@href`, `summary` ("Filed: ... AccNo: ..."), `updated`, `category@term`, `id` | 10 min (stale 2 h) | URL form confirmed by a third-party guide; entry format **from memory**. **Not seen live.** |
| Form D detail | `https://www.sec.gov/Archives/edgar/data/{cik}/{accession without dashes}/primary_doc.xml` | `edgarSubmission.submissionType`, `primaryIssuer.entityName`, `primaryIssuer.issuerAddress.stateOrCountry`, `offeringData.industryGroup.industryGroupType`, `offeringData.typeOfFiling.dateOfFirstSale.{value,yetToOccur}`, `offeringData.offeringSalesAmounts.{totalOfferingAmount,totalAmountSold}` ("Indefinite" becomes null) | 1 day each (a filing never changes) | Element names match a third-party description of the SEC schema (sec-api.io); the file name and path are **from memory**. **Not seen live.** A 404 lists the filing without amounts. |

Request cost: the pipeline is 4 feed calls per 10 minutes. Form D is 1 feed call per 10 minutes
plus one detail call for each of the newest 25 filings the first time it is seen.

Not used: the frames API (`/api/xbrl/frames/us-gaap/{Tag}/USD/CY2019Q1I.json`; documented, one
fact per company per calendar period; would serve market-wide screens later) and EDGAR
full-text search (not checked).

### Statements (`xbrl.js`)

Periods are identified by a fact's own `start`/`end`, never `fy`/`fp` (those describe the filing,
so comparison figures carry the later year's label). Year = a 350 to 380 day span from an annual
form; quarter = 80 to 100 days; the latest-filed value for a period wins; balance-sheet rows are
instants matched exactly on the period's last day. A quarter not reported alone is the
difference of two year-to-date figures, or the year less three quarters, and is flagged in
`row.derived[i]`. EPS and share counts are never derived. IFRS filers get `statements: null`
with `statementsNote`. Tag fallbacks are the `CONCEPTS` table at the top of the file.

## 2. US Treasury par yield curve (chosen; official, no key)

`https://home.treasury.gov/resource-center/data-chart-center/interest-rates/pages/xml?data=daily_treasury_yield_curve&field_tdr_date_value_month=YYYYMM`
(also `field_tdr_date_value=YYYY`, or `=all&page=N`, 300 rows a page). Fields: `d:NEW_DATE`,
`d:BC_1MONTH`, `d:BC_1_5MONTH`, `d:BC_2MONTH`, `d:BC_3MONTH`, `d:BC_4MONTH`, `d:BC_6MONTH`,
`d:BC_1YEAR` ... `d:BC_30YEAR` inside each `entry/content/m:properties`. End-of-day data from
quotes taken at about 3:30 pm; labelled with its date. Budget 20 calls a minute; kept 1 hour
(stale 3 days).

Status: URL and parameters **read in documentation**
(<https://home.treasury.gov/treasury-daily-interest-rate-xml-feed>); `BC_1_5MONTH` and
`BC_4MONTH` confirmed in the Treasury's developer notice; other field names confirmed from an
open-source client; the envelope is **from memory**. The feed itself **could not be opened**.
No terms of use were found on the pages read.

## 3. Federal Reserve meeting dates (chosen; official)

<https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm> **seen live**. The 2026 and
2027 dates and the 2026 minutes dates are held as a table in `calendar.js`, dated 2026-11-19,
because the page's HTML structure could not be inspected and the schedule changes a few times
a year. Events carry no time of day (the page gives none). Minutes dates the Fed has not listed
are computed from its stated rule (three weeks after the decision) and say "expected".
The page lists 2027 meetings on 26-27 October and 16-17 November with the label "Monetary
Policy Strategy Meeting" between them and no December meeting; both dates are held as read.
**Re-check this table whenever the Fed revises its calendar.** `health()` reports an error once
the table has run out.

## 4. FRED (chosen for macro and release dates; free key)

- Observations: `https://api.stlouisfed.org/fred/series/observations?series_id=&api_key=&file_type=json&sort_order=desc&limit=6&units=` returning `observations[].{date,value}` (value is a string). **Read in documentation.** Missing values as "." are **from memory**.
- Series used: `CPIAUCSL` (units `pc1`), `UNRATE`, `FEDFUNDS`, `A191RL1Q225SBEA`, `DGS10`. All are produced by US government bodies. Series ids **from memory**.
- Release dates: `fred/release/dates?release_id=&include_release_dates_with_no_data=true` and `fred/release?release_id=` for the name. Only the sibling `fred/releases/dates` page was **read in documentation** (it confirms future dates need `include_release_dates_with_no_data=true`); these two endpoints and the release ids (10, 50, 53, 54, 46, 9, 192, 13, 180) are **from memory**. The event title is always the name FRED returns, so a wrong id cannot mislabel an event. FRED gives no time of day.
- Terms (<https://fred.stlouisfed.org/docs/api/terms_of_use.html>, read): show the notice "This product uses the FRED® API but is not endorsed or certified by the Federal Reserve Bank of St. Louis." (it is sent in the `sources` note of every answer that uses FRED; the page must display it); link users to the terms; series owned by third parties (stock indexes, for example) need the owner's permission for more than personal use and are not used here. No numeric rate limit is published; ours is 60 a minute.

BLS and BEA release calendars: **could not check** (no parseable official feed was found).

## 5. Prices

There is no official free real-time source of US share prices. Options considered:

| Option | Free tier | Display terms | Decision |
|---|---|---|---|
| Hyperliquid equity and index perpetuals (builder venue `xyz`) | No key. 1,200 weight a minute per IP; `metaAndAssetCtxs` 20, `candleSnapshot` 20 plus 1 per 60 candles. | Public API; no display restriction found in the pages read. | **Keyless path.** |
| Finnhub | 60 calls a minute (third-party summary). | **Could not check**: its pricing and documentation pages returned no readable text. | Keyed provider for quotes, earnings and IPO calendars. Confirm terms before customer display. |
| Twelve Data | 8 credits a minute, 800 a day; real-time US equities; time series and quote included. | Basic plan is "Internal non-display usage"; commercial display needs a business plan and attribution. | Keyed provider for history. **Not licensed for display on the free plan.** |
| Massive (formerly Polygon) | 5 calls a minute, end-of-day, 2 years (third-party comparison). | "Individual-use terms" (same source). | Not built. |
| Alpha Vantage | 25 requests a day (third-party comparison). | Not stated there. | Not built: too small. |
| Tiingo, Stooq | **Could not check.** | **Could not check.** | Not built. |

**Hyperliquid perpetuals, plainly.** `POST https://api.hyperliquid.xyz/info` with
`{"type":"metaAndAssetCtxs","dex":"xyz"}` returns `[{universe:[{name:"xyz:NVDA",...}]}, [{markPx, prevDayPx, dayNtlVlm, oraclePx, ...}]]`
(**read in the official documentation**, which shows `xyz:XYZ100`, `xyz:TSLA`, `xyz:NVDA`).
These are derivative contracts that trade round the clock at their own price. They are not
the exchange's price, the change is over 24 hours and not since the close, there is no share
volume and no market value. Every such quote carries `kind: 'perp'`, `changeBasis: '24h'`,
`previousClose: null` and a `source` naming the contract. A perpetual is used for a share only
if its name is on an allow-list of unmistakable tickers, so a contract named GOLD is never
shown as a company. Index contracts appear under our own symbols (`HL:XYZ100`) and are named
"XYZ100 perpetual on Hyperliquid", never after the index they imitate. Movers are computed
over that handful of shares and say so in `movers.universe`.
Verified in the review (official info-endpoint page): `candleSnapshot` takes the venue-prefixed
coin ("For HIP-3, you need to prefix with the dex name, e.g. `xyz:XYZ100`"), `1d` is a supported
interval, and only the most recent 5,000 candles are available. The venue's own specification
lists the index contracts `SP500`, `XYZ100`, `JP225`, `KR200`. Still unseen: one live answer. Budget: 260 weight a
minute, because `src/hyperliquid.js` may spend up to 900 of the same 1,200 from this server.

**Finnhub** (`https://finnhub.io/api/v1`, `token` query parameter): `/quote?symbol=` returning
`{c,d,dp,h,l,o,pc,t}`; `/calendar/earnings?from=&to=` returning
`earningsCalendar[].{symbol,date,hour,quarter,year,epsEstimate}`; `/calendar/ipo?from=&to=`
returning `ipoCalendar[].{name,symbol,date,exchange,price,status}`. Shapes taken from an
open-source client library, not the official pages. Quotes are marked `delayed: true` because
freshness on the free plan could not be confirmed. Budget 50 a minute; one call per symbol,
kept 30 seconds. Whether these endpoints are still free: **not checked**.

**Twelve Data** (`https://api.twelvedata.com`, header `Authorization: apikey KEY`):
`/time_series?symbol=&interval=1day&outputsize=` returning `values[].{datetime,open,high,low,close,volume}`
(read in documentation); `/quote?symbol=` (fields `close`, `previous_close`, `percent_change`, `timestamp`,
`last_quote_at`, `is_market_open` **read in documentation** in the review; `timestamp` is the
opening time of the current daily bar, so the price's time is taken from `last_quote_at`). Errors arrive as
`{code,message,status:"error"}`. Budget 7 a minute and 750 a day.

A licensed feed plugs in as one more object with `quote(symbol, led)` and
`candles(symbol, range, led)` at the front of the provider lists in `live.js`.

## 6. Not connected in any configuration

Sector moves (`sectors` is always `[]` live), share volume and market value on perpetual
quotes, market-wide movers, times of day for economic releases and Fed events, and
real exchange index levels. Each is reported in `sources` with state `off`.

## Fields beyond the brief

- Every statement: `periodEnds` (ISO dates, parallel to `periods`); rows may carry `derived: [boolean]` and `computed: true`. Quarterly periods are labelled `Q3 FY2026`.
- `/company`: `statementsNote` (why statements are null), `sector` (demo only). `fiscalYearEnd` is `MM-DD`.
- `/quote` and index rows: `kind` (`'stock'|'perp'|null`), `changeBasis`, `source`, `volumeUsd`. `delayed` is `null` when there is no price.
- `/candles`: `interval` (always `1d`), `kind`, `source`; `time` is the UTC midnight of the trading day.
- `/calendar`: `from`, `to`, `timezone` (`America/New_York`; `time` is `HH:MM` in that zone or null).
- `/ipos` rows: `alreadyListed` (the filer already has a ticker, so this is probably not a first listing), `source`. Live rows from EDGAR never have `expectedDate` or `priceRange`; those come only from Finnhub rows, which have `form: null`, `filedAt: null`, `url: null`.
- `/private` rows: `detail` (false when the filing's amounts could not be read).
- `movers.universe` (live) explains what the movers are drawn from; `movers` is null when no price source is on.
- Demo: every `url` is null (there is no real document to link to).

## Review of 2026-11-19: what was checked against documentation, and what changed

Checked with a web-fetch tool against the pages named; "confirmed" means the page says so in
words, not that a live answer was seen. Nothing below was seen live from this server.

| Item | Outcome |
|---|---|
| SEC submissions, company facts, frames (sec.gov "EDGAR Application Programming Interfaces") | URL patterns confirmed. Submissions hold "at least one year of filings or 1,000, whichever is more", with older ones in `files`. Units with a numerator and denominator are written `USD-per-shares` in frames addresses; the `USD/shares` key inside company facts and the `filings.recent` parallel arrays are still **from memory**. No CORS, 10 requests a second, and the User-Agent form are confirmed. |
| SEC ticker files | Both files confirmed to exist with the stated contents; the SEC "does not guarantee accuracy or scope". Field layout of the exchange file still **from memory**. |
| EDGAR `getcurrent` Atom feed | **Could not be checked**: the tool returned an unrelated HTML page for the address. Entry format remains from memory. The parser now fails (502, or the saved answer) on anything that is not an Atom feed, where before an HTML block page read as "no filings". |
| Form D `primary_doc.xml` | File name confirmed on a real filing index (sec.gov, accession 0001620733-19-000001 lists `primary_doc.xml`). Element names confirmed against sec-api.io's reference, which shows `investmentFundInfo` both under `industryGroup` and beside it: both are now read. "Indefinite" as the literal value of `totalOfferingAmount` is **from memory**. |
| Treasury yield feed | Address, `data=`, the three date parameters and paging confirmed (home.treasury.gov). `NEW_DATE` and the `BC_` prefix confirmed from the CRAN `treasury` package source; `BC_1_5MONTH`, `BC_4MONTH`, `m:type` and `m:null` from the Treasury's developer notice. The `feed/entry/content/m:properties` envelope appears only as an image on the Treasury page: **not confirmed**. |
| FRED | `series/observations` (parameters, `pc1`, string `value`) and `release/dates` (`release_id`, `include_release_dates_with_no_data`, `release_dates[].date`) confirmed. The `fred/release` page could not be opened. The "." missing value is not mentioned on the observations page: still **from memory** (it is skipped if it appears, and any other non-number is skipped too). |
| Twelve Data | `time_series`: `outputsize` 1 to 5000 confirmed (used for `range=max`), `values[]` fields confirmed, one credit a symbol. `quote`: field list confirmed. `Authorization: apikey KEY` confirmed as the recommended method; errors are `{code,message,status}`. **Code changed**: `asOf` used `timestamp` (the bar's opening time, hours early) and now uses `last_quote_at`. |
| Finnhub | Official pages returned no text again. A third-party catalogue confirms only that the key is the `token` query parameter. Response fields remain from an open-source client. |
| Hyperliquid | See section 5: prefix, interval and the 5,000-candle limit confirmed; index names confirmed from docs.trade.xyz. |

Other changes from the review that bear on sources:

- **Per-address fairness.** Each request runs for one address (`req.ip`). The router allows 300
  weighted requests a minute per address (company and candles count 3). On top, each source
  charges real upstream calls to the address that caused them: SEC 60 a minute, Finnhub 30,
  Twelve Data 4, Hyperliquid weight 160. Fixed files and feeds (the ticker list, filing feeds,
  the Hyperliquid market list, FRED, calendars) are charged to nobody. Refusals are HTTP 429,
  never cached. This narrows, but cannot remove, the reach of one address over an allowance as
  small as Twelve Data's 7 a minute: two addresses can still use all of it.
- **Calendar.** Finnhub is asked by whole calendar month and the answer cut to the days wanted.
- **Form D.** Details are read in the background; `/private` answers within about 1.5 seconds
  with `detailsPending` and rows marked `detail: false` (amounts unknown, shown as "Not read").
- **A service saying stop.** HTTP 429 (and 403 from the SEC) pauses every call to that source
  for `Retry-After`, or 30 seconds (SEC 60), serving saved answers meanwhile.
- **Bodies** are read up to a cap (4 MB; 64 MB for company facts, 16 MB for the ticker file);
  XML with a document type or entity declarations is refused before parsing.
- **Keys** are stripped from every error message (`token=`, `api_key=`) before it can reach a
  log, the Status page or a client.
- **`range=max`**: Twelve Data `outputsize=5000`; Hyperliquid a 5,000-day window; the demo from
  5 January 2015. Every `/candles` answer carries `range`, `historyStart` and `capped` (true when
  the answer is as long as the source allows, so earlier history may exist).
- **Statements.** `Revenues` (the total) is preferred over the contract-revenue tags; a quarter
  under a second-choice tag is used only if that tag's annual figure agrees with the first
  choice's; quarter ends are also found from stand-alone quarters; a filer reporting in another
  currency gets `statements: null` with a reason naming the currency.
- **Demo names.** Six names were real firms or one letter from one (Vantrix, Ardent Leisure,
  Tindra, Quillon, and the near-misses Zephra, Oktavo) and six pipeline words likewise; all
  were replaced and the replacements searched for. A search finding nothing is not proof that
  no firm anywhere uses a name.

Still unverified until the first live run: every response shape marked from memory above; that
the SEC accepts the configured User-Agent; the real size of company-facts files against the
64 MB cap; Finnhub's free-plan coverage of quotes and calendars; that Hyperliquid's weight for
a 5,000-day candle request is what is budgeted (104).

## Funds: Form 13F, Forms 3/4/5, Schedules 13D and 13G (added 2026-11-19)

Code: `src/tradfi/funds.js` (readers, arithmetic, live service), `src/tradfi/fundsDemo.js`,
two additions to `edgar.js` (`profile` also returns `insiderFilings` and `stakeFilings`; the
filings feed takes `count` and `owner`). All calls go through the one SEC source: same
User-Agent, cache, coalescing, 8 a second, and the per-address share of 60 a minute.

**Calls made**

| What | Address | Charged to |
|---|---|---|
| A manager's filing list | `data.sec.gov/submissions/CIK##########.json` (kept 30 minutes) | the visitor who opens a manager not yet read; nobody when the background fill reads it |
| One 13F filing, whole | `www.sec.gov/Archives/edgar/data/<cik>/<accession, no dashes>/<accession>.txt` (kept 7 days; body cap 64 MB) | as above |
| Fallback: the filing's index, then the table file it lists | `.../index.json`, then `.../<name>.xml` (and `primary_doc.xml` for an amendment) | as above |
| A company's insider and stake filings | the company's submissions file, the same fetch the company page makes | the visitor |
| One Form 4, whole | `.../<accession>.txt` (2 MB cap), newest 10 per company | the visitor, for `/insiders`; nobody for `/insiders/latest` |
| Newest Form 4 filings, all companies | `cgi-bin/browse-edgar?action=getcurrent&type=4&owner=only&count=100&output=atom` | nobody (shared feed) |

A 13F is read from the **complete submission text file**, not from a guessed file name: that
file is named by the accession number alone and holds every document with its `<TYPE>`
(`13F-HR`, `INFORMATION TABLE`), so the cover page and the table arrive in one request. If it
is missing or holds no table, the filing's `index.json` is read and the table is the XML file
that is not `primary_doc.xml` (a name containing "info", "table" or "13f" first, then the
largest). This is a deviation from "find it in the index" only in order: the index is the
fallback, because the text file costs one request where the index route costs two or three.

**Rules applied**

- **Value units.** `value` is multiplied by 1,000 for a filing made before 2023-01-03 and
  taken as dollars from that date, by the filing date in the submissions file.
- **Amendments.** For one quarter: the newest `13F-HR/A` whose cover says RESTATEMENT replaces
  everything before it; later ones that say NEW HOLDINGS are added on; an amendment that says
  neither, or cannot be read, is left out and a note says so. At most the three newest
  amendments of a quarter are opened.
- **Aggregation.** Rows are added by CUSIP + put/call + shares-or-principal. A CUSIP of 6 to 8
  characters gets its leading zeros back (a spreadsheet artefact). A row without a readable
  CUSIP, value or amount is skipped and counted.
- **Cap.** At most 60,000 rows of a table are read (`tuning.fundRows`). A capped table says so,
  its totals are understated, and no changes are computed from it.
- **Changes** are by share count for plain share rows (not options, not principal amounts).
  Increases and decreases are ranked by the change in shares times the latest filing's own
  price (value / shares). A split, a merger or a new CUSIP appears as a change.
- **Share of portfolio** is value over the table's total, options included.
- **Tickers.** No CUSIP-to-ticker source is used. A ticker is attached only when the issuer
  name, normalised (case, punctuation, Inc/Corp/Co/Ltd/Holdings spellings, a trailing state
  such as DEL), equals the normalised name of exactly one company in the SEC ticker file, the
  row is shares and not a note, preferred, warrant, unit or right, and either the company has
  one ticker or it has exactly one ticker without a class suffix and the row is titled as the
  ordinary share with no class. Otherwise the issuer name is shown unlinked. The 13F list
  abbreviates many names, so a large part of real rows will be unlinked.
- **`/holders`** reads only tables already in memory. It never starts a fetch of a filing.
- **Background fill.** Starts on the first Funds request, two managers at a time, 1.5 seconds
  apart, on nobody's account. A table is re-read after 6 hours; a failure is retried after 2
  minutes; `/funds` reports `pending`.
- **Name guard.** A manager is shown only if the name EDGAR returns for its number contains
  the expected word (for example `BRIDGEWATER`); otherwise it is an error row.

**The managers, and how each number was checked (2026-11-19)**

"Title" means a sec.gov search result whose title reads "<filer name> - Form 13F-HR" at an
address under that CIK. "Index" means a sec.gov filing index page for that CIK was opened and
names the filer. Nothing was read from `data.sec.gov` (the fetch tool refuses it).

| Manager | CIK | Checked by |
|---|---|---|
| Berkshire Hathaway | 1067983 | Title |
| Citadel Advisors | 1423053 | Index (0000950123-22-006403: table `13310.xml`, 8.5 MB) |
| Jane Street Group | 1595888 | Index (0001595888-15-000011) |
| Susquehanna International Group | 1446194 | Title |
| Bridgewater Associates | 1350694 | Title |
| Renaissance Technologies | 1037389 | Title |
| Two Sigma Investments | 1179392 | Title |
| Millennium Management | 1273087 | Title |
| Point72 Asset Management | 1603466 | Index (0000902664-25-002399) |
| D. E. Shaw & Co. | 1009207 | Title |
| AQR Capital Management | 1167557 | Title |
| Tiger Global Management | 1167483 | Title |
| Coatue Management | 1135730 | Title |
| Viking Global Investors | 1103804 | Title |
| Lone Pine Capital | 1061165 | Title |
| Pershing Square Capital Management | 1336528 | Title |
| Third Point | 1040273 | Title (under its earlier name, Third Point Management Co LLC) |
| Elliott Investment Management | 1791786 | Index (0001013594-24-000968) |
| Baupost Group | 1061768 | Title |
| Appaloosa | 1656456 | Index (0001656456-18-000006) |
| Duquesne Family Office | 1536411 | Index (0001536411-25-000011) |
| Soros Fund Management | 1029160 | Title |
| Greenlight Capital | 1079114 | Title |
| Tudor Investment Corp | 923093 | Title ("Tudor Investment Corp et al") |
| Scion Asset Management | 1649339 | Cover page of 0000905148-23-001400 opened |
| Situational Awareness LP | 2045724 | Index (0002045724-25-000008) and its submission text file |

None was dropped. Not checked: that each still files (Scion in particular may have stopped;
a manager with no recent 13F-HR is shown as "No 13F holdings report"), and that the newest
1,000 filings in a submissions file always reach back two quarters for the busiest filers
(Citadel, Millennium and Susquehanna file hundreds of 13G forms each February).

**What was verified, and how**

| Item | Outcome |
|---|---|
| 13F information-table element names | **Seen in a real filing** (0002045724-25-000006 text file, tag outline read back by the fetch tool): `informationTable` > `infoTable` > `nameOfIssuer`, `titleOfClass`, `cusip`, `value`, `shrsOrPrnAmt` > `sshPrnamt`, `sshPrnamtType`; `putCall`; `investmentDiscretion`; `votingAuthority` > `Sole`, `Shared`, `None`; all with an `ns1:` prefix in that filing, namespace `http://www.sec.gov/edgar/document/thirteenf/informationtable`. Put/Call values "Put"/"Call" and type "SH" seen. `figi` and `otherManager` from the SEC's 13F data-set readme. The reader accepts any prefix or none. |
| 13F cover (`primary_doc.xml`) | **Seen**: `edgarSubmission` > `headerData` > `submissionType`, `filerInfo` > `periodOfReport`; `formData` > `coverPage` > `reportCalendarOrQuarter`, `reportType`; `summaryPage` > `tableEntryTotal`, `tableValueTotal`. `isAmendment`, `amendmentNo`, `amendmentType` and the values RESTATEMENT / NEW HOLDINGS: **documentation only** (field names in the SEC readme, the two kinds in the SEC's 13F FAQ); the exact tag spelling and nesting are from memory, and that filing had none. Date format `MM-DD-YYYY` seen on a rendered cover. |
| Value-units change | **Documentation**: the SEC's 13F FAQ gives the compliance date of the amended form as 3 January 2023 and the change from thousands to the nearest dollar; the SEC's 13F data-set readme says "Starting on January 3, 2023, market value is reported rounded to the nearest dollar". Also seen: a table filed in May 2022 headed "(x$1000)" and one filed in 2023 headed "(to the nearest dollar)". Whether every filer switched on the day: not checked; a filer that kept using thousands after the date would be shown 1,000 times too small. |
| Complete submission text file | Address pattern confirmed on sec.gov "Accessing EDGAR Data"; header labels `CONFORMED SUBMISSION TYPE`, `FILED AS OF DATE`, `CONFORMED PERIOD OF REPORT` seen. The `<DOCUMENT>`/`<TYPE>`/`<TEXT>` wrapping is **from memory**. |
| `index.json` in a filing directory | The page says index.json exists for directories; the `directory.item[].name/size` shape is **from memory**. Table file names vary as expected: `13310.xml`, `infotable.xml`, `informationtable.xml`, `Form13FInfoTable.xml`, `form13f_20250630.xml`, `SALP13FinfotableQ3.xml` (all seen on index pages). |
| 13F rules | SEC FAQ: due within 45 days of quarter end; short positions are not reported; options are reported under the CUSIP and share count of the underlying, with PUT or CALL, and written options are not reported; a restatement resubmits the whole table, a new-holdings amendment lists only what is added. |
| Form 4 XML element names | **Not seen** (no raw Form 4 could be opened). From memory: `ownershipDocument`, `documentType`, `periodOfReport`, `issuer/issuerCik|issuerName|issuerTradingSymbol`, `reportingOwner/reportingOwnerId/rptOwnerName`, `reportingOwnerRelationship/isDirector|isOfficer|isTenPercentOwner|isOther|officerTitle|otherText`, `nonDerivativeTable/nonDerivativeTransaction`, `derivativeTable/derivativeTransaction`, `securityTitle/value`, `transactionDate/value`, `transactionCoding/transactionCode`, `transactionAmounts/transactionShares|transactionPricePerShare|transactionAcquiredDisposedCode` (each with `value`), `postTransactionAmounts/sharesOwnedFollowingTransaction/value`, `ownershipNature/directOrIndirectOwnership/value`, `underlyingSecurity/underlyingSecurityTitle|underlyingSecurityShares`, `aff10b5One`. The SEC's insider-transactions data-set readme confirms the field set (names in upper case) and the tags `nonDerivativeTransaction` and `derivativeTransaction`. |
| Transaction codes | **Documentation**: the SEC readme's code table (A, C, D, E, F, G, H, I, J, L, M, O, P, S, U, W, X, Z). The plain wording shown is ours. |
| Form names for stakes | `SC 13D`, `SC 13G` and, for filings since the structured forms, `SCHEDULE 13D`, `SCHEDULE 13G`, each with `/A`: **from memory**. |
| `getcurrent` with `owner=only` | **Not checked** (the feed could not be opened, as before). If `owner=only` is ignored the list would also hold 424B and 40-F forms; those are filtered out by form name, at the price of fewer Form 4 rows. |
| That an insider's filing is reachable under the issuer's CIK directory | From memory. |

**Demo.** Eight invented managers (ids `00098…`) hold the demo companies; CUSIPs start with
`DEMO`. Their names were searched for on 2026-11-19 with no exact match; one first choice sat
a letter from a real family office and was replaced. People are an initial and an invented
surname. Tables go through the same `summarise` and `compare` as live filings.

**Fields.** `/funds` rows: `state` is `ready`, `loading`, `none` (no 13F-HR on file),
`error` or `off`. `/fund`: `filing.parts` lists the filings a quarter's table was built from
with `role` (`original`, `restatement`, `new holdings`); `filing.stated` is the manager's own
entry count and value total from the cover, for comparison; `changes` is null when there is
nothing sound to compare with. `/holders`: `matched` is false when the company's name cannot
be tied to 13F rows with certainty. Insider rows: `detail: false` means the filing was listed
but not opened.
