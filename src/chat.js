// Live chat for the Breaking page. One room per feed item plus a "general" room.
// Messages live in memory only: they are lost on restart, and there are no accounts.
import { EventEmitter } from 'node:events';

const clean = (s, max) =>
  String(s ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);

export function createChat({ hasRoom, now = Date.now, maxPerRoom = 200, maxRooms = 300, burst = 5, windowMs = 10000 } = {}) {
  const rooms = new Map();
  const hits = new Map();
  const events = new EventEmitter();
  events.setMaxListeners(0);
  let seq = 0;

  function allowed(ip) {
    const t = now();
    const recent = (hits.get(ip) || []).filter((x) => t - x < windowMs);
    if (recent.length >= burst) {
      hits.set(ip, recent);
      return false;
    }
    recent.push(t);
    hits.set(ip, recent);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return true;
  }

  function post({ room, name, text, ip }) {
    const r = String(room || '');
    if (!hasRoom(r)) return { status: 404, error: 'Unknown room' };
    const body = clean(text, 280);
    if (!body) return { status: 400, error: 'Message is empty' };
    if (!allowed(String(ip || 'unknown'))) return { status: 429, error: 'Slow down a little' };
    const msg = { id: ++seq, room: r, name: clean(name, 20) || 'anon', text: body, ts: now() };
    if (!rooms.has(r)) {
      if (rooms.size >= maxRooms) rooms.delete(rooms.keys().next().value);
      rooms.set(r, []);
    }
    const list = rooms.get(r);
    list.push(msg);
    if (list.length > maxPerRoom) list.splice(0, list.length - maxPerRoom);
    events.emit('msg', msg);
    return { status: 200, msg };
  }

  return {
    post,
    list: (room) => (rooms.get(String(room)) || []).slice(),
    counts: () => Object.fromEntries([...rooms].map(([k, v]) => [k, v.length])),
    on: (fn) => events.on('msg', fn),
    off: (fn) => events.off('msg', fn)
  };
}
