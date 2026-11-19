// Paper trading arithmetic, checked by hand.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const ctx = { window: {} };
vm.runInNewContext(readFileSync(new URL('../public/paper.js', import.meta.url), 'utf8'), ctx);
const E = ctx.window.Paper.engine;
const near = (a, b, tol = 1e-6) => assert.ok(Math.abs(a - b) <= tol, `${a} is not within ${tol} of ${b}`);

test('paper: a long gains when the index rises, a short when it falls, and fees are charged both ways', () => {
  let a = E.fresh(0);
  assert.equal(a.cash, 100000);
  a = E.open(a, { market: 'gpu', name: 'GPU', side: 'long', margin: 1000, leverage: 2, price: 100, now: 1 }).account;
  near(a.cash, 100000 - 1000 - 1);                    // 0.05% of a $2,000 position
  near(a.positions[0].qty, 20);
  near(E.pnlOf(a.positions[0], 110), 200);            // +10% on $2,000
  near(E.summary(a, { gpu: 110 }).equity, 100000 - 1 + 200);
  a = E.close(a, 'gpu', 110, 2).account;
  near(a.cash, 100000 - 1 + 200 - 1.1);               // closing fee on $2,200
  near(a.history[0].pnl, 200 - 1.1);
  a = E.open(a, { market: 'energy', name: 'Energy', side: 'short', margin: 500, leverage: 4, price: 50, now: 3 }).account;
  near(E.pnlOf(a.positions[0], 45), 200);             // short $2,000, index down 10%
  near(E.pnlOf(a.positions[0], 55), -200);
});

test('paper: positions are closed out at the stated level and never lose more than was put up', () => {
  let a = E.open(E.fresh(0), { market: 'gpu', name: 'GPU', side: 'long', margin: 1000, leverage: 5, price: 100, now: 1 }).account;
  const liq = E.liqPrice(a.positions[0]);
  near(liq, 82);                                      // 90% of the margin is an 18% move at 5x
  assert.equal(E.mark(a, { gpu: 83 }, 2).closed.length, 0);
  const out = E.mark(a, { gpu: 60 }, 2);              // a gap far past the level
  assert.deepEqual(Array.from(out.closed), ['GPU']);
  assert.equal(out.account.positions.length, 0);
  const lost = 100000 - out.account.cash;
  assert.ok(lost > 900 && lost <= 1000 + 5, 'the loss is about the money put up, not more: ' + lost);
  const short = E.open(E.fresh(0), { market: 'x', side: 'short', margin: 100, leverage: 10, price: 10, now: 1 }).account;
  near(E.liqPrice(short.positions[0]), 10.9);
  assert.equal(E.mark(short, {}, 2).closed.length, 0, 'an index with no value closes nothing');
});

test('paper: bad orders are refused with a reason, and adding to a position averages the entry', () => {
  const a = E.fresh(0);
  for (const o of [{ margin: 0 }, { margin: -5 }, { leverage: 0.5 }, { leverage: 11 }, { price: 0 }, { side: 'sideways' }, { margin: 100001 }]) {
    assert.ok(E.open(a, { market: 'm', side: 'long', margin: 100, leverage: 2, price: 10, now: 1, ...o }).error, JSON.stringify(o));
  }
  let b = E.open(a, { market: 'm', side: 'long', margin: 100, leverage: 2, price: 10, now: 1 }).account;
  assert.ok(E.open(b, { market: 'm', side: 'short', margin: 100, leverage: 2, price: 10, now: 2 }).error, 'no opposite side on the same index');
  b = E.open(b, { market: 'm', side: 'long', margin: 100, leverage: 2, price: 20, now: 2 }).account;
  near(b.positions[0].qty, 30);                       // 20 units at 10, then 10 units at 20
  near(b.positions[0].entry, 400 / 30);
  near(b.positions[0].margin, 200);
  assert.equal(a.positions.length, 0, 'the account passed in is not changed');
  assert.ok(E.close(b, 'nope', 10, 3).error);
  assert.equal(E.valid({ cash: 1, positions: [{ market: 'm', side: 'up', qty: 1, entry: 1, margin: 1, leverage: 1 }], history: [] }), false);
  assert.equal(E.valid(b), true);
});
