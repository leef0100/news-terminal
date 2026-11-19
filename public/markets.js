// Markets page: candle chart, order book, trades and market stats for Hyperliquid perpetuals.
//
// Live data comes straight from the exchange's own stream (a WebSocket from this browser to
// Hyperliquid), so prices tick as they trade and none of it passes through our server.
// Our server only supplies the candle history and the market list, and a slower polling
// fallback for when the stream cannot be reached. In demo mode the numbers are invented.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var INTERVALS = ['5m', '15m', '1h', '4h', '1d'];
  var st = {
    coin: 'BTC', interval: '15m', markets: [], demo: false, active: false,
    timers: [], chart: null, candles: null, volume: null, fitted: '', last: null,
    stream: null, wsOpen: false, trades: [], got: {}, pending: [], shown: '', historyRetry: null
  };
  try {
    st.coin = localStorage.getItem('nt.coin') || 'BTC';
    st.interval = localStorage.getItem('nt.interval') || '15m';
  } catch (e) { /* storage unavailable */ }
  if (INTERVALS.indexOf(st.interval) === -1) st.interval = '15m';
  // The chart library draws UTC; shifting each timestamp by its own local offset makes the
  // axis read in local time, including across a daylight-saving change.
  // Chart times are real UTC seconds; labels are localised by HL.chartTime.
  function local(sec) { return sec; }

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
  // Decimal places that suit the size of a price: 83,201.5 but 0.14231.
  function decimals(n) { return n >= 10000 ? 1 : n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 5 : 8; }
  function px(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    var d = decimals(Math.abs(n));
    return n.toLocaleString('en-US', { minimumFractionDigits: Math.min(d, 2), maximumFractionDigits: d });
  }
  function qty(n) { return n >= 1000 ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : n >= 1 ? n.toFixed(2) : n.toPrecision(3); }
  function clock(ts) {
    var d = new Date(ts);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function signed(n, digits) { return (n > 0 ? '+' : '') + n.toFixed(digits) + '%'; }
  function get(url) {
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) throw new Error(d.error);
      return d;
    });
  }
  function current() { return st.markets.filter(function (m) { return m.coin === st.coin; })[0]; }
  function setNote(mode) {
    var text = { live: 'Streaming live from Hyperliquid', poll: 'Live stream unavailable. Refreshing every few seconds instead.', demo: 'Demo prices. These are invented, not the market.', wait: 'Connecting…' }[mode];
    $('mLive').className = 'liveNote ' + mode;
    $('mLiveText').textContent = text;
  }

  // ---------- rendering ----------
  function renderPicker() {
    var active = document.activeElement;
    var key = active && active.dataset ? active.dataset.fk : null;
    drawPicker();
    if (key && key.indexOf('coin:') === 0) {
      var again = document.querySelector('[data-fk="' + key.replace(/[^\w:.-]/g, '') + '"]');
      if (again) again.focus({ preventScroll: true });
    }
  }
  function drawPicker() {
    var box = $('mCoins');
    box.textContent = '';
    st.markets.slice(0, 6).forEach(function (m) {
      var on = m.coin === st.coin;
      var b = el('button', 'kind k-crypto' + (on ? ' on' : ''));
      b.type = 'button';
      b.dataset.fk = 'coin:' + m.coin;
      b.setAttribute('aria-pressed', String(on));
      b.appendChild(el('span', 'tick', m.coin));
      b.appendChild(el('span', 'n', signed(m.change24hPct, 1)));
      b.addEventListener('click', function () { setCoin(m.coin); });
      box.appendChild(b);
    });
    var sel = $('mSelect');
    if (sel.options.length !== st.markets.length) {
      sel.textContent = '';
      st.markets.forEach(function (m) { var o = el('option', null, m.coin); o.value = m.coin; sel.appendChild(o); });
    }
    sel.value = st.coin;
  }

  function renderStats() {
    var m = current();
    var box = $('mStats');
    box.textContent = '';
    $('mTitle').textContent = st.coin + ' perpetual';
    if (!m) return;
    var yearly = m.fundingHourly * 24 * 365 * 100;
    [
      ['Mark price', '$' + px(m.mark), ''],
      ['24h change', signed(m.change24hPct, 2), m.change24hPct >= 0 ? 'up' : 'down'],
      ['Oracle price', '$' + px(m.oracle), ''],
      ['Funding, hourly', signed(m.fundingHourly * 100, 4), m.fundingHourly >= 0 ? 'up' : 'down'],
      ['Funding, yearly', signed(yearly, 1), yearly >= 0 ? 'up' : 'down'],
      ['Open interest', money(m.openInterestUsd), ''],
      ['24h volume', money(m.volume24hUsd), ''],
      ['Max leverage', m.maxLeverage ? m.maxLeverage + 'x' : 'n/a', '']
    ].forEach(function (s) {
      var d = el('div', 'stat ' + s[2]);
      d.appendChild(el('span', null, s[0]));
      d.appendChild(el('b', 'mono', s[1]));
      box.appendChild(d);
    });
  }

  function renderIntervals() {
    var box = $('mIntervals');
    box.textContent = '';
    INTERVALS.forEach(function (iv) {
      var b = el('button', iv === st.interval ? 'on' : '', iv);
      b.type = 'button';
      b.setAttribute('aria-pressed', String(iv === st.interval));
      b.addEventListener('click', function () {
        st.interval = iv;
        st.fitted = '';
        try { localStorage.setItem('nt.interval', iv); } catch (e) { /* ignore */ }
        renderIntervals();
        clearChart();
        loadCandles();
        resubscribe();
      });
      box.appendChild(b);
    });
  }

  function ensureChart() {
    if (st.chart || !window.LightweightCharts) return;
    var chartTime = window.HL.chartTime(function () { return st.interval; });
    st.chart = window.LightweightCharts.createChart($('mChart'), {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#C2D4CA', fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { vertLines: { color: 'rgba(50, 80, 64, .5)' }, horzLines: { color: 'rgba(50, 80, 64, .5)' } },
      rightPriceScale: { borderColor: '#325040' },
      timeScale: { borderColor: '#325040', timeVisible: true, secondsVisible: false, tickMarkFormatter: chartTime.tickMarkFormatter },
      localization: { timeFormatter: chartTime.timeFormatter },
      crosshair: { mode: 0 }
    });
    st.candles = st.chart.addCandlestickSeries({ upColor: '#6BE89A', borderUpColor: '#6BE89A', wickUpColor: '#6BE89A', downColor: '#F2876B', borderDownColor: '#F2876B', wickDownColor: '#F2876B' });
    st.volume = st.chart.addHistogramSeries({ priceScaleId: '', priceFormat: { type: 'volume' } });
    st.volume.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  }
  function volBar(c) { return { time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(107, 232, 154, .35)' : 'rgba(242, 135, 107, .35)' }; }

  function drawCandles(list, coin, interval) {
    ensureChart();
    if (!st.chart) { $('mState').textContent = 'The chart library did not load.'; return; }
    var shifted = list.map(function (c) { return { time: local(c.time), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }; });
    $('mState').textContent = shifted.length ? '' : 'No candles for this market yet.';
    if (shifted.length) {
      var d = decimals(shifted[shifted.length - 1].close);
      st.candles.applyOptions({ priceFormat: { type: 'price', precision: d, minMove: Math.pow(10, -d) } });
    }
    st.candles.setData(shifted);
    st.volume.setData(shifted.map(volBar));
    st.last = shifted.length ? shifted[shifted.length - 1].time : null;
    st.shown = coin + interval;
    // Live ticks that arrived while the history was loading are applied now.
    var waiting = st.pending;
    st.pending = [];
    waiting.forEach(tickCandle);
    // Fit once per market and interval, then leave the user's zoom and scroll alone.
    if (st.fitted !== coin + interval) { st.chart.timeScale().fitContent(); st.fitted = coin + interval; }
  }

  // One live candle from the stream. Older-than-latest bars are ignored: the chart
  // library only accepts updates to the newest bar or a brand-new one.
  function tickCandle(c) {
    // Until this market's own history is on the chart, ticks are held back: drawn early
    // they would land on the previous market's candles.
    if (st.shown !== st.coin + st.interval || !st.candles || st.last == null) {
      if (st.pending.length < 50) st.pending.push(c);
      return;
    }
    var bar = { time: local(Math.floor(c.t / 1000)), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v) };
    if (bar.time < st.last || !isFinite(bar.close)) return;
    st.candles.update(bar);
    st.volume.update(volBar(bar));
    st.last = bar.time;
  }

  function drawBook(d) {
    var box = $('book');
    box.textContent = '';
    var head = el('div', 'bookRow head');
    ['Price', 'Size', 'Total'].forEach(function (h) { head.appendChild(el('span', null, h)); });
    box.appendChild(head);
    var asks = d.asks.slice(0, 11), bids = d.bids.slice(0, 11);
    var run = 0;
    var askTot = asks.map(function (l) { run += l.sz; return run; });
    run = 0;
    var bidTot = bids.map(function (l) { run += l.sz; return run; });
    var max = Math.max(askTot[askTot.length - 1] || 0, bidTot[bidTot.length - 1] || 0) || 1;
    var row = function (l, tot, side) {
      var r = el('div', 'bookRow ' + side);
      r.style.setProperty('--depth', ((tot / max) * 100).toFixed(1) + '%');
      r.appendChild(el('span', 'px', px(l.px)));
      r.appendChild(el('span', null, qty(l.sz)));
      r.appendChild(el('span', null, qty(tot)));
      return r;
    };
    for (var i = asks.length - 1; i >= 0; i--) box.appendChild(row(asks[i], askTot[i], 'ask'));
    var mid = bids.length && asks.length ? (bids[0].px + asks[0].px) / 2 : null;
    var spread = mid == null ? null : asks[0].px - bids[0].px;
    var m = el('div', 'bookMid');
    m.appendChild(el('b', 'mono', mid == null ? 'n/a' : px(mid)));
    m.appendChild(el('span', 'muted', spread == null ? '' : 'spread ' + px(spread) + ' (' + ((spread / mid) * 100).toFixed(3) + '%)'));
    box.appendChild(m);
    bids.forEach(function (l, i) { box.appendChild(row(l, bidTot[i], 'bid')); });
  }

  function drawTrades() {
    var box = $('mTrades');
    box.textContent = '';
    st.trades.slice(0, 16).forEach(function (t) {
      var row = el('div', 'tapeRow ' + t.side);
      row.appendChild(el('span', 'mono muted', clock(t.time)));
      row.appendChild(el('span', 'side', t.side === 'buy' ? 'BUY' : 'SELL'));
      row.appendChild(el('span', 'mono', px(t.px)));
      row.appendChild(el('span', 'mono', money(t.usd)));
      box.appendChild(row);
    });
  }

  // ---------- history and polling (our server) ----------
  function loadCandles() {
    var coin = st.coin, interval = st.interval;
    clearTimeout(st.historyRetry);
    return window.HL.candles(coin, interval).then(function (list) {
      if (coin === st.coin && interval === st.interval) drawCandles(list, coin, interval);
    }).catch(function () {
      $('mState').textContent = 'Candles are unavailable right now. Retrying.';
      // History is retried by itself: the live stream cannot draw without it.
      if (st.active && coin === st.coin && interval === st.interval) st.historyRetry = setTimeout(loadCandles, 4000);
    });
  }
  // Empties the chart the moment the market or candle size changes, so the old market's
  // candles are never shown under the new market's name.
  function clearChart() {
    st.shown = '';
    st.last = null;
    st.pending = [];
    if (st.candles) { st.candles.setData([]); st.volume.setData([]); }
  }
  function loadBook() {
    var coin = st.coin;
    get('/api/markets/book?coin=' + encodeURIComponent(coin)).then(function (d) { if (coin === st.coin && !streaming('book')) drawBook(d); })
      .catch(function () { $('book').textContent = 'Order book is unavailable right now.'; });
  }
  function loadTrades() {
    var coin = st.coin;
    get('/api/markets/trades?coin=' + encodeURIComponent(coin)).then(function (d) {
      if (coin !== st.coin || streaming('trades')) return;
      st.trades = d.trades;
      drawTrades();
    }).catch(function () { $('mTrades').textContent = 'Trades are unavailable right now.'; });
  }
  function loadMarkets() {
    return window.HL.markets().then(function (d) {
      st.demo = Boolean(d.demo);
      // The list is up to a few seconds old. The market on screen is being updated by the
      // live stream, so its newer figures are kept and not replaced by older ones.
      var live = streaming('ctx') ? current() : null;
      st.markets = (d.markets || []).map(function (m) { return live && m.coin === live.coin ? live : m; });
      if (st.markets.length && !current()) st.coin = st.markets[0].coin;
      renderPicker();
      renderStats();
    }).catch(function () { $('mState').textContent = 'Market list is unavailable right now. Retrying.'; });
  }

  // True once the live stream has delivered this kind of data for the current market.
  // From then on a slower answer from our server must not overwrite the newer picture.
  function streaming(kind) { return st.wsOpen && st.got[kind] === st.coin; }

  function stopPolling() { st.timers.forEach(clearInterval); st.timers = []; }
  function startPolling() {
    stopPolling();
    st.timers = [setInterval(loadCandles, 10000), setInterval(loadBook, 1500), setInterval(loadTrades, 3000)];
  }

  // ---------- live stream (straight to the exchange) ----------
  function wanted() {
    return [
      { type: 'candle', coin: st.coin, interval: st.interval },
      { type: 'l2Book', coin: st.coin },
      { type: 'trades', coin: st.coin },
      { type: 'activeAssetCtx', coin: st.coin }
    ];
  }
  function resubscribe() { if (st.stream) st.stream.set(wanted()); }

  function onStream(msg) {
    var d = msg.data;
    if (!d) return;
    if (msg.channel === 'candle') {
      if (d.s === st.coin && d.i === st.interval) tickCandle(d);
    } else if (msg.channel === 'l2Book') {
      if (d.coin !== st.coin || !d.levels) return;
      var side = function (levels) { return (levels || []).map(function (l) { return { px: Number(l.px), sz: Number(l.sz) }; }); };
      st.got.book = d.coin;
      drawBook({ bids: side(d.levels[0]), asks: side(d.levels[1]) });
    } else if (msg.channel === 'trades') {
      var fresh = (Array.isArray(d) ? d : []).filter(function (t) { return t.coin === st.coin; }).map(function (t) {
        var p = Number(t.px), s = Number(t.sz);
        return { side: t.side === 'B' ? 'buy' : 'sell', px: p, sz: s, usd: p * s, time: t.time, id: t.tid != null ? t.tid : t.hash };
      });
      if (!fresh.length) return;
      // The first live batch replaces whatever the slower path had shown.
      if (st.got.trades !== st.coin) { st.trades = []; st.got.trades = st.coin; }
      var have = Object.create(null);
      st.trades.forEach(function (t) { if (t.id != null) have[t.id] = true; });
      fresh = fresh.filter(function (t) { return t.id == null || !have[t.id]; });
      st.trades = fresh.concat(st.trades).sort(function (a, b) { return b.time - a.time; }).slice(0, 40);
      drawTrades();
    } else if (msg.channel === 'activeAssetCtx') {
      var m = current();
      if (!m || d.coin !== st.coin || !d.ctx) return;
      var c = d.ctx, mark = Number(c.markPx), prev = Number(c.prevDayPx);
      if (!isFinite(mark) || mark <= 0) return;
      m.mark = mark;
      m.oracle = Number(c.oraclePx) || m.oracle;
      m.fundingHourly = Number(c.funding) || 0;
      m.openInterestUsd = (Number(c.openInterest) || 0) * mark;
      m.volume24hUsd = Number(c.dayNtlVlm) || m.volume24hUsd;
      if (prev) m.change24hPct = ((mark - prev) / prev) * 100;
      st.got.ctx = d.coin;
      renderStats();
    }
  }

  function closeStream() {
    if (st.stream) st.stream.close();
    st.stream = null;
    st.wsOpen = false;
    st.got = {};
  }
  function openStream() {
    closeStream();
    if (!st.active) return;
    st.stream = window.HL.stream({
      onMessage: onStream,
      onOpen: function () { st.wsOpen = true; stopPolling(); setNote('live'); },
      // Keep the page moving on the slower path while the stream reconnects.
      onDown: function () { st.wsOpen = false; st.got = {}; if (st.active) { startPolling(); setNote('poll'); } },
      onRetry: function () { if (st.active) loadCandles(); }
    });
    st.stream.set(wanted());
  }

  // ---------- page lifecycle ----------
  function setCoin(coin) {
    st.coin = coin;
    st.fitted = '';
    st.trades = [];
    try { localStorage.setItem('nt.coin', coin); } catch (e) { /* ignore */ }
    renderPicker();
    renderStats();
    clearChart();
    loadCandles();
    loadBook();
    loadTrades();
    resubscribe();
  }

  var marketsTimer = null;
  function stop() {
    st.active = false;
    clearTimeout(st.historyRetry);
    stopPolling();
    clearInterval(marketsTimer);
    closeStream();
  }
  function start() {
    st.active = true;
    setNote('wait');
    renderIntervals();
    loadMarkets().then(function () {
      if (!st.active) return;
      loadCandles();
      loadBook();
      loadTrades();
      // Demo data has no exchange behind it, so it only polls (unless a test stream is supplied).
      if (!window.HL.canStream()) { startPolling(); setNote('demo'); }
      else { startPolling(); openStream(); }
    });
    marketsTimer = setInterval(loadMarkets, 15000);
  }

  // Lets the screener and the search box open a market here.
  window.HalftoneMarkets = {
    open: function (coin) {
      if (st.active) { if (coin !== st.coin) setCoin(coin); return; }
      st.coin = coin;
      try { localStorage.setItem('nt.coin', coin); } catch (e) { /* ignore */ }
    }
  };

  var onPage = false;
  $('mSelect').addEventListener('change', function (e) { setCoin(e.target.value); });
  document.addEventListener('nt:view', function (e) {
    stop();
    onPage = e.detail === 'markets';
    if (onPage && !document.hidden) start();
  });
  // A tab in the background holds no stream and runs no timers; it starts afresh on return.
  document.addEventListener('visibilitychange', function () {
    if (!onPage) return;
    if (document.hidden) stop(); else start();
  });
})();
