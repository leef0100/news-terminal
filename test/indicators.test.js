// The indicator maths, checked against values worked out by hand or from published examples.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const ctx = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/indicators.js', import.meta.url), 'utf8'), ctx);
const I = ctx.window.Indicators;
const near = (a, b, tol = 1e-9) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);
// Values made inside the sandbox belong to another realm, so compare them by content.
const plain = (v) => JSON.parse(JSON.stringify(v));
const same = (a, b, m) => assert.deepEqual(plain(a), plain(b), m);
const candle = (time, open, high, low, close, volume = 1) => ({ time, open, high, low, close, volume });

test('EMA: seeded with the simple average, then weighted towards new values', () => {
  const out = I.ema([1, 2, 3, 4, 5, 6], 3);
  same(Array.from(out.slice(0, 2)), [null, null]);
  near(out[2], 2);       // average of 1, 2, 3
  near(out[3], 3);       // 4 * 0.5 + 2 * 0.5
  near(out[4], 4);
  near(out[5], 5);
  assert.ok(I.ema([1, 2], 3).every((v) => v === null), 'too little data gives no value');
});

test('RSI: matches the standard worked example, and the extremes', () => {
  // The fourteen-period example from Wilder's method as commonly published.
  const closes = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00, 46.03, 46.41, 46.22, 45.64];
  const out = I.rsi(closes, 14);
  near(out[14], 70.46, 0.1);
  near(out[15], 66.25, 0.1);
  near(out[19], 57.92, 0.15);
  assert.equal(I.rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14)[15], 100, 'only gains');
  near(I.rsi([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1], 14)[15], 0);
});

test('ATR: true range includes gaps from the previous close', () => {
  const list = [candle(0, 10, 11, 9, 10), candle(1, 14, 15, 13, 14), candle(2, 14, 15, 13, 14), candle(3, 14, 15, 13, 14)];
  // True ranges: max(2, |15-10|, |13-10|) = 5, then 2, then 2.
  near(I.atr(list, 2)[2], 3.5);
  near(I.atr(list, 2)[3], (3.5 * 1 + 2) / 2);
});

test('VWAP: volume-weighted, and restarts at the anchor', () => {
  const day = 86400;
  const list = [candle(10, 0, 12, 8, 10, 100), candle(20, 0, 22, 18, 20, 300), candle(day + 10, 0, 32, 28, 30, 50)];
  const out = I.vwap(list, '1h');
  near(out[0], 10);
  near(out[1], (10 * 100 + 20 * 300) / 400);
  near(out[2], 30, 1e-9);
  assert.equal(I.anchorName('1h'), 'day');
  assert.equal(I.anchorName('4h'), 'week');
  // 1970-01-05 was a Monday: the week rolls over there, not on the Thursday the epoch began.
  const w = I.vwap([candle(3 * day, 0, 10, 10, 10, 1), candle(4 * day - 1, 0, 20, 20, 20, 1), candle(4 * day, 0, 40, 40, 40, 1)], '4h');
  near(w[1], 15);
  near(w[2], 40);
});

test('pivots: the classic formulas', () => {
  const p = I.pivots({ high: 110, low: 90, close: 100 });
  same({ ...p }, { P: 100, R1: 110, S1: 90, R2: 120, S2: 80 });
});

test('swings and levels: turning points cluster into levels counted by touches', () => {
  const prices = [10, 11, 12, 13, 12, 11, 10, 11, 12, 13.02, 12, 11, 10.01, 11, 12];
  const list = prices.map((p, i) => candle(i, p, p + 0.1, p - 0.1, p));
  const sw = I.swings(list, 2);
  same(sw.filter((s) => s.kind === 'high').map((s) => s.time), [3, 9]);
  same(sw.filter((s) => s.kind === 'low').map((s) => s.time), [6, 12]);
  const levels = I.clusterLevels(sw, 0.5);
  assert.equal(levels.length, 2);
  assert.ok(levels.every((l) => l.touches === 2));
});

test('volume profile: finds the most-traded price and a value area holding 70% around it', () => {
  const list = [];
  for (let i = 0; i < 20; i++) list.push(candle(i, 100, 101, 99, 100, 100)); // heavy trading around 100
  list.push(candle(20, 100, 120, 100, 120, 20));                               // a thin run up to 120
  list.push(candle(21, 100, 100, 80, 80, 20));                                 // and down to 80
  const vp = I.volumeProfile(list, 40);
  assert.ok(vp.poc > 99 && vp.poc < 101, 'point of control is where the volume is: ' + vp.poc);
  assert.ok(vp.val <= vp.poc && vp.vah >= vp.poc);
  const inside = vp.bins.filter((b) => b.mid >= vp.val && b.mid <= vp.vah).reduce((a, b) => a + b.vol, 0);
  assert.ok(inside / vp.total >= 0.7, 'value area holds at least 70%');
  near(vp.bins.reduce((a, b) => a + b.vol, 0), 2040, 1e-6);
  assert.equal(I.volumeProfile([candle(0, 5, 5, 5, 5, 1)], 10), null, 'no range, no profile');
});

test('walls: only levels far larger than their neighbours', () => {
  const side = (base, dir) => Array.from({ length: 10 }, (_, i) => ({ px: base + dir * i, sz: i === 4 ? 50 : 10 }));
  const w = I.walls({ bids: side(100, -1), asks: side(101, 1) });
  same(w.map((x) => [x.side, x.px]).sort(), [['ask', 105], ['bid', 96]]);
  assert.equal(I.walls({ bids: [], asks: [] }).length, 0);
});

