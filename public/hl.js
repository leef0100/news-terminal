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

  function server(url) {
    return fetch(url).then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) throw new Error(d.error);
      return d;
    });
  }
  function direct(body) {
    return fetch(HTTP, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).then(function (r) {
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
        return rows.map(function (c) { return { time: Math.floor(c.t / 1000), open: Number(c.o), high: Number(c.h), low: Number(c.l), close: Number(c.c), volume: Number(c.v) }; })
          .filter(function (c) { return isFinite(c.close) && c.time > 0; });
      },
      '/api/markets/candles?coin=' + encodeURIComponent(coin) + '&interval=' + encodeURIComponent(interval),
      function (d) { return d.candles || []; }
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
      try { sock = new WebSocket(WS); } catch (e) { if (h.onDown) h.onDown(); return; }
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

  return {
    markets: markets, candles: candles, depth: depth, funding: funding, stream: stream,
    isDemo: function () { return demo === true; },
    // In demo mode there is no exchange behind the numbers, so nothing to stream.
    canStream: function () { return demo === false || forced; },
    STEP: STEP
  };
})();
