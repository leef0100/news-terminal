# Scaling Halftone

What is built for scale, what was measured, and what is still missing before a very large
audience. The target used while designing this was one million people on the site at once.
That target has not been reached or tested; this page says how far the evidence goes.

## The shape

```
            browsers
               |
        CDN  (HTTP/2, caches pages and API answers)
               |
        load balancer
       /       |       \
    web      web      web        any number; each holds live connections
       \       |       /
            Redis                feed, chat, shared rate limits
               |
            ingest               exactly one; polls sources, publishes items

    browsers ----> exchange stream    live market data never touches our servers
```

Run it this way with three settings:

```
REDIS_URL=redis://host:6379 ROLE=ingest node src/server.js
REDIS_URL=redis://host:6379 ROLE=web PORT=3000 TRUST_PROXY=2 node src/server.js   # as many as needed
```

`TRUST_PROXY` is the number of proxies in front (2 for a CDN plus a load balancer). Get it
wrong and every visitor behind one CDN location shares a single rate limit. Without
`REDIS_URL` everything runs in one process, which is what `npm start` does; a `web` or
`ingest` process refuses to start without it.

## Why each part scales

**Reads are the same for everyone, so a CDN serves them.** The feed, story lookups, token
searches, radar, market history and chat history carry cache lifetimes of 1 to 60 seconds.
However many people ask, the servers see roughly one request per address per lifetime per
CDN location. Browsers are told never to reuse an old copy themselves. Failures from an
outside service are held for two seconds as well, so an outage does not send the whole
audience through to the servers, and made-up market names are refused before they cost
anything.

**The busiest answers are built once.** The feed and radar are serialized, compressed and
fingerprinted once per change, then the same bytes are sent to everyone. A browser that
already has the current version gets an empty "not modified" reply.

**Live market data bypasses us.** Charts, order books and trades stream from the exchange
to each browser directly. A million viewers add no load here. The cost is dependence on
the exchange's public stream and its per-address limits; at real scale that wants an
agreement with the exchange or a relay of our own.

**Outside services are called once, not once per user.** Token search and market data are
cached and concurrent requests for the same thing share one upstream call. After a failure
the service is left alone for two seconds and the last good answer is served. Token search
has a per-minute allowance: words in the news always get through, and made-up words share
half of it, with a per-address limit on new ones.

**Live news has two speeds.** Push connections deliver a story the moment it is ingested.
Each web server accepts up to `SSE_MAX` of them (default 10,000, and at most 12 from one
address) and refuses the rest. A refused browser polls the CDN-cached feed every three
seconds instead, and asks for a live connection again after half a minute to a minute. So
the site keeps working for everyone past the push capacity; the overflow is a few seconds
slower. Chat falls back the same way. This path is covered by the browser test.

**Background tabs cost nothing.** A tab that is not on screen closes its news, chat and
market connections and stops its timers, then catches up when reopened. The one exception:
someone with sound alerts switched on keeps their news connection, since they are relying
on hearing it from another tab.

**Sending to a crowd does not freeze the server.** A story is written to connections in
slices with a pause between them, so other requests are answered while it goes out. A
reader who has stopped reading is disconnected before data piles up for them.

**Chat goes to the room, not the audience.** A message is sent only to people with that
room open.

**Servers share nothing but Redis.** Any web server can be added or removed. Each one
subscribes first and then loads the current feed and chat from Redis, and reloads them
whenever its connection to Redis drops and returns, so nothing published in the gap is
lost (tested by cutting the connection mid-publish). If Redis loses its data, the ingest
worker puts the feed back. If Redis is down, pages and the feed keep being served from
memory, rate limits let requests through, and only posting to chat stops.

## What was measured

On a small test machine (2 shared CPU cores, 8 GB, load generator on the same machine,
demo data), one process:

| Test | Result |
|---|---|
| Feed requests, 200 connections, compressed | about 8,500 per second |
| Radar requests | about 8,600 per second |
| Simultaneous push connections held | 8,000, using about 115 MB more memory (roughly 14 KB each) |
| One story delivered to all 8,000 | 130 ms from first to last |
| A health check during that delivery | answered in 8 ms |
| Two web servers and an ingest worker on a real Redis | feed and chat stay in step, including across a dropped Redis connection (automated test) |

