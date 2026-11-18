// Demo mode (`npm run demo`): invented items and invented tokens, so the terminal can be
// tried without any outside connection. Nothing here is real news or a real token.
import { enrich } from '../enrich.js';

const SOURCES = {
  x1: { id: 'x-trader-one', name: '@trader_one', kind: 'x' },
  x2: { id: 'x-macro-figure', name: '@macro_figure', kind: 'x' },
  wire: { id: 'demo-wire', name: 'Demo Newswire', kind: 'wire', crypto: true }
};

const SCRIPT = [
  ['x1', 'Sample post: thinking about otters again. $OTTER'],
  ['wire', 'Sample headline: Central bank holds interest rates, signals cuts next quarter'],
  ['wire', 'Sample headline: Major exchange to list $ROCKET spot pairs at 12:00 UTC'],
  ['x2', 'Sample post: rotating into AI agent names this week, watching $BYTE'],
  ['wire', 'Sample headline: Regulator opens comment period on stablecoin rules'],
  ['x1', 'Sample post: Walrus season? $WALRUS chart looks ready'],
  ['wire', 'Sample headline: Inflation print due in 30 minutes, desks expect a quiet open']
];

export function startDemo(store, { everyMs = 7000, now = Date.now } = {}) {
  let n = 0;
  const push = (backfill, ageMs = 0) => {
    const [src, text] = SCRIPT[n % SCRIPT.length];
    const ts = now() - ageMs;
    store.add(enrich({ id: 'demo-' + n, text, url: null, ts, seenAt: ts + 200 + ((n * 137) % 400), backfill }, SOURCES[src]));
    n += 1;
  };
  for (let i = SCRIPT.length - 1; i >= 0; i--) push(true, (i + 1) * 45000);
  const timer = setInterval(() => push(false), everyMs);
  return () => clearInterval(timer);
}

const ADDR = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
function fakeAddress(seed) {
  let h = 2166136261;
  for (const ch of seed) h = Math.imul(h ^ ch.charCodeAt(0), 16777619) >>> 0;
  let out = '';
  for (let i = 0; i < 40; i++) {
    h = Math.imul(h ^ (seed.charCodeAt(i % seed.length) + i), 16777619) >>> 0;
    out += ADDR[h % ADDR.length];
  }
  return out + 'pump';
}

// Stands in for DexScreener: one established token per term plus two fresh copycats.
export function demoFetch(now = Date.now) {
  return async (url) => {
    const term = decodeURIComponent(String(url).split('q=')[1] || '').toUpperCase();
    const t = now();
    const pair = (suffix, name, createdAt, liq, mcap) => ({
      chainId: 'solana',
      dexId: 'pumpfun',
      url: 'https://dexscreener.com/solana/' + fakeAddress(term + suffix),
      baseToken: { address: fakeAddress(term + suffix), symbol: term, name },
      liquidity: { usd: liq },
      marketCap: mcap,
      volume: { h24: Math.round(liq * 1.8) },
      pairCreatedAt: createdAt
    });
    const title = term.charAt(0) + term.slice(1).toLowerCase();
    const pairs = [
      pair('a', title, t - 41 * 86400000, 1200000, 9400000),
      pair('b', title + ' Again', t - 3000, 14000, 61000),
      pair('c', title + ' Inu', t - 1000, 3000, 9000)
    ];
    return { ok: true, status: 200, json: async () => ({ schemaVersion: '1.0.0', pairs }) };
  };
}
