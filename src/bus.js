// The bus is how server processes share state: the live feed, chat messages and rate limits.
//
//   memory  one process, nothing to install (the default)
//   redis   many web servers plus a separate ingest worker, all seeing the same feed and chat
//
// Both offer the same four calls, so the rest of the code never knows which one it has:
//   append(stream, obj, cap)   store and broadcast to every process
//   history(stream, n)         the most recent n objects
//   on(stream, fn)             be told about each appended object
//   allow(key, burst, windowMs) fixed-window rate limit shared by all processes
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
      if (list.length > cap) list.splice(0, list.length - cap);
      lists.set(stream, list);
      events.emit(stream, obj);
    },
    async history(stream, n = 500) {
      return (lists.get(stream) || []).slice(-n);
    },
    on(stream, fn) {
      events.on(stream, fn);
    },
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

export async function createRedisBus(url, { prefix = 'ht:' } = {}) {
  const mod = await import('ioredis');
  const Redis = mod.Redis || mod.default;
  const pub = new Redis(url, { maxRetriesPerRequest: 2 });
  const sub = new Redis(url);
  const handlers = new Map();
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
  await pub.ping();
  return {
    kind: 'redis',
    async append(stream, obj, cap = 500) {
      const raw = JSON.stringify(obj);
      const key = prefix + 'l:' + stream;
      await pub.multi().rpush(key, raw).ltrim(key, -cap, -1).publish(prefix + 'c:' + stream, raw).exec();
    },
    async history(stream, n = 500) {
      return (await pub.lrange(prefix + 'l:' + stream, -n, -1)).map(parse).filter(Boolean);
    },
    on(stream, fn) {
      const channel = prefix + 'c:' + stream;
      if (!handlers.has(channel)) {
        handlers.set(channel, []);
        sub.subscribe(channel).catch((err) => console.warn('[bus] subscribe:', err.message));
      }
      handlers.get(channel).push(fn);
    },
    async allow(key, burst, windowMs) {
      const k = prefix + 'r:' + key;
      const n = await pub.incr(k);
      if (n === 1) await pub.pexpire(k, windowMs);
      return n <= burst;
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
