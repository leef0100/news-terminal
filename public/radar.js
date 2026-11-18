// Radar page: cross-exchange positioning, funding heatmap and large trades.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var timer = null;
  var HEAT_VENUES = ['Binance', 'Bybit', 'Hyperliquid'];

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
  function price(n) {
    if (n == null) return 'n/a';
    if (n >= 1000) return '$' + n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (n >= 1) return '$' + n.toFixed(2);
    return '$' + n.toPrecision(4);
  }
  function clock(ts) {
    var d = new Date(ts);
    var p = function (x) { return String(x).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function signed(n, digits) { return (n > 0 ? '+' : '') + n.toFixed(digits) + '%'; }

  // A long/short split bar. The numbers are always printed, so colour is never the only cue.
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

  function renderVenues(venues) {
    var box = $('venues');
    box.textContent = '';
    venues.forEach(function (v) {
      var state = v.ok ? (v.partial ? 'part' : 'ok') : 'off';
      var chip = el('span', 'venue ' + state);
      chip.appendChild(el('span', 'dot'));
      chip.appendChild(el('b', null, v.name));
      chip.appendChild(el('span', null, v.ok ? (v.partial ? 'partial' : 'live') : 'unavailable'));
      if (v.error) chip.title = v.error;
      box.appendChild(chip);
    });
  }

  function renderCoins(coins) {
    var box = $('radarCoins');
    box.textContent = '';
    coins.forEach(function (c) {
      var card = el('article', 'card coin tilt-' + c.tilt);
      var head = el('div', 'coinHead');
      head.appendChild(el('span', 'coinName', c.coin));
      head.appendChild(el('span', 'mono', price(c.price)));
      var label = { long: 'Tilted long', short: 'Tilted short', balanced: 'Balanced', unknown: 'No data' }[c.tilt];
      head.appendChild(el('span', 'tiltTag', label));
      card.appendChild(head);

      if (c.blendedLongPct != null) card.appendChild(splitBar(c.blendedLongPct, true));
      card.appendChild(el('p', 'note', c.note));

      if (c.positioning.length) {
        var rows = el('div', 'venueRows');
        c.positioning.forEach(function (p) {
          var row = el('div', 'venueRow');
          var name = el('span', 'vName');
          name.appendChild(el('b', null, p.venue));
          name.appendChild(el('span', 'muted', p.label));
          row.appendChild(name);
          row.appendChild(splitBar(p.longPct, false));
          rows.appendChild(row);
        });
        card.appendChild(rows);
      }

      var foot = el('div', 'coinFoot');
      var oi = el('span');
      oi.appendChild(el('i', null, 'Open interest'));
      oi.appendChild(el('b', null, c.openInterestUsd ? money(c.openInterestUsd) : 'n/a'));
      foot.appendChild(oi);
      var prem = el('span');
      prem.appendChild(el('i', null, 'Coinbase premium'));
      prem.appendChild(el('b', null, c.coinbasePremiumPct == null ? 'n/a' : signed(c.coinbasePremiumPct, 3)));
      foot.appendChild(prem);
      card.appendChild(foot);
      box.appendChild(card);
    });
  }

  function renderHeat(coins) {
    var table = $('heat');
    table.textContent = '';
    var head = el('tr');
    head.appendChild(el('th', null, 'Coin'));
    HEAT_VENUES.forEach(function (v) { var th = el('th', null, v); th.scope = 'col'; head.appendChild(th); });
    table.appendChild(head);
    coins.forEach(function (c) {
      var tr = el('tr');
      var th = el('th', null, c.coin);
      th.scope = 'row';
      tr.appendChild(th);
      HEAT_VENUES.forEach(function (v) {
        var f = c.funding.filter(function (x) { return x.venue === v; })[0];
        var td = el('td', 'mono', f ? signed(f.annualPct, 1) : '—');
        if (f) {
          // Strength scales with the rate and tops out at 40% a year.
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

  function renderTrades(list, minUsd) {
    $('bigNote').textContent = 'Hyperliquid trades of ' + money(minUsd) + ' or more. A trade can open or close a position; the feed cannot tell which.';
    var box = $('bigTrades');
    box.textContent = '';
    if (!list.length) box.appendChild(el('p', 'muted', 'No large trades in the latest window.'));
    list.slice(0, 18).forEach(function (t) {
      var row = el('div', 'tapeRow ' + t.side);
      row.appendChild(el('span', 'mono muted', clock(t.time)));
      row.appendChild(el('b', null, t.coin));
      row.appendChild(el('span', 'side', t.side === 'buy' ? 'BUY' : 'SELL'));
      row.appendChild(el('span', 'mono', money(t.usd)));
      row.appendChild(el('span', 'mono muted', price(t.px)));
      box.appendChild(row);
    });
  }

  function load() {
    fetch('/api/radar').then(function (r) { return r.json(); }).then(function (d) {
      if (d.error) throw new Error(d.error);
      $('radarState').hidden = true;
      $('radarAt').textContent = 'Updated ' + clock(d.at) + ' · refreshes every 15 seconds';
      renderVenues(d.venues);
      renderCoins(d.coins);
      renderHeat(d.coins);
      renderTrades(d.bigTrades, d.bigTradeUsd);
    }).catch(function () {
      $('radarState').hidden = false;
      $('radarState').textContent = 'Radar data is unavailable right now. Retrying.';
    });
  }

  var onPage = false;
  function run() {
    clearInterval(timer);
    timer = null;
    // Nothing is fetched while the page is not on screen or the tab is in the background.
    if (!onPage || document.hidden) return;
    load();
    timer = setInterval(load, 15000);
  }
  document.addEventListener('nt:view', function (e) { onPage = e.detail === 'radar'; run(); });
  document.addEventListener('visibilitychange', run);
})();
