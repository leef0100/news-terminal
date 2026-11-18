// In-memory feed: newest first, de-duplicated by id, capped in size.
// It also groups the same story reported by different outlets under one storyId.
import { EventEmitter } from 'node:events';

const STORY_WINDOW_MS = 6 * 3600000;
const FILLER = new Set(
  'the a an and or but for nor with from into over after before its his her their this that these those new says said will has have had are was were not now more most than then amid sample headline post report reports why how what when where who as at by in of on to is be'.split(' ')
);
// Words that say which way something went. Two headlines that disagree here are
// different stories, however alike they otherwise read ("inflows" vs "outflows").
const UP = new Set('rise rises rose rising jump jumps jumped surge surges surged soar soars soared gain gains gained climb climbs climbed rally rallies rallied up higher inflow inflows beat beats approve approves approved list lists listing win wins won buy buys bought long hike hikes raise raises raised'.split(' '));
const DOWN = new Set('fall falls fell falling drop drops dropped plunge plunges plunged sink sinks sank slump slumps slide slides slid tumble tumbles tumbled loss losses lose loses lost down lower outflow outflows miss misses missed reject rejects rejected delist delists delisting sell sells sold short cut cuts'.split(' '));

// Rough word stem so "sues" and "sued", "securities" and "security" compare equal.
const stem = (w) => (w.length > 3 ? w.replace(/ies$/, 'y').replace(/(ing|ed|s)$/, '').replace(/e$/, '') : w);

// What a headline is about, reduced to the parts worth comparing:
//   words     its meaningful words, stemmed
//   names     the things that tell one story from another: proper nouns, tickers, numbers
//   direction +1 up, -1 down, 0 neither or both
export function storyKey(text) {
  const raw = String(text).replace(/[“”"'’‘(),:;!?]/g, ' ').split(/\s+/).filter(Boolean);
  // In a Title Case Headline every word is capitalised, so capitals say nothing about
  // which words are names; there, only tickers, numbers and all-capital words count.
  const lettered = raw.filter((t) => /^\p{L}/u.test(t));
  const titleCase = lettered.length >= 4 && lettered.filter((t) => /^\p{Lu}/u.test(t)).length / lettered.length > 0.75;
  const words = new Set();
  const names = new Set();
  let up = false;
  let down = false;
  raw.forEach((token) => {
    const bare = token.replace(/^[^\p{L}\p{N}$]+|[^\p{L}\p{N}%]+$/gu, '');
    if (!bare) return;
    const low = bare.toLowerCase();
    if (FILLER.has(low)) return;
    if (UP.has(low)) up = true;
    if (DOWN.has(low)) down = true;
    const allCaps = /^\p{Lu}[\p{Lu}\p{N}&.]+$/u.test(bare);
    if (/\d/.test(bare) || bare.startsWith('$') || allCaps) names.add(low.replace(/^\$/, ''));
    // The opening word counts too: it is usually the subject ("Apple beats…"), and when
    // it is an ordinary word ("Stocks slide…") the other headline will contain it anyway.
    else if (!titleCase && /^\p{Lu}/u.test(bare)) names.add(low);
    if (low.length >= 2) words.add(stem(low.replace(/^\$/, '')));
  });
  return { words, names, direction: up === down ? 0 : up ? 1 : -1 };
}

export function similarity(a, b) {
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const w of a) if (b.has(w)) shared += 1;
  return shared / (a.size + b.size - shared);
}

// 0 when two headlines are different stories, otherwise how alike they are (up to 1).
export function sameStory(a, b) {
  if (a.direction && b.direction && a.direction !== b.direction) return 0;
  // Every name in the shorter list must appear in the other headline: "Apple beats" is
  // not "Amazon beats", and "to list PEPE" is not "to list WIF". A name may appear on the
  // other side as an ordinary word (its first word, or inside a Title Case Headline).
  const [few, many, manyWords] = a.names.size <= b.names.size ? [a.names, b.names, b.words] : [b.names, a.names, a.words];
  for (const n of few) if (!many.has(n) && !manyWords.has(stem(n))) return 0;
  const score = similarity(a.words, b.words);
  // The same names (two or more) is strong evidence on its own, so reworded reports of
  // one event still meet; otherwise the wording has to be close too.
  // With no names to go on (a Title Case Headline), only near-identical wording counts.
  const need = few.size >= 2 ? 0.3 : few.size === 1 ? 0.55 : 0.8;
  return score >= need ? score : 0;
}

export function createStore({ max = 500 } = {}) {
  const byId = new Map();
  const keys = new Map();
  let items = [];
  let version = 0;
  const events = new EventEmitter();
  events.setMaxListeners(0);
  const publisher = (it) => it.publisher || it.sourceId;

  function findStory(item, mine) {
    let best = null;
    let bestScore = 0;
    for (const other of items) {
      if (publisher(other) === publisher(item)) continue;
      if (Math.abs(other.ts - item.ts) > STORY_WINDOW_MS) continue;
      const score = sameStory(mine, keys.get(other.id));
      if (score > bestScore) {
        best = other;
        bestScore = score;
      }
    }
    return best ? best.storyId || best.id : null;
  }

  function add(item) {
    if (!item || !item.id || byId.has(item.id)) return false;
    // Older than everything in a full feed: it would be dropped straight away.
    if (items.length >= max && item.ts <= items[items.length - 1].ts) return false;
    // One outlet carrying the same headline in two of its sections is one item.
    const text = String(item.text).trim().toLowerCase();
    for (const other of items) {
      if (publisher(other) === publisher(item) && other.sourceId !== item.sourceId && Math.abs(other.ts - item.ts) <= STORY_WINDOW_MS && String(other.text).trim().toLowerCase() === text) return false;
    }
    const mine = storyKey(item.text);
    // An item that arrives from another server already carries its story.
    if (!item.storyId) item.storyId = findStory(item, mine) || item.id;
    byId.set(item.id, item);
    keys.set(item.id, mine);
    items.push(item);
    items.sort((a, b) => b.ts - a.ts);
    if (items.length > max) {
      for (const old of items.slice(max)) {
        byId.delete(old.id);
        keys.delete(old.id);
      }
      items = items.slice(0, max);
    }
    version += 1;
    events.emit('item', item);
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
