// RSS / Atom reader. Keeps the headline, timestamp and link only: never the article body.
import { createHash } from 'node:crypto';
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text' });

const asArray = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);
const textOf = (v) => (v == null ? '' : typeof v === 'object' ? String(v['#text'] ?? '') : String(v));
const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
const decode = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] !== '#') return NAMED[e.toLowerCase()] ?? m;
    const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : m;
  });
// Decode first so encoded markup is removed too; the UI only ever sets this as plain text.
const stripTags = (s) => decode(s).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function linkOf(entry) {
  const link = entry.link;
  if (typeof link === 'string') return link.trim();
  const links = asArray(link);
  const alt = links.find((l) => l && l['@_rel'] === 'alternate') || links[0];
  if (alt) return String(alt['@_href'] || alt['#text'] || '').trim();
  return '';
}

export function parseFeed(xml, sourceId) {
  const doc = parser.parse(xml);
  const entries = doc?.rss?.channel?.item ?? doc?.feed?.entry ?? doc?.['rdf:RDF']?.item ?? [];
  const out = [];
  for (const e of asArray(entries)) {
    const title = stripTags(textOf(e.title));
    if (!title) continue;
    const url = linkOf(e);
    const when = Date.parse(textOf(e.pubDate || e.published || e.updated || e['dc:date']));
    const key = textOf(e.guid || e.id) || url || title;
    out.push({
      id: createHash('sha1').update(sourceId + '|' + key).digest('hex').slice(0, 16),
      text: title,
      url,
      ts: Number.isFinite(when) ? when : null
    });
  }
  return out;
}

export async function fetchFeed(source, { fetchImpl = fetch, timeoutMs = 8000, cache = {} } = {}) {
  const headers = { 'user-agent': 'halftone/0.1', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' };
  if (cache.etag) headers['if-none-match'] = cache.etag;
  if (cache.lastModified) headers['if-modified-since'] = cache.lastModified;
  const res = await fetchImpl(source.url, { headers, signal: AbortSignal.timeout(timeoutMs) });
  if (res.status === 304) return [];
  if (!res.ok) throw new Error('HTTP ' + res.status);
  cache.etag = res.headers.get('etag') || undefined;
  cache.lastModified = res.headers.get('last-modified') || undefined;
  return parseFeed(await res.text(), source.id);
}
