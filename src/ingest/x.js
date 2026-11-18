// Slot for X (Twitter) accounts. Not wired in v1.
//
// To add it: open a streaming connection to whichever X data provider you choose, and for
// every post from a tracked account call
//
//   store.add(enrich({ id, text, url, ts, seenAt: Date.now() }, { id: 'x-' + handle, name: '@' + handle, kind: 'x' }))
//
// Everything downstream (cashtags, token matching, copycat flags, alerts, the UI filter)
// already understands kind "x". Use a stream, not polling: polling is too slow to trade on.

export function createXAdapter() {
  return {
    configured: false,
    start() {},
    stop() {}
  };
}
