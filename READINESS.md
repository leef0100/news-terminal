# Readiness

What has been checked, what has not, and what to do before this is shown to investors.
Written 18 November 2026, updated 19 November 2026 for stocks, calendars, private markets,
the X columns and deployment.

## The short version

The product is built and tested as far as it can be from a machine that cannot reach the
outside services it depends on. It has **never been run against live data**. Nobody should
present it as flawless until the first live run below has been done and anything it turns
up has been fixed. Demo mode is clearly marked on every page and all of its data is invented.

## Do this first (about 30 minutes)

1. On a machine with normal internet, run `npm install` then `npm start`, and open
   `http://localhost:3000/#status`.
2. **News sources.** Every source should read "Reporting" within a minute. For any marked
   "Failing", read the error next to it, then fix its address in `config/sources.json` or
   remove it. Leave the page open for an hour and read the "Typical delay" column: that is
   the real speed of each source.
3. **Market data.** Each venue should read "Answering". From a US connection, expect Bybit
   and probably Binance to fail: they refuse US addresses. See "Known limits".
4. **Radar and Markets.** Open both, pick BTC, and compare the price, a few candles, EMA 200,
   funding and the order book against Hyperliquid's own site. The chart note should read
   "Live from Hyperliquid".
5. **Tokens.** Open a crypto story and check the matching tokens against DexScreener.
6. **My panel.** While signed in to X in the same browser, add two accounts, press "Show
   posts from X" and confirm each column fills with that account's posts. Then sign out of X
   and confirm the page explains the empty columns.
7. **Stocks.** Start with `SEC_USER_AGENT="Halftone you@yourdomain.com" npm start`. Open three
   companies you know well (one with a September year-end, one bank, one recent IPO) and
   compare revenue, net income, EPS, total assets and operating cash flow for the last two
   years and two quarters against the company's own 10-K and 10-Q. Any mismatch is a bug to
   report before launch. Check the yield curve against treasury.gov, and that every stock
   price says "perpetual price on Hyperliquid" unless a keyed price source is set.
8. **Calendar and Private.** Check the next Federal Reserve meeting date against the Fed's
   site, and open three Form D rows and three pipeline rows through to their SEC filings.

## What has been verified

| Area | How |
|---|---|
| Every page and interaction | Automated run in real Chrome against demo data, at desktop and phone widths |
| Live market stream | Against a stand-in that speaks the exchange's protocol: ticks, reconnects, candle rollover |
| Trading maths | Unit tests against worked examples: EMA, RSI (Wilder's published example), ATR, VWAP anchoring, pivots, volume profile, liquidation estimate (Hyperliquid's published formula), position sizing |
| Server | API tests, security headers, rate limits, and two web servers plus an ingest worker sharing state through a real Redis |
| Throughput on one machine | About 8,500 feed requests a second; 8,000 live connections in about 115 MB; one story to all of them in 130 ms |
| Exchange API shapes | Compared field by field with official documentation for Hyperliquid, Binance, Bybit and Coinbase |
| Company statements | Unit tests on hand-built filings: non-calendar and 52/53-week years, restatements, overlapping periods, derived fourth quarters, tag changes, non-USD filers, per-share figures never summed |
| Independent review | Five separate reviews (whole app; trading maths; Radar front end and security; sources against the web; the stocks module). Most findings were fixed; those left open are listed below |

## What has not been verified

- **Any live call to an outside service** from this code: news feeds, Hyperliquid, Binance,
  Bybit, Coinbase, DexScreener, X.
- **Everything behind Stocks, Calendar and Private, live.** The SEC, Treasury, FRED, Finnhub,
  Twelve Data and Hyperliquid equity adapters were written against documentation and, in
  places, from memory (the SEC filing feeds and the Treasury file layout in particular).
  `docs/TRADFI-SOURCES.md` lists each one. Expect some to need a fix on first contact.
