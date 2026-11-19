// Web and ingest server.
//
// Roles (ROLE env): "all" runs everything in one process. With REDIS_URL set, run one
// "ingest" process (polls sources, publishes items) and any number of "web" processes
// (serve pages, the API and live connections) behind a load balancer. See SCALING.md.
import express from 'express';
import compression from 'compression';
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore } from './store.js';
import { createBus, createMemoryBus } from './bus.js';
import { createPoller } from './ingest/poller.js';
import { createTokenMatcher } from './tokens.js';
import { startDemo, demoFetch } from './ingest/demo.js';
import { createChat } from './chat.js';
import { createHyperliquid, validCoin, INTERVALS } from './hyperliquid.js';
import { createRadar } from './radar.js';
import { createXPanel, validHandle } from './xpanel.js';
import { createTradfi } from './tradfi/index.js';
import { demoMarketFetch } from './ingest/demo-markets.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function createApp({ demo = false, xToken = '', xDailyPosts = 2000, config, role = 'all', redisUrl = '', sseMax = 10000, streamsPerAddress = 12, frameAncestors = "'self'", trustProxy = false } = {}) {
  // A web-only or ingest-only process has nobody to talk to without Redis: the feed would
  // stay empty for ever. Better to stop here than to start quietly broken.
  if (role !== 'all' && !redisUrl) throw new Error(`ROLE=${role} needs REDIS_URL`);
  const startedAt = Date.now();
  const bus = await createBus({ redisUrl });
  const store = createStore();
  // Limits that protect this one process (searches, market lookups) are counted here, so
  // they keep working, and cost nothing, when Redis is slow or away.
  const local = createMemoryBus();
  const ingests = role !== 'web';
  const serves = role !== 'ingest';

  const matcher = createTokenMatcher(demo ? { fetchImpl: demoFetch() } : {});
  const marketFetch = demo ? demoMarketFetch() : fetch;
  const hl = createHyperliquid({ fetchImpl: marketFetch });
  const xpanel = createXPanel({ token: xToken, demo, dailyPosts: xDailyPosts });
  // Stocks, indexes, company reports, calendars and private markets.
  const tradfi = createTradfi({ demo, env: process.env });
  const radar = createRadar({ fetchImpl: marketFetch, hl });
  const poller = ingests && !demo ? createPoller({ sources: config.sources, store, pollSeconds: config.pollSeconds }) : null;
  const hasRoom = (room) => room === 'general' || Boolean(store.get(room));
  const chat = createChat({ hasRoom, bus });

  // Feed items cross the bus only when there is more than one process to tell.
  let reseed = null;
  if (bus.kind === 'redis') {
    // Subscribe first, then read what is already there, so nothing falls between the two.
    // The same read runs again whenever a dropped connection comes back.
    const catchUp = async () => {
      for (const item of await bus.history('feed', 500)) store.add(item);
    };
    await bus.on('feed', (item) => store.add(item));
    await catchUp();
    bus.onReconnect(catchUp);
    if (ingests) {
      const publish = (item) => bus.append('feed', item, 500).catch((err) => console.warn('[bus] publish:', err.message));
      store.on(publish);
      // If Redis lost its copy (a restart without saved data), put it back, so servers that
      // start afterwards still get the whole feed and not just what comes next.
      reseed = setInterval(async () => {
        try {
          if ((await bus.size('feed')) < Math.min(store.size(), 500)) for (const item of store.list(500)) await publishQuiet(item);
        } catch (err) {
          console.warn('[bus] reseed:', err.message);
        }
      }, 30000);
      reseed.unref();
    }
  }
  // Re-adds an item to the shared copy. Servers that already hold it ignore the repeat.
  const publishQuiet = (item) => bus.append('feed', item, 500);
  await chat.start();

  // ---------- live connections ----------
  // Each event is turned into text once and the same text is written to every connection.
  const clients = new Set();
  // A reader that has stopped reading would otherwise have everything queued up for it in
  // memory. Past a quarter megabyte waiting, the connection is dropped; the browser reconnects.
  const push = (res, frame) => {
    if (res.writableLength > 256 * 1024) res.destroy();
    else res.write(frame);
  };
  // Writing to tens of thousands of connections in one go would freeze everything else
  // (other requests, health checks) for its duration, so it is done in slices with a
  // breath between them. Slices of successive events queue in order, so every reader
  // still receives events in the order they happened.
  const fanout = (targets, frame) => {
    const list = [...targets];
    let i = 0;
    const slice = () => {
      const end = Math.min(i + 2000, list.length);
      for (; i < end; i++) if (!list[i].destroyed) push(list[i], frame);
      if (i < list.length) setImmediate(slice);
    };
    slice();
  };
  const broadcast = (event, obj) => fanout(clients, `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
  store.on((item) => broadcast('item', item));
  // Chat goes only to the people in that room, never to the whole audience.
  const roomClients = new Map();
  let roomCount = 0;
  chat.on((msg) => {
    const set = roomClients.get(msg.room);
    if (!set) return;
    fanout(set, `event: chat\ndata: ${JSON.stringify(msg)}\n\n`);
  });
  const beat = setInterval(() => {
    fanout(clients, ': ping\n\n');
    for (const set of roomClients.values()) fanout(set, ': ping\n\n');
  }, 20000);
  beat.unref();

  const app = express();
  app.disable('x-powered-by');
  if (trustProxy) app.set('trust proxy', trustProxy);

  app.use((_req, res, next) => {
    res.set({
      'x-content-type-options': 'nosniff',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'content-security-policy': [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
        "font-src 'self' https://fonts.gstatic.com",
        "img-src 'self' data:",
        "connect-src 'self' https://api.hyperliquid.xyz wss://api.hyperliquid.xyz",
        "object-src 'none'",
        "base-uri 'self'",
        'frame-ancestors ' + frameAncestors
      ].join('; ')
    });
    next();
  });
  // Live connections must not be buffered by the compressor.
  app.use(compression({ filter: (req, res) => req.path !== '/api/stream' && compression.filter(req, res) }));
  app.use(express.json({ limit: '2kb' }));

  app.get('/healthz', (_req, res) => {
    res.set('cache-control', 'no-store').json({ ok: true, role, bus: bus.kind, demo, items: store.size(), liveConnections: clients.size, chatConnections: roomCount, uptimeSeconds: Math.round((Date.now() - startedAt) / 1000) });
  });

  // Answers are the same for every reader, so a CDN can serve them. `seconds` is how long
  // a shared cache may keep one.
  // Browsers must never show an old copy (a chat room or feed that is seconds stale reads as
  // broken), so "serve stale while refreshing" is offered to the CDN alone.
  const shared = (res, seconds) =>
    res.set({
      'cache-control': `public, max-age=0, s-maxage=${seconds}`,
      'cdn-cache-control': `public, max-age=${seconds}, stale-while-revalidate=${seconds * 5}`
    });
  // An upstream failure is held by the CDN for two seconds: long enough that an outage does
  // not send the whole audience to this server, short enough to recover at once.
  const fail = (res, err) => {
    console.warn('[upstream]', String(err.message || err));
    shared(res, 2).status(502).json({ error: 'That data is unavailable right now' });
  };
  const refuse = (res, status, body) => res.status(status).set('cache-control', 'no-store').json(body);

  // The busiest answers are built, compressed and fingerprinted once per change, then the
  // same bytes go to everyone. A browser that already has the current version gets a
  // tiny "not modified" reply instead.
  const built = new Map();
  const sendBuilt = (req, res, key, version, seconds, build) => {
    let hit = built.get(key);
    if (!hit || hit.version !== version) {
      const body = Buffer.from(JSON.stringify(build()));
      hit = { version, body, gz: gzipSync(body, { level: 6 }), etag: '"' + createHash('sha1').update(body).digest('base64url').slice(0, 20) + '"' };
      built.set(key, hit);
      if (built.size > 50) built.delete(built.keys().next().value);
    }
    shared(res, seconds).set({ etag: hit.etag, vary: 'Accept-Encoding', 'content-type': 'application/json; charset=utf-8' });
    if (req.headers['if-none-match'] === hit.etag) return res.status(304).end();
    if (/\bgzip\b/.test(String(req.headers['accept-encoding'] || ''))) return res.set('content-encoding', 'gzip').end(hit.gz);
    res.end(hit.body);
  };

  if (serves) {
    app.use(
      express.static(path.join(root, 'public'), {
        // Every file is re-checked on load (a tiny "not modified" answer when unchanged), so a
        // new release can never be shown as new pages running old scripts.
        setHeaders: (res) => res.set('cache-control', 'no-cache')
      })
    );
    // The charting library is served from the installed package, so no outside CDN is needed.
    app.get('/vendor/lightweight-charts.js', (_req, res) => {
      res.set('cache-control', 'public, max-age=86400');
      res.sendFile(path.join(root, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js'));
    });

    app.get('/api/feed', (req, res) => {
      // Three sizes only: every distinct size is a separate cached copy.
      const asked = parseInt(req.query.limit, 10) || 150;
      const limit = asked <= 50 ? 50 : asked <= 150 ? 150 : 500;
      sendBuilt(req, res, 'feed:' + limit, store.version(), 1, () => ({ demo, items: store.list(limit) }));
    });

    // One story by id, so a shared link still opens after the story has scrolled out of the feed.
    app.get('/api/item', (req, res) => {
      const item = store.get(String(req.query.id || ''));
      if (!item) return refuse(res, 404, { error: 'This story is no longer available' });
      shared(res, 60).json({ item });
    });

    app.get('/api/health', (_req, res) => {
      res.set('cache-control', 'no-store').json({ demo, role, items: store.size(), sources: poller ? poller.status() : [] });
    });

    // How fresh every source is, in one place: what the Status page shows. Feed figures
    // come from the stories themselves, so they are right on every kind of server; the
    // poller's own record is added where this process runs it.
    const median = (list) => { if (!list.length) return null; const s = list.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
    app.get('/api/status', async (_req, res) => {
      const t = Date.now();
      const polled = new Map((poller ? poller.status() : []).map((p) => [p.id, p]));
      const seenSource = new Map();
      let newest = 0;
      for (const it of store.list(500)) {
        let s = seenSource.get(it.sourceId);
        if (!s) seenSource.set(it.sourceId, (s = { name: it.source, topic: it.topic, items: 0, newest: 0, delays: [] }));
        s.items += 1;
        if (it.ts > s.newest) s.newest = it.ts;
        if (it.ts > newest) newest = it.ts;
        // Time from the publisher's own timestamp to the moment it reached us. Stories
        // already in a feed when we first read it say nothing about speed, so they are left out.
        if (!demo && !it.backfill && it.seenAt >= it.ts) s.delays.push(it.seenAt - it.ts);
      }
      const known = demo ? [] : (config?.sources || []).map((c) => ({ id: c.id, name: c.name, topic: c.topic || null }));
      for (const [id, s] of seenSource) if (!known.some((k) => k.id === id)) known.push({ id, name: s.name, topic: s.topic || null });
      const sources = known.map((k) => {
        const s = seenSource.get(k.id);
        const p = polled.get(k.id);
        const state = p ? (p.ok === false ? 'failing' : p.ok === null ? 'waiting' : 'ok') : s ? 'ok' : 'unknown';
        const d = s ? median(s.delays) : null;
        return {
          id: k.id, name: k.name, topic: k.topic, state,
          error: p?.error || null, lastCheck: p?.lastPoll ?? null, lastOk: p?.lastOk ?? null, responseMs: p?.ms ?? null,
          stories: s?.items || 0, newestStory: s?.newest || null,
          medianDelaySeconds: d == null ? null : Math.round(d / 1000), timedStories: s?.delays.length || 0
        };
      });
      let market = { at: null, venues: [] };
      try {
        const snap = await radar.snapshot();
        market = { at: snap.at, venues: snap.venues.map((v) => ({ name: v.name, ok: v.ok, partial: v.partial, error: v.error || null })) };
      } catch (err) {
        market = { at: null, venues: [], error: String(err.message || err) };
      }
      shared(res, 5).json({
        at: t, demo, role, pollSeconds: config?.pollSeconds ?? 20,
        feed: { stories: store.size(), newestStory: newest || null, sources },
        market: { ...market, exchange: hl.health() },
        x: xpanel.health(),
        tradfi: tradfi.health(),
        viewers: { feed: clients.size, chat: roomCount, limit: sseMax }
      });
    });

    // A viewer's own panel of X accounts. The list of names is the whole request, so two
    // people following the same accounts share one cached answer.
    app.use('/api/tradfi', tradfi.router);

    app.get('/api/x', async (req, res) => {
      const asked = String(req.query.handles || '').split(',').map((h) => h.trim().replace(/^@/, '')).filter(Boolean);
      if (asked.length > 20 || !asked.every(validHandle)) return refuse(res, 400, { error: 'Up to 20 usernames: letters, numbers and underscores only' });
      if (!(await local.allow('x:' + req.ip, 60, 60000))) return refuse(res, 429, { error: 'Too many requests, try again in a minute' });
      shared(res, 5).json(xpanel.panel(asked));
    });

    // Solana tokens matching one ticker or name. Cached per term, shared by everyone.
    // Words in the news right now: their searches are never refused for being too many.
    let inFeed = { version: -1, set: new Set() };
    const feedTerms = () => {
      if (inFeed.version !== store.version()) {
        const set = new Set();
        for (const it of store.list(500)) for (const t of [...(it.cashtags || []), ...(it.terms || [])]) set.add(String(t).toLowerCase());
        inFeed = { version: store.version(), set };
      }
      return inFeed.set;
    };
    app.get('/api/tokens', async (req, res) => {
      const q = String(req.query.q || '').trim().replace(/^\$/, '');
      if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(q)) return refuse(res, 400, { tokens: [], error: 'Enter a ticker or name' });
      const priority = feedTerms().has(q.toLowerCase());
      const ok = (await local.allow('tok:' + req.ip, 90, 60000)) && (priority || (await local.allow('tokx:' + req.ip, 20, 60000)));
      if (!ok) return refuse(res, 429, { tokens: [], error: 'Too many searches, try again in a minute' });
      try {
        shared(res, 15).json({ term: q, tokens: await matcher.search(q, 8, { priority }) });
      } catch (err) {
        shared(res, 2).status(502).json({ term: q, tokens: [], error: String(err.message || err).startsWith('Token search') ? String(err.message) : 'Token search is unavailable right now' });
      }
    });

    // Radar: cross-exchange positioning, funding, open interest and large trades.
    app.get('/api/radar', async (req, res) => {
      try {
        const snap = await radar.snapshot();
        sendBuilt(req, res, 'radar', snap.at, 10, () => ({ demo, ...snap }));
      } catch (err) {
        fail(res, err);
      }
    });

    // Markets page: history and a polling fallback. Live updates go from the browser
    // straight to the exchange's own stream, so they put no load on this server.
    // `costly` routes each spend a real share of this server's allowance at the exchange,
    // so one viewer gets only a few a minute; nobody can use the allowance up for everyone.
    const market = (seconds, fn, costly = false) => async (req, res) => {
      const coin = String(req.query.coin || 'BTC');
      if (!validCoin(coin)) return refuse(res, 400, { error: 'Unknown market' });
      if (!(await local.allow('mkt:' + req.ip, 600, 60000))) return refuse(res, 429, { error: 'Too many requests' });
      if (costly && !demo && !(await local.allow('mktx:' + req.ip, 24, 60000))) return refuse(res, 429, { error: 'Too many requests' });
      try {
        // Only markets the exchange lists; a made-up name must not cost an upstream call.
        if (!(await hl.has(coin))) return refuse(res, 400, { error: 'Unknown market' });
        shared(res, seconds).json(await fn(coin, req));
      } catch (err) {
        // A request we would never answer is refused outright, so it cannot be cached as a variant.
        if (err.status === 400) return refuse(res, 400, { error: err.message });
        fail(res, err);
      }
    };
    app.get('/api/markets', async (_req, res) => {
      try {
        shared(res, 3).json({ demo, markets: await hl.markets() });
      } catch (err) {
        fail(res, err);
      }
    });
    app.get('/api/markets/book', market(1, (coin) => hl.book(coin)));
    app.get('/api/markets/trades', market(1, async (coin) => ({ trades: await hl.trades(coin) })));
    app.get('/api/markets/depth', market(2, (coin, req) => {
      const sig = req.query.sig === undefined ? '3' : String(req.query.sig);
      if (!['2', '3', '4', '5'].includes(sig)) throw Object.assign(new Error('Unknown grouping'), { status: 400 });
      return hl.depth(coin, Number(sig));
    }));
    app.get('/api/markets/funding', market(300, async (coin) => ({ coin, history: await hl.fundingHistory(coin) }), true));
    app.get('/api/markets/candles', market(10, async (coin, req) => {
      const interval = req.query.interval === undefined ? '15m' : String(req.query.interval);
      if (!Object.hasOwn(INTERVALS, interval)) throw Object.assign(new Error('Unknown candle size'), { status: 400 });
      // Two sizes only, so everyone shares the same cached answers.
      return { interval, candles: await hl.candles(coin, interval, String(req.query.bars) === '600' ? 600 : 300) };
    }, true));

    // Breaking-page chat. `room` is "general" or a feed item id.
    app.get('/api/chat', (req, res) => {
      shared(res, 1).json({ messages: chat.list(String(req.query.room || 'general')), counts: chat.counts() });
    });
    app.post('/api/chat', async (req, res) => {
      res.set('cache-control', 'no-store');
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      try {
        const out = await chat.post({ room: b.room, name: b.name, text: b.text, ip: req.ip });
        if (out.error) return refuse(res, out.status, { error: out.error });
        res.json({ message: out.msg });
      } catch (err) {
        res.status(503).json({ error: 'Chat is unavailable right now' });
      }
    });

    app.get('/api/chat/counts', (_req, res) => {
      shared(res, 2).json({ counts: chat.counts() });
    });

    // One address may hold only so many live connections, so a single client cannot take
    // every slot and push everyone else onto the slower path.
    const perAddress = new Map();
    const full = (req) => clients.size + roomCount >= sseMax || (perAddress.get(req.ip) || 0) >= streamsPerAddress;
    const openStream = (req, res) => {
      res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      // Each browser is given its own reconnect delay, so after a restart they do not all
      // come back in the same instant.
      res.write(`retry: ${2000 + Math.floor(Math.random() * 4000)}\n\n`);
      const ip = req.ip;
      perAddress.set(ip, (perAddress.get(ip) || 0) + 1);
      req.on('close', () => {
        const n = (perAddress.get(ip) || 1) - 1;
        if (n <= 0) perAddress.delete(ip); else perAddress.set(ip, n);
      });
    };

    // Live chat for one room, held only while someone has that room open.
    app.get('/api/chat/stream', (req, res) => {
      const room = String(req.query.room || 'general');
      if (!hasRoom(room)) return res.status(404).set('cache-control', 'no-store').end();
      if (full(req)) return res.status(503).set({ 'retry-after': '30', 'cache-control': 'no-store' }).end();
      openStream(req, res);
      if (!roomClients.has(room)) roomClients.set(room, new Set());
      roomClients.get(room).add(res);
      roomCount += 1;
      req.on('close', () => {
        const set = roomClients.get(room);
        if (!set || !set.delete(res)) return;
        roomCount -= 1;
        if (!set.size) roomClients.delete(room);
      });
    });

    // Live push of new feed items (Server-Sent Events).
    app.get('/api/stream', (req, res) => {
      // Past the limit the browser falls back to polling the cached feed.
      if (full(req)) return res.status(503).set({ 'retry-after': '30', 'cache-control': 'no-store' }).end();
      openStream(req, res);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    });
  }

  // Unknown API paths and broken requests get a short JSON answer, never a stack trace.
  app.use('/api', (_req, res) => res.status(404).set('cache-control', 'no-store').json({ error: 'Not found' }));
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error('[server]', err);
    res.status(status).set('cache-control', 'no-store').json({ error: status === 500 ? 'Something went wrong' : 'Bad request' });
  });

  let stopFeed = null;
  return {
    app,
    store,
    chat,
    bus,
    async start() {
      if (!ingests) return;
      if (demo) {
        const seeded = await bus.history('chat', 1);
        if (!seeded.length) {
          const lines = ['Sample chat: anyone watching the otter post?', 'Sample chat: flagged copies showed up within seconds', 'Sample chat: waiting for the inflation print'];
          for (const [i, text] of lines.entries()) await chat.post({ room: 'general', name: 'demo_user_' + (i + 1), text, ip: 'demo-' + i });
        }
        stopFeed = startDemo(store);
      } else {
        poller.start();
        stopFeed = () => poller.stop();
      }
    },
    async stop() {
      clearInterval(beat);
      clearInterval(reseed);
      if (stopFeed) stopFeed();
      xpanel.stop();
      tradfi.stop();
      for (const res of clients) res.end();
      clients.clear();
      for (const set of roomClients.values()) for (const res of set) res.end();
      roomClients.clear();
      await bus.close();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo') || process.env.DEMO === '1';
  const role = ['all', 'web', 'ingest'].includes(process.env.ROLE) ? process.env.ROLE : 'all';
  const config = JSON.parse(readFileSync(path.join(root, 'config', 'sources.json'), 'utf8'));
  const port = Number(process.env.PORT) || 3000;
  const svc = await createApp({
    demo,
    config,
    role,
    redisUrl: process.env.REDIS_URL || '',
    xToken: process.env.X_BEARER_TOKEN || '',
    xDailyPosts: Number(process.env.X_DAILY_POSTS) || 2000,
    sseMax: Number(process.env.SSE_MAX) || 10000,
    streamsPerAddress: Number(process.env.STREAMS_PER_ADDRESS) || 12,
    frameAncestors: process.env.FRAME_ANCESTORS || "'self'",
    // A number of proxies in front (1 for a load balancer, 2 for a CDN plus a load balancer), or "true".
    trustProxy: /^\d+$/.test(process.env.TRUST_PROXY || '') ? Number(process.env.TRUST_PROXY) : process.env.TRUST_PROXY === 'true'
  });
  const server = svc.app.listen(port, async () => {
    await svc.start();
    console.log(`Halftone${demo ? ' (demo data)' : ''} [${role}, ${svc.bus.kind}] running at http://localhost:${port}`);
  });
  // Longer than a load balancer's usual idle timeout, so it never reuses a connection this
  // side has just closed (the cause of stray 502s).
  server.keepAliveTimeout = 65000;
  server.headersTimeout = 66000;
  // Live connections never finish on their own; give them a moment, then close.
  const shutdown = () => {
    server.close(() => process.exit(0));
    svc.stop().finally(() => setTimeout(() => process.exit(0), 1500).unref());
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
