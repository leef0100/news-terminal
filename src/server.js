import express from 'express';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createStore } from './store.js';
import { createPoller } from './ingest/poller.js';
import { createTokenMatcher } from './tokens.js';
import { startDemo, demoFetch } from './ingest/demo.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export function createApp({ demo = false, config } = {}) {
  const store = createStore();
  const matcher = createTokenMatcher(demo ? { fetchImpl: demoFetch() } : {});
  const poller = demo ? null : createPoller({ sources: config.sources, store, pollSeconds: config.pollSeconds });

  const app = express();
  app.disable('x-powered-by');
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

  // Live push of new items (Server-Sent Events).
  app.get('/api/stream', (req, res) => {
    res.set({ 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
    res.flushHeaders();
    res.write('retry: 2000\n\n');
    const send = (item) => res.write(`event: item\ndata: ${JSON.stringify(item)}\n\n`);
    const beat = setInterval(() => res.write(': ping\n\n'), 15000);
    store.on(send);
    req.on('close', () => {
      clearInterval(beat);
      store.off(send);
    });
  });

  return {
    app,
    store,
    start() {
      if (demo) return startDemo(store);
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
    console.log(`News Terminal${demo ? ' (demo data)' : ''} running at http://localhost:${port}`);
  });
}
