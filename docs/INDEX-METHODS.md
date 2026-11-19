# Halftone indexes: methods, inputs and what was verified

What `/api/indexes` and the Indexes page (`#indexes`, `#indexes/<id>`) are built from. Every
index here is **a Halftone index, not an official benchmark**. The rule the module is built
around: an index is only as honest as its inputs. Each one is built only from named inputs
with a source the product may use; its method is data in `config/indexes.json` and is shown on
its page under "How this is calculated"; and when an input is missing the index is "not
connected" with the reason, never a guess.

Code: `src/indexes/` (`index.js` router, `engine.js` methods, `math.js` arithmetic, `live.js`
inputs, `demo.js` invented inputs), `public/indexes.js`, `public/indexes.css`. Tests:
`test/indexes.test.js` (exact numbers for every formula below), `test/e2e/indexes.mjs`.

The build shell has no internet access. Checks were made on 2026-11-19 with a web-fetch tool
that opens only pages a search has surfaced, and answers through a summariser. For every item
below: **seen live** (the page itself was read that day), **read in documentation**, or **not
checked** (coded from prior knowledge; confirm against one real answer before customers see it).
No upstream API answer was seen from this server.

## Settings

| Variable | Unlocks | Without it |
|---|---|---|
| `SEC_USER_AGENT` (stocks module) | AI capital spending tracker and index; GPU demand index | Both "not connected" |
| `TWELVEDATA_KEY` (stocks module), or a licensed feed plugged into the stocks module | Data center index; AI hardware basket | Both "not connected". Showing Twelve Data prices to customers needs its business plan (see TRADFI-SOURCES.md) |
| `EIA_KEY` | Energy cost index, from the EIA | Falls back to `FRED_KEY`; with neither, "not connected" |
| `FRED_KEY` | Energy cost index from FRED's copies (electricity as a producer price index) | see above |
| `INDEXES_CLOUD_PRICES=off` | Turns the Azure price collector off | On by default: no key is needed |
| (none) | Inference price index (a dated table in the config); AI-linked crypto basket (Hyperliquid) | |

With no keys at all: inference (hand-entered table), compute (once Azure has been collected),
AI-linked crypto. With `SEC_USER_AGENT` only: add capital spending and GPU demand.

## The arithmetic (`math.js`)

- **Equal-weighted, rebalanced daily** (`equalWeighted`): on each day every member with a value
  that day and an earlier one counts once; its return is today's value over its own previous
  value; the index moves by the plain average. A member's first value only sets its starting
  point. A missing day leaves the member out, and its whole move arrives when it returns. A day
  with fewer than `minConstituents` counted members is not shown. Scaled to 100 on the base
  date, or the first day if history starts later (the page says which).
  Contribution of member i over a period = sum over days of (index the day before x its return
  / members counted), as a percentage of the index at the start of the period. Contributions
  sum exactly to the index's move.
- **Fixed-weight relatives** (`weightedRelatives`): index = 100 x sum(weight x value / value on
  the base date), over dates every component has.
- **Company quarters** (`calendarQuarter`, `quarterTable`, `trailingFour`, `growth`): a
  reporting quarter is placed in the calendar quarter holding the middle of the period (45 days
  before its end). A total exists only when every company has a figure. Trailing four = the
  quarter and the three before it, all present. Year over year = change from four quarters
  earlier, null if either is missing.
- **Changes on cards**: 1 day (daily indexes, previous point within 5 days), 1 month, 1 year,
  each only when the series reaches back that far (within a few days); otherwise the change
  since the previous point, with its date.

## The five requested indexes

### Inference price index (`inference`)
- **Built from**: a dated, hand-entered table (`snapshots` in the config) of each provider's
  published list prices, one link per row. Blended price = (3 x input + 1 x output) / 4, USD
  per 1M tokens. Index: equal-weighted chain across dated tables, 100 at the first.
- **Connected when**: at least one table with three valid rows is in the config. No key.
  One table is entered (2026-11-19), so the index reads 100 with nothing yet to compare; it
  moves when an operator adds the next dated table.
- **Why by hand**: no official machine-readable price endpoint was found for OpenAI, Anthropic
  or Google (search on 2026-11-19 found only third-party aggregators). Azure's retail price list
  does carry Azure OpenAI meters, but their meter names could not be verified and they are one
  reseller's prices, so they are not used.
- **Verified**: the nine prices were **seen live** on 2026-11-19 on
  developers.openai.com/api/docs/pricing, platform.claude.com/docs/en/about-claude/pricing and
  ai.google.dev/gemini-api/docs/pricing (through the summarising fetch tool; re-read each page
  by eye before an investor demo). Which models to include is a judgement.

