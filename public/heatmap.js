// Two heatmaps that read at a glance.
//
// Heatmaps.treemap: every market as a tile, sized by how much money is in it and coloured
// by how far it moved. Heatmaps.liquidation: price against time, with brightness showing
// where leveraged positions opened at past prices would be closed out. That second one is
// a model built from traded volume. Real position data is licensed; this is not it, and
// the page says so wherever it appears.
(function () {
  'use strict';
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // ---------- treemap ----------
  // Squarified layout (Bruls, Huizing, van Wijk): rows are filled along the shorter side and
  // closed when adding another tile would make the tiles less square.
  function squarify(items, x, y, w, h) {
    var out = [], total = 0;
    items.forEach(function (it) { total += it.size; });
    if (!(total > 0) || !(w > 0) || !(h > 0)) return out;
    var scale = w * h / total;
    var rest = items.map(function (it) { return { it: it, area: it.size * scale }; });
    var worst = function (row, side) {
      var sum = 0, mx = 0, mn = Infinity;
      row.forEach(function (r) { sum += r.area; if (r.area > mx) mx = r.area; if (r.area < mn) mn = r.area; });
      var s2 = side * side, sum2 = sum * sum;
      return Math.max(s2 * mx / sum2, sum2 / (s2 * mn));
    };
    while (rest.length) {
      var side = Math.min(w, h), row = [rest[0]], i = 1;
      while (i < rest.length && worst(row.concat([rest[i]]), side) <= worst(row, side)) { row.push(rest[i]); i += 1; }
      rest = rest.slice(row.length);
      var sum = 0;
      row.forEach(function (r) { sum += r.area; });
      var thick = sum / side, pos = 0;
      row.forEach(function (r) {
        var len = r.area / thick;
        if (w >= h) out.push({ it: r.it, x: x, y: y + pos, w: thick, h: len });
        else out.push({ it: r.it, x: x + pos, y: y, w: len, h: thick });
        pos += len;
      });
      if (w >= h) { x += thick; w -= thick; } else { y += thick; h -= thick; }
    }
    return out;
  }
  // Change to colour: pale near zero, full strength at the limit. Text flips to white on strong tiles.
  function tone(pct, limit, rgbUp, rgbDown) {
    var v = Math.max(-1, Math.min(1, pct / limit)), a = 0.14 + Math.abs(v) * 0.78;
    return { bg: 'rgba(' + (v >= 0 ? rgbUp : rgbDown) + ', ' + a.toFixed(2) + ')', light: a > 0.55 };
  }
  // items: [{ key, label, size, changePct, title }]. Tiles are real buttons.
  function treemap(box, items, opts) {
    var w = box.clientWidth, h = box.clientHeight;
    var list = items.filter(function (it) { return it.size > 0; }).sort(function (a, b) { return b.size - a.size; });
    var frag = document.createDocumentFragment();
    squarify(list, 0, 0, w, h).forEach(function (t) {
      var it = t.it, c = tone(it.changePct, opts.limit || 8, opts.up, opts.down);
      var b = el('button', 'tm' + (c.light ? ' strong' : '') + (it.key === opts.selected ? ' on' : ''));
      b.type = 'button';
      b.dataset.fk = (opts.fk || 'tm:') + it.key;
      b.style.left = (t.x / w * 100) + '%'; b.style.top = (t.y / h * 100) + '%';
      b.style.width = (t.w / w * 100) + '%'; b.style.height = (t.h / h * 100) + '%';
      b.style.background = c.bg;
      b.setAttribute('aria-pressed', String(it.key === opts.selected));
      b.setAttribute('aria-label', it.title);
      b.title = it.title;
      var small = Math.min(t.w, t.h * 1.6);
      // Names and figures only where they fit; the label above always carries them.
      if (t.w >= 34 && t.h >= 20) {
        var name = el('b', null, it.label);
        name.style.fontSize = Math.max(10, Math.min(26, small / 4.2)) + 'px';
        b.appendChild(name);
        if (t.w >= 46 && t.h >= 38) {
          var chg = el('span', 'mono', (it.changePct > 0 ? '+' : '') + it.changePct.toFixed(1) + '%');
          chg.style.fontSize = Math.max(10, Math.min(15, small / 7)) + 'px';
          b.appendChild(chg);
        }
      }
      b.addEventListener('click', function () { opts.onPick(it.key); });
      frag.appendChild(b);
    });
    box.replaceChildren(frag);
  }

  // ---------- liquidation heatmap (model) ----------
  // Dark to bright, readable for colour-blind viewers (the viridis sequence).
  var RAMP = [[23, 10, 54], [62, 44, 122], [49, 104, 142], [33, 145, 140], [53, 183, 121], [170, 220, 50], [253, 231, 37]];
  function ramp(v) {
    var p = Math.max(0, Math.min(1, v)) * (RAMP.length - 1), i = Math.min(RAMP.length - 2, Math.floor(p)), f = p - i;
    var a = RAMP[i], b = RAMP[i + 1];
    return 'rgb(' + Math.round(a[0] + (b[0] - a[0]) * f) + ',' + Math.round(a[1] + (b[1] - a[1]) * f) + ',' + Math.round(a[2] + (b[2] - a[2]) * f) + ')';
  }
  var WEIGHT = { 10: 4, 25: 3, 50: 2, 100: 1 }; // lower leverage is more common
  // Builds the grid. A position assumed opened in a candle shows from the next candle on,
  // at the price where it would be closed out, until a later candle trades through that price.
  function liquidationGrid(candles, leverages, rows) {
    var n = candles.length;
    if (n < 5) return null;
    var lo = Infinity, hi = -Infinity;
    candles.forEach(function (c) { if (c.low < lo) lo = c.low; if (c.high > hi) hi = c.high; });
    var pad = (hi - lo) * 0.12 || hi * 0.05;
    lo = Math.max(lo - pad, lo * 0.5); hi += pad;
    var step = (hi - lo) / rows, grid = [];
    for (var r = 0; r < rows; r++) grid.push(new Float64Array(n + 1));
    var mark = function (price, from, to, amount) {
      var row = Math.floor((price - lo) / step);
      if (row < 0 || row >= rows || from >= to) return;
      grid[row][from] += amount; grid[row][to] -= amount; // difference array along time
    };
    for (var i = 0; i < n - 1; i++) {
      var c = candles[i];
      if (!(c.volume > 0)) continue;
      var entry = (c.high + c.low + c.close) / 3;
      for (var k = 0; k < leverages.length; k++) {
        var L = leverages[k], amount = c.volume * entry * (WEIGHT[L] || 1);
        var below = entry * (1 - 1 / L), above = entry * (1 + 1 / L), endLong = n, endShort = n;
        for (var j = i + 1; j < n; j++) {
          if (endLong === n && candles[j].low <= below) endLong = j;
          if (endShort === n && candles[j].high >= above) endShort = j;
          if (endLong !== n && endShort !== n) break;
        }
        mark(below, i + 1, endLong, amount);
        mark(above, i + 1, endShort, amount);
      }
    }
    var all = [];
    grid.forEach(function (row) { var run = 0; for (var x = 0; x < n; x++) { run += row[x]; row[x] = run; if (run > 0) all.push(run); } });
    all.sort(function (a, b) { return a - b; });
    // The brightest colour is the 98th percentile, so one extreme cell does not dim the rest.
    var top = all.length ? all[Math.floor(all.length * 0.98)] || all[all.length - 1] : 0;
    return { lo: lo, hi: hi, step: step, rows: rows, cols: n, grid: grid, top: top };
  }
  function drawLiquidation(cv, candles, grid, fmt) {
    var box = cv.parentNode, w = box.clientWidth, h = box.clientHeight, ratio = window.devicePixelRatio || 1;
    if (!w || !h) return null;
    if (cv.width !== Math.round(w * ratio) || cv.height !== Math.round(h * ratio)) { cv.width = Math.round(w * ratio); cv.height = Math.round(h * ratio); }
    var g = cv.getContext('2d');
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    var axisW = 64, axisH = 22, pw = w - axisW, ph = h - axisH;
    g.fillStyle = ramp(0); g.fillRect(0, 0, w, h);
    if (!grid) return null;
    var cw = pw / grid.cols, rh = ph / grid.rows;
    var yOf = function (p) { return ph - (p - grid.lo) / (grid.hi - grid.lo) * ph; };
    for (var r = 0; r < grid.rows; r++) {
      var row = grid.grid[r], y = ph - (r + 1) * rh;
      for (var x = 0; x < grid.cols; x++) {
        if (!(row[x] > 0)) continue;
        g.fillStyle = ramp(0.08 + 0.92 * Math.sqrt(Math.min(1, row[x] / grid.top)));
        g.fillRect(x * cw, y, cw + 0.6, rh + 0.6);
      }
    }
    // Price on top: candle ranges as thin bars and the close as a line, in white.
    g.strokeStyle = 'rgba(255, 255, 255, .35)'; g.lineWidth = 1;
    candles.forEach(function (c, i) { var cx = (i + 0.5) * cw; g.beginPath(); g.moveTo(cx, yOf(c.high)); g.lineTo(cx, yOf(c.low)); g.stroke(); });
    g.strokeStyle = '#FFFFFF'; g.lineWidth = 1.6; g.beginPath();
    candles.forEach(function (c, i) { var cx = (i + 0.5) * cw, cy = yOf(c.close); if (i) g.lineTo(cx, cy); else g.moveTo(cx, cy); });
    g.stroke();
    // Axes.
    g.fillStyle = 'rgba(255, 255, 255, .86)'; g.font = '11px Inter, system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'left';
    for (var t = 0; t <= 5; t++) { var p = grid.lo + (grid.hi - grid.lo) * t / 5; g.fillText(fmt.price(p), pw + 8, Math.min(ph - 7, Math.max(8, yOf(p)))); }
    g.textBaseline = 'alphabetic'; g.textAlign = 'center';
    for (var q = 0; q < 5; q++) { var idx = Math.round((grid.cols - 1) * (q + 0.5) / 5); g.fillText(fmt.time(candles[idx].time), (idx + 0.5) * cw, h - 6); }
    return { pw: pw, ph: ph, cw: cw, rh: rh };
  }
  // What is under the pointer, for the read-out below the picture.
  function probe(grid, geo, candles, px, py) {
    if (!grid || !geo || px < 0 || py < 0 || px >= geo.pw || py >= geo.ph) return null;
    var col = Math.min(grid.cols - 1, Math.floor(px / geo.cw)), row = Math.min(grid.rows - 1, Math.floor((geo.ph - py) / geo.rh));
    var v = grid.grid[row][col];
    return { time: candles[col].time, close: candles[col].close, lo: grid.lo + row * grid.step, hi: grid.lo + (row + 1) * grid.step, strength: grid.top > 0 ? Math.min(100, Math.round(v / grid.top * 100)) : 0 };
  }
  function legendCss() { return 'linear-gradient(90deg, ' + [0, 0.17, 0.33, 0.5, 0.67, 0.83, 1].map(ramp).join(', ') + ')'; }

  window.Heatmaps = { squarify: squarify, treemap: treemap, liquidationGrid: liquidationGrid, drawLiquidation: drawLiquidation, probe: probe, legendCss: legendCss, ramp: ramp };
})();
