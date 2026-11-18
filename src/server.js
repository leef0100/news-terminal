import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore } from './store.js';
import { createPoller } from './ingest/poller.js';
import { createTokenMatcher } from './tokens.js';
import { startDemo, demoFetch } from './ingest/demo.js';
import { createChat } from './chat.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createApp({ demo = false, config } = {}) {
  const store = createStore();
  const matcher = createTokenMatcher(demo ? { fetchImpl: demoFetch() } : {});
  const poller = demo ? null : createPoller({ sources: config.sources, store, pollSeconds: config.pollSeconds });

  const chat = createChat({ hasRoom: (room) => room === 'general' || Boolean(store.get(room)) });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2kb' }));
  app.use(express.static(path.join(root, 'public')));

  app.get('/api/feed', (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 150, 1), 500);
    res.json({ demo, items: store.list(limit) });
  });

  app.get('/api/health', (_req, res) => {
    res.json({ demo, items: store.size(), sources: poller ? poller.status() : [] });
  });

  // Tokens for one feed item. `q` overrides the item's own cashtags with a manual search term.
  app.get('/api/matches', async (req, res) => {
    const item = store.get(String(req.query.itemId || ''));
    if (!item) return res.status(404).json({ error: 'Unknown item' });
    const q = String(req.query.q || '').trim().replace(/^\$/, '').slice(0, 40);
    const terms = q ? [q] : item.cashtags;
    if (!terms.length) return res.json({ tokens: [], terms: [], error: null });
    try {
      res.json(await matcher.match(terms, item.ts));
    } catch (err) {
      res.status(502).json({ tokens: [], terms, error: String(err.message || err) });
    }
  });

  // Breaking-page chat. `room` is "general" or a feed item id.
  app.get('/api/chat', (req, res) => {
    res.json({ messages: chat.list(String(req.query.room || 'general')), counts: chat.counts() });
  });

  app.post('/api/chat', (req, res) => {
    const b = req.body && typeof req.body === 'object' ? req.body : {};
    const out = chat.post({ room: b.room, name: b.name, text: b.text, ip: req.ip });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json({ message: out.msg });
  });

  // Live push of new items and chat messages (Server-Sent Events).
  app.get('/api/stream', (req, res) => {
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    const send = (item) => res.write(`event: item\ndata: ${JSON.stringify(item)}\n\n`);
    const beat = setInterval(() => res.write(': ping\n\n'), 15000);
    const sendChat = (msg) => res.write(`event: chat\ndata: ${JSON.stringify(msg)}\n\n`);
    store.on(send);
    chat.on(sendChat);
    req.on('close', () => {
      clearInterval(beat);
      store.off(send);
      chat.off(sendChat);
    });
  });

  return {
    app,
    store,
    chat,
    start() {
      if (demo) {
        ['Sample chat: anyone watching the otter post?', 'Sample chat: flagged copies showed up within seconds', 'Sample chat: waiting for the inflation print'].forEach((text, i) =>
          chat.post({ room: 'general', name: 'demo_user_' + (i + 1), text, ip: 'demo-' + i })
        );
        return startDemo(store);
      }
      poller.start();
      return () => poller.stop();
    }
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const demo = process.argv.includes('--demo');
  const config = JSON.parse(readFileSync(path.join(root, 'config', 'sources.json'), 'utf8'));
  const { app, start } = createApp({ demo, config });
  const port = Number(process.env.PORT) || 3000;
  app.listen(port, () => {
    start();
    console.log(`squawk.trade${demo ? ' (demo data)' : ''} running at http://localhost:${port}`);
  });
}
