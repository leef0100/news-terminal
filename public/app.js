// Home, News and Breaking pages. Radar, Markets and wallet connect live in their own files.
(function () {
  'use strict';

  var $ = function (id) { return document.getElementById(id); };
  var KINDS = [
    { id: 'all', label: 'Everything', title: 'Live feed' },
    { id: 'crypto', label: 'Crypto', title: 'Crypto' },
    { id: 'markets', label: 'Markets', title: 'Markets' },
    { id: 'deals', label: 'Deals', title: 'Deals, IPOs and fundraising' },
    { id: 'business', label: 'Business', title: 'Business' },
    { id: 'technology', label: 'Technology', title: 'Technology' },
    { id: 'macro', label: 'Macro', title: 'Macro' },
    { id: 'politics', label: 'Politics', title: 'Politics' },
    { id: 'world', label: 'World', title: 'World' }
  ];
  var KIND_NAME = { deals: 'Deals', crypto: 'Crypto', markets: 'Markets', business: 'Business', technology: 'Technology', macro: 'Macro', politics: 'Politics', world: 'World' };
  var ICONS = {
    all: 'M12 3 3 8l9 5 9-5-9-5z M3 13l9 5 9-5 M3 18l9 5 9-5',
    crypto: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M9.5 8h4a2 2 0 0 1 0 4h-4z M9.5 12h4.5a2 2 0 0 1 0 4H9.5z M9.5 8v8 M11.5 6.5V8 M11.5 16v1.5',
    markets: 'M3 17l6-6 4 4 8-8 M15 7h6v6',
    business: 'M4 8h16v11H4z M9 8V5h6v3 M4 13h16',
    deals: 'M3 12l4-4 4 3 3-3 7 6 M3 12v6h18v-6 M8 18v-3 M12 18v-4 M16 18v-3',
    technology: 'M7 7h10v10H7z M10 3v4 M14 3v4 M10 17v4 M14 17v4 M3 10h4 M3 14h4 M17 10h4 M17 14h4',
    macro: 'M5 20V10 M11 20V4 M17 20v-7 M22 20H2',
    politics: 'M3 21h18 M5 21V10 M9.5 21V10 M14.5 21V10 M19 21V10 M2 10h20L12 3z',
    world: 'M12 3a9 9 0 1 0 0 18a9 9 0 0 0 0-18z M3 12h18 M12 3c3 3 3 15 0 18 M12 3c-3 3-3 15 0 18',
    chat: 'M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    star: 'M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.9L12 17l-5.2 2.7 1-5.9L3.5 9.7l5.9-.8z'
  };
  var VIEWS = ['home', 'news', 'breaking', 'stocks', 'markets', 'radar', 'calendar', 'private', 'indexes', 'funds', 'voices', 'panel', 'status'];
  var MAX_ITEMS = 400;
  var PAGE = 60;
  var HOUR = 3600000;

  var state = {
    view: 'home', items: [], byId: Object.create(null), loaded: false, failed: false,
    kind: 'all', query: '', source: '', onlyBreaking: false, onlySaved: false, shown: PAGE,
    selected: null, pendingSelect: null, fresh: {}, queued: 0,
    keywords: load('nt.keywords', []), sound: load('nt.sound', false), soundAll: load('nt.soundAll', false),
    saved: load('nt.saved', []), compact: load('nt.compact', false),
    tokens: [], token: null, matchReq: 0, activeTerm: null,
    room: 'general', msgs: Object.create(null), counts: Object.create(null), seenMsg: Object.create(null), seenCount: 0, name: load('nt.name', ''),
    clipSlots: [], clipNext: 0
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
    p.setAttribute('d', ICONS[name] || ICONS.world);
    s.appendChild(p);
    return s;
  }
  function iconBox(name) { var b = el('span', 'ico'); b.appendChild(icon(name)); return b; }
  function safeUrl(u) { return typeof u === 'string' && /^https:\/\//i.test(u) ? u : null; }
  // Lists here are rebuilt when they change. Whoever is using the keyboard would lose
  // their place each time, so the focused control is found again by its key afterwards.
  function keepFocus(rebuild) {
    var a = document.activeElement;
    var key = a && a.dataset ? a.dataset.fk : null;
    rebuild();
    if (!key) return;
    var again = document.querySelector('[data-fk="' + key.replace(/[^\w:.-]/g, '') + '"]');
    if (again) again.focus({ preventScroll: true });
  }
  function copyText(text, done) {
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, function () {});
  }

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
  function fullTime(ts) { return new Date(ts).toLocaleString(); }
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
  function topicName(it) { return KIND_NAME[it.topic] || 'News'; }

  // ---------- data ----------
  function keywordHits(item) {
    var t = item.text.toLowerCase();
    return state.keywords.filter(function (k) { return t.indexOf(k.toLowerCase()) !== -1; });
  }
  function isSaved(id) { return state.saved.some(function (s) { return s.id === id; }); }
  function toggleSaved(it) {
    if (isSaved(it.id)) state.saved = state.saved.filter(function (s) { return s.id !== it.id; });
    else state.saved = [it].concat(state.saved).slice(0, 100);
    save('nt.saved', state.saved);
  }

  function passes(it) {
    if (state.kind !== 'all' && it.topic !== state.kind) return false;
    if (state.source && it.source !== state.source) return false;
    if (state.onlyBreaking && !it.breaking) return false;
    var q = state.query.toLowerCase();
    if (q && (it.text + ' ' + it.source).toLowerCase().indexOf(q) === -1) return false;
    return true;
  }

  // One row per story: the first outlet to report it leads, later copies hang off it.
  function stories() {
    var pool = state.onlySaved ? state.saved : state.items;
    var groups = {}, order = [];
    pool.forEach(function (it) {
      var key = state.onlySaved ? it.id : (it.storyId || it.id);
      if (!groups[key]) { groups[key] = []; order.push(key); }
      groups[key].push(it);
    });
    var out = [];
    order.forEach(function (key) {
      var all = groups[key].slice().sort(function (a, b) { return a.ts - b.ts; });
      if (!all.some(passes)) return;
      out.push({ lead: all[0], also: all.slice(1) });
    });
    out.sort(function (a, b) { return b.lead.ts - a.lead.ts; });
    return out;
  }

  function topStories() {
    var seen = {};
    return state.items
      .filter(function (i) { return Date.now() - i.ts < 6 * HOUR; })
      .sort(function (a, b) { return (b.impact || 0) - (a.impact || 0) || b.ts - a.ts; })
      .filter(function (i) { var k = i.storyId || i.id; if (seen[k]) return false; seen[k] = true; return true; })
      .slice(0, 6);
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
    if (!item || !item.id || state.byId[item.id]) return false;
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
    return true;
  }

  // ---------- routing ----------
  function route() {
    var raw = (location.hash || '#home').slice(1);
    // "#n-<id>" is a shared link to one story.
    if (raw.indexOf('n-') === 0) { state.pendingSelect = raw.slice(2).replace(/[^\w-]/g, '').slice(0, 64); raw = 'news'; }
    if (raw === 'terminal') raw = 'news';
    // "#stocks/NVDA" opens a page with something selected: the part before the slash is the page.
    raw = raw.split('/')[0];
    var v = VIEWS.indexOf(raw) === -1 ? 'home' : raw;
    state.view = v;
    VIEWS.forEach(function (name) { $('view-' + name).hidden = name !== v; });
    document.querySelectorAll('.tabs a').forEach(function (a) {
      var on = a.dataset.view === v;
      a.className = on ? 'on' : '';
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    render();
    if (v === 'news') openPending();
    if (v === 'breaking') openRoom(state.room); else closeChatStream();
    window.scrollTo(0, 0);
    // Radar and Markets live in their own files and start or stop on this signal.
    document.dispatchEvent(new CustomEvent('nt:view', { detail: v }));
  }

  function openPending() {
    if (!state.pendingSelect || !state.loaded) return;
    var id = state.pendingSelect;
    state.pendingSelect = null;
    if (state.byId[id]) { select(id); return; }
    // A shared link can point at a story that has already left the live feed.
    fetch('/api/item?id=' + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.item) throw new Error('gone');
      addItem(d.item, false);
      if (state.view === 'news') { renderFeed(); select(id); }
    }).catch(function () {
      var n = $('notice');
      n.hidden = false;
      n.textContent = 'That story is no longer available. Here is the latest instead.';
      setTimeout(function () { n.hidden = true; }, 8000);
    });
  }

  function render() {
    renderNav();
    if (state.view === 'home') renderHome();
    if (state.view === 'news') { renderKinds(); renderSources(); renderFeed(); renderTop(); }
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
      a.href = '#news';
      a.appendChild(iconBox(k.id));
      a.appendChild(el('span', null, k.label));
      a.appendChild(el('span', 'n', String(n)));
      a.addEventListener('click', function () { state.kind = k.id; state.shown = PAGE; });
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
      mast.appendChild(el('span', null, topicName(it)));
      mast.appendChild(el('span', null, it.source));
      c.appendChild(mast);
      hl = el('span', 'hl', it.text);
      c.appendChild(hl);
      var lines = el('span', 'lines');
      [0, 1].forEach(function () { var i = el('i'); i.style.setProperty('--h', Math.round(36 + r() * 70) + 'px'); lines.appendChild(i); });
      c.appendChild(lines);
    } else if (type === 'ink') {
      if (n === 0) c.className += ' t-accent';
      c.appendChild(el('span', 'kick', topicName(it) + ' · ' + it.source));
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

  // ---------- news: filters ----------
  function renderKinds() { keepFocus(drawKinds); }
  function drawKinds() {
    var box = $('kinds');
    box.textContent = '';
    KINDS.forEach(function (k) {
      var n = k.id === 'all' ? state.items.length : state.items.filter(function (i) { return i.topic === k.id; }).length;
      var on = state.kind === k.id;
      var b = el('button', 'kind k-' + k.id + (on ? ' on' : ''));
      b.type = 'button';
      b.dataset.fk = 'kind:' + k.id;
      b.setAttribute('aria-pressed', String(on));
      b.appendChild(iconBox(k.id));
      b.appendChild(el('span', null, k.label));
      b.appendChild(el('span', 'n', String(n)));
      b.addEventListener('click', function () { state.kind = k.id; state.shown = PAGE; renderKinds(); renderFeed(); });
      box.appendChild(b);
    });
  }

  function renderSources() {
    var names = {};
    state.items.forEach(function (i) { names[i.source] = true; });
    var list = Object.keys(names).sort(function (a, b) { return a.localeCompare(b); });
    var sel = $('srcSel');
    if (sel.options.length !== list.length + 1) {
      sel.textContent = '';
      var all = el('option', null, 'All sources');
      all.value = '';
      sel.appendChild(all);
      list.forEach(function (n) { var o = el('option', null, n); o.value = n; sel.appendChild(o); });
    }
    sel.value = state.source;
  }

  function renderToggles() {
    [['onlyBreaking', state.onlyBreaking], ['onlySaved', state.onlySaved], ['density', state.compact]].forEach(function (t) {
      $(t[0]).setAttribute('aria-pressed', String(t[1]));
      $(t[0]).classList.toggle('on', t[1]);
    });
    $('savedCount').textContent = state.saved.length ? String(state.saved.length) : '';
    document.body.classList.toggle('compact', state.compact);
  }

  // ---------- news: feed ----------
  function storyRow(s) {
    var it = s.lead;
    var row = el('div', 'item k-' + it.topic + (it.id === state.selected ? ' on' : '') + (state.fresh[it.id] ? ' fresh' : ''));
    row.dataset.id = it.id;
    var b = el('button', 'itemMain');
    b.type = 'button';
    b.dataset.fk = 'row:' + it.id;
    b.setAttribute('aria-pressed', String(it.id === state.selected));
    b.appendChild(iconBox(it.topic));
    var body = el('span', 'body');
    var meta = el('span', 'meta');
    meta.appendChild(el('span', 'kindName', topicName(it)));
    meta.appendChild(el('span', 'strong', it.source));
    var when = el('span', 'mono when', ago(it.ts));
    when.title = fullTime(it.ts);
    when.dataset.ts = it.ts;
    meta.appendChild(when);
    var l = lag(it);
    if (l) { var lg = el('span', 'lag', l); lg.title = 'Arrived this long after it was published'; meta.appendChild(lg); }
    body.appendChild(meta);
    body.appendChild(el('span', 'text', it.text));
    var pills = el('span', 'pills');
    if (it.breaking && Date.now() - it.ts < HOUR) pills.appendChild(el('span', 'pill warn', 'Breaking'));
    it.cashtags.forEach(function (c) { pills.appendChild(el('span', 'pill', '$' + c)); });
    if (it.kind === 'listing') pills.appendChild(el('span', 'pill quiet', 'Listing'));
    keywordHits(it).forEach(function (k) { pills.appendChild(el('span', 'pill warn', 'Keyword: ' + k)); });
    if (s.also.length) pills.appendChild(el('span', 'pill quiet', '+' + s.also.length + (s.also.length === 1 ? ' more source' : ' more sources')));
    if (state.counts[it.id]) pills.appendChild(el('span', 'pill quiet', state.counts[it.id] + (state.counts[it.id] === 1 ? ' message' : ' messages')));
    if (pills.childNodes.length) body.appendChild(pills);
    b.appendChild(body);
    b.addEventListener('click', function () { select(it.id); });
    row.appendChild(b);

    var star = el('button', 'star' + (isSaved(it.id) ? ' on' : ''));
    star.type = 'button';
    star.dataset.fk = 'star:' + it.id;
    star.setAttribute('aria-pressed', String(isSaved(it.id)));
    star.setAttribute('aria-label', isSaved(it.id) ? 'Remove from saved' : 'Save story');
    star.appendChild(icon('star', 18));
    star.addEventListener('click', function () { toggleSaved(it); renderToggles(); renderFeed(); if (state.selected === it.id) renderDetailActions(it); });
    row.appendChild(star);
    return row;
  }

  function renderFeed() { keepFocus(drawFeed); }
  function drawFeed() {
    var box = $('feed');
    var empty = $('empty');
    renderToggles();
    $('feedTitle').textContent = state.onlySaved ? 'Saved stories' : (KINDS.filter(function (k) { return k.id === state.kind; })[0] || KINDS[0]).title;
    box.textContent = '';
    state.queued = 0;
    $('newPill').hidden = true;

    if (!state.loaded && !state.onlySaved) {
      empty.hidden = true;
      $('more').hidden = true;
      $('count').textContent = '';
      if (state.failed) { empty.hidden = false; empty.textContent = 'Can\'t reach the server. Trying again…'; return; }
      for (var i = 0; i < 6; i++) box.appendChild(el('div', 'item skeleton'));
      return;
    }

    var list = stories();
    list.slice(0, state.shown).forEach(function (s) { box.appendChild(storyRow(s)); });
    state.fresh = {};
    $('more').hidden = list.length <= state.shown;
    empty.hidden = list.length > 0;
    if (!list.length) {
      var filtered = state.kind !== 'all' || state.query || state.source || state.onlyBreaking;
      empty.textContent = state.onlySaved ? 'Nothing saved yet. Tap the star on a story to keep it here.'
        : filtered ? 'No stories match these filters.' : 'No stories yet. They appear here the moment they arrive.';
    }
    $('count').textContent = list.length + (list.length === 1 ? ' story' : ' stories');
  }

  // New stories do not shove the page while someone is reading further down:
  // they wait behind a "new stories" button until asked for.
  function onLiveItem(it) {
    if (state.view !== 'news') return;
    renderKinds();
    renderTop();
    if (!passes(it) || state.onlySaved) return;
    var top = $('feed').getBoundingClientRect().top;
    if (top < -200) {
      state.queued += 1;
      var pill = $('newPill');
      pill.hidden = false;
      pill.textContent = state.queued + (state.queued === 1 ? ' new story' : ' new stories') + ' ↑';
      return;
    }
    renderFeed();
  }

  function renderTop() { keepFocus(drawTop); }
  function drawTop() {
    var list = topStories();
    var box = $('topList');
    box.textContent = '';
    $('topEmpty').hidden = list.length > 0;
    list.forEach(function (it) {
      var li = el('li');
      var b = el('button', 'topItem k-' + it.topic);
      b.type = 'button';
      b.dataset.fk = 'top:' + it.id;
      var body = el('span', 'body');
      var meta = el('span', 'meta');
      meta.appendChild(el('span', 'kindName', topicName(it)));
      meta.appendChild(el('span', null, it.source));
      meta.appendChild(el('span', 'mono', ago(it.ts)));
      body.appendChild(meta);
      body.appendChild(el('span', 'text', it.text));
      b.appendChild(body);
      b.addEventListener('click', function () { select(it.id); });
      li.appendChild(b);
      box.appendChild(li);
    });
  }

  // ---------- news: story detail + token matches ----------
  function findStory(id) {
    var it = state.byId[id] || state.saved.filter(function (s) { return s.id === id; })[0];
    if (!it) return null;
    var key = it.storyId || it.id;
    var all = state.items.filter(function (x) { return (x.storyId || x.id) === key; });
    if (all.indexOf(it) === -1) all.push(it);
    all.sort(function (a, b) { return a.ts - b.ts; });
    return { item: it, all: all };
  }

  function renderDetailActions(it) {
    $('dSave').textContent = isSaved(it.id) ? 'Saved' : 'Save';
    $('dShare').textContent = 'Copy link';
  }

  function select(id) {
    var story = findStory(id);
    if (!story) return;
    var it = story.item;
    state.selected = id;
    state.tokens = [];
    state.token = null;
    state.activeTerm = null;
    document.querySelectorAll('#feed .item').forEach(function (n) {
      var on = n.dataset.id === id;
      n.classList.toggle('on', on);
      var main = n.querySelector('.itemMain');
      if (main) main.setAttribute('aria-pressed', String(on));
    });
    $('top').hidden = true;
    $('detail').hidden = false;
    $('dTopic').textContent = topicName(it);
    $('dTopic').parentNode.className = 'meta k-' + it.topic;
    $('dSource').textContent = it.source;
    $('dTime').textContent = clock(it.ts);
    $('dTime').title = fullTime(it.ts);
    $('dText').textContent = it.text;
    var link = $('dLink');
    var u = safeUrl(it.url);
    link.hidden = !u;
    if (u) link.href = u; else link.removeAttribute('href');
    renderDetailActions(it);

    var also = $('dAlso');
    var others = story.all.filter(function (x) { return x.id !== it.id; });
    also.hidden = !others.length;
    also.textContent = '';
    if (others.length) {
      also.appendChild(el('span', 'eyebrow', 'Also reported by'));
      others.forEach(function (o) {
        var ou = safeUrl(o.url);
        var row = ou ? el('a', 'alsoRow') : el('span', 'alsoRow');
        if (ou) { row.href = ou; row.target = '_blank'; row.rel = 'noopener noreferrer'; }
        row.appendChild(el('b', null, o.source));
        row.appendChild(el('span', 'mono muted', clock(o.ts)));
        row.appendChild(el('span', 'alsoText', o.text));
        also.appendChild(row);
      });
    }

    $('term').value = '';
    renderTerms(it);
    if (it.cashtags.length) fetchMatches(it, null);
    else { renderTokens(); showMatchState('No ticker in this story. Pick a word above or search for one.'); }
  }

  function closeDetail() {
    state.selected = null;
    $('detail').hidden = true;
    $('top').hidden = false;
    document.querySelectorAll('#feed .item.on').forEach(function (n) { n.classList.remove('on'); });
    renderTop();
  }

  function renderTerms(it) {
    var box = $('terms');
    box.textContent = '';
    it.cashtags.map(function (c) { return '$' + c; }).concat(it.terms || []).forEach(function (t) {
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

  // The server's answer per term is the same for everyone (so it caches well); what is
  // specific to this story, whether a token appeared after it, is worked out here.
  function fetchMatches(it, term) {
    var req = ++state.matchReq;
    // "After the story" means after its first report by anyone, whichever outlet's copy
    // happens to be open. Measuring from a later copy would pass off an early copycat as
    // an established token.
    var story = findStory(it.id);
    var brokeAt = story && story.all.length ? story.all[0].ts : it.ts;
    state.activeTerm = term;
    state.tokens = [];
    state.token = null;
    renderTerms(it);
    renderTokens();
    showMatchState('Searching tokens…');
    var terms = term ? [term] : it.cashtags.slice(0, 4);
    Promise.all(terms.map(function (t) {
      return fetch('/api/tokens?q=' + encodeURIComponent(t)).then(function (r) { return r.json(); }).catch(function () { return { tokens: [], error: 'offline' }; });
    })).then(function (results) {
      if (req !== state.matchReq) return;
      var seen = {}, all = [], err = null;
      results.forEach(function (d) {
        if (d.error) err = d.error;
        (d.tokens || []).forEach(function (t) {
          if (seen[t.address]) return;
          seen[t.address] = true;
          var after = t.createdAt != null && t.createdAt > brokeAt;
          all.push(Object.assign({}, t, {
            createdAfterPost: after,
            // 0 trading before the story, 1 age unknown, 2 started after it.
            group: t.createdAt == null ? 1 : after ? 2 : 0,
            secondsAfterPost: after ? Math.round((t.createdAt - brokeAt) / 1000) : null,
            ageSec: t.createdAt != null ? Math.max(0, Math.round((Date.now() - t.createdAt) / 1000)) : null
          }));
        });
      });
      all.sort(function (a, b) { return a.group - b.group || b.liquidityUsd - a.liquidityUsd; });
      state.tokens = all.slice(0, 8);
      state.token = state.tokens.length ? state.tokens[0].address : null;
      if (!state.tokens.length) showMatchState(err ? 'Token search is unavailable right now.' : 'No Solana tokens match ' + terms.join(', ') + '.');
      else showMatchState('');
      renderTokens();
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
      if (t.createdAfterPost) pills.appendChild(el('span', 'pill warn', '⚠ Started trading ' + dur(t.secondsAfterPost) + ' after this story'));
      else if (t.createdAt) pills.appendChild(el('span', 'pill', 'Trading before this story'));
      else pills.appendChild(el('span', 'pill warn', 'Age unknown'));
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
    copyText(tok.address, function () { $('copy').textContent = 'Copied'; setTimeout(function () { $('copy').textContent = 'Copy address'; }, 1200); });
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

  function renderRooms() { keepFocus(drawRooms); }
  function drawRooms() {
    var box = $('rooms');
    box.textContent = '';
    var g = el('button', 'room general k-all' + (state.room === 'general' ? ' on' : ''));
    g.type = 'button';
    g.dataset.fk = 'room:general';
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
      b.dataset.fk = 'room:' + it.id;
      b.setAttribute('aria-pressed', String(state.room === it.id));
      b.appendChild(iconBox(it.topic));
      var body = el('span', 'body');
      var meta = el('span', 'meta');
      meta.appendChild(el('span', 'kindName', topicName(it)));
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

  // Chat is streamed per room, and only while that room is open on screen.
  var chatStream = null, chatPoll = null, chatRetry = null;
  function closeChatStream() {
    if (chatStream) { chatStream.close(); chatStream = null; }
    clearInterval(chatPoll); chatPoll = null;
    clearTimeout(chatRetry); chatRetry = null;
  }
  function startChatPoll(room) {
    if (!chatPoll) chatPoll = setInterval(function () { if (!document.hidden) loadRoom(room); }, 3000);
  }
  function openChatStream(room) {
    closeChatStream();
    chatStream = new EventSource('/api/chat/stream?room=' + encodeURIComponent(room));
    chatStream.addEventListener('chat', function (e) {
      try { onChat(JSON.parse(e.data)); } catch (err) { /* ignore malformed */ }
    });
    chatStream.onopen = function () {
      // Whatever was said while disconnected is fetched once the stream is back.
      if (chatPoll) { clearInterval(chatPoll); chatPoll = null; loadRoom(room); }
    };
    chatStream.onerror = function () {
      if (state.room !== room || state.view !== 'breaking') return;
      // Keep the room moving by asking for it every few seconds meanwhile.
      startChatPoll(room);
      // A refused connection (the server is full) is never retried by the browser, so
      // ask again later, at a slightly different moment from everyone else.
      if (chatStream && chatStream.readyState === 2 && !chatRetry) {
        chatRetry = setTimeout(function () {
          chatRetry = null;
          if (state.room !== room || state.view !== 'breaking') return;
          openChatStream(room);
          startChatPoll(room);
        }, 30000 + Math.random() * 30000);
      }
    };
  }
  // History from the server is merged with what the live stream has already delivered,
  // never swapped in over it: the answer can be a few seconds old.
  function loadRoom(room) {
    fetch('/api/chat?room=' + encodeURIComponent(room)).then(function (r) { return r.json(); }).then(function (data) {
      var have = state.msgs[room] || [];
      var ids = Object.create(null);
      have.forEach(function (m) { ids[m.id] = true; });
      (data.messages || []).forEach(function (m) { if (!ids[m.id]) { have.push(m); markSeen(m.id); } });
      have.sort(function (a, b) { return a.ts - b.ts; });
      state.msgs[room] = have.slice(-200);
      state.counts = Object.assign(Object.create(null), data.counts || state.counts);
      if (state.room === room && state.view === 'breaking') { renderMsgs(); renderRooms(); }
    }).catch(function () {});
  }
  function markSeen(id) {
    if (state.seenMsg[id]) return;
    state.seenMsg[id] = true;
    // Only recent ids matter for spotting repeats, so the record starts over now and then.
    if (++state.seenCount > 3000) { state.seenMsg = Object.create(null); state.seenCount = 0; }
  }

  function openRoom(room) {
    if (room !== 'general' && !state.byId[room]) room = 'general';
    state.room = room;
    var it = state.byId[room];
    $('roomTag').textContent = it ? topicName(it) + ' · ' + it.source + ' · ' + clock(it.ts) : 'General room';
    $('roomTitle').textContent = it ? it.text : 'Everything breaking';
    $('roomTokens').hidden = !it;
    $('chatError').textContent = '';
    renderRooms();
    renderMsgs();
    loadRoom(room);
    openChatStream(room);
  }

  function msgRow(m) {
    var row = el('div', 'msg' + (m.name === state.name ? ' me' : ''));
    var who = el('span', 'who');
    who.appendChild(el('b', null, m.name));
    who.appendChild(document.createTextNode(clock(m.ts)));
    row.appendChild(who);
    row.appendChild(el('span', 'say', m.text));
    return row;
  }
  function renderMsgs() {
    var box = $('msgs');
    box.textContent = '';
    var list = state.msgs[state.room] || [];
    if (!list.length) box.appendChild(el('p', 'muted', 'No messages yet. Start the conversation.'));
    list.forEach(function (m) { box.appendChild(msgRow(m)); });
    box.scrollTop = box.scrollHeight;
  }

  function onChat(m) {
    if (!m || !m.room || !m.id || state.seenMsg[m.id]) return;
    markSeen(m.id);
    state.counts[m.room] = (state.counts[m.room] || 0) + 1;
    var list = state.msgs[m.room];
    if (list) { list.push(m); if (list.length > 200) list.splice(0, list.length - 200); }
    if (state.view !== 'breaking') return;
    if (m.room === state.room) {
      // One new line is added; the room is not redrawn, so it is not read out again
      // by a screen reader and the scroll position is kept unless already at the end.
      var box = $('msgs');
      var atEnd = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
      if (list && list.length === 1) box.textContent = '';
      box.appendChild(msgRow(m));
      while (box.childNodes.length > 200) box.removeChild(box.firstChild);
      if (atEnd || m.name === state.name) box.scrollTop = box.scrollHeight;
    }
    renderRooms();
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

  var audio = null, lastBeep = 0;
  function beep(strong) {
    // A batch of stories arriving together (after a reconnect, say) makes one sound, not many.
    if (Date.now() - lastBeep < 1000) return;
    lastBeep = Date.now();
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
  $('q').addEventListener('input', function (e) { state.query = e.target.value.trim(); state.shown = PAGE; renderFeed(); });
  $('srcSel').addEventListener('change', function (e) { state.source = e.target.value; state.shown = PAGE; renderFeed(); });
  $('onlyBreaking').addEventListener('click', function () { state.onlyBreaking = !state.onlyBreaking; state.shown = PAGE; renderFeed(); });
  $('onlySaved').addEventListener('click', function () { state.onlySaved = !state.onlySaved; state.shown = PAGE; renderFeed(); });
  $('density').addEventListener('click', function () { state.compact = !state.compact; save('nt.compact', state.compact); renderToggles(); });
  $('more').addEventListener('click', function () { state.shown += PAGE; renderFeed(); });
  $('newPill').addEventListener('click', function () { renderFeed(); window.scrollTo({ top: 0, behavior: 'smooth' }); });
  $('back').addEventListener('click', closeDetail);
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
    var story = state.selected && findStory(state.selected);
    if (v && story) fetchMatches(story.item, v);
  });
  $('copy').addEventListener('click', copyAddress);
  $('dSave').addEventListener('click', function () {
    var story = state.selected && findStory(state.selected);
    if (!story) return;
    toggleSaved(story.item);
    renderFeed();
    renderDetailActions(story.item);
  });
  $('dShare').addEventListener('click', function () {
    if (!state.selected) return;
    copyText(location.origin + location.pathname + '#n-' + state.selected, function () { $('dShare').textContent = 'Link copied'; });
  });
  $('chatForm').addEventListener('submit', sendChat);
  $('handle').value = state.name;
  // "Discuss in Breaking" carries the selected story across; "See matching tokens" carries it back.
  $('dTalk').addEventListener('click', function () { if (state.selected && state.byId[state.selected]) state.room = state.selected; });
  $('roomTokens').addEventListener('click', function () { state.pendingSelect = state.room; });
  $('sound').checked = state.sound;
  $('soundAll').checked = state.soundAll;
  $('sound').addEventListener('change', function (e) { state.sound = e.target.checked; save('nt.sound', state.sound); if (state.sound) beep(true); });
  $('soundAll').addEventListener('change', function (e) { state.soundAll = e.target.checked; save('nt.soundAll', state.soundAll); if (state.soundAll) beep(false); });

  document.addEventListener('keydown', function (e) {
    var typing = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
    if (typing) { if (e.key === 'Escape') e.target.blur(); return; }
    if (state.view !== 'news' || e.metaKey || e.ctrlKey || e.altKey) return;
    var k = e.key.toLowerCase();
    if (k === '/') { e.preventDefault(); $('q').focus(); return; }
    if (k === 'escape' && state.selected) { closeDetail(); return; }
    if (k === 'j' || k === 'k') {
      var list = stories().slice(0, state.shown);
      if (!list.length) return;
      var i = list.findIndex(function (s) { return s.lead.id === state.selected; });
      var next = i === -1 ? 0 : Math.min(list.length - 1, Math.max(0, i + (k === 'j' ? 1 : -1)));
      select(list[next].lead.id);
      var node = document.querySelector('#feed .item.on');
      if (node) node.scrollIntoView({ block: 'nearest' });
      return;
    }
    var story = state.selected && findStory(state.selected);
    if (k === 's' && story) { toggleSaved(story.item); renderFeed(); renderDetailActions(story.item); return; }
    if (k === 'o' && story) { var ou = safeUrl(story.item.url); if (ou) window.open(ou, '_blank', 'noopener'); return; }
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

  // ---------- connection ----------
  // Live push first. If the stream cannot be held (network, or the server is at its
  // connection limit) the page quietly polls the cached feed instead.
  var poll = null, streamFails = 0;
  function setLive(mode) {
    $('live').className = 'live' + (mode === 'live' ? '' : ' off');
    $('liveText').textContent = mode === 'live' ? 'Live' : mode === 'poll' ? 'Live (polling)' : 'Reconnecting';
    $('offline').hidden = mode !== 'down';
  }
  function loadFeed(live) {
    return fetch('/api/feed').then(function (r) { if (!r.ok) throw new Error('feed'); return r.json(); }).then(function (data) {
      $('demoBadge').hidden = !data.demo;
      $('demoRibbon').hidden = !data.demo;
      var fresh = [];
      (data.items || []).forEach(function (it) { if (addItem(it, live && state.loaded)) fresh.push(it); });
      var first = !state.loaded;
      state.loaded = true;
      state.failed = false;
      if (first) { render(); openPending(); }
      else if (fresh.length) { renderNav(); fresh.forEach(onLiveItem); if (state.view !== 'news') render(); }
      return true;
    }).catch(function () {
      if (!state.loaded) { state.failed = true; if (state.view === 'news') renderFeed(); }
      return false;
    });
  }
  function startPolling() {
    if (poll) return;
    setLive('poll');
    poll = setInterval(function () { if (!document.hidden) loadFeed(true).then(function (ok) { setLive(ok ? 'poll' : 'down'); }); }, 3000);
  }
  function stopPolling() { clearInterval(poll); poll = null; }

  var es = null, esRetry = null;
  function disconnectStream() {
    if (es) { es.close(); es = null; }
    clearTimeout(esRetry); esRetry = null;
    stopPolling();
  }
  function connectStream() {
    if (es) es.close();
    clearTimeout(esRetry); esRetry = null;
    es = new EventSource('/api/stream');
    es.onopen = function () {
      // Anything published while disconnected is picked up by one catch-up fetch.
      if (streamFails || poll) loadFeed(true);
      streamFails = 0;
      stopPolling();
      setLive('live');
    };
    es.onerror = function () {
      streamFails += 1;
      // readyState 2 means the browser has given up (the server refused: it is at its
      // connection limit). It will not try again by itself, so poll now and ask for a
      // live connection again later, at a slightly different moment from everyone else.
      if (es && es.readyState === 2) {
        startPolling();
        if (!esRetry) esRetry = setTimeout(connectStream, 30000 + Math.random() * 30000);
        return;
      }
      if (streamFails >= 2) startPolling(); else setLive('down');
    };
    es.addEventListener('item', function (e) {
      var it;
      try { it = JSON.parse(e.data); } catch (err) { return; }
      if (!addItem(it, true)) return;
      // The first load may have failed; a story arriving live still gets the page going.
      if (!state.loaded) { state.loaded = true; state.failed = false; render(); return; }
      renderNav();
      if (state.view === 'home' && !it.backfill) pasteClip(it);
      if (state.view === 'home') renderHome();
      if (state.view === 'breaking') renderRooms();
      onLiveItem(it);
    });
  }
  // The first load is retried, a little slower each time, until it succeeds.
  function firstLoad(wait) {
    loadFeed(false).then(function (ok) {
      if (!ok && !state.loaded) setTimeout(function () { firstLoad(Math.min(wait * 2, 15000)); }, wait);
    });
  }

  function start() {
    renderKeywords();
    renderToggles();
    window.addEventListener('hashchange', route);
    route();
    firstLoad(1500);
    fetch('/api/chat?room=general').then(function (r) { return r.json(); }).then(function (data) {
      state.msgs.general = data.messages || [];
      state.msgs.general.forEach(function (m) { markSeen(m.id); });
      state.counts = Object.assign(Object.create(null), data.counts || {});
      if (state.view === 'breaking') { renderRooms(); if (state.room === 'general') renderMsgs(); }
    }).catch(function () {});

    connectStream();
    // A tab in the background holds no connections: browsers allow only a handful per
    // site, and at scale idle tabs would otherwise occupy the servers. On return the
    // page catches up with one fetch and reconnects.
    document.addEventListener('visibilitychange', function () {
      // Someone with sound alerts on is relying on hearing them from another tab, so
      // their connection is kept.
      var listening = state.soundAll || (state.sound && state.keywords.length > 0);
      if (document.hidden) { closeChatStream(); if (!listening) disconnectStream(); return; }
      loadFeed(true);
      if (!es || es.readyState === 2) connectStream();
      if (state.view === 'breaking') { loadRoom(state.room); openChatStream(state.room); }
    });
    // Keeps "2m ago" labels and the hourly counts honest without rebuilding the list.
    setInterval(function () {
      renderNav();
      document.querySelectorAll('.when[data-ts]').forEach(function (n) { n.textContent = ago(Number(n.dataset.ts)); });
      if (state.view === 'breaking') {
        // Message counts for the other rooms, which this page is not streaming.
        if (!document.hidden) fetch('/api/chat/counts').then(function (r) { return r.json(); }).then(function (d) { state.counts = Object.assign(Object.create(null), d.counts || state.counts); renderRooms(); }).catch(function () { renderRooms(); });
      }
      if (state.view === 'news' && !state.selected) renderTop();
    }, 30000);
  }
  start();
})();
