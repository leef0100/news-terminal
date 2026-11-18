// Live chat for the Breaking page. One room per feed item plus a "general" room.
// Messages travel over the bus, so every web server shows the same conversation.
// There are no accounts and no moderation yet: see SCALING.md before opening this up.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

const clean = (s, max) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export function createChat({ hasRoom, bus, now = Date.now, maxPerRoom = 200, maxRooms = 500, burst = 5, windowMs = 10000, keep = 5000 } = {}) {
  const rooms = new Map();
  const seen = new Set();
  const events = new EventEmitter();
  events.setMaxListeners(0);

  function insert(msg, announce) {
    if (!msg || !msg.id || !msg.room || seen.has(msg.id)) return;
    seen.add(msg.id);
    if (seen.size > keep * 2) seen.delete(seen.values().next().value);
    if (!rooms.has(msg.room)) {
      if (rooms.size >= maxRooms) rooms.delete(rooms.keys().next().value);
      rooms.set(msg.room, []);
    }
    const list = rooms.get(msg.room);
    list.push(msg);
    if (list.length > maxPerRoom) list.splice(0, list.length - maxPerRoom);
    if (announce) events.emit('msg', msg);
  }

  bus.on('chat', (msg) => insert(msg, true));

  async function post({ room, name, text, ip }) {
    const r = String(room || '');
    if (!hasRoom(r)) return { status: 404, error: 'Unknown room' };
    const body = clean(text, 280);
    if (!body) return { status: 400, error: 'Message is empty' };
    if (!(await bus.allow('chat:' + String(ip || 'unknown'), burst, windowMs))) return { status: 429, error: 'Slow down a little' };
    const msg = { id: now().toString(36) + '-' + randomBytes(5).toString('hex'), room: r, name: clean(name, 20) || 'anon', text: body, ts: now() };
    await bus.append('chat', msg, keep);
    return { status: 200, msg };
  }

  return {
    post,
    // Load what other servers already hold, so a server that starts late shows the same history.
    async hydrate() {
      for (const msg of await bus.history('chat', keep)) insert(msg, false);
    },
    list: (room) => (rooms.get(String(room)) || []).slice(),
    counts: () => Object.fromEntries([...rooms].map(([k, v]) => [k, v.length])),
    on: (fn) => events.on('msg', fn),
    off: (fn) => events.off('msg', fn)
  };
}
