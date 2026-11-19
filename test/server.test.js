// End-to-end checks of the HTTP server in demo mode, and of two servers sharing Redis.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createApp } from '../src/server.js';

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const url = (server, p) => `http://127.0.0.1:${server.address().port}${p}`;

// Reads a live stream until `want` events have arrived (or it times out).
async function readEvents(streamUrl, want, ms = 4000) {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), ms);
  const out = [];
  try {
    const res = await fetch(streamUrl, { signal: ac.signal });
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) !== -1) {
        const frame = buf.slice(0, i);
        buf = buf.slice(i + 2);
        const ev = /^event: (.+)$/m.exec(frame);
        const data = /^data: (.+)$/m.exec(frame);
        if (ev && data) out.push({ event: ev[1], data: JSON.parse(data[1]) });
        if (out.length >= want) { ac.abort(); return out; }
      }
    }
  } catch { /* aborted */ }
  clearTimeout(timer);
  return out;
}

test('server: pages, cache and security headers, feed, tokens, markets, radar, chat, live stream', async () => {
  const svc = await createApp({ demo: true });
  const server = await listen(svc.app);
  await svc.start();
  try {
    const page = await fetch(url(server, '/'));
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-cache');
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('x-content-type-options'), 'nosniff');
    assert.equal((await fetch(url(server, '/app.js'))).headers.get('cache-control'), 'no-cache');

    const feedRes = await fetch(url(server, '/api/feed'));
    assert.match(feedRes.headers.get('cache-control'), /s-maxage=1/);
    const feed = await feedRes.json();
    assert.equal(feed.demo, true);
    assert.ok(feed.items.length >= 10);
    assert.ok(feed.items.every((i) => i.storyId && i.topic && typeof i.impact === 'number'));

    assert.equal((await (await fetch(url(server, '/api/item?id=' + feed.items[0].id))).json()).item.id, feed.items[0].id);
    assert.equal((await fetch(url(server, '/api/item?id=nope'))).status, 404);

    const tok = await fetch(url(server, '/api/tokens?q=%24OTTER'));
    assert.match(tok.headers.get('cache-control'), /s-maxage=15/);
    assert.equal((await tok.json()).tokens.length, 3);
    assert.equal((await fetch(url(server, '/api/tokens?q=%3Cscript%3E'))).status, 400);

    assert.ok((await (await fetch(url(server, '/api/markets'))).json()).markets.length >= 6);
    assert.equal((await fetch(url(server, '/api/markets/book?coin=..%2F'))).status, 400);
    assert.equal((await fetch(url(server, '/api/markets/candles?coin=FAKE1'))).status, 400, 'made-up markets are refused');
    assert.ok((await (await fetch(url(server, '/api/markets/candles?coin=BTC&interval=1h'))).json()).candles.length > 100);
    const status = await (await fetch(url(server, '/api/status'))).json();
    assert.ok(status.feed.sources.length >= 4 && status.feed.sources.every((x) => x.state === 'ok' && x.medianDelaySeconds === null), 'demo sources report, with no made-up delay figure');
    assert.deepEqual(status.market.venues.map((v) => v.name), ['Binance', 'Bybit', 'Hyperliquid', 'Coinbase', 'Papertrade']);
    assert.ok(status.market.exchange.allowancePerMinute > 0 && status.viewers.limit > 0);
    const xp = await (await fetch(url(server, '/api/x?handles=@Some_One,another'))).json();
    assert.ok(xp.demo && xp.posts.length === 2 && xp.posts.every((q) => q.placeholder), 'the demo panel shows labelled placeholders only');
    assert.equal((await fetch(url(server, '/api/x?handles=bad-name'))).status, 400);
    assert.equal((await fetch(url(server, '/api/x?handles=' + Array.from({ length: 21 }, (_, i) => 'u' + i).join(',')))).status, 400);
    const depth = await (await fetch(url(server, '/api/markets/depth?coin=BTC&sig=3'))).json();
    assert.ok(depth.bids.length > 5 && depth.asks.length > 5 && depth.bids[0].px < depth.asks[0].px);
    const funding = await (await fetch(url(server, '/api/markets/funding?coin=BTC'))).json();
    assert.ok(funding.history.length > 150 && funding.history[0].time < funding.history.at(-1).time, 'a week of hourly funding, oldest first');
    assert.equal((await fetch(url(server, '/api/markets/depth?coin=FAKE1'))).status, 400);
    assert.equal((await fetch(url(server, '/api/markets/funding?coin=..%2F'))).status, 400);
    assert.equal((await (await fetch(url(server, '/api/radar'))).json()).coins.length, 6);

    const stream = readEvents(url(server, '/api/chat/stream?room=general'), 1);
    const feedOnly = readEvents(url(server, '/api/stream'), 1, 700);
    await new Promise((r) => setTimeout(r, 150));
    const post = await fetch(url(server, '/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'general', name: 't', text: 'hello <b>there</b>' }) });
    assert.equal(post.status, 200);
    const events = await stream;
    assert.equal(events[0].event, 'chat');
    assert.equal(events[0].data.text, 'hello <b>there</b>');
    assert.ok((await feedOnly).every((e) => e.event !== 'chat'), 'chat is not broadcast to the whole audience');
    assert.equal((await fetch(url(server, '/api/chat/stream?room=nope'))).status, 404);
    assert.equal((await (await fetch(url(server, '/api/chat/counts'))).json()).counts.general, 4);
    assert.equal((await fetch(url(server, '/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"room":"nope","text":"x"}' })).status, 404);
    assert.equal((await fetch(url(server, '/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' })).status, 400);

    const health = await (await fetch(url(server, '/healthz'))).json();
    assert.deepEqual([health.ok, health.role, health.bus], [true, 'all', 'memory']);
  } finally {
    await svc.stop();
    server.close();
  }
});

test('server: refuses live connections past its limit so browsers fall back to polling', async () => {
  const svc = await createApp({ demo: true, sseMax: 1 });
  const server = await listen(svc.app);
  try {
    const first = new AbortController();
    const held = await fetch(url(server, '/api/stream'), { signal: first.signal });
    assert.equal(held.status, 200);
    assert.equal((await fetch(url(server, '/api/stream'))).status, 503);
    first.abort();
  } finally {
    await svc.stop();
    server.close();
  }
});

const hasRedis = spawnSync('redis-server', ['--version']).status === 0;

test('cluster: an ingest process and two web servers share the feed and chat through Redis', { skip: !hasRedis && 'redis-server is not installed' }, async () => {
  const port = 6500 + Math.floor(Math.random() * 400);
  const redis = spawn('redis-server', ['--port', String(port), '--save', '', '--appendonly', 'no'], { stdio: 'ignore' });
  await new Promise((r) => setTimeout(r, 600));
  const redisUrl = `redis://127.0.0.1:${port}`;
  const ingest = await createApp({ demo: true, role: 'ingest', redisUrl });
  const webA = await createApp({ demo: true, role: 'web', redisUrl });
  const a = await listen(webA.app);
  try {
    assert.equal((await (await fetch(url(a, '/api/feed'))).json()).items.length, 0, 'a web server has no feed of its own');
    await ingest.start();
    await new Promise((r) => setTimeout(r, 300));
    const fromA = (await (await fetch(url(a, '/api/feed'))).json()).items;
    assert.ok(fromA.length >= 10, 'items published by ingest reach the web server');

    // A second web server that starts later catches up from Redis.
    const webB = await createApp({ demo: true, role: 'web', redisUrl });
    const b = await listen(webB.app);
    try {
      const fromB = (await (await fetch(url(b, '/api/feed'))).json()).items;
      assert.deepEqual(fromB.map((i) => i.id).sort(), fromA.map((i) => i.id).sort());
      assert.equal((await (await fetch(url(b, '/api/chat?room=general'))).json()).messages.length, 3, 'chat history is shared');

      // A message posted to server A is pushed live to someone connected to server B.
      const stream = readEvents(url(b, '/api/chat/stream?room=general'), 1);
      await new Promise((r) => setTimeout(r, 150));
      await fetch(url(a, '/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ room: 'general', name: 'x', text: 'across servers' }) });
      const events = await stream;
      assert.equal(events[0]?.data.text, 'across servers');
      assert.equal((await (await fetch(url(b, '/healthz'))).json()).bus, 'redis');

      // The subscriber connections are cut; a story published in that moment must still
      // reach the web servers once they reconnect.
      spawnSync('redis-cli', ['-p', String(port), 'CLIENT', 'KILL', 'TYPE', 'pubsub']);
      ingest.store.add({ id: 'during-outage', sourceId: 'x', source: 'X', text: 'Published while disconnected', ts: Date.now() + 1000, cashtags: [], terms: [] });
      let caught = false;
      for (let i = 0; i < 40 && !caught; i++) {
        await new Promise((r) => setTimeout(r, 150));
        caught = (await (await fetch(url(b, '/api/feed'))).json()).items.some((x) => x.id === 'during-outage');
      }
      assert.ok(caught, 'the missed story was recovered after reconnecting');
    } finally {
      await webB.stop();
      b.close();
    }
  } finally {
    await webA.stop();
    await ingest.stop();
    a.close();
    redis.kill();
  }
});

test('server: the feed answers "not modified" to a browser that already has the current version', async () => {
  const svc = await createApp({ demo: true });
  const server = await listen(svc.app);
  await svc.start();
  try {
    const first = await fetch(url(server, '/api/feed'), { headers: { 'accept-encoding': 'gzip' } });
    const etag = first.headers.get('etag');
    assert.ok(etag);
    assert.ok((await first.json()).items.length >= 10, 'compressed body still decodes');
    const again = await fetch(url(server, '/api/feed'), { headers: { 'if-none-match': etag } });
    assert.equal(again.status, 304);
    svc.store.add({ id: 'new-one', sourceId: 't', source: 'T', text: 'Fresh item', ts: Date.now(), cashtags: [], terms: [] });
    const changed = await fetch(url(server, '/api/feed'), { headers: { 'if-none-match': etag } });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).items[0].id, 'new-one');
  } finally {
    await svc.stop();
    server.close();
  }
});

test('server: bad requests get short JSON errors, and feed sizes snap to a fixed menu', async () => {
  const svc = await createApp({ demo: true });
  const server = await listen(svc.app);
  await svc.start();
  try {
    const bad = await fetch(url(server, '/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{bad' });
    assert.equal(bad.status, 400);
    assert.deepEqual(await bad.json(), { error: 'Bad request' });
    const big = await fetch(url(server, '/api/chat'), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'x'.repeat(5000) }) });
    assert.equal(big.status, 413);
    assert.match(big.headers.get('content-type'), /json/);
    const missing = await fetch(url(server, '/api/nope'));
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { error: 'Not found' });
    const a = await fetch(url(server, '/api/feed?limit=7'));
    const b = await fetch(url(server, '/api/feed?limit=49'));
    assert.equal(a.headers.get('etag'), b.headers.get('etag'));
  } finally {
    await svc.stop();
    server.close();
  }
});

test('server: one address cannot hold every live connection; split roles need Redis', async () => {
  await assert.rejects(() => createApp({ demo: true, role: 'web' }), /needs REDIS_URL/);
  const svc = await createApp({ demo: true, streamsPerAddress: 2 });
  const server = await listen(svc.app);
  try {
    const held = [new AbortController(), new AbortController()];
    for (const h of held) assert.equal((await fetch(url(server, '/api/stream'), { signal: h.signal })).status, 200);
    assert.equal((await fetch(url(server, '/api/stream'))).status, 503);
    held[0].abort();
    await new Promise((r) => setTimeout(r, 100));
    const again = new AbortController();
    assert.equal((await fetch(url(server, '/api/stream'), { signal: again.signal })).status, 200, 'the slot is freed when a connection closes');
    again.abort(); held[1].abort();
  } finally {
    await svc.stop();
    server.close();
  }
});
