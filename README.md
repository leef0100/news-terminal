# Halftone

Live market news for traders. One feed for crypto, markets, business, technology, macro and
politics, with the tokens each story moves, the copycats flagged, a room to talk about what
is breaking, a read on how traders are positioned, and live markets.

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
npm test             # unit and server tests (25), including a two-server Redis cluster
npm run test:e2e     # full browser test of every page (needs Chrome; set CHROME_PATH)
```

## What is in it

| Page | What it does |
|---|---|
| **News** | The centrepiece. Live feed sorted into categories. The same story from several outlets is one row. Top stories panel, search, source filter, breaking-only and saved views, compact mode, keyboard control, shareable links. New stories wait behind a button while you read further down. |
| **Story detail** | Other outlets reporting it, and matching Solana tokens: the one that existed before the story first, anything created after it flagged with how long after, thin pools marked. Copy the address, open the chart, or open the token on pump.fun. |
| **Breaking** | The most immediate items of the last hour, each with a live chat room, plus a general room. |
| **Radar** | Long/short split per coin across venues, a funding heatmap, open interest, the Coinbase premium, and large Hyperliquid trades. |
| **Markets** | Candle chart, order book, trades and stats for any Hyperliquid perpetual, streamed tick by tick from the exchange. |
| **Wallet** | Connect Phantom, Solflare, Backpack, MetaMask, Coinbase Wallet and other announcing wallets. Connect only: no signature, no transaction. |
| **Home** | A newsprint collage built from the highest-impact headlines in the live feed. |

## Where the data comes from

| Data | Source | Notes |
|---|---|---|
| News | RSS feeds listed in `config/sources.json` (crypto outlets, plus WSJ, NYT and FT sections) | Headline, time and link only, never the article. Polled every 20 seconds. |
| Token matches | DexScreener public search | Solana only. Cached 15 seconds per term. |
| Live markets | Hyperliquid public stream, straight from the browser | History and a polling fallback come from this server. |
| Positioning | Binance and Bybit futures, Hyperliquid, Coinbase spot | Binance and Bybit do not serve some regions, the US included, and show as unavailable there. |

Not included, and why: Coinglass heatmaps (their data is licensed; a paid key would add
liquidation heatmaps), Papertrade (no public data feed), X accounts (needs a paid streaming
provider; `src/ingest/x.js` is the slot).

## What has and has not been verified

Verified by tests: every page and interaction in a real browser against demo data; the
server API; two web servers and an ingest worker sharing one feed and chat through Redis;
the live-market stream against a stand-in that speaks the exchange's protocol.

Not yet verified: any call to a real outside service. The feed addresses, DexScreener,
Hyperliquid, Binance, Bybit and Coinbase are used as their public documentation describes,
but this was built where those sites could not be reached. On first live run, check
`http://localhost:3000/api/health` for feeds that fail and fix or remove them.

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
src/ingest/           RSS reader, poller, demo data, X slot
public/               the site (plain HTML, CSS and JavaScript, no build step)
test/                 unit, server, cluster and browser tests
```

API: `/api/feed`, `/api/item?id=`, `/api/stream`, `/api/tokens?q=`, `/api/chat`,
`/api/chat/stream?room=`, `/api/chat/counts`, `/api/radar`, `/api/markets`,
`/api/markets/book|candles|trades?coin=`, `/api/health`, `/healthz`.
