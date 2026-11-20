# Halftone

One terminal for crypto, stocks and private markets: live news; crypto charts, heatmaps,
positioning and a confluence read; stock indexes, company pages and financial statements
from SEC filings; calendars for earnings, IPOs and economic releases; the IPO pipeline and
private fundraising filings; your own deck of X accounts; and a status page that shows
where every number comes from. Green and white.

To put it online, read [DEPLOY.md](DEPLOY.md). Before showing it to anyone, read [READINESS.md](READINESS.md): it lists what has been
checked, what has not, and what to do first.

## Run it

Needs Node 20 or newer.

```
npm install
npm start        # live: real news feeds, real token search, real market data
npm run demo     # invented data, works offline; the site shows a "Demo mode" banner
```

Open http://localhost:3000. Everything in demo mode is made up, prices included; use
`npm start` to see the real market.

```
npm test             # unit and server tests, including a two-server Redis cluster
npm run test:e2e     # full browser test of every page (needs Chrome; set CHROME_PATH)
```

## What is in it

| Page | What it does |
|---|---|
| **News** | The centrepiece. Live feed sorted into categories. The same story from several outlets is grouped into one row (by matching names, numbers and direction, so it errs towards keeping stories apart). Top stories panel, search, source filter, breaking-only and saved views, compact mode, keyboard control, shareable links. New stories wait behind a button while you read further down. |
| **Story detail** | Other outlets reporting it, and matching Solana tokens: the one already trading before the story's first report comes first, anything that started trading after it is flagged with how long after, unknown ages are marked, thin pools too. Copy the address, open the chart, or open the token on pump.fun. |
| **Breaking** | The most immediate items of the last hour, each with a live chat room, plus a general room. |
| **Radar** | A chart workspace for one market: candles with EMA 9/21/50/200 and anchored VWAP; key levels drawn on the chart (yesterday's high and low, pivots, repeated turning points, the most-traded price and value area, large resting orders); heat layers for volume by price, the order book and a modelled liquidation map; a confluence card that lines up trend, momentum, VWAP, volume, funding, positioning and location in plain language; the same readings across 15m, 1h, 4h and 1d; a risk-first position size calculator with a liquidation estimate; a market heatmap; funding across venues plus a week of hourly history; long/short split per venue; large trades. It describes the market. It does not give advice. |
| **Markets** | Candle chart, order book, trades and stats for any Hyperliquid perpetual, streamed tick by tick from the exchange, and a sortable, filterable table of every market. |
| **My panel** | Add up to 20 X usernames. Free mode: one column per account drawn by X's own embedded timelines, which X shows to anyone signed in to X in that browser; nothing loads from X until the viewer asks. Optional second mode: one merged feed through X's paid API. The list stays in the browser. |
| **Stocks** | Indexes, sector moves, a market map, movers, the Treasury yield curve, macro figures and a watchlist. Every US-listed company has a page: price chart (daily, weekly, monthly, up to the full history held), key facts, income statement, balance sheet and cash flow as an expandable table (annual and quarterly, with year-over-year change), and recent filings linking to the SEC. |
| **Calendar** | Earnings, IPOs, economic releases and central-bank meetings on one agenda, with filters. |
| **Private** | Companies that have filed to go public, and private fundraising disclosed to the SEC on Form D: who raised, how much, which industry. Not valuations, and not a complete record of private deals. |
| **Indexes** | Halftone's own AI infrastructure indexes, each with its method published: inference price, GPU demand, energy cost, compute price, data center, an AI capital spending tracker, an AI hardware basket and an AI-linked crypto basket. An index whose inputs are not connected says so. See docs/INDEX-METHODS.md. |
| **Paper trade** | Go long or short on any index with pretend money kept in the browser. No funds, no orders. A preview of a compute exchange; see ROADMAP.md. |
| **Funds** | What 26 large managers reported holding on SEC Form 13F and what changed since the quarter before, with the limits stated (quarterly, up to 45 days late, no shorts); insider transactions and stakes above 5%. |
| **Voices** | A reading list of 31 market writers and research desks: latest public pieces by title and link, with one-click adding to My panel. |
| **Status** | Every news source and market venue with its state, newest story, and the measured delay between a publisher's timestamp and the story appearing here. |
| **Search** | Ctrl or Cmd + K jumps to a page, a market or a headline. |
| **Wallet** | Connect Phantom, Solflare, Backpack, MetaMask, Coinbase Wallet and other announcing wallets. Connect only: no signature, no transaction. |
| **Home** | A newsprint collage built from the highest-impact headlines in the live feed. |

## Where the data comes from

| Data | Source | Notes |
|---|---|---|
| News | RSS feeds listed in `config/sources.json` (crypto outlets; WSJ, NYT and FT sections; SEC, Federal Reserve and ECB releases) | Headline, time and link only, never the article. Polled every 20 seconds. |
| Token matches | DexScreener public search | Solana only. Cached 15 seconds per term. |
| Live markets | Hyperliquid public stream and history, straight from each browser | Each viewer uses their own allowance at the exchange. This server is the fallback, with a cap on what it spends. |
| Companies, statements, filings, IPO pipeline, private raises | SEC EDGAR (official, free) | Needs `SEC_USER_AGENT` (your site name and a contact email; the SEC requires it). Statements are built from each company's XBRL filings. |
| Yield curve, central-bank dates | US Treasury, Federal Reserve (official, free) | End of day. |
| Stock and index prices | Hyperliquid equity perpetuals with no key; Finnhub and Twelve Data with keys | There is no free official real-time stock feed. Perpetual prices are labelled as such: they are not the exchange's price. Twelve Data's free plan does not permit public display; a public site needs their business plan or another licensed feed. |
| Macro figures, economic releases | FRED, with `FRED_KEY` | Free key. |
| Earnings and IPO dates | Finnhub, with `FINNHUB_KEY` | Free key; display terms unconfirmed. |
| X columns | X's embedded timelines, in the viewer's browser | Free. Shown by X only to viewers signed in to X. |
| X merged feed | X API v2, with `X_BEARER_TOKEN` | Paid: X charges per post read and has no free read access. Each account is fetched once for all viewers, only new posts are requested, and `X_DAILY_POSTS` (default 2000) caps a day's reads. Posts arrive by polling, typically within a minute, not instantly. |
| Positioning | Binance and Bybit futures, Hyperliquid, Coinbase spot | Binance and Bybit do not serve some regions, the US included, and show as unavailable there. |

Not included, and why: Coinglass heatmaps (their data is licensed; the liquidation layer here
is a labelled model built from traded volume, not real positions), Papertrade (no public data
feed), X accounts in the main news feed (`src/ingest/x.js` is the slot; it wants a streaming
connection, which is a separate X product from the polling the panel uses).

## What has and has not been verified

See [READINESS.md](READINESS.md) for the full list. In short: every page is tested in a real
browser against demo data and stand-in exchanges, and the trading maths is tested against
worked examples. No call to a real outside service has been made from where this was built.
On the first live run, open the Status page and fix or remove anything marked failing.

## Before a commercial launch

- **News licensing.** WSJ, NYT and FT publish RSS for reading; their terms for commercial
  reuse differ. Check them or license a newswire. RSS polling is also slower than a
  licensed push feed, which is what a product selling speed needs.
- **Chat.** No accounts, no moderation, no blocking. Add all three before opening it up.
- **Scale.** See [SCALING.md](SCALING.md) for what is built, what was measured, and what is
  left on the way to very large audiences.
- **Not advice.** Positioning and token data describe the market; they do not recommend trades.

## Layout

```
config/sources.json   feeds and poll interval
src/server.js         web server, API, live connections, roles
src/bus.js            shared state between servers: memory or Redis
src/store.js          the feed, story grouping
src/enrich.js         category, tickers, breaking flag, impact score
src/tokens.js         token search, ranking, copycat flags
src/chat.js           chat rooms
src/radar.js          cross-exchange positioning snapshot
src/hyperliquid.js    market data history and polling fallback
src/xpanel.js         personal X panels (merged feed)
src/tradfi/           stocks, statements, calendars, private markets (see docs/TRADFI-SOURCES.md)
src/ingest/           RSS reader, poller, demo data, X slot
public/               the site (plain HTML, CSS and JavaScript, no build step)
test/                 unit, server, cluster and browser tests
```

API: `/api/feed`, `/api/item?id=`, `/api/stream`, `/api/tokens?q=`, `/api/chat`,
`/api/chat/stream?room=`, `/api/chat/counts`, `/api/radar`, `/api/markets`,
`/api/markets/book|candles|trades|depth|funding?coin=`, `/api/x?handles=`, `/api/status`,
`/api/tradfi/overview|search|quote|candles|company|calendar|ipos|private`,
`/api/health`, `/healthz`.