test('liquidation model: longs below price, shorts above, nothing on the wrong side', () => {
  const vp = I.volumeProfile([candle(0, 100, 101, 99, 100, 1000), candle(1, 100, 101, 99, 100, 1000)], 4);
  const m = I.liquidationModel(vp, 100, 60);
  assert.ok(m.bins.filter((b) => b.long > 0).every((b) => b.lo < 100));
  assert.ok(m.bins.filter((b) => b.short > 0).every((b) => b.hi > 100));
  // 10x from about 100 is liquidated about 10% away, 25x about 4% away.
  assert.ok(m.bins.some((b) => b.long > 0 && b.mid > 89 && b.mid < 91));
  assert.ok(m.bins.some((b) => b.short > 0 && b.mid > 103 && b.mid < 105));
});

test('position size: risk decides the size; leverage decides margin and liquidation', () => {
  const r = I.positionSize({ account: 1000, riskPct: 1, entry: 100, stop: 95, leverage: 10 });
  assert.equal(r.side, 'long');
  near(r.riskUsd, 10); near(r.qty, 2); near(r.notional, 200); near(r.margin, 20);
  near(r.liq, 90.5);
  assert.equal(r.stopBeyondLiq, false);
  same(r.targets.map((t) => t.price), [105, 110, 115]);
  const hot = I.positionSize({ account: 1000, riskPct: 1, entry: 100, stop: 95, leverage: 50 });
  near(hot.liq, 98.5);
  assert.equal(hot.stopBeyondLiq, true, 'liquidated before the stop');
  const short = I.positionSize({ account: 1000, riskPct: 2, entry: 100, stop: 104, leverage: 5 });
  assert.equal(short.side, 'short');
  near(short.qty, 5); near(short.liq, 119.5);
  same(short.targets.map((t) => t.price), [96, 92, 88]);
  assert.equal(I.positionSize({ account: 100, riskPct: 5, entry: 100, stop: 99.9, leverage: 1 }).tooBig, true);
  assert.equal(I.positionSize({ account: 1000, riskPct: 1, entry: 100, stop: 90, leverage: 1 }).liq, null);
  assert.equal(I.positionSize({ account: 1000, riskPct: 1, entry: 100, stop: 100, leverage: 5 }), null);
  assert.equal(I.positionSize({ account: '', riskPct: 1, entry: 100, stop: 90 }), null);
});

function trend(n, start, step) {
  const out = [];
  for (let i = 0; i < n; i++) { const c = start + step * i; out.push(candle(i * 3600, c - step, Math.max(c, c - step) + 0.2, Math.min(c, c - step) - 0.2, c, 100)); }
  return out;
}

test('summary and confluence: a steady climb reads up, a steady fall reads down, and neither is advice', () => {
  const up = trend(260, 100, 0.5), down = trend(260, 300, -0.5);
  const su = I.summarize(up, '1h'), sd = I.summarize(down, '1h');
  assert.equal(su.trend, 'up');
  assert.equal(sd.trend, 'down');
  assert.ok(su.ema9 > su.ema21 && su.ema21 > su.ema50 && su.ema50 > su.ema200);
  assert.ok(su.rsi > 70 && sd.rsi < 30);
  near(su.volRatio, 1);
  assert.equal(I.summarize(up.slice(0, 10), '1h'), null, 'too little history');

  const price = su.close;
  const cu = I.confluence({ tf: { '1d': su, '4h': su, '1h': su, '15m': su }, price, levels: [], fundingAnnualPct: 5, longPct: 52 });
  assert.equal(cu.verdict, 'up');
  assert.ok(cu.up >= 4 && cu.down === 0);
  assert.equal(cu.factors.find((f) => f.id === 'rsi').lean, 'caution', 'a stretched RSI is a caution, not a vote');
  const cd = I.confluence({ tf: { '1d': sd, '4h': sd, '1h': sd, '15m': sd }, price: sd.close, levels: [], fundingAnnualPct: -45, longPct: 71 });
  assert.equal(cd.verdict, 'down');
  assert.equal(cd.factors.find((f) => f.id === 'funding').lean, 'caution');
  assert.equal(cd.factors.find((f) => f.id === 'crowd').lean, 'caution');
  const mixed = I.confluence({ tf: { '1d': su, '4h': sd, '1h': sd, '15m': su }, price, levels: [] });
  assert.equal(mixed.verdict, 'mixed');
  assert.equal(I.confluence({ tf: {}, price: 1, levels: [] }).verdict, 'unknown');
  assert.ok(cu.factors.every((f) => f.why && f.detail && !/\b(buy|sell) now\b/i.test(f.detail + f.why)));
});

test('key levels: sorted, sided, and measured from price', () => {
  const daily = [candle(0, 95, 110, 90, 100), candle(86400, 100, 104, 99, 102)];
  const levels = I.keyLevels({ price: 102, daily, profile: { poc: 101, vah: 105, val: 97 }, swingCandles: [], walls: [{ px: 98, side: 'bid', times: 4.04 }] });
  const by = (label) => levels.find((l) => l.label === label);
  assert.equal(by('Yesterday high').price, 110);
  assert.equal(by('Yesterday high').side, 'above');
  near(by('Yesterday low').distPct, (90 - 102) / 102 * 100);
  assert.equal(by('Pivot').price, 100);
  assert.equal(by('Buy wall').note, '4x typical size');
  same(levels.map((l) => l.price), levels.map((l) => l.price).slice().sort((a, b) => b - a));
});
