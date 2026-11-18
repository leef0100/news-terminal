// In-memory feed: newest first, de-duplicated by id, capped in size.
// It also groups the same story reported by different sources under one storyId.
import { EventEmitter } from 'node:events';

const STORY_WINDOW_MS = 6 * 3600000;
const STORY_MATCH = 0.55;
const FILLER = new Set(
  'the a an and or but for nor with from into over after before its his her their this that these those new says said will has have had are was were not now more most than then amid sample headline post report reports'.split(' ')
);

// The words that carry a headline's meaning, for comparing two headlines.
export function storyWords(text) {
  const out = new Set();
  for (const w of String(text).toLowerCase().replace(/[^a-z0-9$ ]+/g, ' ').split(/\s+/)) {
    if (w.length >= 3 && !FILLER.has(w)) out.add(w);
  }
  return out;
}

export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

export function createStore({ max = 500 } = {}) {
  const byId = new Map();
  const words = new Map();
  let items = [];
  let version = 0;
  const events = new EventEmitter();
  events.setMaxListeners(0);

  function findStory(item, mine) {
    for (const other of items) {
      if (other.sourceId === item.sourceId) continue;
      if (Math.abs(other.ts - item.ts) > STORY_WINDOW_MS) continue;
      if (similarity(mine, words.get(other.id) || new Set()) >= STORY_MATCH) return other.storyId || other.id;
    }
    return null;
  }

  function add(item) {
    if (!item || !item.id || byId.has(item.id)) return false;
    const mine = storyWords(item.text);
    // An item that arrives from another server already carries its story.
    if (!item.storyId) item.storyId = findStory(item, mine) || item.id;
    byId.set(item.id, item);
    words.set(item.id, mine);
    items.push(item);
    items.sort((a, b) => b.ts - a.ts);
    if (items.length > max) {
      for (const old of items.slice(max)) {
        byId.delete(old.id);
        words.delete(old.id);
      }
      items = items.slice(0, max);
    }
    version += 1;
    if (byId.has(item.id)) events.emit('item', item);
    return true;
  }

  return {
    add,
    get: (id) => byId.get(id) || null,
    list: (limit = 100) => items.slice(0, limit),
    size: () => items.length,
    // Goes up on every change, so callers can tell whether a cached answer is still current.
    version: () => version,
    on: (fn) => events.on('item', fn),
    off: (fn) => events.off('item', fn)
  };
}
