// Radar page: one market read from several angles at once.
//   Confluence     the separate readings (trend, momentum, average price, volume, funding,
//                  crowd, location) lined up, each with a plain explanation
//   Chart          candles with moving averages, VWAP and key levels, and three price-level
//                  heat layers: volume by price, resting orders, and a liquidation model
//   Levels, timeframes, market and funding heatmaps, positioning, large trades
//   Position size  how much to trade for a chosen risk
// The maths lives in indicators.js; data access in hl.js.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var I = window.Indicators, HL = window.HL;
  var INTERVALS = ['15m', '1h', '4h', '1d'];
  var HEAT_VENUES = ['Binance', 'Bybit', 'Hyperliquid'];
  var LINES = [
    { id: 'ema9', label: 'EMA 9', color: '#F7D774', period: 9 },
    { id: 'ema21', label: 'EMA 21', color: '#86D3F7', period: 21 },
    { id: 'ema50', label: 'EMA 50', color: '#CFC0F7', period: 50 },
    { id: 'ema200', label: 'EMA 200', color: '#F5B49A', period: 200 },
    { id: 'vwap', label: 'VWAP', color: '#FFFFFF' }
  ];
  var LAYERS = [
    { id: 'levels', label: 'Key levels' },
    { id: 'profile', label: 'Volume by price' },
    { id: 'book', label: 'Resting orders' },
    { id: 'liq', label: 'Liquidation model' }
  ];
  var st = {
    onPage: false, active: false, coin: 'BTC', interval: '1h', markets: [], snap: null,
    c: {}, depth: null, funding: [], profile: null, walls: [], levels: [], liq: null, conf: null,
    chart: null, candles: null, volume: null, lines: {}, priceLines: [], fitted: '', shown: '',
    stream: null, live: false, timers: [], raf: null, sig: '', dirty: false, loadId: 0,
    on: { ema9: false, ema21: true, ema50: true, ema200: true, vwap: true, levels: true, profile: true, book: true, liq: false }
  };
  try {
    st.coin = localStorage.getItem('nt.rcoin') || 'BTC';
    var iv = localStorage.getItem('nt.rinterval');
    if (INTERVALS.indexOf(iv) !== -1) st.interval = iv;
    var saved = JSON.parse(localStorage.getItem('nt.rlayers') || 'null');
    if (saved && typeof saved === 'object') Object.keys(st.on).forEach(function (k) { if (typeof saved[k] === 'boolean') st.on[k] = saved[k]; });
  } catch (e) { /* storage unavailable */ }
  function remember(key, val) { try { localStorage.setItem(key, val); } catch (e) { /* ignore */ } }

  // ---------- small helpers ----------
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function money(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
    return '$' + Math.round(n);
  }
  function decimals(n) { return n >= 10000 ? 1 : n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 5 : 8; }
  function px(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    var d = decimals(Math.abs(n));
    return n.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
  }
  function clock(ts) {
    var d = new Date(ts);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function signed(n, digits) { return (n > 0 ? '+' : '') + n.toFixed(digits) + '%'; }
  function local(sec) { return sec - new Date(sec * 1000).getTimezoneOffset() * 60; }
  function market() { return st.markets.filter(function (m) { return m.coin === st.coin; })[0] || null; }
  function price() {
    var m = market(), list = st.c[st.interval];
    if (m && m.mark > 0) return m.mark;
    return list && list.length ? list[list.length - 1].close : null;
  }
  function keepFocus(prefix, rebuild) {
    var a = document.activeElement, key = a && a.dataset ? a.dataset.fk : null;
    rebuild();
    if (key && key.indexOf(prefix) === 0) {
      var again = document.querySelector('[data-fk="' + key.replace(/[^\w:.-]/g, '') + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }

  // ---------- pickers ----------
  function renderPicker() {
    keepFocus('rcoin:', function () {
      var box = $('rCoins');
      box.textContent = '';
      st.markets.slice(0, 6).forEach(function (m) {
        var on = m.coin === st.coin;
        var b = el('button', 'kind k-crypto' + (on ? ' on' : ''));
        b.type = 'button';
        b.dataset.fk = 'rcoin:' + m.coin;
        b.setAttribute('aria-pressed', String(on));
        b.appendChild(el('span', 'tick', m.coin));
        b.appendChild(el('span', 'n', signed(m.change24hPct, 1)));
        b.addEventListener('click', function () { setCoin(m.coin); });
        box.appendChild(b);
      });
    });
    var sel = $('rSelect');
    if (sel.options.length !== st.markets.length) {
      sel.textContent = '';
      st.markets.forEach(function (m) { var o = el('option', null, m.coin); o.value = m.coin; sel.appendChild(o); });
    }
    sel.value = st.coin;
  }
  function renderIntervals() {
    var box = $('rIntervals');
    box.textContent = '';
    INTERVALS.forEach(function (v) {
      var b = el('button', v === st.interval ? 'on' : '', v);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(v === st.interval));
      b.addEventListener('click', function () {
        if (v === st.interval) return;
        st.interval = v;
        st.fitted = '';
        remember('nt.rinterval', v);
        renderIntervals();
        clearChart();
        analyse();
        resubscribe();
      });
      box.appendChild(b);
    });
  }
  function renderToggles() {
    var box = $('rToggles');
    box.textContent = '';
    LINES.concat(LAYERS).forEach(function (t) {
      var b = el('button', 'tgl' + (st.on[t.id] ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(st.on[t.id]));
      if (t.color) { var sw = el('span', 'sw'); sw.style.background = t.color; b.appendChild(sw); }
      b.appendChild(el('span', null, t.label));
      b.addEventListener('click', function () {
        st.on[t.id] = !st.on[t.id];
        remember('nt.rlayers', JSON.stringify(st.on));
        renderToggles();
        drawOverlays();
        st.dirty = true;
      });
      box.appendChild(b);
    });
  }

  // ---------- chart ----------
  function ensureChart() {
    if (st.chart || !window.LightweightCharts) return;
    var LC = window.LightweightCharts;
    st.chart = LC.createChart($('rChart'), {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#C2D4CA', fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { vertLines: { color: 'rgba(50, 80, 64, .45)' }, horzLines: { color: 'rgba(50, 80, 64, .45)' } },
      rightPriceScale: { borderColor: '#325040' },
      timeScale: { borderColor: '#325040', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }
    });
    st.candles = st.chart.addCandlestickSeries({ upColor: '#6BE89A', borderUpColor: '#6BE89A', wickUpColor: '#6BE89A', downColor: '#F2876B', borderDownColor: '#F2876B', wickDownColor: '#F2876B' });
    st.volume = st.chart.addHistogramSeries({ priceScaleId: '', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    st.volume.priceScale().applyOptions({ scaleMargins: { top: 0.86, bottom: 0 } });
    LINES.forEach(function (l) {
      st.lines[l.id] = st.chart.addLineSeries({ color: l.color, lineWidth: l.id === 'vwap' ? 2 : 1, lineStyle: l.id === 'vwap' ? 2 : 0, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    });
  }
  function volBar(c) { return { time: local(c.time), value: c.volume, color: c.close >= c.open ? 'rgba(107, 232, 154, .3)' : 'rgba(242, 135, 107, .3)' }; }
  function clearChart() {
    st.shown = '';
    if (!st.candles) return;
    st.candles.setData([]);
    st.volume.setData([]);
    LINES.forEach(function (l) { st.lines[l.id].setData([]); });
    st.priceLines.forEach(function (pl) { st.candles.removePriceLine(pl); });
    st.priceLines = [];
    st.dirty = true;
  }

  function drawChart() {
    var list = st.c[st.interval];
    ensureChart();
    if (!st.chart) { $('rChartNote').textContent = 'The chart library did not load.'; return; }
    if (!list || !list.length) return;
    var d = decimals(list[list.length - 1].close);
    st.candles.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: Math.pow(10, -d) } });
    st.candles.setData(list.map(function (c) { return { time: local(c.time), open: c.open, high: c.high, low: c.low, close: c.close }; }));
    st.volume.setData(list.map(volBar));
    st.shown = st.coin + st.interval;
    drawOverlays();
    if (st.fitted !== st.shown) {
      // Open on the most recent stretch, readable at a glance; scroll or pinch for the rest.
      if (list.length > 190) st.chart.timeScale().setVisibleLogicalRange({ from: list.length - 180, to: list.length + 6 });
      else st.chart.timeScale().fitContent();
      st.fitted = st.shown;
    }
  }

  // Moving averages, VWAP and the level lines. Cheap enough to redo on every refresh.
  function drawOverlays() {
    var list = st.c[st.interval];
    if (!st.chart || !list || !list.length || st.shown !== st.coin + st.interval) return;
    var closes = list.map(function (c) { return c.close; });
    LINES.forEach(function (l) {
      var series = st.lines[l.id];
      if (!st.on[l.id]) { series.setData([]); return; }
      var vals = l.id === 'vwap' ? I.vwap(list, st.interval) : I.ema(closes, l.period);
      var pts = [];
      vals.forEach(function (v, i) { if (v != null && isFinite(v)) pts.push({ time: local(list[i].time), value: v }); });
      series.setData(pts);
    });
    st.priceLines.forEach(function (pl) { st.candles.removePriceLine(pl); });
    st.priceLines = [];
    if (st.on.levels) {
      var p = price();
      // The five nearest on each side: more than that and the chart is unreadable.
      var above = st.levels.filter(function (l) { return l.side === 'above'; }).sort(function (a, b) { return a.price - b.price; }).slice(0, 5);
      var below = st.levels.filter(function (l) { return l.side === 'below'; }).sort(function (a, b) { return b.price - a.price; }).slice(0, 5);
      above.concat(below).forEach(function (l) {
        if (!p || Math.abs(l.distPct) > 12) return;
        var color = { pivot: '#9DB5A8', prior: '#F7D774', profile: '#7EEBD0', swing: l.side === 'above' ? '#F7A58E' : '#6BE89A', wall: '#86D3F7' }[l.kind];
        st.priceLines.push(st.candles.createPriceLine({ price: l.price, color: color, lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: l.label }));
      });
    }
    var parts = [];
    if (st.on.vwap) parts.push('VWAP restarts each ' + I.anchorName(st.interval) + ' (UTC).');
    if (st.on.profile) parts.push('Volume by price covers every candle loaded (scroll left to see them) and spreads each candle\'s volume across its range.');
    if (st.on.liq) parts.push('The liquidation layer is a model, not real positions.');
    $('rChartNote').textContent = parts.join(' ');
  }

  // One live candle. It replaces or follows the last one in memory; the screen is
  // refreshed at most once a second from that.
  function tick(c) {
    var list = st.c[st.interval];
    if (!list || !list.length || st.shown !== st.coin + st.interval) return;
    var bar = { time: Math.floor(c.t / 1000), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v) };
    if (!isFinite(bar.close)) return;
    var lastBar = list[list.length - 1];
    if (bar.time < lastBar.time) return;
    if (bar.time === lastBar.time) list[list.length - 1] = bar; else { list.push(bar); if (list.length > 400) list.shift(); }
    st.candles.update({ time: local(bar.time), open: bar.open, high: bar.high, low: bar.low, close: bar.close });
    st.volume.update(volBar(bar));
    st.tickPending = true;
  }

  // ---------- heat layers drawn over the chart, aligned to its price axis ----------
  function drawHeat() {
    var cv = $('rHeat'), box = $('rChart');
    var w = box.clientWidth, h = box.clientHeight;
    if (!st.chart || !w || !h) return;
    var ratio = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(w * ratio) || cv.height !== Math.round(h * ratio)) { cv.width = Math.round(w * ratio); cv.height = Math.round(h * ratio); }
    var g = cv.getContext('2d');
    g.setTransform(ratio, 0, 0, ratio, 0, 0);
    g.clearRect(0, 0, w, h);
    if (st.shown !== st.coin + st.interval) return;
    var scaleW = 0, timeH = 26;
    try { scaleW = st.chart.priceScale('right').width(); } catch (e) { scaleW = 70; }
    var paneW = w - scaleW, paneH = h - timeH;
    var y = function (p) { var v = st.candles.priceToCoordinate(p); return v == null ? null : v; };
    var band = function (lo, hi) {
      var a = y(hi), b = y(lo);
      if (a == null || b == null) return null;
      if (b < 0 || a > paneH) return null;
      return { top: Math.max(0, a), height: Math.max(1, Math.min(paneH, b) - Math.max(0, a)) };
    };
    g.save();
    g.beginPath(); g.rect(0, 0, paneW, paneH); g.clip();

    if (st.on.liq && st.liq && st.liq.max > 0) {
      st.liq.bins.forEach(function (b) {
        var r = band(b.lo, b.hi);
        if (!r) return;
        var v = Math.max(b.long, b.short) / st.liq.max;
        if (v < 0.08) return;
        g.fillStyle = 'rgba(247, 199, 104, ' + (0.05 + v * 0.3).toFixed(3) + ')';
        g.fillRect(0, r.top, paneW, r.height);
      });
    }
    if (st.on.profile && st.profile) {
      var maxW = paneW * 0.26;
      st.profile.bins.forEach(function (b) {
        var r = band(b.lo, b.hi);
        if (!r || !b.vol) return;
        var isPoc = Math.abs(b.mid - st.profile.poc) < st.profile.step / 2;
        var inValue = b.mid <= st.profile.vah && b.mid >= st.profile.val;
        g.fillStyle = isPoc ? 'rgba(126, 235, 208, .6)' : inValue ? 'rgba(126, 235, 208, .26)' : 'rgba(126, 235, 208, .12)';
        g.fillRect(0, r.top + 0.5, Math.max(1, b.vol / st.profile.max * maxW), Math.max(1, r.height - 1));
      });
    }
    if (st.on.book && st.depth) {
      var all = st.depth.bids.concat(st.depth.asks), maxSz = 0;
      all.forEach(function (l) { if (l.sz > maxSz) maxSz = l.sz; });
      var step = st.depth.bids.length > 1 ? Math.abs(st.depth.bids[0].px - st.depth.bids[1].px) : 0;
      var draw = function (levels, color, strong) {
        levels.forEach(function (l) {
          var r = band(l.px - step / 2, l.px + step / 2);
          if (!r || !maxSz) return;
          var len = l.sz / maxSz * paneW * 0.22;
          var wall = st.walls.some(function (x) { return x.px === l.px; });
          g.fillStyle = wall ? strong : color;
          g.fillRect(paneW - len, r.top + 0.5, len, Math.max(1.5, r.height - 1));
        });
      };
      draw(st.depth.bids, 'rgba(107, 232, 154, .22)', 'rgba(107, 232, 154, .6)');
      draw(st.depth.asks, 'rgba(242, 135, 107, .22)', 'rgba(242, 135, 107, .6)');
    }
    g.restore();
  }
  // The chart can be zoomed and dragged at any moment and offers no event for a change
  // of its price axis, so the layer checks a few reference points each frame and repaints
  // only when one has moved.
  function watchHeat() {
    cancelAnimationFrame(st.raf);
    var loop = function () {
      if (!st.active) return;
      st.raf = requestAnimationFrame(loop);
      if (!st.chart || !st.candles) return;
      var box = $('rChart'), p = price() || 1;
      var a = st.candles.priceToCoordinate(p), b = st.candles.priceToCoordinate(p * 1.01);
      var sig = [box.clientWidth, box.clientHeight, a == null ? 'x' : a.toFixed(1), b == null ? 'x' : b.toFixed(1), st.shown].join('|');
      if (sig === st.sig && !st.dirty) return;
      st.sig = sig;
      st.dirty = false;
      drawHeat();
    };
    st.raf = requestAnimationFrame(loop);
  }

  // ---------- analysis ----------
  // Recomputes everything derived from the data in hand and redraws the panels.
  function analyse() {
    var p = price(), list = st.c[st.interval];
    if (!p || !list || !list.length) return;
    var tf = {};
    INTERVALS.forEach(function (v) { if (st.c[v]) tf[v] = I.summarize(st.c[v], v); });
    st.profile = I.volumeProfile(list, 48);
    st.walls = I.walls(st.depth);
    st.levels = I.keyLevels({ price: p, daily: st.c['1d'], profile: st.profile, swingCandles: st.c['1h'] || list, walls: st.walls });
    st.liq = I.liquidationModel(st.profile, p, 60);
    var m = market(), snapCoin = st.snap ? st.snap.coins.filter(function (c) { return c.coin === st.coin; })[0] : null;
    st.conf = I.confluence({
      tf: tf, price: p, levels: st.levels,
      fundingAnnualPct: m ? m.fundingHourly * 24 * 365 * 100 : null,
      longPct: snapCoin ? snapCoin.blendedLongPct : null
    });
    st.tf = tf;
    $('radarState').hidden = true;
    $('rTitle').textContent = st.coin + ' · ' + st.interval + ' · $' + px(p);
    if (st.shown !== st.coin + st.interval) drawChart(); else drawOverlays();
    renderConfluence();
    renderLevels();
    renderTf();
    st.dirty = true;
  }

  function renderConfluence() {
    var c = st.conf;
    var v = $('cVerdict');
    v.className = 'verdictBig v-' + c.verdict;
    v.textContent = c.text;
    var counts = $('cCounts');
    counts.textContent = '';
    [['up', c.up, 'lean up'], ['down', c.down, 'lean down'], ['caution', c.caution, c.caution === 1 ? 'caution' : 'cautions']].forEach(function (x) {
      var s = el('span', 'cnt c-' + x[0]);
      s.appendChild(el('b', null, String(x[1])));
      s.appendChild(document.createTextNode(' ' + x[2]));
      counts.appendChild(s);
    });
    // The explanations are kept open or closed as the reader left them.
    var open = {};
    document.querySelectorAll('#cFactors details[open]').forEach(function (d) { open[d.dataset.id] = true; });
    var box = $('cFactors');
    box.textContent = '';
    c.factors.forEach(function (f) {
      var li = el('li', 'factor f-' + f.lean);
      var word = { up: 'Leans up', down: 'Leans down', neutral: 'Neutral', caution: 'Caution' }[f.lean];
      li.appendChild(el('span', 'lean', word));
      var body = el('div', 'fBody');
      body.appendChild(el('b', null, f.label));
      body.appendChild(el('span', 'fDetail', f.detail));
      var d = el('details');
      d.dataset.id = f.id;
      if (open[f.id]) d.open = true;
      d.appendChild(el('summary', null, 'What this means'));
      d.appendChild(el('p', null, f.why));
      body.appendChild(d);
      li.appendChild(body);
      box.appendChild(li);
    });
  }

  function renderLevels() {
    var box = $('rLevels'), p = price();
    box.textContent = '';
    var row = function (l) {
      var r = el('div', 'lv lv-' + l.kind + ' ' + l.side);
      var name = el('span', 'lvName');
      name.appendChild(el('b', null, l.label));
      if (l.note) name.appendChild(el('span', 'muted', l.note));
      r.appendChild(name);
      r.appendChild(el('span', 'mono', px(l.price)));
      r.appendChild(el('span', 'mono lvDist', signed(l.distPct, 2)));
      return r;
    };
    var above = st.levels.filter(function (l) { return l.side === 'above'; }).sort(function (a, b) { return a.price - b.price; }).slice(0, 6).reverse();
    var below = st.levels.filter(function (l) { return l.side === 'below'; }).sort(function (a, b) { return b.price - a.price; }).slice(0, 6);
    above.forEach(function (l) { box.appendChild(row(l)); });
    var now = el('div', 'lv now');
    now.appendChild(el('b', null, 'Price now'));
    now.appendChild(el('span', 'mono', px(p)));
    now.appendChild(el('span', null, ''));
    box.appendChild(now);
    below.forEach(function (l) { box.appendChild(row(l)); });
    if (!above.length && !below.length) box.appendChild(el('p', 'muted small', 'Not enough history for levels yet.'));
  }

  function renderTf() {
    var t = $('rTf');
    t.textContent = '';
    var head = el('tr');
    ['', 'Trend', 'vs EMA 50', 'vs EMA 200', 'RSI', 'vs VWAP'].forEach(function (hh, i) { var th = el('th', null, hh); if (i) th.scope = 'col'; head.appendChild(th); });
    t.appendChild(head);
    INTERVALS.slice().reverse().forEach(function (v) {
      var s = st.tf[v], tr = el('tr');
      var th = el('th', null, v); th.scope = 'row'; tr.appendChild(th);
      if (!s) { var td = el('td', 'muted', 'loading'); td.colSpan = 5; tr.appendChild(td); t.appendChild(tr); return; }
      var cell = function (text, cls) { tr.appendChild(el('td', 'mono ' + (cls || ''), text)); };
      cell({ up: '▲ Up', down: '▼ Down', flat: '– Flat' }[s.trend], s.trend === 'up' ? 'up' : s.trend === 'down' ? 'down' : '');
      var rel = function (ref) { if (ref == null || !isFinite(ref)) return cell('n/a'); var d = (s.close - ref) / ref * 100; cell(signed(d, 2), d >= 0 ? 'up' : 'down'); };
      rel(s.ema50); rel(s.ema200);
      cell(s.rsi == null ? 'n/a' : s.rsi.toFixed(0), s.rsi >= 70 || s.rsi <= 30 ? 'warn' : s.rsi > 55 ? 'up' : s.rsi < 45 ? 'down' : '');
      rel(s.vwap);
      t.appendChild(tr);
    });
  }

  // ---------- market heatmap ----------
  function renderMap() {
    keepFocus('map:', function () {
      var box = $('rMap');
      box.textContent = '';
      var list = st.markets.slice(0, 28), maxV = list.length ? list[0].volume24hUsd : 1;
      list.forEach(function (m) {
        var b = el('button', 'tile' + (m.coin === st.coin ? ' on' : ''));
        b.type = 'button';
        b.dataset.fk = 'map:' + m.coin;
        // Area follows volume on a compressed scale, so small markets stay readable.
        b.style.flexGrow = String(Math.max(1, Math.round(Math.sqrt(m.volume24hUsd / maxV) * 12)));
        var a = Math.min(1, Math.abs(m.change24hPct) / 8) * 0.3 + 0.06;
        b.style.background = m.change24hPct >= 0 ? 'rgba(107, 232, 154, ' + a.toFixed(2) + ')' : 'rgba(242, 135, 107, ' + a.toFixed(2) + ')';
        b.appendChild(el('b', null, m.coin));
        b.appendChild(el('span', 'mono', signed(m.change24hPct, 1)));
        b.title = m.coin + ': $' + px(m.mark) + ', volume ' + money(m.volume24hUsd) + ', open interest ' + money(m.openInterestUsd);
        b.addEventListener('click', function () { setCoin(m.coin); window.scrollTo({ top: 0, behavior: 'smooth' }); });
        box.appendChild(b);
      });
    });
  }

  // ---------- funding ----------
  function renderFundingGrid() {
    var table = $('heat');
    table.textContent = '';
    if (!st.snap) return;
    var head = el('tr');
    head.appendChild(el('th', null, 'Coin'));
    HEAT_VENUES.forEach(function (v) { var th = el('th', null, v); th.scope = 'col'; head.appendChild(th); });
    table.appendChild(head);
    st.snap.coins.forEach(function (c) {
      var tr = el('tr');
      var th = el('th', null, c.coin); th.scope = 'row'; tr.appendChild(th);
      HEAT_VENUES.forEach(function (v) {
        var f = c.funding.filter(function (x) { return x.venue === v; })[0];
        var td = el('td', 'mono', f ? signed(f.annualPct, 1) : '—');
        if (f) {
          // Capped so the light text keeps at least 4.5:1 contrast on the strongest cells.
          var a = Math.min(1, Math.abs(f.annualPct) / 40) * 0.24 + 0.06;
          td.style.background = f.annualPct >= 0 ? 'rgba(107, 232, 154, ' + a.toFixed(2) + ')' : 'rgba(242, 135, 107, ' + a.toFixed(2) + ')';
          td.title = (f.rate8h * 100).toFixed(4) + '% per 8 hours';
        }
        tr.appendChild(td);
      });
      table.appendChild(tr);
    });
  }
  function renderFundingHistory() {
    var box = $('rFundHist'), list = st.funding.slice(-168);
    box.textContent = '';
    $('fhTitle').textContent = st.coin + ' funding, past week, hour by hour';
    if (!list.length) { $('rFundNote').textContent = 'No funding history for this market yet.'; return; }
    var max = 0, sum = 0;
    list.forEach(function (f) { max = Math.max(max, Math.abs(f.rate)); sum += f.rate; });
    list.forEach(function (f) {
      var c = el('span', 'fh');
      var a = max > 0 ? Math.abs(f.rate) / max * 0.75 + 0.1 : 0.1;
      c.style.background = f.rate >= 0 ? 'rgba(107, 232, 154, ' + a.toFixed(2) + ')' : 'rgba(242, 135, 107, ' + a.toFixed(2) + ')';
      c.title = new Date(f.time).toLocaleString() + ': ' + signed(f.rate * 24 * 365 * 100, 1) + ' a year';
      box.appendChild(c);
    });
    var avg = sum / list.length * 24 * 365 * 100, lastRate = list[list.length - 1].rate * 24 * 365 * 100;
    var positive = list.filter(function (f) { return f.rate > 0; }).length;
    $('rFundNote').textContent = 'Week average ' + signed(avg, 1) + ' a year, latest hour ' + signed(lastRate, 1) + '. Longs paid in ' + Math.round(positive / list.length * 100) + '% of hours. Oldest on the left.';
  }

  // ---------- positioning and trades (cross-venue snapshot from our server) ----------
  function splitBar(longPct, big) {
    var wrap = el('div', 'split' + (big ? ' big' : ''));
    var bar = el('div', 'splitBar');
    var l = el('span', 'long');
    l.style.width = longPct + '%';
    bar.appendChild(l);
    bar.setAttribute('role', 'img');
    bar.setAttribute('aria-label', Math.round(longPct) + '% long, ' + Math.round(100 - longPct) + '% short');
    wrap.appendChild(el('span', 'pct longTxt', Math.round(longPct) + '% long'));
    wrap.appendChild(bar);
    wrap.appendChild(el('span', 'pct shortTxt', Math.round(100 - longPct) + '% short'));
    return wrap;
  }
  function renderSnapshot() {
    var d = st.snap;
    if (!d) return;
    var vb = $('venues');
    vb.textContent = '';
    d.venues.forEach(function (v) {
      var state = v.ok ? (v.partial ? 'part' : 'ok') : 'off';
      var chip = el('span', 'venue ' + state);
      chip.appendChild(el('span', 'dot'));
      chip.appendChild(el('b', null, v.name));
      chip.appendChild(el('span', null, v.ok ? (v.partial ? 'partial' : 'live') : 'unavailable'));
      if (v.error) chip.title = v.error;
      vb.appendChild(chip);
    });
    var box = $('radarCoins');
    box.textContent = '';
    d.coins.forEach(function (c) {
      var card = el('article', 'card coin tilt-' + c.tilt);
      var head = el('div', 'coinHead');
      head.appendChild(el('span', 'coinName', c.coin));
      head.appendChild(el('span', 'mono', c.price == null ? 'n/a' : '$' + px(c.price)));
      head.appendChild(el('span', 'tiltTag', { long: 'Tilted long', short: 'Tilted short', balanced: 'Balanced', unknown: 'No data' }[c.tilt]));
      card.appendChild(head);
      if (c.blendedLongPct != null) card.appendChild(splitBar(c.blendedLongPct, true));
      card.appendChild(el('p', 'note', c.note));
      if (c.positioning.length) {
        var rows = el('div', 'venueRows');
        c.positioning.forEach(function (p) {
          var r = el('div', 'venueRow');
          var name = el('span', 'vName');
          name.appendChild(el('b', null, p.venue));
          name.appendChild(el('span', 'muted', p.label));
          r.appendChild(name);
          r.appendChild(splitBar(p.longPct, false));
          rows.appendChild(r);
        });
        card.appendChild(rows);
      }
      var foot = el('div', 'coinFoot');
      [['Open interest', c.openInterestUsd ? money(c.openInterestUsd) : 'n/a'], ['Coinbase premium', c.coinbasePremiumPct == null ? 'n/a' : signed(c.coinbasePremiumPct, 3)]].forEach(function (x) {
        var s = el('span');
        s.appendChild(el('i', null, x[0]));
        s.appendChild(el('b', null, x[1]));
        foot.appendChild(s);
      });
      card.appendChild(foot);
      box.appendChild(card);
    });
    $('bigNote').textContent = 'Hyperliquid trades of ' + money(d.bigTradeUsd) + ' or more in BTC, ETH and SOL. A trade can open or close a position; the feed cannot tell which.';
    var tb = $('bigTrades');
    tb.textContent = '';
    if (!d.bigTrades.length) tb.appendChild(el('p', 'muted', 'No large trades in the latest window.'));
    d.bigTrades.slice(0, 14).forEach(function (t) {
      var r = el('div', 'tapeRow ' + t.side);
      r.appendChild(el('span', 'mono muted', clock(t.time)));
      r.appendChild(el('b', null, t.coin));
      r.appendChild(el('span', 'side', t.side === 'buy' ? 'BUY' : 'SELL'));
      r.appendChild(el('span', 'mono', money(t.usd)));
      r.appendChild(el('span', 'mono muted', '$' + px(t.px)));
      tb.appendChild(r);
    });
    renderFundingGrid();
  }

  // ---------- position size ----------
  function renderSize() {
    var out = $('psOut');
    out.textContent = '';
    var r = I.positionSize({ account: $('psAccount').value, riskPct: $('psRisk').value, entry: $('psEntry').value, stop: $('psStop').value, leverage: $('psLev').value });
    if (!r) { out.appendChild(el('p', 'muted small', 'Enter an entry and a stop to see the size.')); return; }
    var line = function (k, v, cls) { var d = el('div', 'psLine ' + (cls || '')); d.appendChild(el('span', null, k)); d.appendChild(el('b', 'mono', v)); out.appendChild(d); };
    line('Direction', r.side === 'long' ? 'Long (stop below entry)' : 'Short (stop above entry)');
    line('You risk', money(r.riskUsd) + ' if the stop is hit');
    line('Position size', (r.qty >= 1 ? r.qty.toFixed(3) : r.qty.toPrecision(3)) + ' ' + st.coin + ' ($' + Math.round(r.notional).toLocaleString('en-US') + ')');
    line('Margin needed', money(r.margin) + ' (' + r.marginPctOfAccount.toFixed(0) + '% of account)', r.tooBig ? 'bad' : '');
    line('Stop distance', r.stopPct.toFixed(2) + '%');
    line('Liquidation, roughly', r.liq == null ? 'none at 1x' : '$' + px(r.liq), r.stopBeyondLiq ? 'bad' : '');
    r.targets.forEach(function (t) { line(t.r + 'x the risk', '$' + px(t.price) + ' (+' + money(t.gain) + ')'); });
    if (r.stopBeyondLiq) out.appendChild(el('p', 'psWarn', 'At this leverage the position would be liquidated before price reaches your stop. Lower the leverage or tighten the stop.'));
    if (r.tooBig) out.appendChild(el('p', 'psWarn', 'This needs more margin than the account holds. Raise the leverage, widen the risk, or move the stop further away.'));
    out.appendChild(el('p', 'muted small', 'The liquidation price is an estimate (0.5% maintenance margin, no fees or funding). The exchange\'s own figure is the one that counts.'));
  }

  // ---------- data ----------
  function fail(what) { if (!st.c[st.interval]) { $('radarState').hidden = false; $('radarState').textContent = what; } }

  function loadCandles(interval) {
    var coin = st.coin, id = st.loadId;
    return HL.candles(coin, interval).then(function (list) {
      if (coin !== st.coin || id !== st.loadId || !list.length) return;
      // A live tick may already have moved the last candle on; keep the newer one.
      var have = st.c[interval];
      if (have && have.length && st.live && interval === st.interval) {
        var mine = have[have.length - 1], theirs = list[list.length - 1];
        if (mine.time === theirs.time) list[list.length - 1] = mine;
        else if (mine.time > theirs.time) list.push(mine);
      }
      st.c[interval] = list;
    }).catch(function () { if (interval === st.interval) fail('Market data is unavailable right now. Retrying.'); });
  }
  function loadAllCandles() {
    return Promise.all(INTERVALS.map(loadCandles)).then(analyse);
  }
  function loadDepth() {
    var coin = st.coin;
    return HL.depth(coin, 3).then(function (d) { if (coin === st.coin) { st.depth = d; analyse(); } }).catch(function () {});
  }
  function loadFunding() {
    var coin = st.coin;
    return HL.funding(coin).then(function (list) { if (coin === st.coin) { st.funding = list; renderFundingHistory(); } }).catch(function () { st.funding = []; renderFundingHistory(); });
  }
  function loadSnapshot() {
    return fetch('/api/radar').then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) throw new Error(d.error);
      st.snap = d;
      $('radarAt').textContent = 'Positioning updated ' + clock(d.at);
      renderSnapshot();
      analyse();
    }).catch(function () { $('radarAt').textContent = 'Positioning is unavailable right now'; });
  }
  function loadMarkets() {
    return HL.markets().then(function (d) {
      // The market on screen is being updated live; its newer numbers are kept.
      var live = st.live ? market() : null;
      st.markets = (d.markets || []).map(function (m) { return live && m.coin === live.coin ? live : m; });
      if (st.markets.length && !market()) st.coin = st.markets[0].coin;
      renderPicker();
      renderMap();
    }).catch(function () { fail('The market list is unavailable right now. Retrying.'); });
  }

  // ---------- live stream ----------
  function wanted() { return [{ type: 'candle', coin: st.coin, interval: st.interval }, { type: 'activeAssetCtx', coin: st.coin }]; }
  function resubscribe() { if (st.stream) st.stream.set(wanted()); }
  function setNote(mode) {
    $('rLive').className = 'liveNote ' + mode;
    $('rLiveText').textContent = { live: 'Live from Hyperliquid', poll: 'Live stream unavailable. Refreshing every few seconds.', demo: 'Demo prices. These are invented, not the market.', wait: 'Connecting…' }[mode];
  }
  function onStream(msg) {
    var d = msg.data;
    if (msg.channel === 'candle') {
      if (d.s === st.coin && d.i === st.interval) tick(d);
    } else if (msg.channel === 'activeAssetCtx') {
      var m = market();
      if (!m || d.coin !== st.coin || !d.ctx) return;
      var mark = Number(d.ctx.markPx), prev = Number(d.ctx.prevDayPx);
      if (!isFinite(mark) || mark <= 0) return;
      m.mark = mark;
      m.fundingHourly = Number(d.ctx.funding) || 0;
      m.openInterestUsd = (Number(d.ctx.openInterest) || 0) * mark;
      if (prev) m.change24hPct = (mark - prev) / prev * 100;
      st.tickPending = true;
    }
  }

  // ---------- lifecycle ----------
  function setCoin(coin) {
    if (coin === st.coin) return;
    st.coin = coin;
    st.loadId += 1;
    st.c = {}; st.depth = null; st.funding = []; st.fitted = '';
    remember('nt.rcoin', coin);
    renderPicker();
    renderMap();
    clearChart();
    $('rTitle').textContent = coin + ' · ' + st.interval;
    loadAllCandles();
    loadDepth();
    loadFunding();
    resubscribe();
  }

  function stop() {
    st.active = false;
    st.timers.forEach(clearInterval);
    st.timers = [];
    cancelAnimationFrame(st.raf);
    if (st.stream) st.stream.close();
    st.stream = null;
    st.live = false;
  }
  function start() {
    stop();
    // Nothing is fetched while the page is not on screen or the tab is in the background.
    if (!st.onPage || document.hidden) return;
    st.active = true;
    st.loadId += 1;
    setNote('wait');
    renderIntervals();
    renderToggles();
    renderSize();
    watchHeat();
    loadMarkets().then(function () {
      if (!st.active) return;
      loadAllCandles();
      loadDepth();
      loadFunding();
      loadSnapshot();
      if (!HL.canStream()) setNote('demo');
      else {
        st.stream = HL.stream({
          onMessage: onStream,
          onOpen: function () { st.live = true; setNote('live'); },
          onDown: function () { st.live = false; if (st.active) setNote('poll'); },
          onRetry: function () { if (st.active) loadCandles(st.interval).then(analyse); }
        });
        st.stream.set(wanted());
      }
    });
    st.timers = [
      // Live ticks are folded into the panels at most once a second.
      setInterval(function () { if (st.tickPending) { st.tickPending = false; analyse(); } }, 1000),
      // Without a live stream the chart's own timeframe is refreshed often; the others slowly.
      setInterval(function () { if (!st.live) loadCandles(st.interval).then(function () { st.shown = ''; analyse(); }); }, 10000),
      setInterval(function () { Promise.all(INTERVALS.filter(function (v) { return v !== st.interval; }).map(loadCandles)).then(analyse); }, 60000),
      setInterval(loadDepth, 5000),
      setInterval(loadMarkets, 15000),
      setInterval(loadSnapshot, 20000),
      setInterval(loadFunding, 600000)
    ];
  }

  $('rSelect').addEventListener('change', function (e) { setCoin(e.target.value); });
  ['psAccount', 'psRisk', 'psEntry', 'psStop', 'psLev'].forEach(function (id) { $(id).addEventListener('input', renderSize); });
  $('psForm').addEventListener('submit', function (e) { e.preventDefault(); });
  $('psUsePrice').addEventListener('click', function () { var p = price(); if (p) { $('psEntry').value = Number(p.toPrecision(7)); renderSize(); } });
  function nearest(side) {
    var list = st.levels.filter(function (l) { return l.side === side && (l.kind === 'swing' || l.kind === 'prior' || l.kind === 'profile'); });
    list.sort(function (a, b) { return Math.abs(a.distPct) - Math.abs(b.distPct); });
    return list[0] || null;
  }
  // The stop goes a little beyond the level (a quarter of a typical hour's move), since
  // price often pokes through a level before turning.
  function stopAt(side) {
    var l = nearest(side), s = st.tf && st.tf['1h'];
    if (!l) return;
    var pad = s && s.atr ? s.atr * 0.25 : l.price * 0.002;
    $('psStop').value = Number((side === 'below' ? l.price - pad : l.price + pad).toPrecision(7));
    if (!$('psEntry').value && price()) $('psEntry').value = Number(price().toPrecision(7));
    renderSize();
  }
  $('psUseSupport').addEventListener('click', function () { stopAt('below'); });
  $('psUseResist').addEventListener('click', function () { stopAt('above'); });

  document.addEventListener('nt:view', function (e) { st.onPage = e.detail === 'radar'; start(); });
  document.addEventListener('visibilitychange', function () { if (st.onPage) start(); });
})();
