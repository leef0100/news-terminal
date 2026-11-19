// The desk tools around the main pages: the all-markets table on Markets, the Status
// page, and the search box (Ctrl or Cmd + K) that jumps to a page, a market or a headline.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function getJson(url) {
    return fetch(url, { headers: { accept: 'application/json' } }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    });
  }
  function money(n) {
    if (n == null || !isFinite(n)) return 'n/a';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
    return '$' + n.toFixed(0);
  }
  function price(n) {
    if (n == null || !isFinite(n) || n <= 0) return 'n/a';
    var d = n >= 10000 ? 1 : n >= 100 ? 2 : n >= 1 ? 4 : n >= 0.01 ? 5 : 8;
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function signed(n, d) { return (n > 0 ? '+' : '') + n.toFixed(d == null ? 2 : d) + '%'; }
  function ago(ts, now) {
    if (!ts) return 'never';
    var s = Math.max(0, Math.round((now - ts) / 1000));
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  function span(sec) {
    if (sec == null) return 'n/a';
    if (sec < 90) return sec + 's';
    if (sec < 5400) return Math.round(sec / 60) + ' min';
    return (sec / 3600).toFixed(1) + ' h';
  }
  var view = 'home';

  // ---------- all markets ----------
  var sc = { rows: [], sort: 'volume24hUsd', dir: -1, filter: '', timer: null, demo: false };
  var COLS = [
    { id: 'coin', label: 'Market', text: true },
    { id: 'mark', label: 'Price' },
    { id: 'change24hPct', label: '24h' },
    { id: 'volume24hUsd', label: 'Volume, 24h' },
    { id: 'openInterestUsd', label: 'Open interest' },
    { id: 'fundingYear', label: 'Funding, yearly' }
  ];
  function drawScreener() {
    var table = $('screener');
    var q = sc.filter.trim().toUpperCase();
    var rows = sc.rows.filter(function (m) { return !q || m.coin.toUpperCase().indexOf(q) !== -1; });
    rows.sort(function (a, b) {
      var x = a[sc.sort], y = b[sc.sort];
      if (typeof x === 'string') return sc.dir * x.localeCompare(y);
      return sc.dir * (x - y);
    });
    var frag = document.createDocumentFragment();
    var head = el('tr');
    COLS.forEach(function (c) {
      var th = el('th');
      th.scope = 'col';
      if (sc.sort === c.id) th.setAttribute('aria-sort', sc.dir === 1 ? 'ascending' : 'descending');
      var b = el('button', 'thBtn' + (sc.sort === c.id ? ' on' : ''), c.label + (sc.sort === c.id ? (sc.dir === 1 ? ' ▲' : ' ▼') : ''));
      b.type = 'button';
      b.dataset.fk = 'sc-' + c.id;
      b.addEventListener('click', function () {
        if (sc.sort === c.id) sc.dir = -sc.dir; else { sc.sort = c.id; sc.dir = c.text ? 1 : -1; }
        drawScreener();
        var again = table.querySelector('[data-fk="sc-' + c.id + '"]');
        if (again) again.focus();
      });
      th.appendChild(b);
      head.appendChild(th);
    });
    frag.appendChild(head);
    rows.forEach(function (m) {
      var tr = el('tr');
      var name = el('td');
      var open = el('button', 'linkBtn strong', m.coin);
      open.type = 'button';
      open.setAttribute('aria-label', 'Open the ' + m.coin + ' chart');
      open.addEventListener('click', function () {
        if (window.HalftoneMarkets) window.HalftoneMarkets.open(m.coin);
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      name.appendChild(open);
      tr.appendChild(name);
      tr.appendChild(el('td', 'mono', price(m.mark)));
      tr.appendChild(el('td', 'mono ' + (m.change24hPct > 0 ? 'up' : m.change24hPct < 0 ? 'down' : ''), signed(m.change24hPct)));
      tr.appendChild(el('td', 'mono', money(m.volume24hUsd)));
      tr.appendChild(el('td', 'mono', money(m.openInterestUsd)));
      tr.appendChild(el('td', 'mono ' + (m.fundingYear > 0 ? 'up' : m.fundingYear < 0 ? 'down' : ''), signed(m.fundingYear, 1)));
      frag.appendChild(tr);
    });
    table.replaceChildren(frag);
    $('scCount').textContent = rows.length === sc.rows.length ? rows.length + ' markets' : rows.length + ' of ' + sc.rows.length;
    $('scNote').textContent = sc.rows.length
      ? 'Perpetual markets on Hyperliquid. Funding is the current hourly rate carried over a year: positive means longs pay shorts.' + (sc.demo ? ' Demo figures: invented, not the market.' : '')
      : '';
  }
  function loadScreener() {
    window.HL.markets().then(function (d) {
      sc.demo = Boolean(d.demo);
      sc.rows = (d.markets || []).map(function (m) {
        // Hourly funding carried over a year, as a percentage.
        return Object.assign({}, m, { fundingYear: (m.fundingHourly || 0) * 24 * 365 * 100 });
      });
      if (view === 'markets') drawScreener();
    }).catch(function () {
      if (!sc.rows.length) $('scNote').textContent = 'The market list could not be loaded. Trying again shortly.';
    });
  }
  $('scFilter').addEventListener('input', function (e) { sc.filter = e.target.value; drawScreener(); });

  // ---------- status ----------
  var stTimer = null;
  var SUPPLIES = {
    Binance: 'Long and short accounts, top-trader positions, funding, open interest',
    Bybit: 'Long and short accounts, funding, open interest',
    Hyperliquid: 'Prices, candles, order book, trades, funding',
    Coinbase: 'Spot price, for the Coinbase premium',
    Papertrade: 'Nothing: it publishes no public data'
  };
  var STATE = { ok: ['Reporting', 'good'], failing: ['Failing', 'bad'], waiting: ['First check pending', 'wait'], unknown: ['No stories yet', 'wait'] };
  function pill(text, tone) { return el('span', 'stPill ' + tone, text); }
  function tile(label, value, sub) {
    var d = el('div', 'stTile');
    d.appendChild(el('span', 'statLabel', label));
    d.appendChild(el('b', 'statValue', value));
    if (sub) d.appendChild(el('span', 'muted small', sub));
    return d;
  }
  function headRow(labels) {
    var tr = el('tr');
    labels.forEach(function (l) { var th = el('th', null, l); th.scope = 'col'; tr.appendChild(th); });
    return tr;
  }
  function drawStatus(s) {
    var now = s.at;
    var feeds = s.feed.sources.slice().sort(function (a, b) {
      var bad = (b.state === 'failing') - (a.state === 'failing');
      return bad || (b.newestStory || 0) - (a.newestStory || 0);
    });
    var reporting = feeds.filter(function (f) { return f.state === 'ok'; }).length;
    var failing = feeds.filter(function (f) { return f.state === 'failing'; }).length;
    var delays = feeds.filter(function (f) { return f.medianDelaySeconds != null; }).map(function (f) { return f.medianDelaySeconds; }).sort(function (a, b) { return a - b; });
    var venues = s.market.venues.filter(function (v) { return v.name !== 'Papertrade'; });
    var venuesOk = venues.filter(function (v) { return v.ok && !v.partial; }).length;

    $('stState').hidden = true;
    $('stAt').textContent = 'Checked ' + new Date(now).toLocaleTimeString([], { hour12: false }) + (s.demo ? ' · demo data' : '');
    var sum = document.createDocumentFragment();
    sum.appendChild(tile('News sources reporting', reporting + ' of ' + feeds.length, failing ? failing + ' failing' : 'None failing'));
    sum.appendChild(tile('Newest story', ago(s.feed.newestStory, now), s.feed.stories + ' stories held'));
    sum.appendChild(tile('Typical delay', delays.length ? span(delays[Math.floor(delays.length / 2)]) : 'n/a', delays.length ? 'Publisher timestamp to here' : 'Needs stories that arrive while running'));
    sum.appendChild(tile('Market venues answering', venuesOk + ' of ' + venues.length, 'Sources checked every ' + s.pollSeconds + 's'));
    sum.appendChild(tile('People connected', String(s.viewers.feed + s.viewers.chat), 'To this server, of ' + s.viewers.limit.toLocaleString('en-US')));
    $('stSummary').replaceChildren(sum);

    var ft = document.createDocumentFragment();
    ft.appendChild(headRow(['Source', 'State', 'Newest story', 'Typical delay', 'Stories held', 'Last checked']));
    feeds.forEach(function (f) {
      var tr = el('tr');
      var name = el('td');
      name.appendChild(el('b', null, f.name));
      if (f.error) name.appendChild(el('div', 'muted small', f.error));
      tr.appendChild(name);
      var st = STATE[f.state] || STATE.unknown;
      var cell = el('td'); cell.appendChild(pill(st[0], st[1])); tr.appendChild(cell);
      tr.appendChild(el('td', 'mono', f.newestStory ? ago(f.newestStory, now) : 'none'));
      tr.appendChild(el('td', 'mono', f.medianDelaySeconds == null ? 'n/a' : span(f.medianDelaySeconds) + ' (' + f.timedStories + ')'));
      tr.appendChild(el('td', 'mono', String(f.stories)));
      tr.appendChild(el('td', 'mono', f.lastCheck ? ago(f.lastCheck, now) + (f.responseMs != null ? ' · ' + f.responseMs + ' ms' : '') : 'n/a'));
      ft.appendChild(tr);
    });
    $('stFeeds').replaceChildren(ft);
    $('stFeedNote').textContent = s.demo ? 'Demo sources. Their stories are invented.' : 'The number in brackets is how many stories the delay is measured over.';

    var vt = document.createDocumentFragment();
    vt.appendChild(headRow(['Venue', 'State', 'Supplies', 'Detail']));
    s.market.venues.forEach(function (v) {
      var tr = el('tr');
      var n = el('td'); n.appendChild(el('b', null, v.name)); tr.appendChild(n);
      var none = v.name === 'Papertrade';
      var c = el('td');
      c.appendChild(none ? pill('Not available', 'wait') : v.ok && !v.partial ? pill('Answering', 'good') : v.ok ? pill('Partly answering', 'wait') : pill('Not answering', 'bad'));
      tr.appendChild(c);
      tr.appendChild(el('td', null, SUPPLIES[v.name] || ''));
      tr.appendChild(el('td', 'muted small', v.error || (none ? '' : 'No errors on the last check')));
      vt.appendChild(tr);
    });
    $('stVenues').replaceChildren(vt);
    var rt = document.createDocumentFragment();
    rt.appendChild(headRow(['Source', 'State', 'Detail', 'Last answered']));
    ((s.tradfi && s.tradfi.sources) || []).forEach(function (r) {
      var tr = el('tr');
      var n = el('td'); n.appendChild(el('b', null, r.name)); tr.appendChild(n);
      var c = el('td');
      c.appendChild(r.state === 'ok' ? pill('Answering', 'good') : r.state === 'off' ? pill('Not connected', 'wait') : pill('Failing', 'bad'));
      tr.appendChild(c);
      tr.appendChild(el('td', 'muted small', r.note || r.lastError || ''));
      tr.appendChild(el('td', 'mono', r.lastOk ? ago(r.lastOk, now) : 'n/a'));
      rt.appendChild(tr);
    });
    $('stRef').replaceChildren(rt);
    $('stRefCard').hidden = !(s.tradfi && s.tradfi.sources && s.tradfi.sources.length);
    var ex = s.market.exchange || {};
    $('stMktNote').textContent = s.demo ? 'Demo venues. Their figures are invented.'
      : 'Positioning checked ' + ago(s.market.at, now) + '. Hyperliquid last answered this server ' + ago(ex.lastOk, now) + '; ' + (ex.spentThisMinute || 0) + ' of ' + (ex.allowancePerMinute || 0) + ' of its request allowance used this minute.';
  }
  function loadStatus() {
    getJson('/api/status').then(function (s) { if (view === 'status') drawStatus(s); }).catch(function () {
      $('stState').hidden = false;
      $('stState').textContent = 'The status check did not get an answer. Trying again shortly.';
    });
  }

  // ---------- search and jump ----------
  var pal = { items: [], shown: [], at: 0, feed: [], markets: [] };
  var PAGES = [
    ['Home', '#home', 'Front page'], ['News', '#news', 'The live feed'], ['Breaking', '#breaking', 'The most immediate stories, with chat'],
    ['Stocks', '#stocks', 'Indexes, companies, charts and financial reports'], ['Calendar', '#calendar', 'Earnings, IPOs, economic releases and central banks'], ['Private', '#private', 'IPO pipeline and private fundraising filings'], ['Indexes', '#indexes', 'AI infrastructure: GPU, compute, inference, energy, data centers'], ['Paper trade', '#paper', 'Go long or short on the indexes with pretend money'], ['Funds', '#funds', 'What large managers and insiders reported to the SEC'], ['Voices', '#voices', 'Market writers and their latest pieces'],
    ['Radar', '#radar', 'Crypto chart, levels, heatmaps and confluence'], ['Crypto', '#markets', 'Order book, trades and every crypto market'], ['My panel', '#panel', 'Your own feed of X accounts'], ['Status', '#status', 'Where every number comes from']
  ];
  function buildPalette() {
    var items = PAGES.map(function (p) { return { kind: 'Page', text: p[0], sub: p[2], go: function () { location.hash = p[1]; } }; });
    pal.markets.forEach(function (m) {
      items.push({ kind: 'Market', text: m.coin + ' chart and order book', sub: price(m.mark) + '  ' + signed(m.change24hPct), key: m.coin, go: function () { if (window.HalftoneMarkets) window.HalftoneMarkets.open(m.coin); location.hash = '#markets'; } });
      items.push({ kind: 'Radar', text: m.coin + ' levels and confluence', sub: 'Open in Radar', key: m.coin, go: function () { if (window.HalftoneRadar) window.HalftoneRadar.open(m.coin); location.hash = '#radar'; } });
    });
    pal.feed.forEach(function (it) {
      items.push({ kind: 'Story', text: it.text, sub: it.source, go: function () { location.hash = '#n-' + it.id; } });
    });
    pal.items = items;
  }
  function drawPalette() {
    var q = $('palInput').value.trim().toLowerCase();
    var words = q.split(/\s+/).filter(Boolean);
    var scored = [];
    pal.items.forEach(function (it, i) {
      var hay = (it.text + ' ' + (it.kind || '') + ' ' + (it.sub || '')).toLowerCase();
      if (!words.every(function (w) { return hay.indexOf(w) !== -1; })) return;
      // An exact market name first, then names that start with the query, then the rest in order.
      var rank = it.key && it.key.toLowerCase() === q ? 0 : it.text.toLowerCase().indexOf(q) === 0 ? 1 : 2;
      scored.push({ it: it, rank: q ? rank : 2, i: i });
    });
    scored.sort(function (a, b) { return a.rank - b.rank || a.i - b.i; });
    pal.shown = scored.slice(0, 12).map(function (s) { return s.it; });
    if (pal.at >= pal.shown.length) pal.at = Math.max(0, pal.shown.length - 1);
    var frag = document.createDocumentFragment();
    pal.shown.forEach(function (it, i) {
      var li = el('li', 'palItem' + (i === pal.at ? ' on' : ''));
      li.id = 'pal-' + i;
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === pal.at));
      li.appendChild(el('span', 'palKind', it.kind));
      var body = el('span', 'palBody');
      body.appendChild(el('span', 'palText', it.text));
      if (it.sub) body.appendChild(el('span', 'muted small', it.sub));
      li.appendChild(body);
      li.addEventListener('click', function () { choose(i); });
      frag.appendChild(li);
    });
    if (!pal.shown.length) frag.appendChild(el('li', 'palEmpty muted', 'Nothing matches. Try a market name such as BTC, or a word from a headline.'));
    $('palList').replaceChildren(frag);
    if (pal.shown.length) $('palInput').setAttribute('aria-activedescendant', 'pal-' + pal.at); else $('palInput').removeAttribute('aria-activedescendant');
    var on = $('palList').querySelector('.on');
    if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
  }
  function choose(i) {
    var it = pal.shown[i];
    if (!it) return;
    $('palDlg').close();
    it.go();
  }
  function openPalette() {
    var dlg = $('palDlg');
    if (dlg.open) return;
    $('palInput').value = '';
    pal.at = 0;
    buildPalette();
    drawPalette();
    dlg.showModal();
    $('palInput').focus();
    // Fresh lists arrive behind the open box.
    window.HL.markets().then(function (d) { pal.markets = (d.markets || []).slice(0, 250); buildPalette(); if (dlg.open) drawPalette(); }).catch(function () { /* pages and stories still work */ });
    getJson('/api/feed?limit=150').then(function (d) { pal.feed = (d.items || []).slice(0, 150); buildPalette(); if (dlg.open) drawPalette(); }).catch(function () { /* pages and markets still work */ });
  }
  $('palBtn').addEventListener('click', openPalette);
  $('palInput').addEventListener('input', function () { pal.at = 0; drawPalette(); });
  $('palInput').addEventListener('keydown', function (e) {
    if (e.key === 'ArrowDown') { e.preventDefault(); pal.at = Math.min(pal.shown.length - 1, pal.at + 1); drawPalette(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); pal.at = Math.max(0, pal.at - 1); drawPalette(); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(pal.at); }
  });
  $('palDlg').addEventListener('click', function (e) { if (e.target === $('palDlg')) $('palDlg').close(); });
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); }
  });
  if (/Mac|iPhone|iPad/.test(navigator.platform || '')) $('palKey').textContent = '⌘K';

  // ---------- lifecycle ----------
  function stop() {
    clearInterval(sc.timer); sc.timer = null;
    clearInterval(stTimer); stTimer = null;
  }
  function start() {
    stop();
    if (document.hidden) return;
    if (view === 'markets') { loadScreener(); sc.timer = setInterval(loadScreener, 15000); }
    if (view === 'status') { loadStatus(); stTimer = setInterval(loadStatus, 10000); }
  }
  document.addEventListener('nt:view', function (e) { view = e.detail; start(); });
  document.addEventListener('visibilitychange', start);
})();
