// The bus is how server processes share state: the live feed, chat messages and rate limits.
//
//   memory  one process, nothing to install (the default)
//   redis   many web servers plus a separate ingest worker, all seeing the same feed and chat
//
// Both offer the same calls, so the rest of the code never knows which one it has:
//   append(stream, obj, cap)    store and broadcast to every process
//   history(stream, n)          the newest n objects (by their own `ts`), oldest first
//   on(stream, fn)              be told about each appended object
//   onReconnect(fn)             be told when a dropped connection is back, to re-read history
//   allow(key, burst, windowMs) fixed-window rate limit shared by all processes
//   size(stream)                how many objects the stream holds
import { EventEmitter } from 'node:events';

export function createMemoryBus({ now = Date.now } = {}) {
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const lists = new Map();
  const windows = new Map();
  return {
    kind: 'memory',
    async append(stream, obj, cap = 500) {
      const list = lists.get(stream) || [];
      list.push(obj);
      list.sort((a, b) => (a.ts || 0) - (b.ts || 0));
      if (list.length > cap) list.splice(0, list.length - cap);
      lists.set(stream, list);
      events.emit(stream, obj);
    },
    async history(stream, n = 500) {
      return (lists.get(stream) || []).slice(-n);
    },
    async size(stream) {
      return (lists.get(stream) || []).length;
    },
    async on(stream, fn) {
      events.on(stream, fn);
    },
    onReconnect() {},
    async allow(key, burst, windowMs) {
      const t = now();
      let w = windows.get(key);
      if (!w || t >= w.resetAt) {
        w = { count: 0, resetAt: t + windowMs };
        windows.set(key, w);
        // Keep the table from growing without bound under many distinct callers.
        if (windows.size > 20000) for (const [k, v] of windows) if (t >= v.resetAt) windows.delete(k);
      }
      w.count += 1;
      return w.count <= burst;
    },
    async close() {}
  };
}

export async function createRedisBus(url, { prefix = 'ht:', commandTimeout = 1500 } = {}) {
  const mod = await import('ioredis');
  const Redis = mod.Redis || mod.default;
  // Commands give up quickly: a slow or absent Redis must not hang web requests.
  const pub = new Redis(url, { maxRetriesPerRequest: 1, commandTimeout });
  const sub = new Redis(url);
  const handlers = new Map();
  const reconnectFns = [];
  const parse = (raw) => {
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };
  sub.on('message', (channel, raw) => {
    const obj = parse(raw);
    if (obj) for (const fn of handlers.get(channel) || []) fn(obj);
  });
  pub.on('error', (err) => console.warn('[bus] redis:', err.message));
  sub.on('error', (err) => console.warn('[bus] redis:', err.message));
  // Anything published while the subscriber was away was missed. Each time it comes back
  // (ioredis re-subscribes by itself) the owners are told, and they re-read history.
  let everReady = false;
  sub.on('ready', () => {
    if (everReady) for (const fn of reconnectFns) Promise.resolve().then(fn).catch((err) => console.warn('[bus] catch-up:', err.message));
    everReady = true;
  });
  await pub.ping();

  return {
    kind: 'redis',
    // Kept as a set ordered by each object's own time, so trimming drops the oldest story,
    // not whichever happened to arrive first.
    async append(stream, obj, cap = 500) {
      const raw = JSON.stringify(obj);
      const key = prefix + 'z:' + stream;
      await pub.multi().zadd(key, Number(obj.ts) || Date.now(), raw).zremrangebyrank(key, 0, -cap - 1).publish(prefix + 'c:' + stream, raw).exec();
    },
    async history(stream, n = 500) {
      return (await pub.zrange(prefix + 'z:' + stream, -n, -1)).map(parse).filter(Boolean);
    },
    async size(stream) {
      return pub.zcard(prefix + 'z:' + stream);
    },
    // Resolves once the subscription is live, so a caller can subscribe first and read
    // history second without a gap between the two.
    async on(stream, fn) {
      const channel = prefix + 'c:' + stream;
      const first = !handlers.has(channel);
      if (first) handlers.set(channel, []);
      handlers.get(channel).push(fn);
      if (first) await sub.subscribe(channel);
    },
    onReconnect(fn) {
      reconnectFns.push(fn);
    },
    // If Redis cannot answer, the request is let through: a rate limiter that is down
    // must not take the feature down with it. The expiry is set in the same step as the
    // first count, so a counter can never be left without one.
    async allow(key, burst, windowMs) {
      const k = prefix + 'r:' + key;
      try {
        const out = await pub.multi().set(k, 0, 'PX', windowMs, 'NX').incr(k).exec();
        const n = Number(out?.[1]?.[1]);
        return !Number.isFinite(n) || n <= burst;
      } catch {
        return true;
      }
    },
    async close() {
      pub.disconnect();
      sub.disconnect();
    }
  };
}

export async function createBus({ redisUrl } = {}) {
  return redisUrl ? createRedisBus(redisUrl) : createMemoryBus();
}
