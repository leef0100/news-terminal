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
REDIS_URL=redis://host:6379 ROLE=web PORT=3000 TRUST_PROXY=1 node src/server.js   # as many as needed
```

Without `REDIS_URL` everything runs in one process, which is what `npm start` does.

## Why each part scales

**Reads are the same for everyone, so a CDN serves them.** The feed, story lookups, token
searches, radar, market history and chat history carry cache lifetimes of 1 to 60 seconds.
However many people ask, the servers see roughly one request per address per lifetime per
CDN location. Browsers are told never to reuse an old copy themselves.

**The busiest answers are built once.** The feed and radar are serialized, compressed and
fingerprinted once per change, then the same bytes are sent to everyone. A browser that
already has the current version gets an empty "not modified" reply.

**Live market data bypasses us.** Charts, order books and trades stream from the exchange
to each browser directly. A million viewers add no load here. The cost is dependence on
the exchange's public stream and its per-address limits; at real scale that wants an
agreement with the exchange or a relay of our own.

**Outside services are called once, not once per user.** Token search and market data are
cached and concurrent requests for the same thing share one upstream call.

**Live news has two speeds.** Push connections deliver a story the moment it is ingested.
Each web server accepts up to `SSE_MAX` of them (default 50,000) and refuses the rest, and
a refused browser silently polls the CDN-cached feed every three seconds instead. So the
site keeps working for everyone past the push capacity; the overflow is a few seconds
slower. Tabs in the background hold no connection at all and catch up when reopened.

**Chat goes to the room, not the audience.** A message is sent only to people with that
room open.

**Servers share nothing but Redis.** Any web server can be added or removed; one that
starts late loads the current feed and chat history from Redis.

## What was measured

On a small test machine (2 shared CPU cores, 8 GB, load generator on the same machine,
demo data), one process:

| Test | Result |
|---|---|
| Feed requests, 200 connections, compressed | about 7,800 per second |
| Radar requests | about 3,300 per second (before it was pre-built like the feed) |
| Simultaneous push connections held | 8,000, using about 84 MB more memory (roughly 10 KB each) |
| One message delivered to all 8,000 | 190 ms |
| Two web servers and an ingest worker on a real Redis | feed and chat stay in step (automated test) |

These are single-machine numbers on weak hardware, useful for sizing, not proof of the target.

## Sizing for one million at once

- **Pages and API:** almost entirely CDN. Origin traffic depends on the number of CDN
  locations and distinct addresses, not on the audience.
- **Push connections:** at roughly 10 KB each, a million is about 10 GB of memory plus
  headroom, so 25 to 40 web servers at 25,000 to 40,000 connections each, with file-handle
  and network limits raised. Fewer servers if most of the audience is allowed to poll.
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
3. **Chat will not survive a large crowd as is.** No accounts, moderation, blocking or spam
   defence beyond a per-address rate limit; one busy room would be unreadable; history is
   capped in Redis and not stored anywhere durable. It needs identity (the wallet connect
   is a start: add a signed message), moderation tools, room sharding and a database.
4. **Ingest is a single worker polling every 20 seconds.** It needs a standby, and for a
   product sold on speed it needs licensed push feeds, not RSS.
5. **No database.** The feed keeps the latest 500 items in memory and Redis. Search over
   history, saved stories across devices and analytics all need one.
6. **Thin operations.** There is a health endpoint and nothing else: no metrics, tracing,
   alerting, deploy pipeline or abuse protection at the edge.
7. **Per-address rate limits assume a correct client address.** Set `TRUST_PROXY` to match
   the proxies in front, or every user looks like the load balancer.
8. **Third-party terms.** Hyperliquid, DexScreener, Binance, Bybit and Coinbase are used
   through free public endpoints with their own limits and terms. At scale, get agreements
   or paid data.

## Settings

| Setting | Meaning | Default |
|---|---|---|
| `PORT` | Port to listen on | 3000 |
| `ROLE` | `all`, `web` or `ingest` | `all` |
| `REDIS_URL` | Turns on sharing between servers | off |
| `SSE_MAX` | Push connections one server accepts | 50000 |
| `TRUST_PROXY` | Number of proxies in front, for the real client address | off |
| `FRAME_ANCESTORS` | Sites allowed to embed this one in a frame | `'self'` |
| `DEMO=1` | Same as `npm run demo` | off |
