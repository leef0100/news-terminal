// The reading list in config/voices.json, checked before anything is done with it.
//
// This file is the only place a feed address can come from. Nothing a visitor sends is
// ever fetched, so the list is checked once, strictly, when the server starts: a mistake
// in it stops the server with a sentence saying which entry is wrong.
import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';

export const HANDLE_RE = /^[A-Za-z0-9_]{1,15}$/;
export const ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// An https address on a public host name: no credentials, no port, no IP literal, no
// single-label or internal name. Returns the parsed URL, or null.
export function publicHttps(value) {
  if (typeof value !== 'string' || value.length > 300 || /[\s<>"'`\\]/.test(value)) return null;
  let u;
  try { u = new URL(value); } catch { return null; }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return null;
  const host = u.hostname.toLowerCase();
  if (isIP(host) || host.startsWith('[') || !host.includes('.')) return null;
  if (/(^|\.)(localhost|local|internal|lan|home|corp|test|invalid|example)$/.test(host)) return null;
  return u;
}

const text = (v, max) => typeof v === 'string' && v.trim().length > 0 && v.length <= max;

export function validateConfig(raw) {
  const fail = (m) => { throw new Error('config/voices.json: ' + m); };
  if (!raw || typeof raw !== 'object') fail('not an object');
  const pollMinutes = raw.pollMinutes === undefined ? 15 : Number(raw.pollMinutes);
  // Fifteen minutes is the floor whatever the file says.
  if (!Number.isFinite(pollMinutes) || pollMinutes < 15 || pollMinutes > 1440) fail('pollMinutes must be between 15 and 1440');

  if (!Array.isArray(raw.groups) || !raw.groups.length || raw.groups.length > 12) fail('groups must list 1 to 12 groups');
  const groups = raw.groups.map((g) => {
    if (!g || !ID_RE.test(g.id) || !text(g.name, 60)) fail('every group needs an id and a name');
    return { id: g.id, name: g.name.trim() };
  });
  if (new Set(groups.map((g) => g.id)).size !== groups.length) fail('group ids repeat');

  if (!Array.isArray(raw.voices) || raw.voices.length > 80) fail('voices must be a list of at most 80');
  const seen = { id: new Set(), x: new Set(), feed: new Set(), site: new Set(), who: new Set() };
  const once = (kind, key, id) => { if (seen[kind].has(key)) fail(`${id}: ${kind} repeats another entry`); seen[kind].add(key); };
  const voices = raw.voices.map((v, i) => {
    const id = v && v.id;
    if (!ID_RE.test(id || '')) fail(`entry ${i + 1} has no usable id`);
    once('id', id, id);
    if (!text(v.name, 80) || !text(v.publication, 80) || !text(v.covers, 120)) fail(`${id}: name, publication and covers are required`);
    if (!groups.some((g) => g.id === v.group)) fail(`${id}: unknown group`);
    if (!text(v.verified, 800)) fail(`${id}: a note on how it was verified is required`);
    once('who', (v.name + '|' + v.publication).toLowerCase(), id);
    const site = publicHttps(v.site);
    if (!site) fail(`${id}: site must be an https address on a public host`);
    once('site', site.href.toLowerCase(), id);
    let x = null;
    if (v.x !== undefined && v.x !== null) {
      if (typeof v.x !== 'string' || !HANDLE_RE.test(v.x)) fail(`${id}: x must be a handle of up to 15 letters, numbers or underscores, without @`);
      x = v.x;
      once('x', x.toLowerCase(), id);
    }
    let feed = null;
    if (v.feed !== undefined && v.feed !== null) {
      const f = publicHttps(v.feed);
      if (!f) fail(`${id}: feed must be an https address on a public host`);
      feed = f.href;
      once('feed', feed.toLowerCase(), id);
    }
    return { id, name: v.name.trim(), publication: v.publication.trim(), group: v.group, covers: v.covers.trim(), x, feed, site: site.href, excerpt: v.excerpt !== false, verified: v.verified };
  });

  const suggested = (raw.suggested || []).map((id) => {
    const v = voices.find((x) => x.id === id);
    if (!v || !v.x) fail(`suggested: ${id} is not an entry with an X handle`);
    return id;
  });
  if (new Set(suggested).size !== suggested.length) fail('suggested repeats an entry');
  return { pollMinutes, groups, voices, suggested };
}

export function loadConfig(url = new URL('../../config/voices.json', import.meta.url)) {
  return validateConfig(JSON.parse(readFileSync(url, 'utf8')));
}