### GPU demand index (`gpu-demand`)
- **Built from**: trailing-four-quarter **total revenue** of NVDA, AMD, AVGO, MU (half) and
  trailing-four-quarter capital expenditure of the tracker's buyers (half), from SEC statements
  through `tradfi.company`. Fixed-weight relatives, 100 at the first quarter both exist.
- **Connected when**: `SEC_USER_AGENT` is set and every company has four consecutive quarters.
- **Segment data**: the SEC's documentation (sec.gov "EDGAR Application Programming Interfaces",
  **read in documentation**) says the company-facts API holds facts that "apply to the entire
  filing entity". Data-center segment revenue is a dimensional fact and is therefore not there,
  so total revenue is used and labelled as such on the page.
- **GPU rental prices**: not built. No public source with a documented API and terms that
  clearly allow display was found; marketplace sites were not scraped.
- **Not checked**: that each of the four tickers returns quarterly `revenue` through the stocks
  module's tag fallbacks. TSMC is excluded because it files under IFRS.

### Energy cost index (`energy`)
- **Built from** (EIA): US average industrial retail electricity price, monthly
  (`electricity/retail-sales`, `data[0]=price`, `facets[sectorid][]=IND`,
  `facets[stateid][]=US`), and Henry Hub natural gas spot, daily (`natural-gas/pri/fut`,
  `facets[series][]=RNGWHHD`), averaged by month here. Half each against the base month 2023-01.
- **Fallback** (FRED): `WPU0543` (BLS producer price index, industrial electric power) and
  `MHHNGSP` (Henry Hub monthly, EIA). The page says the electricity input is then an index.
- **Connected when**: `EIA_KEY`, or `FRED_KEY`.
- **Verified**: API v2 base address, `api_key`, `frequency`, `data[]`, `facets[...][]`, `start`,
  `sort`, `offset`, `length`, the 5,000-row limit, values returned as strings, the
  `response.data[]` envelope, `sectorid` value `IND`, monthly periods as `YYYY-MM` and the
  retail-sales route: **read in documentation** (eia.gov/opendata documentation and the API
  v2.1.0 guide). Route `natural-gas/pri/fut` with daily frequency and `period`/`value` fields:
  read in an open-source client (gridstatus). Series id `RNGWHHD`: from the EIA's own page
  address for the series; the `series` facet name on that route and `stateid=US`: **not
  checked**. Limits: under about 9,000 requests an hour and 5 a second (EIA FAQ, read); this
  uses two calls every six hours. Terms: EIA material is public domain and may be reused; it
  asks for an acknowledgment with a date (eia.gov/about/copyrights_reuse.php, **read**); the
  source line carries "Source: U.S. Energy Information Administration". FRED series ids
  confirmed by title in search results; FRED's notice is shown as its terms require.
- **Not built**: wholesale power prices (no wholesale price series was found in the EIA API
  documentation read; the wholesale figures the EIA republishes come from a commercial
  exchange) and the generation mix (it describes supply, not cost, and would not change the
  index).

### Compute price index (`compute`)
- **Built from**: hourly pay-as-you-go Linux list prices of seven named Azure machines in
  `eastus` (four GPU, three CPU), from Microsoft's public retail price list
  (`https://prices.azure.com/api/retail/prices?$filter=armSkuName eq '…' and armRegionName eq
  'eastus' and priceType eq 'Consumption'`), collected at start-up and every six hours, one
  price per machine per day. Equal-weighted chain, 100 on the first day three machines have a
  price. A machine is used only if exactly one price is left after dropping Windows, Spot, Low
  Priority, reserved, other units and other currencies.
- **Connected when**: the collector has run once and three machines matched. No key.
  **History starts when this server first collects**, is kept in memory, and restarts with the
  server unless a store is passed (`createIndexes({ store })`, with `put(series, day, value)` and
  `get(series)`). Wiring a permanent store needs a change in `src/server.js`, which this module
  does not own.
- **Verified**: endpoint, no authentication, filter fields (`armSkuName`, `armRegionName`,
  `priceType`), item fields (`retailPrice`, `unitOfMeasure: "1 Hour"`, `type: "Consumption"`,
  `productName`, `meterName`, `skuName`, `currencyCode`), `Items`/`NextPageLink`, 1,000 rows a
  page: **read in documentation** (learn.microsoft.com, Azure Retail Prices overview). Machine
  names `Standard_NC40ads_H100_v5` and `Standard_ND96isr_H100_v5`: confirmed in Microsoft's VM
  documentation titles; the A100, T4 and D-series names: **not checked**. That Windows rows are
  told apart by `productName` and Spot/Low Priority by `meterName`/`skuName`: partly documented
  (the Spot convention), otherwise **not checked**; a wrong guess makes a machine "not found",
  never mispriced. **Terms**: the page states no rate limit and no API-specific terms of use;
  confirm display rights with Microsoft before customer display.
