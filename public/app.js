(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var KINDS = [
    { id: 'all', label: 'All sources' },
    { id: 'x', label: 'X accounts' },
    { id: 'wire', label: 'Newswires' },
    { id: 'listing', label: 'Exchange listings' },
    { id: 'macro', label: 'Macro' }
  ];
  var KIND_TAG = { x: 'X', wire: 'Wire', listing: 'Listing', macro: 'Macro', stream: 'Stream' };
  var MAX_ITEMS = 300;

  var state = {
    items: [], byId: {}, kind: 'all', query: '', selected: null, fresh: {},
    keywords: load('nt.keywords', []), sound: load('nt.sound', false), soundAll: load('nt.soundAll', false),
    tokens: [], token: null, matchReq: 0, activeTerm: null
  };

  function load(key, fallback) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? fallback : v; } catch (e) { return fallback; }
  }
  function save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ } }

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function safeUrl(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null; }

  // ---------- formatting ----------
  function clock(ts) {
    var d = new Date(ts);
    var p = function (n) { return String(n).padStart(2, '0'); };
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }
  function dur(sec) {
    if (sec == null) return 'n/a';
    if (sec < 60) return sec + 's';
    if (sec < 3600) return Math.round(sec / 60) + 'm';
    if (sec < 172800) return Math.round(sec / 3600) + 'h';
    return Math.round(sec / 86400) + 'd';
  }
  function money(n) {
    if (!n) return 'n/a';
    if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
    if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return '$' + Math.round(n / 1e3) + 'k';
    return '$' + Math.round(n);
  }
  function lag(item) {
    if (item.backfill) return '';
    var ms = item.seenAt - item.ts;
    if (!(ms >= 0) || ms > 3600000) return '';
    return ms < 60000 ? '+' + (ms / 1000).toFixed(1) + 's' : '+' + Math.round(ms / 60000) + 'm';
  }
  function shortAddr(a) { return a.length > 10 ? a.slice(0, 4) + '…' + a.slice(-4) : a; }

  // ---------- feed ----------
  function keywordHits(item) {
    var t = item.text.toLowerCase();
    return state.keywords.filter(function (k) { return t.indexOf(k.toLowerCase()) !== -1; });
  }
  function visible() {
    var q = state.query.toLowerCase();
    return state.items.filter(function (it) {
      if (state.kind !== 'all' && it.kind !== state.kind) return false;
      if (q && (it.text + ' ' + it.source).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }

  function addItem(item, live) {
    if (!item || !item.id || state.byId[item.id]) return;
    state.byId[item.id] = item;
    state.items.push(item);
    state.items.sort(function (a, b) { return b.ts - a.ts; });
    if (state.items.length > MAX_ITEMS) {
      state.items.splice(MAX_ITEMS).forEach(function (old) { delete state.byId[old.id]; });
    }
    if (live && !item.backfill) {
      state.fresh[item.id] = true;
      var hit = keywordHits(item).length > 0;
      if ((hit && state.sound) || state.soundAll) beep(hit);
    }
  }

  function renderKinds() {
    var box = $('kinds');
    box.textContent = '';
    KINDS.forEach(function (k) {
      var n = k.id === 'all' ? state.items.length : state.items.filter(function (i) { return i.kind === k.id; }).length;
      var b = el('button', 'kind' + (state.kind === k.id ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.kind === k.id));
      b.appendChild(el('span', null, k.label));
      b.appendChild(el('span', 'n', String(n)));
      b.addEventListener('click', function () { state.kind = k.id; renderKinds(); renderFeed(); });
      box.appendChild(b);
    });
  }

  function renderFeed() {
    var list = visible();
    var box = $('feed');
    box.textContent = '';
    list.forEach(function (it) {
      var b = el('button', 'item' + (it.id === state.selected ? ' on' : '') + (state.fresh[it.id] ? ' fresh' : ''));
      b.type = 'button';
      b.dataset.id = it.id;
      b.setAttribute('aria-pressed', String(it.id === state.selected));
      var meta = el('span', 'meta');
      meta.appendChild(el('span', 'mono', clock(it.ts)));
      meta.appendChild(el('span', 'tag', KIND_TAG[it.kind] || it.kind));
      meta.appendChild(el('span', 'strong', it.source));
      meta.appendChild(el('span', 'lag', lag(it)));
      b.appendChild(meta);
      b.appendChild(el('span', 'text', it.text));
      var pills = el('span', 'pills');
      it.cashtags.forEach(function (c) { pills.appendChild(el('span', 'pill', '$' + c)); });
      keywordHits(it).forEach(function (k) { pills.appendChild(el('span', 'pill warn', 'Keyword: ' + k)); });
      if (pills.childNodes.length) b.appendChild(pills);
      b.addEventListener('click', function () { select(it.id); });
      box.appendChild(b);
    });
    state.fresh = {};
    $('empty').hidden = list.length > 0;
    $('count').textContent = list.length + (list.length === 1 ? ' item' : ' items');
  }

  // ---------- detail + token matches ----------
  function select(id) {
    var it = state.byId[id];
    if (!it) return;
    state.selected = id;
    state.tokens = [];
    state.token = null;
    state.activeTerm = null;
    renderFeed();
    $('detailEmpty').hidden = true;
    $('detail').hidden = false;
    $('dTime').textContent = clock(it.ts);
    $('dSource').textContent = it.source;
    $('dText').textContent = it.text;
    var link = $('dLink');
    var u = safeUrl(it.url);
    link.hidden = !u;
    if (u) link.href = u; else link.removeAttribute('href');
    $('term').value = '';
    renderTerms(it);
    if (it.cashtags.length) fetchMatches(it, null);
    else { renderTokens(); showMatchState('No ticker in this item. Pick a word above or search for one.'); }
  }

  function renderTerms(it) {
    var box = $('terms');
    box.textContent = '';
    it.cashtags.map(function (c) { return '$' + c; }).concat(it.terms).forEach(function (t) {
      var raw = t.replace(/^\$/, '');
      var b = el('button', 'chip' + (state.activeTerm === raw ? ' on' : ''), t);
      b.type = 'button';
      b.addEventListener('click', function () { fetchMatches(it, raw); });
      box.appendChild(b);
    });
  }

  function showMatchState(msg) {
    var s = $('matchState');
    s.hidden = !msg;
    s.textContent = msg || '';
  }

  function fetchMatches(it, term) {
    var req = ++state.matchReq;
    state.activeTerm = term;
    state.tokens = [];
    state.token = null;
    renderTerms(it);
    renderTokens();
    showMatchState('Searching tokens…');
    var url = '/api/matches?itemId=' + encodeURIComponent(it.id) + (term ? '&q=' + encodeURIComponent(term) : '');
    fetch(url).then(function (r) { return r.json(); }).then(function (data) {
      if (req !== state.matchReq) return;
      state.tokens = data.tokens || [];
      state.token = state.tokens.length ? state.tokens[0].address : null;
      if (data.error && !state.tokens.length) showMatchState('Token search is unavailable right now (' + data.error + ').');
      else if (!state.tokens.length) showMatchState('No Solana tokens match ' + (data.terms || []).join(', ') + '.');
      else showMatchState('');
      renderTokens();
    }).catch(function () {
      if (req !== state.matchReq) return;
      showMatchState('Token search is unavailable right now.');
    });
  }

  function currentToken() {
    for (var i = 0; i < state.tokens.length; i++) if (state.tokens[i].address === state.token) return state.tokens[i];
    return null;
  }

  function renderTokens() {
    var box = $('matches');
    box.textContent = '';
    state.tokens.forEach(function (t) {
      var b = el('button', 'tok' + (t.address === state.token ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(t.address === state.token));
      var head = el('span', 'tokHead');
      head.appendChild(el('span', 'sym', '$' + t.symbol));
      head.appendChild(el('span', 'name', t.name));
      head.appendChild(el('span', 'ca', shortAddr(t.address)));
      b.appendChild(head);
      var stats = el('span', 'stats');
      [['Age', dur(t.ageSec)], ['Liquidity', money(t.liquidityUsd)], ['Market cap', money(t.marketCap)]].forEach(function (s) {
        var c = el('span');
        c.appendChild(el('i', null, s[0]));
        c.appendChild(el('b', null, s[1]));
        stats.appendChild(c);
      });
      b.appendChild(stats);
      var pills = el('span', 'pills');
      if (t.createdAfterPost) pills.appendChild(el('span', 'pill warn', '⚠ Created ' + dur(t.secondsAfterPost) + ' after this item'));
      else if (t.createdAt) pills.appendChild(el('span', 'pill', 'Existed before this item'));
      if (t.lowLiquidity) pills.appendChild(el('span', 'pill warn', 'Low liquidity'));
      b.appendChild(pills);
      b.addEventListener('click', function () { state.token = t.address; renderTokens(); });
      box.appendChild(b);
    });

    var tok = currentToken();
    $('buy').hidden = !tok;
    if (!tok) return;
    $('bAddr').textContent = tok.address;
    var buy = safeUrl(tok.buyUrl), chart = safeUrl(tok.pairUrl);
    var open = $('open'), ch = $('chart');
    open.textContent = 'Open $' + tok.symbol + (tok.isPumpFun ? ' on pump.fun' : ' on DexScreener');
    if (buy) open.href = buy; else open.removeAttribute('href');
    ch.hidden = !chart;
    if (chart) ch.href = chart;
    $('copy').textContent = 'Copy address';
  }

  function copyAddress() {
    var tok = currentToken();
    if (!tok) return;
    var done = function () { $('copy').textContent = 'Copied'; setTimeout(function () { $('copy').textContent = 'Copy address'; }, 1200); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(tok.address).then(done, function () {});
  }

  // ---------- keyword alerts ----------
  function renderKeywords() {
    var box = $('keywords');
    box.textContent = '';
    state.keywords.forEach(function (k) {
      var b = el('button', 'chip');
      b.type = 'button';
      b.setAttribute('aria-label', 'Remove keyword ' + k);
      b.appendChild(el('span', null, k));
      b.appendChild(el('span', 'x', '×'));
      b.addEventListener('click', function () {
        state.keywords = state.keywords.filter(function (x) { return x !== k; });
        save('nt.keywords', state.keywords);
        renderKeywords(); renderFeed();
      });
      box.appendChild(b);
    });
  }

  var audio = null;
  function beep(strong) {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = strong ? 880 : 520;
      g.gain.setValueAtTime(0.08, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.18);
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + 0.2);
    } catch (e) { /* audio blocked */ }
  }

  // ---------- wiring ----------
  $('q').addEventListener('input', function (e) { state.query = e.target.value.trim(); renderFeed(); });
  $('kwForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('kw').value.trim();
    if (v && state.keywords.indexOf(v) === -1) { state.keywords.push(v); save('nt.keywords', state.keywords); }
    $('kw').value = '';
    renderKeywords(); renderFeed();
  });
  $('termForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var v = $('term').value.trim().replace(/^\$/, '');
    var it = state.byId[state.selected];
    if (v && it) fetchMatches(it, v);
  });
  $('copy').addEventListener('click', copyAddress);
  $('sound').checked = state.sound;
  $('soundAll').checked = state.soundAll;
  $('sound').addEventListener('change', function (e) { state.sound = e.target.checked; save('nt.sound', state.sound); if (state.sound) beep(true); });
  $('soundAll').addEventListener('change', function (e) { state.soundAll = e.target.checked; save('nt.soundAll', state.soundAll); if (state.soundAll) beep(false); });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === '/') { e.preventDefault(); $('q').focus(); return; }
    if (k === 'j' || k === 'k') {
      var list = visible();
      if (!list.length) return;
      var i = list.findIndex(function (x) { return x.id === state.selected; });
      var next = i === -1 ? 0 : Math.min(list.length - 1, Math.max(0, i + (k === 'j' ? 1 : -1)));
      select(list[next].id);
      var node = document.querySelector('.item.on');
      if (node) node.scrollIntoView({ block: 'nearest' });
      return;
    }
    if (k === 'c') { copyAddress(); return; }
    if (k === 'enter' && e.target.tagName !== 'BUTTON' && e.target.tagName !== 'A') {
      var tok = currentToken();
      var u = tok && safeUrl(tok.buyUrl);
      if (u) window.open(u, '_blank', 'noopener');
    }
  });

  function setLive(on) {
    $('live').className = 'live' + (on ? '' : ' off');
    $('liveText').textContent = on ? 'Live' : 'Reconnecting';
  }

  function start() {
    renderKinds(); renderKeywords(); renderFeed();
    fetch('/api/feed').then(function (r) { return r.json(); }).then(function (data) {
      $('demoBadge').hidden = !data.demo;
      (data.items || []).forEach(function (it) { addItem(it, false); });
      renderKinds(); renderFeed();
    }).catch(function () {});
    var es = new EventSource('/api/stream');
    es.onopen = function () { setLive(true); };
    es.onerror = function () { setLive(false); };
    es.addEventListener('item', function (e) {
      try { addItem(JSON.parse(e.data), true); } catch (err) { return; }
      renderKinds(); renderFeed();
    });
  }
  start();
})();
