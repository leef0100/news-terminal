// Market indicators and the confluence read built on them. Pure functions: numbers in,
// numbers out, no page or network access, so they can be tested on their own.
//
// A candle is { time (seconds), open, high, low, close, volume }.
window.Indicators = (function () {
  'use strict';

  function last(arr) { return arr.length ? arr[arr.length - 1] : null; }
  function finite(n) { return typeof n === 'number' && isFinite(n); }

  // Exponential moving average, seeded with the simple average of the first `period`
  // values. Entries before that are null.
  function ema(values, period) {
    var out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    var k = 2 / (period + 1), sum = 0;
    for (var i = 0; i < period; i++) sum += values[i];
    var prev = sum / period;
    out[period - 1] = prev;
    for (var j = period; j < values.length; j++) {
      prev = values[j] * k + prev * (1 - k);
      out[j] = prev;
    }
    return out;
  }

  // Relative strength index, Wilder's smoothing. 0 to 100.
  function rsi(closes, period) {
    period = period || 14;
    var out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;
    var gain = 0, loss = 0;
    for (var i = 1; i <= period; i++) {
      var d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    gain /= period; loss /= period;
    out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    for (var j = period + 1; j < closes.length; j++) {
      var ch = closes[j] - closes[j - 1];
      gain = (gain * (period - 1) + (ch > 0 ? ch : 0)) / period;
      loss = (loss * (period - 1) + (ch < 0 ? -ch : 0)) / period;
      out[j] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
    }
    return out;
  }

  // Average true range: how far price typically moves in one candle.
  function atr(candles, period) {
    period = period || 14;
    var out = new Array(candles.length).fill(null);
    if (candles.length <= period) return out;
    var trs = [];
    for (var i = 1; i < candles.length; i++) {
      var c = candles[i], p = candles[i - 1].close;
      trs.push(Math.max(c.high - c.low, Math.abs(c.high - p), Math.abs(c.low - p)));
    }
    var sum = 0;
    for (var a = 0; a < period; a++) sum += trs[a];
    var prev = sum / period;
    out[period] = prev;
    for (var j = period; j < trs.length; j++) {
      prev = (prev * (period - 1) + trs[j]) / period;
      out[j + 1] = prev;
    }
    return out;
  }

  // Where the average-price line restarts: each UTC day for short candles, each week for
  // 4-hour candles, each month for daily candles.
  function anchorOf(interval) {
    if (interval === '1d') return function (t) { var d = new Date(t * 1000); return d.getUTCFullYear() * 12 + d.getUTCMonth(); };
    if (interval === '4h') return function (t) { return Math.floor((t / 86400 + 3) / 7); }; // weeks starting Monday
    return function (t) { return Math.floor(t / 86400); };
  }
  function anchorName(interval) { return interval === '1d' ? 'month' : interval === '4h' ? 'week' : 'day'; }

  // Volume-weighted average price since the anchor: the average price actually paid.
  function vwap(candles, interval) {
    var key = anchorOf(interval), out = [], pv = 0, v = 0, cur = null;
    candles.forEach(function (c) {
      var k = key(c.time);
      if (k !== cur) { cur = k; pv = 0; v = 0; }
      pv += ((c.high + c.low + c.close) / 3) * c.volume;
      v += c.volume;
      out.push(v > 0 ? pv / v : null);
    });
    return out;
  }

  // Classic floor pivots from the previous day's high, low and close.
  function pivots(day) {
    if (!day) return null;
    var p = (day.high + day.low + day.close) / 3, range = day.high - day.low;
    return { P: p, R1: 2 * p - day.low, S1: 2 * p - day.high, R2: p + range, S2: p - range };
  }

  // Turning points: a high (or low) with `n` lower highs (higher lows) on each side.
  function swings(candles, n) {
    n = n || 3;
    var out = [];
    for (var i = n; i < candles.length - n; i++) {
      var hi = true, lo = true;
      for (var k = 1; k <= n; k++) {
        if (candles[i].high <= candles[i - k].high || candles[i].high < candles[i + k].high) hi = false;
        if (candles[i].low >= candles[i - k].low || candles[i].low > candles[i + k].low) lo = false;
      }
      if (hi) out.push({ price: candles[i].high, time: candles[i].time, kind: 'high' });
      if (lo) out.push({ price: candles[i].low, time: candles[i].time, kind: 'low' });
    }
    return out;
  }

  // Turning points that sit within `tolPct` percent of each other are one level; the more
  // times price turned there, the stronger the level.
  function clusterLevels(points, tolPct) {
    var sorted = points.slice().sort(function (a, b) { return a.price - b.price; });
    var groups = [];
    sorted.forEach(function (p) {
      var g = last(groups);
      if (g && (p.price - g.mean) / g.mean * 100 <= tolPct) {
        g.sum += p.price; g.touches += 1; g.mean = g.sum / g.touches;
        g.lastTime = Math.max(g.lastTime, p.time);
      } else groups.push({ sum: p.price, mean: p.price, touches: 1, lastTime: p.time });
    });
    return groups.map(function (g) { return { price: g.mean, touches: g.touches, lastTime: g.lastTime }; });
  }

  // Volume by price: how much traded at each price. Each candle's volume is spread evenly
  // across its high-low range, which is an approximation (the true split is not published).
  //   poc       the price with the most volume
  //   vah, val  top and bottom of the band holding 70% of the volume around it
  function volumeProfile(candles, binCount) {
    binCount = binCount || 48;
    if (!candles.length) return null;
    var lo = Infinity, hi = -Infinity;
    candles.forEach(function (c) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; });
    if (!(hi > lo)) return null;
    var step = (hi - lo) / binCount, bins = [];
    for (var i = 0; i < binCount; i++) bins.push({ lo: lo + i * step, hi: lo + (i + 1) * step, mid: lo + (i + 0.5) * step, vol: 0 });
    candles.forEach(function (c) {
      var a = Math.max(0, Math.min(binCount - 1, Math.floor((c.low - lo) / step)));
      var b = Math.max(0, Math.min(binCount - 1, Math.floor((c.high - lo) / step)));
      var share = c.volume / (b - a + 1);
      for (var k = a; k <= b; k++) bins[k].vol += share;
    });
    var total = 0, pocI = 0;
    bins.forEach(function (bn, idx) { total += bn.vol; if (bn.vol > bins[pocI].vol) pocI = idx; });
    var up = pocI, down = pocI, acc = bins[pocI].vol;
    while (acc < total * 0.7 && (down > 0 || up < binCount - 1)) {
      var nextUp = up < binCount - 1 ? bins[up + 1].vol : -1;
      var nextDown = down > 0 ? bins[down - 1].vol : -1;
      if (nextUp >= nextDown) { up += 1; acc += bins[up].vol; } else { down -= 1; acc += bins[down].vol; }
    }
    return { bins: bins, max: bins[pocI].vol, total: total, poc: bins[pocI].mid, vah: bins[up].hi, val: bins[down].lo, step: step };
  }

  // Unusually large resting orders in the book ("walls"): levels at least 2.5 times the
  // typical level on their side. `depth` is { bids: [{px, sz}], asks: [...] }.
  function walls(depth) {
    var out = [];
    ['bids', 'asks'].forEach(function (side) {
      var levels = (depth && depth[side]) || [];
      if (levels.length < 5) return;
      var sizes = levels.map(function (l) { return l.sz; }).sort(function (a, b) { return a - b; });
      var median = sizes[Math.floor(sizes.length / 2)];
      levels.forEach(function (l) {
        if (median > 0 && l.sz >= median * 2.5) out.push({ px: l.px, sz: l.sz, usd: l.px * l.sz, side: side === 'bids' ? 'bid' : 'ask', times: l.sz / median });
      });
    });
    return out.sort(function (a, b) { return b.usd - a.usd; });
  }

  // A MODEL, not data. Nobody publishes where traders' liquidation prices are. This
  // assumes positions were opened where volume traded, at a few common leverage levels,
  // and marks where those positions would be closed out: longs below, shorts above.
  // It shows where forced selling or buying could cluster IF that assumption holds.
  var LEVERAGES = [{ x: 100, w: 0.1 }, { x: 50, w: 0.2 }, { x: 25, w: 0.3 }, { x: 10, w: 0.4 }];
  function liquidationModel(profile, price, binCount) {
    if (!profile || !finite(price)) return null;
    binCount = binCount || 60;
    var lo = price * 0.85, hi = price * 1.15, step = (hi - lo) / binCount, bins = [];
    for (var i = 0; i < binCount; i++) bins.push({ lo: lo + i * step, hi: lo + (i + 1) * step, mid: lo + (i + 0.5) * step, long: 0, short: 0 });
    var put = function (p, field, w) {
      var idx = Math.floor((p - lo) / step);
      if (idx >= 0 && idx < binCount) bins[idx][field] += w;
    };
    profile.bins.forEach(function (b) {
      if (!b.vol) return;
      LEVERAGES.forEach(function (L) {
        var below = b.mid * (1 - 1 / L.x), above = b.mid * (1 + 1 / L.x);
        // Only levels price has not already traded through are still "live".
        if (below < price) put(below, 'long', b.vol * L.w);
        if (above > price) put(above, 'short', b.vol * L.w);
      });
    });
    var max = 0;
    bins.forEach(function (b) { max = Math.max(max, b.long, b.short); });
    return { bins: bins, max: max, step: step };
  }

  // One timeframe in a few numbers.
  function summarize(candles, interval) {
    if (!candles || candles.length < 30) return null;
    var closes = candles.map(function (c) { return c.close; });
    var e9 = last(ema(closes, 9)), e21 = last(ema(closes, 21)), e50 = last(ema(closes, 50)), e200 = last(ema(closes, 200));
    var vols = candles.slice(-21, -1).map(function (c) { return c.volume; });
    var avgVol = vols.length ? vols.reduce(function (a, b) { return a + b; }, 0) / vols.length : 0;
    // The candle still forming has only part of its volume, so the last finished one is compared.
    var lastDone = candles.length > 1 ? candles[candles.length - 2] : last(candles);
    var close = last(closes);
    var trend = 'flat';
    if (finite(e50)) {
      if (close > e50 && (!finite(e200) || e50 > e200)) trend = 'up';
      else if (close < e50 && (!finite(e200) || e50 < e200)) trend = 'down';
    }
    return {
      interval: interval, close: close, ema9: e9, ema21: e21, ema50: e50, ema200: e200,
      rsi: last(rsi(closes, 14)), atr: last(atr(candles, 14)), vwap: last(vwap(candles, interval)),
      volRatio: avgVol > 0 ? lastDone.volume / avgVol : null, trend: trend
    };
  }

  // The price levels worth knowing about, nearest first on each side of the current price.
  function keyLevels(input) {
    var price = input.price, out = [];
    var add = function (p, label, kind, note) { if (finite(p) && p > 0) out.push({ price: p, label: label, kind: kind, note: note || '' }); };
    var daily = input.daily || [];
    if (daily.length >= 2) {
      var prev = daily[daily.length - 2], today = daily[daily.length - 1];
      add(prev.high, 'Yesterday high', 'prior');
      add(prev.low, 'Yesterday low', 'prior');
      add(today.open, 'Today open', 'prior');
      var pv = pivots(prev);
      add(pv.P, 'Pivot', 'pivot'); add(pv.R1, 'R1', 'pivot'); add(pv.R2, 'R2', 'pivot'); add(pv.S1, 'S1', 'pivot'); add(pv.S2, 'S2', 'pivot');
    }
    if (input.profile) {
      add(input.profile.poc, 'Most-traded price', 'profile', 'Point of control');
      add(input.profile.vah, 'Value area high', 'profile');
      add(input.profile.val, 'Value area low', 'profile');
    }
    clusterLevels(swings(input.swingCandles || [], 3), 0.35)
      .filter(function (l) { return l.touches >= 2; })
      .forEach(function (l) { add(l.price, l.price > price ? 'Resistance' : 'Support', 'swing', l.touches + ' turns'); });
    (input.walls || []).slice(0, 4).forEach(function (w) { add(w.px, w.side === 'bid' ? 'Buy wall' : 'Sell wall', 'wall', Math.round(w.times * 10) / 10 + 'x typical size'); });
    out.forEach(function (l) { l.distPct = (l.price - price) / price * 100; l.side = l.price >= price ? 'above' : 'below'; });
    return out.sort(function (a, b) { return b.price - a.price; });
  }

  // Lines up the separate readings and says which way each one leans.
  //   lean: 'up' | 'down' | 'neutral' | 'caution'
  // A caution is a reason for care in either direction (a crowded trade, price at a level).
  // The result describes the indicators. It is not advice and predicts nothing.
  function confluence(input) {
    var f = [], tf = input.tf || {}, price = input.price;
    var add = function (id, label, lean, detail, why) { f.push({ id: id, label: label, lean: lean, detail: detail, why: why }); };
    var pct = function (a, b) { return ((a - b) / b * 100); };
    var fmt = function (n) { return (n > 0 ? '+' : '') + n.toFixed(2) + '%'; };

    ['1d', '4h', '1h'].forEach(function (iv) {
      var s = tf[iv];
      if (!s || !finite(s.ema50)) return;
      var name = { '1d': 'Daily', '4h': '4-hour', '1h': '1-hour' }[iv];
      add('trend-' + iv, name + ' trend', s.trend === 'up' ? 'up' : s.trend === 'down' ? 'down' : 'neutral',
        'Price is ' + fmt(pct(s.close, s.ema50)) + ' from its 50-period average' + (finite(s.ema200) ? ', which is ' + (s.ema50 > s.ema200 ? 'above' : 'below') + ' the 200' : ''),
        'Price above a rising average means buyers have been in control on this timeframe; below means sellers have.');
    });

    var h = tf['1h'];
    if (h && finite(h.ema9) && finite(h.ema21) && finite(h.ema50)) {
      var stackedUp = h.ema9 > h.ema21 && h.ema21 > h.ema50, stackedDown = h.ema9 < h.ema21 && h.ema21 < h.ema50;
      add('stack', 'Averages in order (1h)', stackedUp ? 'up' : stackedDown ? 'down' : 'neutral',
        stackedUp ? 'Fast above medium above slow (9 > 21 > 50)' : stackedDown ? 'Fast below medium below slow (9 < 21 < 50)' : 'The 9, 21 and 50 are tangled',
        'When the short, medium and long averages line up in order, the move is consistent across horizons. Tangled averages mean a range or a turn.');
    }
    if (h && finite(h.rsi)) {
      var r = h.rsi;
      add('rsi', 'Momentum (1h RSI)', r >= 70 || r <= 30 ? 'caution' : r > 55 ? 'up' : r < 45 ? 'down' : 'neutral',
        'RSI ' + r.toFixed(0) + (r >= 70 ? ': stretched to the upside' : r <= 30 ? ': stretched to the downside' : ''),
        'RSI measures how one-sided recent moves have been, from 0 to 100. Above 55 buyers lead, below 45 sellers lead. Above 70 or below 30 the move is stretched and often pauses.');
    }
    var m = tf['15m'] || h;
    if (m && finite(m.vwap)) {
      var d = pct(price, m.vwap);
      add('vwap', 'Versus today\'s average price (VWAP)', Math.abs(d) < 0.1 ? 'neutral' : d > 0 ? 'up' : 'down',
        'Price is ' + fmt(d) + ' from VWAP',
        'VWAP is the average price everyone has paid today, weighted by volume. Above it, today\'s buyers are in profit and tend to defend dips; below it, the reverse.');
    }
    if (h && finite(h.volRatio)) {
      add('volume', 'Volume (1h)', 'neutral',
        'Last finished hour traded ' + h.volRatio.toFixed(1) + 'x its 20-hour average' + (h.volRatio >= 1.5 ? ': heavy' : h.volRatio <= 0.6 ? ': thin' : ''),
        'Moves on heavy volume are more likely to be real. A breakout on thin volume fails more often. Volume says how much to trust a move, not which way it goes.');
    }
    if (finite(input.fundingAnnualPct)) {
      var fa = input.fundingAnnualPct;
      add('funding', 'Funding', Math.abs(fa) >= 30 ? 'caution' : 'neutral',
        (fa >= 0 ? 'Longs pay shorts ' : 'Shorts pay longs ') + Math.abs(fa).toFixed(1) + '% a year' + (Math.abs(fa) >= 30 ? ': crowded' : ''),
        'Funding is the fee one side pays the other to keep a perpetual position open. Very high funding means that side is crowded and paying up, which often comes before a shake-out against it.');
    }
    if (finite(input.longPct)) {
      var lp = input.longPct;
      add('crowd', 'Positioning', lp >= 65 || lp <= 35 ? 'caution' : 'neutral',
        Math.round(lp) + '% of accounts are long' + (lp >= 65 ? ': crowded long' : lp <= 35 ? ': crowded short' : ''),
        'When most accounts sit on one side, there are few left to join and many who could be forced out. It is a warning about the crowd, not a timing signal.');
    }
    var levels = input.levels || [];
    var above = levels.filter(function (l) { return l.side === 'above'; }).sort(function (a, b) { return a.price - b.price; })[0];
    var below = levels.filter(function (l) { return l.side === 'below'; }).sort(function (a, b) { return b.price - a.price; })[0];
    var atrPct = h && finite(h.atr) ? h.atr / price * 100 : 0.5;
    if (above && below) {
      var near = above.distPct <= atrPct / 2 ? above : -below.distPct <= atrPct / 2 ? below : null;
      add('location', 'Location', near ? 'caution' : 'neutral',
        near ? 'Price is at ' + near.label.toLowerCase() + ' (' + fmt(near.distPct) + ')' : 'Nearest level above ' + fmt(above.distPct) + ' (' + above.label.toLowerCase() + '), below ' + fmt(below.distPct) + ' (' + below.label.toLowerCase() + ')',
        'Price tends to react at levels where it turned or traded heavily before. Buying straight into a level overhead, or selling into one underneath, has less room to work.');
    }

    var up = 0, down = 0, caution = 0, read = 0;
    f.forEach(function (x) {
      if (x.lean === 'up') up += 1; else if (x.lean === 'down') down += 1; else if (x.lean === 'caution') caution += 1;
      if (x.lean === 'up' || x.lean === 'down') read += 1;
    });
    var verdict = 'mixed', text = 'The readings disagree';
    if (f.length < 3) { verdict = 'unknown'; text = 'Not enough data yet'; }
    else if (up >= 3 && up >= down * 2) { verdict = 'up'; text = 'Most readings lean up'; }
    else if (down >= 3 && down >= up * 2) { verdict = 'down'; text = 'Most readings lean down'; }
    return { factors: f, up: up, down: down, caution: caution, directional: read, verdict: verdict, text: text };
  }

  // How big a position can be for a chosen risk, and roughly where it would be liquidated.
  // The liquidation price is an estimate: it ignores fees, funding and the exchange's
  // exact maintenance rules (0.5% maintenance margin is assumed here).
  function positionSize(a) {
    var account = Number(a.account), riskPct = Number(a.riskPct), entry = Number(a.entry), stop = Number(a.stop), lev = Number(a.leverage) || 1;
    if (!(account > 0) || !(riskPct > 0) || !(entry > 0) || !(stop > 0) || entry === stop) return null;
    var long = stop < entry, perUnit = Math.abs(entry - stop), riskUsd = account * riskPct / 100;
    var qty = riskUsd / perUnit, notional = qty * entry, margin = notional / lev;
    var mm = 0.005;
    var liq = long ? entry * (1 - 1 / lev + mm) : entry * (1 + 1 / lev - mm);
    // With no borrowing a long has nothing to be liquidated on; the formula's
    // small leftover is an artefact of the maintenance margin, not a real price.
    if (long && (lev <= 1 || liq <= 0)) liq = null;
    var stopBeyondLiq = liq != null && (long ? stop <= liq : stop >= liq);
    return {
      side: long ? 'long' : 'short', riskUsd: riskUsd, qty: qty, notional: notional, margin: margin,
      marginPctOfAccount: margin / account * 100, stopPct: perUnit / entry * 100, liq: liq, stopBeyondLiq: stopBeyondLiq,
      tooBig: margin > account,
      targets: [1, 2, 3].map(function (r) { return { r: r, price: long ? entry + perUnit * r : entry - perUnit * r, gain: riskUsd * r }; })
    };
  }

  return {
    ema: ema, rsi: rsi, atr: atr, vwap: vwap, anchorName: anchorName, pivots: pivots, swings: swings, clusterLevels: clusterLevels,
    volumeProfile: volumeProfile, walls: walls, liquidationModel: liquidationModel, summarize: summarize,
    keyLevels: keyLevels, confluence: confluence, positionSize: positionSize
  };
})();
