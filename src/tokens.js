// Token matching against DexScreener's public search API (no key needed).
// The point of this module: when a post names a ticker, show every Solana token that
// matches, real one first, and flag the copycats minted after the post went out.

const SEARCH = 'https://api.dexscreener.com/latest/dex/search?q=';
const LOW_LIQUIDITY_USD = 10000;

export function rankPairs(pairs, term, postTs, nowTs) {
  const t = String(term).toLowerCase();
  const byToken = new Map();
  for (const p of pairs || []) {
    if (!p || p.chainId !== 'solana' || !p.baseToken?.address) continue;
    const symbol = String(p.baseToken.symbol || '');
    const name = String(p.baseToken.name || '');
    const hit = symbol.toLowerCase() === t || name.toLowerCase() === t || (t.length >= 3 && name.toLowerCase().includes(t));
    if (!hit) continue;
    const liquidityUsd = Number(p.liquidity?.usd) || 0;
    const prev = byToken.get(p.baseToken.address);
    const createdAt = Number(p.pairCreatedAt) || null;
    if (prev) {
      // Same token, several pools: keep the deepest pool, but the earliest creation time.
      if (createdAt && (!prev.createdAt || createdAt < prev.createdAt)) prev.createdAt = createdAt;
      if (liquidityUsd <= prev.liquidityUsd) continue;
      prev.liquidityUsd = liquidityUsd;
      prev.pairUrl = p.url || prev.pairUrl;
      prev.dex = p.dexId || prev.dex;
      prev.marketCap = Number(p.marketCap ?? p.fdv) || prev.marketCap;
      prev.volume24h = Number(p.volume?.h24) || prev.volume24h;
      continue;
    }
    byToken.set(p.baseToken.address, {
      address: p.baseToken.address,
      symbol,
      name,
      term,
      dex: p.dexId || null,
      pairUrl: p.url || null,
      liquidityUsd,
      marketCap: Number(p.marketCap ?? p.fdv) || 0,
      volume24h: Number(p.volume?.h24) || 0,
      createdAt
    });
  }
  const out = [...byToken.values()].map((tok) => {
    const after = tok.createdAt != null && postTs != null && tok.createdAt > postTs;
    const isPumpFun = tok.address.endsWith('pump');
    return {
      ...tok,
      ageSec: tok.createdAt != null ? Math.max(0, Math.round((nowTs - tok.createdAt) / 1000)) : null,
      createdAfterPost: after,
      secondsAfterPost: after ? Math.round((tok.createdAt - postTs) / 1000) : null,
      lowLiquidity: tok.liquidityUsd < LOW_LIQUIDITY_USD,
      isPumpFun,
      buyUrl: isPumpFun ? 'https://pump.fun/coin/' + tok.address : tok.pairUrl
    };
  });
  // Tokens that existed before the post come first; within each group, deepest liquidity first.
  out.sort((a, b) => Number(a.createdAfterPost) - Number(b.createdAfterPost) || b.liquidityUsd - a.liquidityUsd);
  return out;
}

export function createTokenMatcher({ fetchImpl = fetch, ttlMs = 20000, now = Date.now, timeoutMs = 6000 } = {}) {
  const cache = new Map();

  async function search(term) {
    const key = term.toLowerCase();
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return hit.pairs;
    const res = await fetchImpl(SEARCH + encodeURIComponent(term), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) throw new Error('Token search failed: HTTP ' + res.status);
    const body = await res.json();
    const pairs = Array.isArray(body?.pairs) ? body.pairs : [];
    cache.set(key, { at: now(), pairs });
    if (cache.size > 500) cache.delete(cache.keys().next().value);
    return pairs;
  }

  async function match(terms, postTs, limit = 8) {
    const unique = [...new Set(terms.map((t) => String(t).trim()).filter(Boolean))].slice(0, 4);
    const seen = new Set();
    const all = [];
    const errors = [];
    const results = await Promise.allSettled(unique.map((t) => search(t)));
    results.forEach((r, i) => {
      if (r.status === 'rejected') return errors.push(String(r.reason?.message || r.reason));
      for (const tok of rankPairs(r.value, unique[i], postTs, now())) {
        if (seen.has(tok.address)) continue;
        seen.add(tok.address);
        all.push(tok);
      }
    });
    all.sort((a, b) => Number(a.createdAfterPost) - Number(b.createdAfterPost) || b.liquidityUsd - a.liquidityUsd);
    return { tokens: all.slice(0, limit), terms: unique, error: errors.length && !all.length ? errors[0] : null };
  }

  return { match };
}