These are single-machine numbers on weak hardware, useful for sizing, not proof of the target.

## Sizing for one million at once

- **Pages and API:** almost entirely CDN. Origin traffic depends on the number of CDN
  locations and distinct addresses, not on the audience.
- **Push connections:** at roughly 14 KB each, a million is about 14 GB of memory plus
  headroom. Only 8,000 per server has been measured, so plan on many small servers (about
  100 at the default limit) until a higher figure per server has been tested. Far fewer if
  most of the audience is allowed to poll.
- **Polling instead:** a million browsers polling every three seconds is about 330,000
  requests per second at the CDN and about one per second per location at the origin.
  This is the cheap route and it is already built in.
- **Redis:** one small instance carries the feed. Chat is the part that grows; see below.

## What is not done

1. **No load test beyond one machine.** Nothing here has been run at even 100,000 users.
   Do that before believing the sizing above.
2. **HTTP/2 at the edge is required.** Browsers allow about six connections per site over
   HTTP/1.1; with a push connection per tab, several open tabs can stall the site. A CDN or
   load balancer speaking HTTP/2 removes the limit. Background tabs already disconnect.
3. **Chat will not survive a large crowd as is.** Each server keeps 200 messages a room
   while Redis keeps the newest 5,000 overall, so a restarted server can show a busy room's
   history differently. No accounts, moderation, blocking or spam
   defence beyond a per-address rate limit; one busy room would be unreadable; history is
   capped in Redis and not stored anywhere durable. It needs identity (the wallet connect
   is a start: add a signed message), moderation tools, room sharding and a database.
4. **Ingest is a single worker polling every 20 seconds.** It needs a standby, and for a
   product sold on speed it needs licensed push feeds, not RSS.
5. **No database.** The feed keeps the latest 500 items in memory and Redis. Search over
   history, saved stories across devices and analytics all need one.
6. **Thin operations.** There is a health endpoint and nothing else: no metrics, tracing,
   alerting, deploy pipeline or abuse protection at the edge.
7. **Limits are per server, and per address.** The search allowance and most rate limits
   are counted by each web server on its own, so the real ceiling is that number times the
   number of servers; only chat's limit is shared. All of them rely on `TRUST_PROXY` being
   right, or every user looks like the load balancer.
8. **Copycat flags use pool age.** "Started trading after this story" is the creation time
   of the token's deepest trading pool, which is what the data source gives. An old token
   that moved to a new pool would be flagged. Token mint time needs a Solana data provider.
9. **Third-party terms.** Hyperliquid, DexScreener, Binance, Bybit and Coinbase are used
   through free public endpoints with their own limits and terms. At scale, get agreements
   or paid data.

10. **My panel is per server.** Each web server polls X for the accounts its own viewers
    follow, so several servers would each pay to read the same account. Before running more
    than one, move the polling into the ingest worker and share results through Redis, as
    the news feed does. At 300 accounts the checking interval stretches to several minutes.
11. **Market history depends on browsers reaching the exchange.** Each browser fetches
    candles from Hyperliquid directly. If that is blocked (a network that filters it, or the
    exchange refusing cross-site requests), every viewer falls back to this server, whose
    allowance covers a few dozen distinct charts a minute. A paid data feed or a caching
    tier in front of the exchange removes that ceiling.
12. **Binance and Bybit refuse US servers.** Bybit documents it and Binance is reported to.
    Hosted in the US, Radar's long/short split has no source and funding and open interest
    come from Hyperliquid alone. Host the ingest outside the US or license the data.

## Settings

| Setting | Meaning | Default |
|---|---|---|
| `PORT` | Port to listen on | 3000 |
| `ROLE` | `all`, `web` or `ingest` | `all` |
| `REDIS_URL` | Turns on sharing between servers | off |
| `SSE_MAX` | Push connections one server accepts | 10000 |
| `STREAMS_PER_ADDRESS` | Push connections one address may hold | 12 |
| `TRUST_PROXY` | Number of proxies in front (1, 2, …), for the real client address | off |
| `FRAME_ANCESTORS` | Sites allowed to embed this one in a frame | `'self'` |
| `DEMO=1` | Same as `npm run demo` | off |
| `X_BEARER_TOKEN` | X API key for My panel | off |
| `X_DAILY_POSTS` | Most posts read from X in one UTC day | 2000 |
