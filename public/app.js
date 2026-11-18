(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var KINDS = [
    { id: 'all', label: 'Everything', title: 'Live feed' },
    { id: 'crypto', label: 'Crypto', title: 'Crypto' },
    { id: 'markets', label: 'Markets', title: 'Markets' },
    { id: 'business', label: 'Business', title: 'Business' },
    { id: 'technology', label: 'Technology', title: 'Technology' },
    { id: 'macro', label: 'Macro', title: 'Macro' },
    { id: 'politics', label: 'Politics', title: 'Politics' },
    { id: 'world', label: 'World', title: 'World' }
  ];
  var KIND_NAME = { crypto: 'Crypto', markets: 'Markets', business: 'Business', technology: 'Technology', macro: 'Macro', politics: 'Politics', world: 'World' };
  var ICONS = {
    all: 'M12 3 3 8l9 5 9-5-9-5z M3 13l9 5 9-5 M3 18l9 5 9-5',
    crypto: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M9.5 8h4a2 2 0 0 1 0 4h-4z M9.5 12h4.5a2 2 0 0 1 0 4H9.5z M9.5 8v8 M11.5 6.5V8 M11.5 16v1.5',
    markets: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
    business: 'M4 8h16v11H4z M9 8V5h6v3 M4 13h16',
    technology: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
    macro: 'M5 20V10 M11 20V4 M17 20v-7 M22 20H2',
    politics: 'M3 21h18 M5 21V10 M9.5 21V10 M14.5 21V10 M19 21V10 M2 10h20L12 3z',
    world: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
    chat: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'
  };
  var VIEWS = ['home', 'terminal', 'breaking', 'radar', 'markets'];
  var MAX_ITEMS = 300;
  var HOUR = 3600000;

  var state = {
    view: 'home', items: [], byId: {}, kind: 'all', query: '', selected: null, fresh: {},
    keywords: load('nt.keywords', []), sound: load('nt.sound', false), soundAll: load('nt.soundAll', false),
    tokens: [], token: null, matchReq: 0, activeTerm: null,
    room: 'general', msgs: {}, counts: {}, seenMsg: {}, name: load('nt.name', ''), collageAt: 0
  };
  if (!state.name) { state.name = 'anon-' + Math.floor(1000 + Math.random() * 9000); save('nt.name', state.name); }

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
  function icon(name, size) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', size || 18);
    s.setAttribute('height', size || 18);
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', '2');
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    s.setAttribute('aria-hidden', 'true');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', ICONS[name] || ICONS.wire);
    s.appendChild(p);
    return s;
  }
  function iconBox(name) { var b = el('span', 'ico'); b.appendChild(icon(name)); return b; }
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
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    return s < 45 ? 'just now' : dur(s) + ' ago';
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
    if (!(ms >= 0) || ms > HOUR) return '';
    return ms < 60000 ? '+' + (ms / 1000).toFixed(1) + 's' : '+' + Math.round(ms / 60000) + 'm';
  }
  function shortAddr(a) { return a.length > 10 ? a.slice(0, 4) + '…' + a.slice(-4) : a; }

  // ---------- data ----------
  function keywordHits(item) {
    var t = item.text.toLowerCase();
    return state.keywords.filter(function (k) { return t.indexOf(k.toLowerCase()) !== -1; });
  }
  function visible() {
    var q = state.query.toLowerCase();
    return state.items.filter(function (it) {
      if (state.kind !== 'all' && it.topic !== state.kind) return false;
      if (q && (it.text + ' ' + it.source).toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
  }
  // Most immediate items: urgent ones from the last hour, or the newest urgent ones if it is quiet.
  function breakingList() {
    var urgent = state.items.filter(function (i) { return i.breaking; });
    var recent = urgent.filter(function (i) { return Date.now() - i.ts < HOUR; });
    return (recent.length >= 3 ? recent : urgent.slice(0, 12)).slice(0, 30);
  }
  function breakingThisHour() {
    return state.items.filter(function (i) { return i.breaking && Date.now() - i.ts < HOUR; }).length;
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

  // ---------- routing ----------
  function route() {
    var v = (location.hash || '#home').slice(1);
    if (VIEWS.indexOf(v) === -1) v = 'home';
    state.view = v;
    VIEWS.forEach(function (name) { $('view-' + name).hidden = name !== v; });
    document.querySelectorAll('.tabs a').forEach(function (a) {
      var on = a.dataset.view === v;
      a.className = on ? 'on' : '';
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    render();
    if (v === 'breaking') openRoom(state.room);
    window.scrollTo(0, 0);
    // Radar and Markets live in their own files and start or stop on this signal.
    document.dispatchEvent(new CustomEvent('nt:view', { detail: v }));
  }

  function render() {
    renderNav();
    if (state.view === 'home') renderHome();
    if (state.view === 'terminal') { renderKinds(); renderFeed(); }
    if (state.view === 'breaking') renderRooms();
  }

  function renderNav() {
    var n = breakingThisHour();
    var c = $('breakingCount');
    c.hidden = n === 0;
    c.textContent = String(n);
  }

  // ---------- home ----------
  function renderHome() {
    var cats = $('homeCats');
    cats.textContent = '';
    KINDS.slice(1).forEach(function (k) {
      var n = state.items.filter(function (i) { return i.topic === k.id; }).length;
      var a = el('a', 'kind k-' + k.id);
      a.href = '#terminal';
      a.appendChild(iconBox(k.id));
      a.appendChild(el('span', null, k.label));
      a.appendChild(el('span', 'n', String(n)));
      a.addEventListener('click', function () { state.kind = k.id; });
      cats.appendChild(a);
    });

    // Built once; live items are pasted onto it afterwards.
    var box = $('collage');
    if (!state.items.length || box.childNodes.length) return;
    buildCollage(box);
    var track = $('ticker');
    track.textContent = '';
    var latest = state.items.slice(0, 12);
    // Two copies so the strip can loop without a gap.
    latest.concat(latest).forEach(function (it) {
      var s = el('span');
      s.appendChild(el('b', null, clock(it.ts)));
      s.appendChild(document.createTextNode(it.text));
      track.appendChild(s);
    });
  }

  // Scrapbook of clippings made from live headlines. Layout is seeded so it is stable between rebuilds.
  var CLIP_TYPES = ['ink', 'news', 'news', 'halftone', 'news', 'news', 'chart', 'news', 'ink', 'news', 'news', 'halftone', 'news', 'ink'];
  var GLYPHS = ['$', '%', '↗', 'Extra', '24h', 'No. 1'];
  function seeded(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function candles(r) {
    var ns = 'http://www.w3.org/2000/svg';
    var s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 240 120');
    var y = 70;
    for (var i = 0; i < 14; i++) {
      var open = y, close = Math.min(105, Math.max(15, y + (r() - 0.56) * 34));
      var top = Math.min(open, close) - r() * 12, bot = Math.max(open, close) + r() * 12;
      var x = 12 + i * 16;
      var wick = document.createElementNS(ns, 'line');
      wick.setAttribute('x1', x); wick.setAttribute('x2', x); wick.setAttribute('y1', top); wick.setAttribute('y2', bot);
      wick.setAttribute('stroke', '#10251A'); wick.setAttribute('stroke-width', '1.5');
      var body = document.createElementNS(ns, 'rect');
      body.setAttribute('x', x - 4.5); body.setAttribute('width', 9);
      body.setAttribute('y', Math.min(open, close)); body.setAttribute('height', Math.max(2, Math.abs(close - open)));
      body.setAttribute('fill', close < open ? '#1F7A4A' : '#10251A');
      s.appendChild(wick); s.appendChild(body);
      y = close;
    }
    return s;
  }
  function clipNode(it, type, r, n) {
    var c = el('div', 'clip t-' + type + ' tear' + (1 + Math.floor(r() * 4)));
    c.style.setProperty('--r', (r() * 11 - 5.5).toFixed(1) + 'deg');
    c.style.setProperty('--t', (11 + r() * 10).toFixed(1) + 's');
    c.style.setProperty('--sway', (r() * 1.6 - 0.8).toFixed(1) + 'deg');
    var hl = null;
    if (type === 'news') {
      var mast = el('span', 'mast');
      mast.appendChild(el('span', null, KIND_NAME[it.topic] || 'News'));
      mast.appendChild(el('span', null, it.source));
      c.appendChild(mast);
      hl = el('span', 'hl', it.text);
      c.appendChild(hl);
      var lines = el('span', 'lines');
      [0, 1].forEach(function () { var i = el('i'); i.style.setProperty('--h', Math.round(36 + r() * 70) + 'px'); lines.appendChild(i); });
      c.appendChild(lines);
    } else if (type === 'ink') {
      if (n === 0) c.className += ' t-accent';
      c.appendChild(el('span', 'kick', (KIND_NAME[it.topic] || 'News') + ' · ' + it.source));
      hl = el('span', 'hl', it.text);
      c.appendChild(hl);
    } else if (type === 'strip') {
      c.appendChild(el('span', 'stamp', clock(it.ts) + '  ' + it.source));
      hl = el('span', 'hl', it.text);
      c.appendChild(hl);
    } else if (type === 'halftone') {
      var g = it.cashtags[0] ? '$' + it.cashtags[0] : GLYPHS[n % GLYPHS.length];
      c.appendChild(el('span', 'glyph' + (g.length > 4 ? ' long' : ''), g));
    } else {
      c.appendChild(el('span', 'cap', 'Markets'));
      c.appendChild(candles(r));
    }
    return { node: c, hl: hl };
  }

  // The collage frames the hero: clippings sit around the edge, the middle stays clear.
  // It shows the highest-impact headlines in the feed, biggest stories on the bold clippings.
  function buildCollage(box) {
    state.collageAt = Date.now();
    state.clipSlots = [];
    state.clipNext = 0;
    box.textContent = '';
    var ranked = state.items.slice().sort(function (a, b) { return (b.impact || 0) - (a.impact || 0) || b.ts - a.ts; });
    var bold = ranked.slice(0, 3), rest = ranked.slice(3);
    if (!rest.length) rest = ranked;
    var r = seeded(11);
    var cols = 5, rows = 4, n = 0, bi = 0, ri = 0;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        if (x >= 1 && x <= 3 && y >= 1 && y <= 2) continue;
        var type = CLIP_TYPES[n % CLIP_TYPES.length];
        var it = type === 'ink' ? bold[bi++ % bold.length] : rest[ri++ % rest.length];
        var wrap = el('div', 'clipWrap');
        wrap.style.left = ((x + 0.5 + (r() - 0.5) * 0.3) / cols * 100).toFixed(1) + '%';
        wrap.style.top = ((y + 0.5 + (r() - 0.5) * 0.3) / rows * 100).toFixed(1) + '%';
        wrap.style.zIndex = String(Math.floor(r() * 10));
        wrap.style.setProperty('--w', (type === 'halftone' ? 0.6 : type === 'chart' ? 0.8 : type === 'ink' ? 1.1 : 0.95).toFixed(2));
        wrap.style.setProperty('--d', (0.3 + r() * 0.9).toFixed(2));
        var made = clipNode(it, type, r, n);
        wrap.appendChild(made.node);
        box.appendChild(wrap);
        if (made.hl) state.clipSlots.push(made);
        n++;
      }
    }
  }

  // A live item replaces one clipping's headline, with a "pasted on" animation.
  function pasteClip(item) {
    var slots = state.clipSlots || [];
    if (!slots.length) return;
    var slot = slots[state.clipNext % slots.length];
    state.clipNext = (state.clipNext + 3) % slots.length;
    slot.hl.textContent = item.text;
    slot.node.classList.remove('paste');
    void slot.node.offsetWidth;
    slot.node.classList.add('paste');
  }

  // ---------- terminal: categories + feed ----------
  function renderKinds() {
    var box = $('kinds');
    box.textContent = '';
    KINDS.forEach(function (k) {
      var n = k.id === 'all' ? state.items.length : state.items.filter(function (i) { return i.topic === k.id; }).length;
      var on = state.kind === k.id;
      var b = el('button', 'kind k-' + k.id + (on ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(on));
      b.appendChild(iconBox(k.id));
      b.appendChild(el('span', null, k.label));
      b.appendChild(el('span', 'n', String(n)));
      b.addEventListener('click', function () { state.kind = k.id; renderKinds(); renderFeed(); });
      box.appendChild(b);
      if (on) $('feedTitle').textContent = k.title;
    });
  }

  function itemMeta(it, withLag) {
    var meta = el('span', 'meta');
    meta.appendChild(el('span', 'kindName', KIND_NAME[it.topic] || 'News'));
    meta.appendChild(el('span', 'strong', it.source));
    meta.appendChild(el('span', 'mono', clock(it.ts)));
    if (withLag) meta.appendChild(el('span', 'lag', lag(it)));
    return meta;
  }

  function renderFeed() {
    var list = visible();
    var box = $('feed');
    box.textContent = '';
    list.forEach(function (it) {
      var b = el('button', 'item k-' + it.topic + (it.id === state.selected ? ' on' : '') + (state.fresh[it.id] ? ' fresh' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(it.id === state.selected));
      b.appendChild(iconBox(it.topic));
      var body = el('span', 'body');
      body.appendChild(itemMeta(it, true));
      body.appendChild(el('span', 'text', it.text));
      var pills = el('span', 'pills');
      it.cashtags.forEach(function (c) { pills.appendChild(el('span', 'pill', '$' + c)); });
      if (it.kind === 'listing') pills.appendChild(el('span', 'pill quiet', 'Listing'));
      keywordHits(it).forEach(function (k) { pills.appendChild(el('span', 'pill warn', 'Keyword: ' + k)); });
      if (state.counts[it.id]) pills.appendChild(el('span', 'pill quiet', state.counts[it.id] + (state.counts[it.id] === 1 ? ' message' : ' messages')));
      if (pills.childNodes.length) body.appendChild(pills);
      b.appendChild(body);
      b.addEventListener('click', function () { select(it.id); });
      box.appendChild(b);
    });
    state.fresh = {};
    $('empty').hidden = list.length > 0;
    $('count').textContent = list.length + (list.length === 1 ? ' item' : ' items');
  }

  // ---------- terminal: detail + token matches ----------
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
      var stats = el('span', 'statsRow');
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

  // ---------- breaking: rooms + chat ----------
  function talkBadge(roomId) {
    var n = state.counts[roomId] || 0;
    var t = el('span', 'talk' + (n ? ' hot' : ''));
    t.appendChild(icon('chat', 13));
    t.appendChild(document.createTextNode(String(n)));
    t.setAttribute('aria-label', n + (n === 1 ? ' message' : ' messages'));
    return t;
  }

  function renderRooms() {
    var box = $('rooms');
    box.textContent = '';
    var g = el('button', 'room general k-all' + (state.room === 'general' ? ' on' : ''));
    g.type = 'button';
    g.setAttribute('aria-pressed', String(state.room === 'general'));
    g.appendChild(iconBox('chat'));
    var gb = el('span', 'body');
    gb.appendChild(el('span', 'text', 'General room'));
    gb.appendChild(el('span', 'muted small', 'Talk about anything that is breaking'));
    g.appendChild(gb);
    g.appendChild(talkBadge('general'));
    g.addEventListener('click', function () { openRoom('general'); });
    box.appendChild(g);

    var list = breakingList();
    // Keep the open room on the list even after it ages out.
    var open = state.byId[state.room];
    if (open && list.indexOf(open) === -1) list = [open].concat(list);
    list.forEach(function (it) {
      var b = el('button', 'room k-' + it.topic + (state.room === it.id ? ' on' : ''));
      b.type = 'button';
      b.setAttribute('aria-pressed', String(state.room === it.id));
      b.appendChild(iconBox(it.topic));
      var body = el('span', 'body');
      var meta = el('span', 'meta');
      meta.appendChild(el('span', 'kindName', KIND_NAME[it.topic] || 'News'));
      meta.appendChild(el('span', 'strong', it.source));
      meta.appendChild(el('span', 'mono', ago(it.ts)));
      body.appendChild(meta);
      body.appendChild(el('span', 'text', it.text));
      if (it.cashtags.length) {
        var pills = el('span', 'pills');
        it.cashtags.forEach(function (c) { pills.appendChild(el('span', 'pill', '$' + c)); });
        body.appendChild(pills);
      }
      b.appendChild(body);
      b.appendChild(talkBadge(it.id));
      b.addEventListener('click', function () { openRoom(it.id); });
      box.appendChild(b);
    });
    if (!list.length) box.appendChild(el('p', 'emptyBox', 'Nothing urgent yet. Items land here the moment they arrive.'));
  }

  function openRoom(room) {
    if (room !== 'general' && !state.byId[room]) room = 'general';
    state.room = room;
    var it = state.byId[room];
    $('roomTag').textContent = it ? (KIND_NAME[it.topic] || 'News') + ' · ' + it.source + ' · ' + clock(it.ts) : 'General room';
    $('roomTitle').textContent = it ? it.text : 'Everything breaking';
    $('roomTokens').hidden = !it;
    $('chatError').textContent = '';
    renderRooms();
    renderMsgs();
    fetch('/api/chat?room=' + encodeURIComponent(room)).then(function (r) { return r.json(); }).then(function (data) {
      state.msgs[room] = data.messages || [];
      state.counts = data.counts || state.counts;
      if (state.room === room) { renderMsgs(); renderRooms(); }
    }).catch(function () {});
  }

  function renderMsgs() {
    var box = $('msgs');
    box.textContent = '';
    var list = state.msgs[state.room] || [];
    if (!list.length) box.appendChild(el('p', 'muted', 'No messages yet. Start the conversation.'));
    list.forEach(function (m) {
      var row = el('div', 'msg' + (m.name === state.name ? ' me' : ''));
      var who = el('span', 'who');
      who.appendChild(el('b', null, m.name));
      who.appendChild(document.createTextNode(clock(m.ts)));
      row.appendChild(who);
      row.appendChild(el('span', 'say', m.text));
      box.appendChild(row);
    });
    box.scrollTop = box.scrollHeight;
  }

  function onChat(m) {
    if (!m || !m.room || state.seenMsg[m.id]) return;
    state.seenMsg[m.id] = true;
    var list = state.msgs[m.room];
    // A message already in a fetched list has been counted by that fetch.
    if (list && list.some(function (x) { return x.id === m.id; })) return;
    state.counts[m.room] = (state.counts[m.room] || 0) + 1;
    if (list) list.push(m);
    if (state.view === 'breaking') {
      renderRooms();
      if (m.room === state.room) renderMsgs();
    }
  }

  function sendChat(e) {
    e.preventDefault();
    var text = $('msg').value.trim();
    var name = $('handle').value.trim() || state.name;
    if (!text) return;
    state.name = name;
    save('nt.name', name);
    $('chatError').textContent = '';
    // Clear straight away so fast typers do not run two messages together; put it back if sending fails.
    $('msg').value = '';
    var restore = function () { if (!$('msg').value) $('msg').value = text; };
    fetch('/api/chat', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ room: state.room, name: name, text: text })
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); }).then(function (res) {
      if (!res.ok) { $('chatError').textContent = res.d.error || 'Message was not sent.'; restore(); return; }
      onChat(res.d.message);
    }).catch(function () { $('chatError').textContent = 'Message was not sent. Check your connection.'; restore(); });
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
  $('alertsBtn').addEventListener('click', function () {
    var open = $('alerts').hidden;
    $('alerts').hidden = !open;
    $('alertsBtn').setAttribute('aria-expanded', String(open));
  });
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
  $('chatForm').addEventListener('submit', sendChat);
  $('handle').value = state.name;
  // "Discuss in Breaking" carries the selected item across; "See matching tokens" carries it back.
  $('dTalk').addEventListener('click', function () { if (state.selected) state.room = state.selected; });
  $('roomTokens').addEventListener('click', function () {
    var id = state.room;
    setTimeout(function () { if (state.byId[id]) select(id); }, 0);
  });
  $('sound').checked = state.sound;
  $('soundAll').checked = state.soundAll;
  $('sound').addEventListener('change', function (e) { state.sound = e.target.checked; save('nt.sound', state.sound); if (state.sound) beep(true); });
  $('soundAll').addEventListener('change', function (e) { state.soundAll = e.target.checked; save('nt.soundAll', state.soundAll); if (state.soundAll) beep(false); });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA)$/.test(e.target.tagName);
    if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
    if (state.view !== 'terminal' || e.metaKey || e.ctrlKey || e.altKey) return;
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

  // The collage shifts a little with the pointer, nearer clippings more than far ones.
  $('view-home').addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var c = $('collage');
    c.style.setProperty('--px', ((e.clientX / window.innerWidth - 0.5) * -36).toFixed(1) + 'px');
    c.style.setProperty('--py', ((e.clientY / window.innerHeight - 0.5) * -28).toFixed(1) + 'px');
  });

  function setLive(on) {
    $('live').className = 'live' + (on ? '' : ' off');
    $('liveText').textContent = on ? 'Live' : 'Reconnecting';
  }

  function start() {
    renderKeywords();
    window.addEventListener('hashchange', route);
    route();
    fetch('/api/feed').then(function (r) { return r.json(); }).then(function (data) {
      $('demoBadge').hidden = !data.demo;
      (data.items || []).forEach(function (it) { addItem(it, false); });
      render();
    }).catch(function () {});
    fetch('/api/chat?room=general').then(function (r) { return r.json(); }).then(function (data) {
      state.msgs.general = data.messages || [];
      state.counts = data.counts || {};
      render();
      if (state.view === 'breaking' && state.room === 'general') renderMsgs();
    }).catch(function () {});
    var es = new EventSource('/api/stream');
    es.onopen = function () { setLive(true); };
    es.onerror = function () { setLive(false); };
    es.addEventListener('item', function (e) {
      var it;
      try { it = JSON.parse(e.data); addItem(it, true); } catch (err) { return; }
      if (state.view === 'home' && !it.backfill) pasteClip(it);
      render();
    });
    es.addEventListener('chat', function (e) {
      try { onChat(JSON.parse(e.data)); } catch (err) { /* ignore malformed */ }
    });
    // Keeps "2m ago" labels and the hourly counts honest.
    setInterval(function () { renderNav(); if (state.view === 'breaking') renderRooms(); }, 30000);
  }
  start();
})();
