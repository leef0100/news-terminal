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
Unverified: that `candleSnapshot` accepts a venue-prefixed coin such as `xyz:NVDA` (not in the
documentation read), and which index contracts exist beyond `XYZ100`. Budget: 260 weight a
minute, because `src/hyperliquid.js` may spend up to 900 of the same 1,200 from this server.

**Finnhub** (`https://finnhub.io/api/v1`, `token` query parameter): `/quote?symbol=` returning
`{c,d,dp,h,l,o,pc,t}`; `/calendar/earnings?from=&to=` returning
`earningsCalendar[].{symbol,date,hour,quarter,year,epsEstimate}`; `/calendar/ipo?from=&to=`
returning `ipoCalendar[].{name,symbol,date,exchange,price,status}`. Shapes taken from an
open-source client library, not the official pages. Quotes are marked `delayed: true` because
freshness on the free plan could not be confirmed. Budget 50 a minute; one call per symbol,
kept 20 seconds. Whether these endpoints are still free: **not checked**.

**Twelve Data** (`https://api.twelvedata.com`, header `Authorization: apikey KEY`):
`/time_series?symbol=&interval=1day&outputsize=` returning `values[].{datetime,open,high,low,close,volume}`
(read in documentation); `/quote?symbol=` (fields `close`, `previous_close`, `percent_change`,
`timestamp` are **from memory**; only `is_market_open` was confirmed). Errors arrive as
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
