// Market data access for the Markets and Radar pages.
//
// History is fetched from the exchange by the browser itself where possible. The exchange
// allows each address a fixed number of requests a minute; asked for by a million browsers
// directly, that is a million allowances, where routed through our server it would be one.
// Our server remains the fallback (and the only source in demo mode). Live ticks arrive
// over one stream connection to the exchange, shared by whatever the page is showing.
window.HL = (function () {
  'use strict';
  var HTTP = window.HALFTONE_HL_HTTP || 'https://api.hyperliquid.xyz/info';
  var WS = window.HALFTONE_HL_WS || 'wss://api.hyperliquid.xyz/ws';
  var STEP = { '5m': 300000, '15m': 900000, '1h': 3600000, '4h': 14400000, '1d': 86400000 };
  var forced = Boolean(window.HALFTONE_HL_HTTP || window.HALFTONE_HL_WS); // tests point these at a stand-in
  var demo = null;        // unknown until the market list has been loaded once
  var directOffUntil = 0; // after a failed direct call, use our server for a while

  // A request that gets no answer is given up on, so the page can fall back or say so.
  function limit() { return window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(7000) : undefined; }
  // Candles exactly as a chart needs them: complete numbers, oldest first, one per time.
  function clean(list) {
    var ok = list.filter(function (c) { return c.time > 0 && [c.open, c.high, c.low, c.close].every(function (n) { return isFinite(n) && n > 0; }) && isFinite(c.volume); })
      .sort(function (a, b) { return a.time - b.time; });
    var out = [];
    ok.forEach(function (c) { if (out.length && out[out.length - 1].time === c.time) out[out.length - 1] = c; else out.push(c); });
    return out.slice(-700);
  }
  function server(url) {
    return fetch(url, { signal: limit() }).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) throw new Error(d.error);
      return d;
    });
  }
  function direct(body) {
    return fetch(HTTP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: limit() }).then(function (r) {
      if (!r.ok) throw new Error('exchange ' + r.status);
      return r.json();
    });
  }
  function canDirect() { return (demo === false || forced) && Date.now() >= directOffUntil; }
  // Runs the direct request; on any failure switches to our server for a minute and
  // answers from there, so a blocked or failing direct path costs one retry, not an error.
  function withFallback(body, shape, serverUrl, pick) {
    var viaServer = function () { return server(serverUrl).then(pick); };
    if (!canDirect()) return viaServer();
    return direct(body).then(shape).catch(function () {
      directOffUntil = Date.now() + 60000;
      return viaServer();
    });
  }

  function markets() {
    return server('/api/markets').then(function (d) {
      demo = Boolean(d.demo);
      return d;
    });
  }

  function candles(coin, interval, bars) {
    var step = STEP[interval] || STEP['15m'];
    var end = Math.floor(Date.now() / step) * step + step;
    return withFallback(
      { type: 'candleSnapshot', req: { coin: coin, interval: interval, startTime: end - (bars || 300) * step, endTime: end } },
      function (rows) {
        if (!Array.isArray(rows)) throw new Error('unexpected answer');
        return clean(rows.map(function (c) { return { time: Math.floor(c.t / 1000), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v) }; }));
      },
      '/api/markets/candles?coin=' + encodeURIComponent(coin) + '&interval=' + encodeURIComponent(interval) + ((bars || 300) > 300 ? '&bars=600' : ''),
      function (d) { return clean(Array.isArray(d.candles) ? d.candles : []); }
    );
  }

  function depth(coin, sig) {
    var side = function (levels) { return (levels || []).map(function (l) { return { px: Number(l.px), sz: Number(l.sz) }; }).filter(function (l) { return l.px > 0 && l.sz > 0; }); };
    return withFallback(
      { type: 'l2Book', coin: coin, nSigFigs: sig || 3 },
      function (d) {
        if (!d || !d.levels) throw new Error('unexpected answer');
        return { bids: side(d.levels[0]), asks: side(d.levels[1]) };
      },
      '/api/markets/depth?coin=' + encodeURIComponent(coin) + '&sig=' + (sig || 3),
      function (d) { return { bids: d.bids || [], asks: d.asks || [] }; }
    );
  }

  function funding(coin) {
    var hour = 3600000;
    return withFallback(
      { type: 'fundingHistory', coin: coin, startTime: Math.floor(Date.now() / hour) * hour - 7 * 24 * hour },
      function (rows) {
        if (!Array.isArray(rows)) throw new Error('unexpected answer');
        return rows.map(function (f) { return { time: Number(f.time), rate: Number(f.fundingRate) }; }).filter(function (f) { return isFinite(f.rate) && isFinite(f.time); })
          .sort(function (a, b) { return a.time - b.time; });
      },
      '/api/markets/funding?coin=' + encodeURIComponent(coin),
      function (d) { return d.history || []; }
    );
  }

  // One live connection to the exchange. `set(subs)` says what to listen to; only the
  // differences are sent. It reconnects by itself, waiting longer after each failure (up
  // to a minute, never in step with other browsers), and tells its owner when it is up
  // (`onOpen`) or down (`onDown`) so the owner can poll in the meantime.
  function stream(h) {
    var ws = null, open = false, want = [], have = [], retry = 0, timer = null, stable = null, ping = null, lastMsg = 0, closed = false;
    var key = function (s) { return JSON.stringify(s); };
    function send(obj) { if (ws && open) ws.send(JSON.stringify(obj)); }
    function sync() {
      if (!open) return;
      var wk = want.map(key), hk = have.map(key);
      have.forEach(function (s, i) { if (wk.indexOf(hk[i]) === -1) send({ method: 'unsubscribe', subscription: s }); });
      want.forEach(function (s, i) { if (hk.indexOf(wk[i]) === -1) send({ method: 'subscribe', subscription: s }); });
      have = want.slice();
    }
    function drop() {
      clearTimeout(timer); clearTimeout(stable); clearInterval(ping);
      if (ws) { ws.onclose = null; ws.onerror = null; ws.onmessage = null; ws.onopen = null; try { ws.close(); } catch (e) { /* ignore */ } }
      ws = null; open = false; have = [];
    }
    function connect() {
      drop();
      if (closed) return;
      var sock;
      try { sock = new WebSocket(WS); } catch (e) {
        if (h.onDown) h.onDown();
        retry = Math.min(retry + 1, 6);
        timer = setTimeout(connect, Math.min(60000, 1000 * Math.pow(2, retry)));
        return;
      }
      ws = sock;
      sock.onopen = function () {
        open = true;
        lastMsg = Date.now();
        // The failure count is forgotten only after the connection has held for a while,
        // so a server that accepts and then drops is not hammered.
        stable = setTimeout(function () { retry = 0; }, 30000);
        sync();
        if (h.onOpen) h.onOpen();
        ping = setInterval(function () {
          if (Date.now() - lastMsg > 45000) { try { sock.close(); } catch (e) { /* ignore */ } return; }
          send({ method: 'ping' });
        }, 20000);
      };
      sock.onmessage = function (e) {
        lastMsg = Date.now();
        var msg;
        try { msg = JSON.parse(e.data); } catch (err) { return; }
        if (msg && msg.data && h.onMessage) h.onMessage(msg);
      };
      sock.onclose = function () {
        open = false; have = [];
        clearInterval(ping); clearTimeout(stable);
        if (closed) return;
        if (h.onDown) h.onDown();
        retry = Math.min(retry + 1, 6);
        var wait = Math.min(60000, 1000 * Math.pow(2, retry)) * (0.5 + Math.random());
        timer = setTimeout(function () { if (h.onRetry) h.onRetry(); connect(); }, wait);
      };
      sock.onerror = function () { /* onclose follows and handles it */ };
    }
    connect();
    return {
      set: function (subs) { want = subs.slice(); sync(); },
      isOpen: function () { return open; },
      close: function () { closed = true; drop(); }
    };
  }

  // Charts are given real (UTC) times and only the labels are put in the viewer's own
  // time zone. Shifting the times themselves breaks twice a year, when two different hours
  // land on the same clock time, and puts every daily candle under the wrong date for
  // anyone west of UTC. Daily candles are UTC days, so they are labelled by their UTC date.
  // Colours for charts and canvases, which cannot use CSS variables directly.
  var THEME = {
    text: '#2F4A3C', grid: 'rgba(143, 176, 155, .28)', border: '#C3D7CA',
    up: '#12A05C', down: '#D9534A', upRgb: '18, 160, 92', downRgb: '217, 83, 74',
    ema9: '#C99700', ema21: '#1D7FC4', ema50: '#7B5CD6', ema200: '#D0673A', vwap: '#0F2A1D',
    pivot: '#587166', prior: '#B78900', profile: '#0E9C87', profileRgb: '14, 156, 135', wall: '#1D7FC4', liqRgb: '201, 151, 0'
  };
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function chartTime(getInterval) {
    var two = function (n) { return String(n).padStart(2, '0'); };
    var parts = function (sec) {
      var d = new Date(sec * 1000), utc = getInterval() === '1d';
      return utc
        ? { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: 0, mi: 0, daily: true }
        : { y: d.getFullYear(), mo: d.getMonth(), d: d.getDate(), h: d.getHours(), mi: d.getMinutes(), daily: false };
    };
    return {
      timeFormatter: function (sec) {
        var p = parts(sec);
        return p.d + ' ' + MONTHS[p.mo] + (p.daily ? ' ' + p.y + ' (UTC day)' : ' ' + two(p.h) + ':' + two(p.mi));
      },
      tickMarkFormatter: function (sec, type) {
        var p = parts(sec);
        if (type === 0) return String(p.y);
        if (type === 1) return MONTHS[p.mo];
        if (p.daily) return String(p.d);
        var clock = two(p.h) + ':' + two(p.mi);
        // The chart places day marks at midnight UTC, which is mid-day or evening elsewhere.
        if (type === 2) return clock === '00:00' ? p.d + ' ' + MONTHS[p.mo] : p.d + ' ' + clock;
        return clock;
      }
    };
  }

  return { chartTime: chartTime, theme: THEME,
    markets: markets, candles: candles, depth: depth, funding: funding, stream: stream,
    isDemo: function () { return demo === true; },
    // In demo mode there is no exchange behind the numbers, so nothing to stream.
    canStream: function () { return demo === false || forced; },
    STEP: STEP
  };
})();
