# News Terminal

A real-time news feed for memecoin traders. Each item shows the tickers it mentions, and
selecting one lists the matching Solana tokens with the real one first and copycats
(tokens created after the news) flagged.

## Run it

Needs Node 20 or newer.

```
npm install
npm run demo     # invented data, works offline: use this to try the UI
npm start        # live news feeds + live token search
```

Then open http://localhost:3000. `npm test` runs the tests.

## Pages

- **Home**: landing page with a scrapbook collage of newsprint clippings built from the live headlines; new items get pasted on as they arrive. It picks the
  highest-impact headlines in the feed (ousters, collapses, records, attacks and the like),
  never invented ones.
- **Terminal**: the feed, category tabs (Crypto, Markets, Business, Technology, Macro,
  Politics, World), token matching and quick buy.
- **Breaking**: the most immediate items (tickers, listings, X posts, urgent headlines from
  the last hour), each with its own live chat room, plus a general room.

## What it does

- **Live feed** pushed to the browser as items arrive (no refresh), newest first, with the
  delay between publication and arrival shown on each live item.
- **Sources**: news headlines over RSS (crypto outlets plus WSJ, NYT and FT sections), set
  in `config/sources.json`. Each headline is sorted into a category by keyword, falling
  back to its feed's own category.
- **Token matching**: `$TICKER` mentions are searched automatically; any other word can be
  searched from the item. Results are Solana only, de-duplicated per token, with age,
  liquidity and market cap.
- **Copycat flagging**: tokens that existed before the item rank first; tokens created
  after it carry a warning with how long after. Thin pools get a "Low liquidity" tag.
- **Quick buy**: copy the contract address, open the chart, or open the token on pump.fun
  (DexScreener for tokens not launched there). No wallet code and no custody in v1.
- **Keyword alerts** with optional sound, a feed filter, and keyboard control
  (`J`/`K` move, `C` copy address, `Enter` open token, `/` filter).

## Chat limits to know about

Chat has no accounts and no moderation: anyone can post under any name. Messages are kept
in memory, so they vanish when the server restarts. Posting is rate-limited per address
(5 messages per 10 seconds) and messages are capped at 280 characters. Add sign-in,
moderation and a database before opening this to the public.

## Not yet verified against live services

This was built and tested where outside sites could not be reached, so:

- The feed URLs in `config/sources.json` have not been fetched for real. A feed that fails
  is logged and skipped; check `http://localhost:3000/api/health` to see each feed's state
  and fix or remove any that fail.
- Token search uses DexScreener's public search endpoint as documented. It was tested
  against data in that shape, not against the live service.

## Before a commercial launch

WSJ, NYT and FT publish RSS for reading, and their terms for commercial reuse differ. This
app keeps only the headline, time and a link out. Check each publisher's terms or license
a newswire before charging for this or shipping it inside another product.

## Next

1. X accounts: `src/ingest/x.js` is the slot. Needs a streaming data provider and key.
2. Exchange listing announcements as their own source (currently inferred from headlines).
3. Macro calendar with scheduled releases.
4. News pinned on the token chart, and a per-source track record.
5. In-app swap with a confirm step.

## Layout

```
config/sources.json   feeds and poll interval
src/server.js         web server, API, live stream
src/ingest/           RSS reader, poller, demo data, X slot
src/enrich.js         kind, cashtags, search terms
src/tokens.js         token search, ranking, copycat flags
src/chat.js           Breaking-page chat rooms
public/               the terminal UI (no build step)
test/                 tests
```

API: `GET /api/feed`, `GET /api/stream` (Server-Sent Events), `GET /api/matches?itemId=&q=`,
`GET /api/health`, `GET /api/chat?room=`, `POST /api/chat`.
