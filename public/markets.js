// Markets page: candle chart, order book, trades and market stats from Hyperliquid's public data.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var INTERVALS = ['5m', '15m', '1h', '4h', '1d'];
  var st = { coin: 'BTC', interval: '15m', markets: [], timers: [], chart: null, candles: null, volume: null, fitted: '' };
  try {
    st.coin = localStorage.getItem('nt.coin') || 'BTC';
    st.interval = localStorage.getItem('nt.interval') || '15m';
  } catch (e) { /* storage unavailable */ }
  if (INTERVALS.indexOf(st.interval) === -1) st.interval = '15m';

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
  function px(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    if (n >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    if (n >= 1) return n.toFixed(3);
    return n.toPrecision(4);
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

  function setCoin(coin) {
    st.coin = coin;
    st.fitted = '';
    try { localStorage.setItem('nt.coin', coin); } catch (e) { /* ignore */ }
    renderPicker();
    renderStats();
    loadCandles();
    loadBook();
    loadTrades();
  }

  function renderPicker() {
    var box = $('mCoins');
    box.textContent = '';
    st.markets.slice(0, 6).forEach(function (m) {
      var on = m.coin === st.coin;
      var b = el('button', 'kind k-crypto' + (on ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      b.appendChild(el('span', 'tick', m.coin));
      var ch = el('span', 'n', signed(m.change24hPct, 1));
      b.appendChild(ch);
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
        loadCandles();
      });
      box.appendChild(b);
    });
  }

  function ensureChart() {
    if (st.chart || !window.LightweightCharts) return;
    st.chart = window.LightweightCharts.createChart($('mChart'), {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: '#C2D4CA', fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { vertLines: { color: 'rgba(50, 80, 64, .5)' }, horzLines: { color: 'rgba(50, 80, 64, .5)' } },
      rightPriceScale: { borderColor: '#325040' },
      timeScale: { borderColor: '#325040', timeVisible: true, secondsVisible: false },
      crosshair: { mode: 0 }
    });
    st.candles = st.chart.addCandlestickSeries({ upColor: '#6BE89A', borderUpColor: '#6BE89A', wickUpColor: '#6BE89A', downColor: '#F2876B', borderDownColor: '#F2876B', wickDownColor: '#F2876B' });
    st.volume = st.chart.addHistogramSeries({ priceScaleId: '', priceFormat: { type: 'volume' } });
    st.volume.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
  }

  function loadCandles() {
    var coin = st.coin, interval = st.interval;
    get('/api/markets/candles?coin=' + encodeURIComponent(coin) + '&interval=' + interval).then(function (d) {
      if (coin !== st.coin || interval !== st.interval) return;
      ensureChart();
      if (!st.chart) { $('mState').textContent = 'The chart library did not load.'; return; }
      $('mState').textContent = d.candles.length ? '' : 'No candles for this market yet.';
      // The chart library draws UTC; shift the candles so the axis reads in local time.
      var shift = new Date().getTimezoneOffset() * 60;
      d.candles.forEach(function (c) { c.time -= shift; });
      st.candles.setData(d.candles);
      st.volume.setData(d.candles.map(function (c) { return { time: c.time, value: c.volume, color: c.close >= c.open ? 'rgba(107, 232, 154, .35)' : 'rgba(242, 135, 107, .35)' }; }));
      // Fit once per market and interval, then leave the user's zoom and scroll alone.
      if (st.fitted !== coin + interval) { st.chart.timeScale().fitContent(); st.fitted = coin + interval; }
    }).catch(function () { $('mState').textContent = 'Candles are unavailable right now. Retrying.'; });
  }

  function loadBook() {
    var coin = st.coin;
    get('/api/markets/book?coin=' + encodeURIComponent(coin)).then(function (d) {
      if (coin !== st.coin) return;
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
      var mid = el('div', 'bookMid');
      mid.appendChild(el('b', 'mono', d.mid == null ? 'n/a' : px(d.mid)));
      mid.appendChild(el('span', 'muted', d.spread == null ? '' : 'spread ' + px(d.spread) + ' (' + ((d.spread / d.mid) * 100).toFixed(3) + '%)'));
      box.appendChild(mid);
      bids.forEach(function (l, i) { box.appendChild(row(l, bidTot[i], 'bid')); });
    }).catch(function () { $('book').textContent = 'Order book is unavailable right now.'; });
  }

  function loadTrades() {
    var coin = st.coin;
    get('/api/markets/trades?coin=' + encodeURIComponent(coin)).then(function (d) {
      if (coin !== st.coin) return;
      var box = $('mTrades');
      box.textContent = '';
      d.trades.slice(0, 16).forEach(function (t) {
        var row = el('div', 'tapeRow ' + t.side);
        row.appendChild(el('span', 'mono muted', clock(t.time)));
        row.appendChild(el('span', 'side', t.side === 'buy' ? 'BUY' : 'SELL'));
        row.appendChild(el('span', 'mono', px(t.px)));
        row.appendChild(el('span', 'mono', money(t.usd)));
        box.appendChild(row);
      });
    }).catch(function () { $('mTrades').textContent = 'Trades are unavailable right now.'; });
  }

  function loadMarkets() {
    return get('/api/markets').then(function (d) {
      st.markets = d.markets || [];
      if (st.markets.length && !current()) st.coin = st.markets[0].coin;
      renderPicker();
      renderStats();
    }).catch(function () { $('mState').textContent = 'Market list is unavailable right now. Retrying.'; });
  }

  function stop() { st.timers.forEach(clearInterval); st.timers = []; }
  function start() {
    renderIntervals();
    loadMarkets().then(function () { loadCandles(); loadBook(); loadTrades(); });
    st.timers = [
      setInterval(loadMarkets, 10000),
      setInterval(loadCandles, 10000),
      setInterval(loadBook, 1500),
      setInterval(loadTrades, 3000)
    ];
  }

  $('mSelect').addEventListener('change', function (e) { setCoin(e.target.value); });
  document.addEventListener('nt:view', function (e) {
    stop();
    if (e.detail === 'markets') start();
  });
})();