- **Not built**: AWS (its public bulk price file for EC2 in one region is hundreds of megabytes,
  **not checked** this session; the query API needs AWS credentials) and Google Cloud (its
  catalog API needs a key).

### Data center index (`data-center`)
- **Built from**: daily closes of EQIX, DLR, IRM, VRT, ETN, GEV, ANET, CEG, VST, DELL, CRWV via
  `tradfi.candles(symbol, '5y')`. Equal-weighted, daily, 100 on 2025-01-02.
- **Connected when**: the stocks module returns `kind: 'stock'` closes for at least four
  members (`TWELVEDATA_KEY` or a licensed feed). Hyperliquid perpetual prices are refused: they
  are not closes. With Twelve Data's allowance of seven calls a minute, the 21 basket members
  of the two share indexes are read over about three minutes after start-up; until every
  member is read the index is "Reading inputs" and shows no value. Closes are then kept six hours.
- **Tickers**: from prior knowledge, **not checked** against the SEC list in this session. At
  run time the stocks module rejects a ticker the SEC does not list; that member is then left
  out and named on the page.

## Extras

- **AI capital spending** (`capex`, and `GET /capex`): quarterly capital expenditure (the
  stocks module's `capex` cash-flow row, from `PaymentsToAcquirePropertyPlantAndEquipment` or
  `PaymentsToAcquireProductiveAssets`) of MSFT, GOOGL, AMZN, META, ORCL, by calendar quarter,
  with totals, year-over-year growth, trailing four quarters and an index (first trailing total
  = 100). Needs only `SEC_USER_AGENT`. The stocks module serves eight quarters, so: four
  year-over-year figures and five index points. Figures derived from year-to-date filings are
  marked †.
- **AI hardware basket** (`semis`): NVDA, AMD, AVGO, TSM, MU, MRVL, ASML, AMAT, LRCX, KLAC; same
  method and needs as the data center index.
- **AI-linked crypto basket** (`ai-crypto`): candidates TAO, RENDER, FET, IO, GRASS, VIRTUAL,
  AIXBT, NEAR. Each is used only if `hl.markets()` lists exactly that name when the index is
  built; the rest are dropped and named. Daily closes from `hl.candles(coin, '1d', 400)`, the
  day still trading left out. No key. Which of the names are listed today: **not checked**
  (decided at run time by design).

## Demo

All eight indexes, labelled "Demo: invented figures". Share baskets, the tracker and GPU demand
run the real arithmetic over the stocks demo's invented companies. Tokens, machines, model
providers and energy prices are invented in `demo.js` from fixed seeds. The method text shown
is the real index's, under a note saying so.

## Answers

Every answer carries `demo`, `at`, `sources: [{ name, state: 'ok'|'off'|'error', note }]`.
An index's own `state` is `ok`, `off` (not connected), `pending` (still reading inputs) or `error`.

- `GET /` -> `{ label, indexes: [{ id, name, meaning, label, state, note, frequency:
  'daily'|'monthly'|'quarterly'|'irregular', value, change: { d1, m1, y1, previous: { pct, since } },
  spark: [number], asOf, base: { t, value }, method }] }`. 502 only if every index is failing.
- `GET /series?id=&range=1m|6m|1y|5y|max` (default `1y`) -> `{ id, kind, name, meaning, label,
  summary, state, note, frequency, range, base, asOf, from, value, changePct, change,
  series: [{ t, v, r }]` (`v` on the index's base, `r` set to 100 at the start of the range)`,
  constituents: [{ id, name, reason, group, link, state: 'ok'|'missing'|'pending', note,
  weightPct, latest: { value, unit, asOf }, changePct, contributionPts, from }], weightNote,
  history, facts: [{ label, value, unit }], tables: [{ title, columns: [{ label, kind }], rows, note }],
  inputs: [{ name, source, url, from, asOf, note }], method: [text], methodNote, limits: [text] }`.
  Unknown id or range: 400. Index in `error`: 502.
- `GET /capex` -> `{ id, name, meaning, label, state, note, unit: 'USD', companies: [{ symbol,
  name, reason, state, note }], quarters: ['2025-Q1', ...oldest first], quarterEnds, values:
  { SYMBOL: [number|null] }, derived: { SYMBOL: [boolean] }, totals, yoy, companyYoy, trailing,
  trailingYoy, index, method, limits }`.

Cache headers: 60 s (`/`, `/series`; 5 s while anything is pending), 300 s (`/capex`), 2 s on
502, `no-store` on 400 and 429. 240 weighted requests a minute per address.

## Still unverified until the first live run

Every upstream shape marked not checked above; that the SEC statements of all nine companies
carry `capex` and `revenue` rows for eight quarters; that Oracle's and NVIDIA's off-calendar
quarters land where intended; the Azure selection rules; the EIA `series` facet and `stateid=US`.
In each case the failure mode is an index that says "not connected" or names the member it
left out, not a wrong figure.
