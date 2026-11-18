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
import { createBus } from './bus.js';
import { createPoller } from './ingest/poller.js';
import { createTokenMatcher } from './tokens.js';
import { startDemo, demoFetch } from './ingest/demo.js';
import { createChat } from './chat.js';
import { createHyperliquid, validCoin, INTERVALS } from './hyperliquid.js';
import { createRadar } from './radar.js';
import { demoMarketFetch } from './ingest/demo-markets.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export async function createApp({ demo = false, config, role = 'all', redisUrl = '', sseMax = 50000, frameAncestors = "'self'", trustProxy = false } = {}) {
  const startedAt = Date.now();
  const bus = await createBus({ redisUrl });
  const store = createStore();
  const ingests = role !== 'web';
  const serves = role !== 'ingest';

  const matcher = createTokenMatcher(demo ? { fetchImpl: demoFetch() } : {});
  const marketFetch = demo ? demoMarketFetch() : fetch;
  const hl = createHyperliquid({ fetchImpl: marketFetch });
  const radar = createRadar({ fetchImpl: marketFetch, hl });
  const poller = ingests && !demo ? createPoller({ sources: config.sources, store, pollSeconds: config.pollSeconds }) : null;
  const hasRoom = (room) => room === 'general' || Boolean(store.get(room));
  const chat = createChat({ hasRoom, bus });

  // Feed items cross the bus only when there is more than one process to tell.
  if (bus.kind === 'redis') {
    for (const item of await bus.history('feed', 500)) store.add(item);
    bus.on('feed', (item) => store.add(item));
    if (ingests) store.on((item) => bus.append('feed', item, 500).catch((err) => console.warn('[bus] publish:', err.message)));
  }
  await chat.hydrate();

  // ---------- live connections ----------
  // Each event is turned into text once and the same text is written to every connection.
  const clients = new Set();
  const broadcast = (event, obj) => {
    const frame = `event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`;
    for (const res of clients) res.write(frame);
  };
  store.on((item) => broadcast('item', item));
  // Chat goes only to the people in that room, never to the whole audience.
  const roomClients = new Map();
  let roomCount = 0;
  chat.on((msg) => {
    const set = roomClients.get(msg.room);
    if (!set) return;
    const frame = `event: chat\ndata: ${JSON.stringify(msg)}\n\n`;
    for (const res of set) res.write(frame);
  });
  const beat = setInterval(() => {
    for (const res of clients) res.write(': ping\n\n');
    for (const set of roomClients.values()) for (const res of set) res.write(': ping\n\n');
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
  const fail = (res, err) => res.status(502).set('cache-control', 'no-store').json({ error: String(err.message || err) });

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
        setHeaders: (res, file) => res.set('cache-control', file.endsWith('.html') ? 'no-cache' : 'public, max-age=300')
      })
    );
    // The charting library is served from the installed package, so no outside CDN is needed.
    app.get('/vendor/lightweight-charts.js', (_req, res) => {
      res.set('cache-control', 'public, max-age=86400');
      res.sendFile(path.join(root, 'node_modules', 'lightweight-charts', 'dist', 'lightweight-charts.standalone.production.js'));
    });

    app.get('/api/feed', (req, res) => {
      const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 150, 1), 500);
      sendBuilt(req, res, 'feed:' + limit, store.version(), 1, () => ({ demo, items: store.list(limit) }));
    });

    // One story by id, so a shared link still opens after the story has scrolled out of the feed.
    app.get('/api/item', (req, res) => {
      const item = store.get(String(req.query.id || ''));
      if (!item) return res.status(404).set('cache-control', 'no-store').json({ error: 'This story is no longer available' });
      shared(res, 60).json({ item });
    });

    app.get('/api/health', (_req, res) => {
      res.set('cache-control', 'no-store').json({ demo, role, items: store.size(), sources: poller ? poller.status() : [] });
    });

    // Solana tokens matching one ticker or name. Cached per term, shared by everyone.
    app.get('/api/tokens', async (req, res) => {
      const q = String(req.query.q || '').trim().replace(/^\$/, '');
      if (!/^[\p{L}\p{N} ._-]{1,40}$/u.test(q)) return res.status(400).json({ tokens: [], error: 'Enter a ticker or name' });
      try {
        if (!(await bus.allow('tok:' + req.ip, 90, 60000))) return res.status(429).json({ tokens: [], error: 'Too many searches, try again in a minute' });
        shared(res, 15).json({ term: q, tokens: await matcher.search(q) });
      } catch (err) {
        res.status(502).set('cache-control', 'no-store').json({ term: q, tokens: [], error: String(err.message || err) });
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
    const market = (seconds, fn) => async (req, res) => {
      const coin = String(req.query.coin || 'BTC');
      if (!validCoin(coin)) return res.status(400).json({ error: 'Unknown market' });
      try {
        shared(res, seconds).json(await fn(coin, req));
      } catch (err) {
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
    app.get('/api/markets/candles', market(3, async (coin, req) => {
      const interval = Object.hasOwn(INTERVALS, String(req.query.interval)) ? String(req.query.interval) : '15m';
      return { interval, candles: await hl.candles(coin, interval) };
    }));

    // Breaking-page chat. `room` is "general" or a feed item id.
    app.get('/api/chat', (req, res) => {
      shared(res, 1).json({ messages: chat.list(String(req.query.room || 'general')), counts: chat.counts() });
    });
    app.post('/api/chat', async (req, res) => {
      res.set('cache-control', 'no-store');
      const b = req.body && typeof req.body === 'object' ? req.body : {};
      try {
        const out = await chat.post({ room: b.room, name: b.name, text: b.text, ip: req.ip });
        if (out.error) return res.status(out.status).json({ error: out.error });
        res.json({ message: out.msg });
      } catch (err) {
        res.status(503).json({ error: 'Chat is unavailable right now' });
      }
    });

    app.get('/api/chat/counts', (_req, res) => {
      shared(res, 2).json({ counts: chat.counts() });
    });

    const openStream = (res) => {
      res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
      res.flushHeaders();
      res.write('retry: 3000\n\n');
    };

    // Live chat for one room, held only while someone has that room open.
    app.get('/api/chat/stream', (req, res) => {
      const room = String(req.query.room || 'general');
      if (!hasRoom(room)) return res.status(404).set('cache-control', 'no-store').end();
      if (clients.size + roomCount >= sseMax) return res.status(503).set({ 'retry-after': '30', 'cache-control': 'no-store' }).end();
      openStream(res);
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
      if (clients.size + roomCount >= sseMax) return res.status(503).set({ 'retry-after': '30', 'cache-control': 'no-store' }).end();
      openStream(res);
      clients.add(res);
      req.on('close', () => clients.delete(res));
    });
  }

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
      if (stopFeed) stopFeed();
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
    sseMax: Number(process.env.SSE_MAX) || 50000,
    frameAncestors: process.env.FRAME_ANCESTORS || "'self'",
    trustProxy: process.env.TRUST_PROXY ? (Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY) : false
  });
  const server = svc.app.listen(port, async () => {
    await svc.start();
    console.log(`Halftone${demo ? ' (demo data)' : ''} [${role}, ${svc.bus.kind}] running at http://localhost:${port}`);
  });
  // Live connections never finish on their own; give them a moment, then close.
  const shutdown = () => {
    server.close(() => process.exit(0));
    svc.stop().finally(() => setTimeout(() => process.exit(0), 1500).unref());
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
