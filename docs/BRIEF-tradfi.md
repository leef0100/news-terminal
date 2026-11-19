# Brief: Halftone becomes one terminal for crypto, stocks and private markets

Written by the build lead for the agents doing the work. Halftone is being built by a firm
as a product it will sell: a single terminal a trader or analyst can live in. It already
covers crypto (news, Radar, live markets). This brief adds traditional and private markets.

## What the customer asked for

Stock indexes and charts; every listed company with its financial reports as a click-down;
upcoming IPOs; calendars; private-market activity; "everything and more". Green and white
theme. It will be shown to investors, so nothing on screen may be wrong, unlabelled, or
invented and passed off as real.

## Rules that do not bend

1. Real data only from sources we are allowed to use, used as their documentation says.
   Prefer official and public-domain sources (SEC EDGAR, US Treasury, Federal Reserve, BLS,
   BEA). Do not scrape sites whose terms forbid it. No unofficial Yahoo/Google endpoints.
2. Every figure shows where it came from and how old it is. Delayed or end-of-day prices
   say so. A source that is not configured shows "not connected", never a guess.
3. Demo mode uses invented companies with invented tickers (never real company names with
   made-up numbers) and is labelled as demo.
4. Descriptive, not advice. No ratings, targets or "buy/sell" language of our own.
5. The shell here cannot reach the internet. Code against documented shapes, test against
   stand-ins, and write down exactly what was and was not verified.

## Pages

- **Stocks** (`#stocks`, `#stocks/SYMBOL`): overview (indexes with sparklines, sector
  moves, movers, Treasury yield curve, key macro figures), a search box over all listed US
  companies, and a company page: price chart, key facts, financial statements (income,
  balance sheet, cash flow; annual and quarterly) as an expandable click-down, and recent
  filings linking to the SEC.
- **Calendar** (`#calendar`): earnings, IPOs, economic releases and central-bank dates on
  one agenda, filterable by kind.
- **Private** (`#private`): the IPO pipeline (new registration statements) and private
  fundraising disclosed to the SEC (Form D): who raised, how much, what industry, when.

## API contract (server answers JSON under `/api/tradfi`)

Every answer carries `demo` (boolean), `at` (ms), and `sources`: an array of
`{ name, state: 'ok'|'off'|'error', note }` for the sources that answer drew on. A part whose
source is off is `null` (or an empty array) with the reason in `sources`.

- `GET /overview` -> `{ indexes: [{ symbol, name, price, changePct, spark: [number], asOf, delayed }],
  sectors: [{ name, changePct }], movers: { gainers, losers, active: [{ symbol, name, price, changePct, volume }] },
  yields: { asOf, points: [{ tenor: '1M'..'30Y', value }] }, macro: [{ id, name, value, unit, period, previous }] }`
- `GET /search?q=` -> `{ results: [{ symbol, name, exchange }] }` (max 12)
- `GET /quote?symbols=A,B` (max 20) -> `{ quotes: [{ symbol, name, price, changePct, previousClose, open, high, low, volume, marketCap, asOf, delayed }] }`
- `GET /candles?symbol=&range=1m|6m|1y|5y` -> `{ symbol, candles: [{ time (UTC seconds), open, high, low, close, volume }], delayed }`
- `GET /company?symbol=` -> `{ symbol, name, cik, exchange, industry, fiscalYearEnd,
  facts: [{ label, value, unit, period }],
  statements: { annual: S, quarterly: S }, filings: [{ form, filedAt, title, url }] }`
  where `S = { periods: ['FY2025', ...newest first, up to 5 annual / 8 quarterly],
  income: [Row], balance: [Row], cashflow: [Row] }` and
  `Row = { key, label, unit: 'USD'|'USD/share'|'shares', values: [number|null], children?: [Row] }`.
- `GET /calendar?from=YYYY-MM-DD&to=YYYY-MM-DD` (max 45 days) -> `{ events: [{ date, time, kind:
  'earnings'|'ipo'|'economic'|'central-bank', title, symbol, detail, importance: 1..3, source, url }] }`
- `GET /ipos` -> `{ pipeline: [{ company, symbol, exchange, form, filedAt, expectedDate, priceRange, status: 'filed'|'expected'|'priced'|'withdrawn', url }] }`
- `GET /private` -> `{ raises: [{ issuer, industry, state, filedAt, amountOffered, amountSold, firstSale, form, url }] }`

Unknown symbol or bad parameter: HTTP 400 `{ error }`. Upstream failure: 502 `{ error }`.

## Environment

Optional keys unlock sources: read them from the `env` object passed in, never from
`process.env` directly. Each source reports itself through `health()` for the Status page.
