// Live chat for the Breaking page. One room per feed item plus a "general" room.
// Messages travel over the bus, so every web server shows the same conversation.
// There are no accounts and no moderation yet: see SCALING.md before opening this up.
import { EventEmitter } from 'node:events';
import { randomBytes } from 'node:crypto';

// Normalises look-alike characters and removes invisible and direction-flipping ones,
// which are otherwise used to impersonate names ("nimda" shown as "admin").
const clean = (s, max) =>
  String(s ?? '')
    .normalize('NFKC')
    .replace(/[\p{Cf}\p{Co}\p{Cs}]/gu, '')
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
    // Rooms are kept in order of last activity. When there are too many, the quietest
    // goes first, and the general room is never the one to go.
    const list = rooms.get(msg.room) || [];
    rooms.delete(msg.room);
    rooms.set(msg.room, list);
    if (rooms.size > maxRooms) {
      for (const key of rooms.keys()) {
        if (key !== 'general' && key !== msg.room) { rooms.delete(key); break; }
      }
    }
    list.push(msg);
    if (list.length > maxPerRoom) list.splice(0, list.length - maxPerRoom);
    if (announce) events.emit('msg', msg);
  }

  const hydrate = async (announce) => {
    for (const msg of await bus.history('chat', keep)) insert(msg, announce);
  };

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
    // Subscribe first, then load what other servers already hold: nothing can slip between
    // the two. After a dropped connection the history is read again and anything missed
    // is delivered as if it had just arrived.
    async start() {
      await bus.on('chat', (msg) => insert(msg, true));
      await hydrate(false);
      bus.onReconnect(() => hydrate(true));
    },
    list: (room) => (rooms.get(String(room)) || []).slice(),
    counts: () => Object.fromEntries([...rooms].map(([k, v]) => [k, v.length])),
    on: (fn) => events.on('msg', fn),
    off: (fn) => events.off('msg', fn)
  };
}
