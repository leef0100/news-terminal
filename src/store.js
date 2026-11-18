// In-memory feed: newest first, de-duplicated by id, capped in size.
import { EventEmitter } from 'node:events';

export function createStore({ max = 500 } = {}) {
  const byId = new Map();
  let items = [];
  const events = new EventEmitter();
  events.setMaxListeners(0);

  function add(item) {
    if (!item || !item.id || byId.has(item.id)) return false;
    byId.set(item.id, item);
    items.push(item);
    items.sort((a, b) => b.ts - a.ts);
    if (items.length > max) {
      for (const old of items.slice(max)) byId.delete(old.id);
      items = items.slice(0, max);
    }
    if (byId.has(item.id)) events.emit('item', item);
    return true;
  }

  return {
    add,
    get: (id) => byId.get(id) || null,
    list: (limit = 100) => items.slice(0, limit),
    size: () => items.length,
    on: (fn) => events.on('item', fn),
    off: (fn) => events.off('item', fn)
  };
}