- **X's embedded timelines.** Coded to X's published embed interface; never loaded from here.
- **The Render blueprint.** `render.yaml` follows Render's documented format; never deployed.
- **The 18 news feed addresses, directly.** Fifteen were confirmed alive through third-party
  feed readers that poll the same addresses; the SEC and ECB feeds were fetched directly;
  the Federal Reserve address is the one listed on its own feeds page. None was fetched by
  this code.
- **Whether publishers block this server.** Polling 18 feeds every 20 seconds with a custom
  user agent may be refused by some.
- **Whether browsers may call Hyperliquid cross-site.** If not, charts fall back to this
  server, which can serve only a few dozen distinct charts a minute.
- **Binance "top traders" without a key.** Its documentation lists an API key header; the
  code sends none. If it is refused, that row disappears and the venue shows as partial.
- **DexScreener's search fields and rate limit**, and the X API's current limits and prices
  (reported at $0.005 per post read; confirm on X's pricing page).
- **Load beyond one machine.** Nothing has been run at even 100,000 users. See SCALING.md.

## Known limits (true even when everything works)

- **News speed.** RSS is polled every 20 seconds and publishers release to RSS after their
  own sites and wires. This is not as fast as a licensed newswire, and should not be pitched
  as such until it carries one.
- **News rights.** Headlines and links only are shown. Commercial reuse terms for WSJ, NYT
  and FT have not been checked. Display and redistribution terms for the exchange data have
  not been confirmed either.
- **US hosting.** Binance and Bybit refuse US addresses, which removes the long/short split.
  Host outside the US or license that data.
- **Liquidation map is a model**, built from where volume traded. It is labelled as such.
  Real liquidation data is licensed (Coinglass and others).
- **Positioning counts accounts, not money**, on two exchanges, and is averaged without
  weighting. The page says which venues a figure comes from.
- **Volume by price** spreads each candle's volume evenly across its range, an approximation.
- **Liquidation estimate** is for an isolated position before fees and funding.
- **Stock prices have no free official source.** With no key, prices are Hyperliquid
  perpetuals for about 30 large shares and a few indexes, labelled as such; they track the
  share but are not its exchange price, and most companies show no price at all. A real
  equities product needs a licensed feed. Twelve Data's free plan does not allow public
  display.
- **Statements come from each company's own XBRL tags.** Banks, insurers and foreign filers
  will have gaps, shown as dashes. Share counts and EPS are not adjusted for later splits.
- **Private markets means SEC filings**: Form D notices and registration statements. It is
  not valuations, cap tables or a full record of private deals; that data is sold by
  PitchBook, Crunchbase and others.
- **Earnings dates, IPO dates and macro figures need free keys** (Finnhub, FRED). Without
  them the calendar shows central-bank dates and filings only, and says what is not connected.
- **X columns need the viewer signed in to X**, show one account per column, and refresh on
  reload. A single merged, instant feed needs X's paid service.
- **Chat has no accounts or moderation.** Do not open it to the public as is.
- **Radar and Markets cover Hyperliquid perpetuals.** Spot markets, other exchanges' order
  books, options and on-chain data are not included.
- **Not advice.** Confluence and positioning describe indicators. Nothing predicts price.

## Review findings left open

- The Radar still recomputes its panels every three seconds while live; lighter per-tick
  updates would cut CPU use on slow phones further.
- Tables have no captions, and a few figures (heatmap tile volume, hourly funding cells)
  are only in hover tooltips, so not reachable by touch or keyboard.
- The confluence compares price with VWAP on 15-minute candles while the timeframe table
  uses each timeframe's own; near the line the two can differ in sign.
- ATR includes the candle still forming, slightly understating it just after a candle opens.
- A viewer with many tabs open, or an office of a dozen people behind one address, can
  exceed Hyperliquid's per-address allowance and its limit of ten live connections.

## For the pitch

Safe to say: it is a working product covering crypto, stocks and private-market filings,
with a tested core, a clear architecture for scale, and an honest status page. Not safe to say yet: that the data is verified live, that it is the
fastest news source, or that it has been load tested for a million users.
