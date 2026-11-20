// Stocks, Calendar and Private: the traditional-markets pages. Everything here is drawn
// from the answers under /api/tradfi. Every block names its source and its age, a source
// that is not connected says so in a sentence, and demo answers are labelled as invented.
// Nothing is fetched while a page is hidden or the tab is in the background.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var SVG = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs) {
    var n = document.createElementNS(SVG, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
    return n;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  var DASH = '–';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

  // ---------- what the server sends is not trusted ----------
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 200) : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  // Lookups in plain tables go through this, so a word from the server such as "constructor"
  // can never fetch something inherited instead of an entry.
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function isPerp(x) { return x && x.kind === 'perp'; }
  var PERP_WORDS = 'Price of a perpetual contract on Hyperliquid, which trades round the clock at its own price. It is not the stock exchange’s price, and the change shown is over 24 hours, not since the last close.';
  var SYM = /^[A-Z0-9.\-:]{1,12}$/;
  function sym(v) { var s = typeof v === 'string' ? v.trim().toUpperCase() : ''; return SYM.test(s) ? s : ''; }
  function fk(s) { return String(s).replace(/[^\w:.-]/g, ''); }
  // Links are made only to the official sites the data comes from.
  var SEC = ['https://www.sec.gov/'];
  var OFFICIAL = SEC.concat(['https://www.federalreserve.gov/', 'https://www.bls.gov/', 'https://www.bea.gov/', 'https://home.treasury.gov/', 'https://fiscaldata.treasury.gov/', 'https://www.census.gov/', 'https://fred.stlouisfed.org/']);
  function safeUrl(u, list) {
    if (typeof u !== 'string' || u.length > 600 || /[\s<>"'`\\]/.test(u)) return '';
    for (var i = 0; i < list.length; i++) if (u.indexOf(list[i]) === 0) return u;
    return '';
  }
  function outLink(url, text, label) {
    var a = el('a', 'link', text);
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    if (label) a.setAttribute('aria-label', label);
    return a;
  }

  function limit() { return window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined; }
  function api(path) {
    return fetch('/api/tradfi' + path, { headers: { accept: 'application/json' }, signal: limit() }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        d = obj(d);
        if (!r.ok) { var e = new Error(str(d.error, 160) || 'HTTP ' + r.status); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  // ---------- numbers and dates for people ----------
  function fix(n, d) { return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function trim(n, d) { return n.toLocaleString('en-US', { maximumFractionDigits: d == null ? 2 : d }); }
  function px(n) { n = num(n); return n == null ? DASH : fix(n, 2); }
  function compact(n) {
    var a = Math.abs(n);
    // Each step starts where the one below would round up to it, so 999,960,000 is 1.00B and never "1,000.0M".
    if (a >= 999.995e9) return fix(n / 1e12, 2) + 'T';
    if (a >= 999.95e6) return fix(n / 1e9, 2) + 'B';
    if (a >= 999.5e3) return fix(n / 1e6, 1) + 'M';
    if (a >= 1e4) return fix(n / 1e3, 0) + 'K';
    return trim(n, 0);
  }
  function money(n) { n = num(n); return n == null ? DASH : (n < 0 ? '-$' : '$') + compact(Math.abs(n)); }
  function dir(n) { return n > 0 ? 'up' : n < 0 ? 'down' : ''; }
  // The arrow and the sign carry the direction; colour only repeats it.
  function chg(n, d) {
    n = num(n);
    if (n == null) return DASH;
    return (n > 0 ? '▲ +' : n < 0 ? '▼ ' : '') + n.toFixed(d == null ? 2 : d) + '%';
  }
  function chgNode(tag, n, cls) { return el(tag, 'mono ' + (cls ? cls + ' ' : '') + dir(num(n) || 0), chg(n)); }
  function withUnit(value, unit) {
    if (typeof value === 'string') return str(value, 60) || DASH;
    var v = num(value), u = str(unit, 24);
    if (v == null) return DASH;
    // Rates keep at least one decimal, so 4.0% does not sit beside 4.25% looking like a different kind of figure.
    if (u === '%' || /^percent/i.test(u)) return v.toLocaleString('en-US', { minimumFractionDigits: 1, maximumFractionDigits: 2 }) + '%';
    if (u === 'USD') return money(v);
    if (u === 'USD/share') return (v < 0 ? '-$' : '$') + fix(Math.abs(v), 2);
    if (u === 'shares') return compact(v);
    if (u === 'x' || u === '×' || u === 'ratio') return trim(v, 2) + '×';
    if (!u || /^index/i.test(u)) return trim(v, 2);
    return (Math.abs(v) >= 1e6 ? compact(v) : trim(v, 2)) + ' ' + u;
  }
  function ymd(s) {
    var m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(s) : null;
    return m ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
  }
  function day(s) { var p = ymd(s); return p ? p.d + ' ' + MONTHS[p.m] + ' ' + p.y : DASH; }
  // "2026-10" is a month, "2026-11-18" a day; anything else is shown as the source wrote it.
  function period(s) {
    s = str(s, 40);
    var m = /^(\d{4})-(\d{2})$/.exec(s);
    if (m && MONTHS[+m[2] - 1]) return MONTHS[+m[2] - 1] + ' ' + m[1];
    return ymd(s) && s.length === 10 ? day(s) : s;
  }
  function two(n) { return String(n).padStart(2, '0'); }
  // The moment at which a clock in the named zone reads the given date and time.
  function zoned(date, hh, mm, zone) {
    var p = ymd(date);
    if (!p) return NaN;
    try {
      var f = new Intl.DateTimeFormat('en-US', { timeZone: zone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
      var want = Date.UTC(p.y, p.m, p.d, hh, mm), t = want;
      for (var i = 0; i < 2; i++) {
        var o = {};
        f.formatToParts(new Date(t)).forEach(function (x) { o[x.type] = Number(x.value); });
        t -= Date.UTC(o.year, o.month - 1, o.day, o.hour % 24, o.minute) - want;
      }
      return t;
    } catch (e) { return NaN; }
  }
  function clock(d) { return two(d.getHours()) + ':' + two(d.getMinutes()); }
  function isoLocal(d) { return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate()); }
  // A moment (milliseconds, seconds or an ISO time) or a plain date, as the viewer reads it.
  function when(v) {
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return day(v);
    var ms = typeof v === 'number' ? (v < 1e11 ? v * 1000 : v) : typeof v === 'string' ? Date.parse(v) : NaN;
    if (!isFinite(ms)) return '';
    var d = new Date(ms);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + (d.getFullYear() !== new Date().getFullYear() ? ' ' + d.getFullYear() : '') + ' ' + clock(d);
  }
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  var ZONE = (function () {
    try {
      var parts = new Intl.DateTimeFormat([], { timeZoneName: 'short' }).formatToParts(new Date());
      var short = parts.filter(function (p) { return p.type === 'timeZoneName'; })[0];
      var name = Intl.DateTimeFormat().resolvedOptions().timeZone || '';
      return (name ? name.replace(/_/g, ' ') : 'local time') + (short && short.value ? ' (' + short.value + ')' : '');
    } catch (e) { return 'your local time'; }
  })();

  // ---------- sources, ages, and the sentence shown when a source is missing ----------
  function pick(d, re) {
    var all = arr(d && d.sources).filter(function (s) { return s && typeof s === 'object'; });
    if (!re) return all;
    var hit = all.filter(function (s) { return re.test(str(s.name) + ' ' + str(s.id) + ' ' + str(s.part)); });
    // A demo answer has one source for everything. A live block is credited only to the
    // sources that are its own: never to whatever else happened to be in the same answer.
    return hit.length || !(d && d.demo) ? hit : all;
  }
  // "Index prices are not connected on this server." rather than an empty hole.
  function gap(d, re, noun, verb) {
    var list = pick(d, re).filter(function (s) { return s.state !== 'ok'; });
    var s = list[0];
    if (!s) return noun + ' ' + verb + ' not available right now.';
    var note = str(s.note, 200).replace(/[.\s]+$/, '');
    var who = str(s.name, 60);
    if (s.state === 'off') return noun + ' ' + verb + ' not connected on this server' + (who ? ' (' + who + (note ? ': ' + note : '') + ').' : '.');
    return noun + ' could not be loaded' + (who ? ' from ' + who : '') + (note ? ': ' + note : '') + '.';
  }
  function failed(err, noun) {
    if (err && err.name === 'TimeoutError') return noun + ' did not answer in time. Trying again shortly.';
    if (err && err.status === 502) return noun + ' could not be loaded: the source behind it did not answer. Trying again shortly.';
    if (err && err.status === 503) return noun + ' is not switched on for this server yet.';
    if (err && err.status === 429) return noun + ' could not be loaded: too many requests from this address in the last minute. Trying again shortly.';
    return noun + ' could not be loaded. Trying again shortly.';
  }
  // Fills a block's small print: who supplied it, how old it is, and whether it is invented.
  function setNote(node, d, re, extra) {
    var frag = document.createDocumentFragment();
    if (!d && extra) frag.appendChild(el('span', null, extra));
    if (d) {
      var names = pick(d, re).filter(function (s) { return s.state === 'ok'; }).map(function (s) { return str(s.name, 60); }).filter(Boolean);
      if (extra) frag.appendChild(el('span', null, extra + ' · '));
      if (names.length) frag.appendChild(el('span', null, 'Source: ' + names.slice(0, 4).join(', ') + ' · '));
      // A source answering from its saved copy says so, with the copy's age.
      pick(d, re).forEach(function (s) { if (s.state === 'ok' && /saved answer/i.test(str(s.note))) frag.appendChild(el('span', 'tfDemo', str(s.note, 200) + ' · ')); });
      var at = num(d.at);
      if (at) { var age = el('span', 'tfAge', 'updated ' + ago(at)); age.dataset.at = String(at); frag.appendChild(age); }
      if (d.demo) frag.appendChild(el('span', 'tfDemo', ' · Demo: invented figures'));
    }
    node.replaceChildren(frag);
  }
  function tickAges() {
    document.querySelectorAll('#view-' + st.view + ' .tfAge').forEach(function (n) {
      var at = Number(n.dataset.at);
      if (at) n.textContent = 'updated ' + ago(at);
    });
  }

  // ---------- state ----------
  var MAXW = 30;
  var st = {
    view: '', sym: '', sigs: {}, timers: [],
    ov: null, watch: [], quotes: {}, wq: null, wErr: '', wSeq: 0, mv: {},
    route: null, co: { on: false, raw: null, seq: 0, data: null, quote: null, qData: null, tab: 'income', per: 'annual', open: {}, range: '1y', size: 'd', cSeq: 0, candles: null, shown: '' },
    chart: null, series: null, volume: null, ema50: null, ema200: null,
    cal: { page: 0, data: null, seq: 0, on: { earnings: true, ipo: true, economic: true, 'central-bank': true } },
    ipo: null,
    pv: { data: null, sort: 'filedAt', dir: -1, industry: '', q: '' }
  };
  try {
    var saved = JSON.parse(localStorage.getItem('nt.watch') || '[]');
    if (Array.isArray(saved)) {
      saved.forEach(function (s) { s = sym(s); if (s && st.watch.indexOf(s) === -1 && st.watch.length < MAXW) st.watch.push(s); });
    }
  } catch (e) { /* storage unavailable or damaged: start empty */ }
  function saveWatch() { try { localStorage.setItem('nt.watch', JSON.stringify(st.watch)); } catch (e) { /* ignore */ } }
  function changed(name, value) { var v = JSON.stringify(value); if (st.sigs[name] === v) return false; st.sigs[name] = v; return true; }
  function forget(prefix) { Object.keys(st.sigs).forEach(function (k) { if (k.indexOf(prefix) === 0) delete st.sigs[k]; }); }
  // Replaces a block's contents and puts focus and sideways table scroll back where they were.
  function swap(box, node) {
    var a = document.activeElement, key = a && a.dataset && box.contains(a) ? a.dataset.fk : null;
    var lefts = Array.prototype.map.call(box.querySelectorAll('.tableWrap'), function (w) { return w.scrollLeft; });
    box.replaceChildren(node);
    box.querySelectorAll('.tableWrap').forEach(function (w, i) { if (lefts[i]) w.scrollLeft = lefts[i]; });
    if (key) refocus(box, key);
  }
  function refocus(box, key) { var n = box.querySelector('[data-fk="' + fk(key) + '"]'); if (n) n.focus({ preventScroll: true }); }
  function go(symbol) { location.hash = '#stocks/' + encodeURIComponent(symbol); }
  // A link to a company page: the ticker, with the company's name under it when known.
  function symLink(symbol, name) {
    var a = el('a', 'tfSym');
    a.href = '#stocks/' + encodeURIComponent(symbol);
    a.appendChild(el('b', 'mono', symbol));
    if (name) a.appendChild(el('span', 'muted small tfCoName', name));
    return a;
  }

  // ---------- page furniture ----------
  function header(view, kicker, title) {
    var head = el('div', 'breakHead');
    var left = el('div');
    var k = el('p', 'kicker tfKick', kicker);
    var h = el('h1', 'display', title);
    var at = el('p', 'muted tfHeadNote');
    add(left, k, h);
    add(head, left, at);
    view.appendChild(head);
    return { h: h, at: at };
  }
  function card(title, id, cls) {
    var sec = el('section', 'card tfBlock' + (cls ? ' ' + cls : ''));
    sec.id = id;
    sec.setAttribute('aria-labelledby', id + 'T');
    var head = el('div', 'sideHead padHead');
    var h = el('h2', null, title); h.id = id + 'T';
    var note = el('span', 'muted small tfNote');
    add(head, h, note);
    var body = el('div', 'tfBody');
    add(sec, head, body);
    return { sec: sec, body: body, note: note, head: head, h: h };
  }
  function seg(label, options, current, prefix, onPick) {
    var box = el('div', 'seg');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', label);
    options.forEach(function (o) {
      var b = el('button', o[0] === current ? 'on' : '', o[1]);
      b.type = 'button';
      b.dataset.fk = fk(prefix + o[0]);
      b.setAttribute('aria-pressed', String(o[0] === current));
      b.addEventListener('click', function () { onPick(o[0]); });
      box.appendChild(b);
    });
    return box;
  }
  function tile(label, value, sub, cls) {
    var d = el('div', 'stTile tfTile');
    d.appendChild(el('span', 'statLabel', label));
    d.appendChild(el('b', 'tfVal ' + (cls || ''), value));
    if (sub) d.appendChild(el('span', 'muted small', sub));
    return d;
  }
  function sayBox(text) { var p = el('p', 'emptyBox', text); p.setAttribute('role', 'status'); return p; }
  function cmp(a, b, d) {
    var na = a == null || a === '', nb = b == null || b === '';
    if (na || nb) return na && nb ? 0 : na ? 1 : -1; // blanks last, whichever way the sort runs
    if (typeof a === 'string' || typeof b === 'string') return d * String(a).localeCompare(String(b));
    return d * (a - b);
  }
  // A header row of sort buttons, as on the all-markets table.
  function sortHead(cols, state, prefix, redraw) {
    var tr = el('tr');
    cols.forEach(function (c) {
      var th = el('th');
      th.scope = 'col';
      if (!c.id) { th.textContent = c.label; tr.appendChild(th); return; }
      var on = state.sort === c.id;
      if (on) th.setAttribute('aria-sort', state.dir === 1 ? 'ascending' : 'descending');
      var b = el('button', 'thBtn' + (on ? ' on' : ''), c.label + (on ? (state.dir === 1 ? ' ▲' : ' ▼') : ''));
      b.type = 'button';
      b.dataset.fk = fk(prefix + c.id);
      b.addEventListener('click', function () {
        if (state.sort === c.id) state.dir = -state.dir; else { state.sort = c.id; state.dir = c.text ? 1 : -1; }
        redraw();
      });
      th.appendChild(b);
      tr.appendChild(th);
    });
    var head = el('thead');
    head.appendChild(tr);
    return head;
  }

  // ---------- company search (a combobox with a list of results) ----------
  function makeSearch(o) {
    var s = { items: [], at: 0, seq: 0, timer: null, enter: false, q: '', settled: false };
    var wrap = el('div', 'tfSearch');
    var lab = el('label', 'sr', o.label); lab.htmlFor = o.id;
    var input = el('input');
    input.type = 'text'; input.id = o.id; input.placeholder = o.placeholder; input.maxLength = 40;
    input.autocomplete = 'off'; input.spellcheck = false;
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-controls', o.id + 'L');
    var list = el('ul', 'tfResults'); list.id = o.id + 'L'; list.hidden = true;
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', o.label);
    var said = el('p', 'sr'); said.setAttribute('role', 'status');
    add(wrap, lab, input, list, said);

    function close() {
      list.hidden = true;
      input.setAttribute('aria-expanded', 'false');
      input.removeAttribute('aria-activedescendant');
    }
    function choose(i) {
      var it = s.items[i];
      if (!it) return;
      clearTimeout(s.timer); s.seq++; s.items = []; s.enter = false;
      input.value = '';
      close();
      o.onPick(it);
    }
    function draw(message, demo) {
      var frag = document.createDocumentFragment();
      s.items.forEach(function (it, i) {
        var li = el('li', 'tfOpt' + (i === s.at ? ' on' : ''));
        li.id = o.id + '-' + i;
        li.setAttribute('role', 'option');
        li.setAttribute('aria-selected', String(i === s.at));
        add(li, el('b', 'mono', it.symbol), el('span', 'tfOptName', it.name || it.symbol), el('span', 'muted small', it.exchange));
        // Keeps the caret in the box while the mouse picks a row.
        li.addEventListener('mousedown', function (e) { e.preventDefault(); });
        li.addEventListener('click', function () { choose(i); });
        frag.appendChild(li);
      });
      if (message) { var m = el('li', 'tfOptNote muted', message); m.setAttribute('role', 'presentation'); frag.appendChild(m); }
      if (demo && s.items.length) { var dm = el('li', 'tfOptNote tfDemo small', 'Demo: these companies are invented.'); dm.setAttribute('role', 'presentation'); frag.appendChild(dm); }
      list.replaceChildren(frag);
      list.hidden = false;
      input.setAttribute('aria-expanded', 'true');
      if (s.items.length) input.setAttribute('aria-activedescendant', o.id + '-' + s.at); else input.removeAttribute('aria-activedescendant');
      var on = list.querySelector('.on');
      if (on && on.scrollIntoView) on.scrollIntoView({ block: 'nearest' });
      said.textContent = message || (s.items.length + (s.items.length === 1 ? ' company' : ' companies') + ' found');
    }
    function run() {
      var q = input.value.trim();
      s.timer = null;
      if (!q) { s.seq++; s.items = []; close(); return; }
      var seq = ++s.seq;
      s.q = q; s.settled = false;
      api('/search?q=' + encodeURIComponent(q)).then(function (d) {
        if (seq !== s.seq) return; // a newer search has been sent
        s.settled = true;
        var seen = {};
        s.items = arr(d.results).map(function (r) { r = obj(r); return { symbol: sym(r.symbol), name: str(r.name, 80), exchange: str(r.exchange, 24) }; })
          .filter(function (r) { if (!r.symbol || seen[r.symbol]) return false; seen[r.symbol] = true; return true; }).slice(0, 12);
        // A typed ticker selects its own row first.
        var exact = -1;
        s.items.forEach(function (r, i) { if (r.symbol === q.toUpperCase()) exact = i; });
        s.at = exact === -1 ? 0 : exact;
        if (s.enter && s.items.length) { choose(s.at); return; }
        s.enter = false;
        draw(s.items.length ? '' : 'No listed company matches “' + q.slice(0, 40) + '”.', Boolean(d.demo));
      }).catch(function (err) {
        if (seq !== s.seq) return;
        s.items = []; s.enter = false; s.settled = true;
        draw(failed(err, 'Company search'));
      });
    }
    input.addEventListener('input', function () {
      clearTimeout(s.timer);
      s.enter = false; s.settled = false;
      s.seq++;
      s.timer = setTimeout(run, 200);
    });
    input.addEventListener('keydown', function (e) {
      var open = !list.hidden && s.items.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (!open) return;
        e.preventDefault();
        s.at = (s.at + (e.key === 'ArrowDown' ? 1 : s.items.length - 1)) % s.items.length;
        draw('');
      } else if (e.key === 'Enter') {
        e.preventDefault();
        // Enter before the list has caught up with the typing takes the first match when it arrives.
        if (!input.value.trim()) return;
        if (s.timer) { clearTimeout(s.timer); s.enter = true; run(); }
        else if (s.settled && s.q === input.value.trim()) choose(s.at);
        else s.enter = true;
      } else if (e.key === 'Escape') {
        if (!list.hidden) { e.preventDefault(); e.stopPropagation(); close(); }
      }
    });
    input.addEventListener('blur', close);
    input.addEventListener('focus', function () { if (s.items.length && input.value.trim()) draw(''); });
    return { node: wrap, input: input };
  }

  // =====================================================================================
  // STOCKS
  // =====================================================================================
  var ui = {};
  function buildStocks() {
    var view = $('view-stocks');
    ui.sHead = header(view, 'Stocks', 'The stock market at a glance');
    var bar = el('div', 'filters tfBar');
    ui.back = el('a', 'btn backBtn', '← All stocks');
    ui.back.href = '#stocks';
    ui.back.hidden = true;
    ui.search = makeSearch({ id: 'tfQ', label: 'Find a company by name or ticker', placeholder: 'Find a company by name or ticker', onPick: function (r) { go(r.symbol); } });
    add(bar, ui.back, ui.search.node);
    view.appendChild(bar);

    // ----- overview -----
    ui.ov = el('div', 'pad'); ui.ov.id = 'tfOverview';
    ui.ovState = sayBox('Loading the market overview…');
    ui.idx = card('Indexes', 'tfIdx');
    ui.sec = card('Sectors today', 'tfSec');
    ui.map = card('Market map', 'tfMap');
    ui.mov = card('Movers', 'tfMov');
    ui.yld = card('Treasury yield curve', 'tfYld');
    ui.mac = card('Key macro figures', 'tfMac');
    ui.wat = card('Your watchlist', 'tfWat');
    ui.watAdd = makeSearch({ id: 'tfWQ', label: 'Add a company to your watchlist', placeholder: 'Add by name or ticker', onPick: function (r) { addWatch(r.symbol); ui.watAdd.input.focus(); } });
    ui.watMsg = el('p', 'tfMsg'); ui.watMsg.setAttribute('role', 'status');
    ui.watBody = el('div');
    add(ui.wat.body, ui.watAdd.node, ui.watMsg, ui.watBody);
    var two = el('div', 'tfSplit');
    add(two, ui.yld.sec, ui.wat.sec);
    add(ui.ov, ui.ovState, ui.idx.sec, ui.sec.sec, ui.map.sec, ui.mov.sec, two, ui.mac.sec);
    view.appendChild(ui.ov);

    // ----- company -----
    ui.co = el('div', 'pad'); ui.co.id = 'tfCompany'; ui.co.hidden = true;
    ui.coState = sayBox('');
    ui.coMain = el('div', 'stack tfCoMain');
    ui.quote = card('Price', 'tfQuote');
    ui.chartCard = card('Price chart', 'tfChartC');
    ui.ranges = el('div', 'tfSegs');
    ui.legend = el('p', 'tfLegend small');
    add(ui.legend, legendKey('tfSw50', 'EMA 50 (solid line)'), legendKey('tfSw200', 'EMA 200 (dashed line)'), el('span', 'muted', 'Bars along the bottom: volume'));
    ui.chartBox = el('div', 'chart tfChart'); ui.chartBox.id = 'tfChart';
    ui.chartBox.setAttribute('role', 'img');
    ui.chartBox.setAttribute('aria-label', 'Price chart');
    ui.chartSum = el('p', 'small tfChartSum'); ui.chartSum.id = 'tfChartSum';
    var credit = el('p', 'muted small');
    add(credit, document.createTextNode('Charts by '), outLink('https://www.tradingview.com/', 'TradingView Lightweight Charts'), document.createTextNode('.'));
    var chartTop = el('div', 'row between tfChartTop');
    add(chartTop, ui.ranges, ui.legend);
    ui.chartData = el('details', 'tfDetails'); ui.chartData.id = 'tfChartData';
    ui.chartData.appendChild(el('summary', null, 'Show these candles as a table'));
    ui.chartTable = el('div');
    ui.chartData.appendChild(ui.chartTable);
    ui.chartData.addEventListener('toggle', drawCandleTable);
    add(ui.chartCard.body, chartTop, ui.chartBox, ui.chartSum, ui.chartData, credit);
    ui.facts = card('Key facts', 'tfFacts');
    ui.stmt = card('Financial statements', 'tfStmt');
    ui.fil = card('Recent filings', 'tfFil');
    // Large managers holding the share, insider transactions and stakes above 5%: drawn by funds.js.
    ui.own = card('Who holds it and who is trading it', 'tfOwn');
    add(ui.coMain, ui.quote.sec, ui.chartCard.sec, ui.facts.sec, ui.stmt.sec, ui.own.sec, ui.fil.sec);
    add(ui.co, ui.coState, ui.coMain);
    view.appendChild(ui.co);
    drawRanges();
  }
  function legendKey(cls, text) {
    var s = el('span', 'tfKey');
    var sw = el('i', 'tfSw ' + cls); sw.setAttribute('aria-hidden', 'true');
    add(s, sw, document.createTextNode(text));
    return s;
  }

  // ----- overview blocks -----
  function spark(values) {
    var v = arr(values).map(num).filter(function (n) { return n != null; });
    if (v.length < 2) return null;
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v), span = hi - lo || 1;
    var pts = v.map(function (n, i) { return (i / (v.length - 1) * 120).toFixed(1) + ',' + (30 - (n - lo) / span * 28).toFixed(1); }).join(' ');
    var s = svg('svg', { viewBox: '0 0 120 32', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
    s.setAttribute('class', 'tfSpark ' + dir(v[v.length - 1] - v[0]));
    s.appendChild(svg('polyline', { points: pts, fill: 'none', 'vector-effect': 'non-scaling-stroke' }));
    return s;
  }
  function drawIndexes(d) {
    var list = arr(d.indexes).map(obj).filter(function (x) { return str(x.name) || str(x.symbol); });
    setNote(ui.idx.note, d, /index|price|quote|market|perpetual|hyperliquid|finnhub|twelve/i);
    if (!changed('ov.idx', [list, list.length ? 0 : pick(d)])) return;
    if (!list.length) { swap(ui.idx.body, sayBox(gap(d, /index|price|quote|market|perpetual|hyperliquid|finnhub|twelve/i, 'Index prices', 'are'))); return; }
    var grid = el('div', 'tfTiles');
    list.forEach(function (x) {
      var t = el('div', 'stTile tfTile tfIndex');
      var top = el('span', 'statLabel', str(x.name, 60) || str(x.symbol, 12));
      if (str(x.name) && str(x.symbol)) top.appendChild(el('span', 'mono tfTick', str(x.symbol, 12)));
      var line = el('div', 'tfIdxLine');
      add(line, el('b', 'tfVal', px(x.price)), chgNode('span', x.changePct, 'tfChg'));
      var asOf = when(x.asOf);
      if (isPerp(x)) line.appendChild(el('span', 'stPill wait tfPerp', 'Perpetual'));
      add(t, top, line, spark(x.spark), el('span', 'muted small', (isPerp(x) ? 'Perpetual contract price, not the index level · change over 24 hours' : x.delayed ? 'Delayed' : 'Latest') + (asOf ? ' · as of ' + asOf : '')));
      grid.appendChild(t);
    });
    if (list.some(isPerp)) { var both = document.createDocumentFragment(); add(both, el('p', 'tfPerpNote small', PERP_WORDS), grid); swap(ui.idx.body, both); return; }
    swap(ui.idx.body, grid);
  }
  function drawSectors(d) {
    var list = arr(d.sectors).map(obj).filter(function (x) { return str(x.name) && num(x.changePct) != null; })
      .sort(function (a, b) { return b.changePct - a.changePct; });
    setNote(ui.sec.note, d, /sector/i);
    if (!changed('ov.sec', [list, list.length ? 0 : pick(d)])) return;
    if (!list.length) { swap(ui.sec.body, sayBox(gap(d, /sector/i, 'Sector moves', 'are'))); return; }
    var max = Math.max.apply(null, list.map(function (x) { return Math.abs(x.changePct); })) || 1;
    var row = el('ul', 'tfHeat');
    list.forEach(function (x) {
      var li = el('li', 'tfHeatCell ' + dir(x.changePct));
      // Shade deepens with the size of the move; the figure itself is always printed.
      li.style.setProperty('--m', Math.round(8 + Math.abs(x.changePct) / max * 26) + '%');
      add(li, el('span', 'tfHeatName', str(x.name, 40)), el('b', 'mono', chg(x.changePct)));
      row.appendChild(li);
    });
    swap(ui.sec.body, row);
  }
  // The market map: a squarified treemap (Bruls, Huizing and van Wijk) of the companies in
  // the movers lists. Rows of tiles are added along the shorter side while that keeps the
  // tiles closer to square.
  function squarify(areas, W, H) {
    var out = [], x = 0, y = 0, w = W, h = H, row = [], i = 0;
    var sum = function (r) { return r.reduce(function (a, b) { return a + b; }, 0); };
    var worst = function (r, side) {
      var t = sum(r), max = Math.max.apply(null, r), min = Math.min.apply(null, r);
      return Math.max(side * side * max / (t * t), t * t / (side * side * min));
    };
    var lay = function (r) {
      var t = sum(r);
      if (w >= h) { var cw = t / h, cy = y; r.forEach(function (a) { out.push({ x: x, y: cy, w: cw, h: a / cw }); cy += a / cw; }); x += cw; w -= cw; }
      else { var ch = t / w, cx = x; r.forEach(function (a) { out.push({ x: cx, y: y, w: a / ch, h: ch }); cx += a / ch; }); y += ch; h -= ch; }
    };
    while (i < areas.length) {
      var side = Math.min(w, h);
      if (!row.length || worst(row.concat([areas[i]]), side) <= worst(row, side)) { row.push(areas[i]); i++; }
      else { lay(row); row = []; }
    }
    if (row.length) lay(row);
    return out;
  }
  var MAP_CAP = 3; // a move of 3% or more gets the deepest shade
  function shade(pct) { return Math.round(10 + Math.min(1, Math.abs(pct) / MAP_CAP) * 38) + '%'; }
  var mapItems = [], mapBy = '';
  function drawMap(d) {
    var mv = obj(d.movers), seen = {}, list = [];
    ['gainers', 'losers', 'active'].forEach(function (k) {
      arr(mv[k]).map(obj).forEach(function (r) {
        var s = sym(r.symbol);
        if (!s || seen[s] || num(r.changePct) == null) return;
        seen[s] = true;
        list.push({ symbol: s, name: str(r.name, 60), changePct: r.changePct, cap: num(r.marketCap), perp: isPerp(r),
          traded: num(r.price) != null && num(r.volume) != null ? r.price * r.volume : num(r.volumeUsd), volume: num(r.volume) });
      });
    });
    // Area by market value when every company carries one; otherwise by value traded today.
    var by = list.length && list.every(function (r) { return r.cap > 0; }) ? 'cap' : list.every(function (r) { return r.traded > 0; }) ? 'traded' : 'volume';
    list = list.filter(function (r) { return r[by] > 0; }).sort(function (a, b) { return b[by] - a[by]; }).slice(0, 40);
    setNote(ui.map.note, d, /mover|price|quote|market|perpetual|hyperliquid|finnhub|twelve/i);
    if (!changed('ov.map', [list, by, list.length ? 0 : pick(d)])) return;
    mapItems = list; mapBy = by;
    var perps = list.some(function (r) { return r.perp; });
    var moveWords = perps ? 'the 24-hour change of each company’s perpetual contract on Hyperliquid (not its exchange price)' : 'today’s change';
    var byWords = perps && by === 'traded' ? 'value traded in the perpetual contract over 24 hours' : MAP_WORDS[by];
    if (list.length < 2) { mapItems = []; swap(ui.map.body, sayBox(gap(d, /mover|price|quote|market|perpetual|hyperliquid|finnhub|twelve/i, 'The market map', 'is'))); return; }
    var frag = document.createDocumentFragment();
    var box = el('div', 'tfMapBox'); box.id = 'tfMapBox';
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Market map: one button per company, sized by ' + byWords + ' and shaded by ' + moveWords);
    frag.appendChild(box);
    var legend = el('div', 'tfMapLegend');
    var scale = el('div', 'tfMapScale'); scale.setAttribute('aria-hidden', 'true');
    [-3, -2, -1, 0, 1, 2, 3].forEach(function (v) {
      var sw = el('span', 'tfMapSw ' + dir(v), (v > 0 ? '+' : '') + v + '%' + (Math.abs(v) === MAP_CAP ? (v > 0 ? ' or more' : ' or less') : ''));
      sw.style.setProperty('--m', v ? shade(v) : '0%');
      scale.appendChild(sw);
    });
    add(legend, scale, el('p', 'muted small', 'Shade shows ' + moveWords + ', deepest at ' + MAP_CAP + '% either way; each tile also prints it with an arrow. Tile area follows ' + byWords +
      ', on a square-root scale so the smallest companies stay readable: a tile four times the area is sixteen times the figure. Covers the ' + list.length + ' companies in the movers lists below, where the same figures are in tables.'));
    frag.appendChild(legend);
    swap(ui.map.body, frag);
    layMap(true);
  }
  var MAP_WORDS = { cap: 'market value', traded: 'value traded today (price × volume)', volume: 'shares traded today' };
  function layMap(force) {
    var box = $('tfMapBox');
    if (!box || !mapItems.length) return;
    var W = box.clientWidth, H = box.clientHeight;
    if (!W || !H) return;
    if (!force && box.dataset.w === W + 'x' + H) return;
    box.dataset.w = W + 'x' + H;
    var roots = mapItems.map(function (r) { return Math.sqrt(r[mapBy]); });
    var total = roots.reduce(function (a, b) { return a + b; }, 0);
    var rects = squarify(roots.map(function (v) { return v / total * W * H; }), W, H);
    var frag = document.createDocumentFragment();
    mapItems.forEach(function (r, i) {
      var q = rects[i];
      var b = el('button', 'tfMapTile ' + dir(r.changePct));
      b.type = 'button';
      b.dataset.fk = fk('hm-' + r.symbol);
      b.dataset.symbol = r.symbol;
      b.style.left = (q.x / W * 100).toFixed(3) + '%'; b.style.top = (q.y / H * 100).toFixed(3) + '%';
      b.style.width = (q.w / W * 100).toFixed(3) + '%'; b.style.height = (q.h / H * 100).toFixed(3) + '%';
      b.style.setProperty('--m', r.changePct ? shade(r.changePct) : '0%');
      var size = Math.max(11, Math.min(22, Math.floor(Math.min(q.w / 5.2, q.h / 2.6))));
      b.style.fontSize = size + 'px';
      if (q.w < 46 || q.h < 22) b.classList.add('tiny');
      else if (q.h < 40) b.classList.add('short');
      add(b, el('b', null, r.symbol), el('span', 'mono', chg(r.changePct)));
      var text = r.symbol + (r.name ? ', ' + r.name : '') + ': ' + chg(r.changePct).replace('▲ ', 'up ').replace('▼ ', 'down ') + '. ' +
        (r.perp ? 'Perpetual contract on Hyperliquid, 24-hour change, not the exchange price. ' : '') +
        (mapBy === 'cap' ? 'Market value ' + money(r.cap) : mapBy === 'traded' ? 'Value traded ' + money(r.traded) : 'Volume ' + compact(r.volume)) + '. Open the company page.';
      b.setAttribute('aria-label', text);
      b.title = text;
      b.addEventListener('click', function () { go(r.symbol); });
      frag.appendChild(b);
    });
    swap(box, frag);
  }
  var MOVERS = [['gainers', 'Gainers', 'changePct', -1], ['losers', 'Losers', 'changePct', 1], ['active', 'Most active', 'volume', -1]];
  var MCOLS = [{ id: 'symbol', label: 'Company', text: true }, { id: 'price', label: 'Price' }, { id: 'changePct', label: 'Change' }, { id: 'volume', label: 'Volume' }];
  function drawMovers(d, force) {
    var mv = obj(d.movers);
    var lists = MOVERS.map(function (m) { return arr(mv[m[0]]).map(obj).filter(function (r) { return sym(r.symbol); }); });
    setNote(ui.mov.note, d, /mover|price|quote|market|perpetual|hyperliquid|finnhub|twelve/i);
    if (!changed('ov.mov', [lists, pick(d).length, mv.universe]) && !force) return;
    if (!lists.some(function (l) { return l.length; })) { swap(ui.mov.body, sayBox(gap(d, /mover|price|quote|market|perpetual|hyperliquid|finnhub|twelve/i, 'Movers', 'are'))); return; }
    var grid = el('div', 'tfThree');
    var perps = lists.some(function (l) { return l.some(isPerp); });
    // Perpetual contracts have no share volume; what they have is dollars traded in 24 hours.
    var vol = function (r) { return num(r.volume) != null ? r.volume : num(r.volumeUsd); };
    var cols = perps ? MCOLS.map(function (c) { return c.id === 'volume' ? { id: 'volume', label: 'Traded, 24h' } : c.id === 'changePct' ? { id: 'changePct', label: 'Change, 24h' } : c; }) : MCOLS;
    MOVERS.forEach(function (m, i) {
      var state = st.mv[m[0]] || (st.mv[m[0]] = { sort: m[2], dir: m[3] });
      var box = el('div', 'tfMover');
      var h = el('h3', 'subHead', m[1]); h.id = 'tfMv' + m[0];
      box.appendChild(h);
      if (!lists[i].length) { box.appendChild(el('p', 'muted small', 'Nothing to list.')); grid.appendChild(box); return; }
      var table = el('table', 'screener tfRows');
      table.setAttribute('aria-labelledby', h.id);
      table.appendChild(sortHead(cols, state, 'mv-' + m[0] + '-', function () { drawMovers(st.ov, true); }));
      var body = el('tbody');
      lists[i].slice().sort(function (a, b) {
        var val = function (r) { return state.sort === 'symbol' ? sym(r.symbol) : state.sort === 'volume' ? vol(r) : num(r[state.sort]); };
        return cmp(val(a), val(b), state.dir);
      }).forEach(function (r) {
        var s = sym(r.symbol);
        var tr = el('tr', 'tfRowLink');
        var name = el('th'); name.scope = 'row';
        var a = symLink(s, str(r.name, 60) + (isPerp(r) ? ' · perpetual' : ''));
        a.dataset.fk = fk('mvr-' + m[0] + '-' + s);
        name.appendChild(a);
        add(tr, name, el('td', 'mono', px(r.price)), chgNode('td', r.changePct), el('td', 'mono', num(r.volume) != null ? compact(r.volume) : num(r.volumeUsd) != null ? money(r.volumeUsd) : DASH));
        // The whole row opens the company; the link in it does the same for keyboards.
        tr.addEventListener('click', function (e) { if (!e.target.closest('a')) go(s); });
        body.appendChild(tr);
      });
      table.appendChild(body);
      var wrap = el('div', 'tableWrap');
      wrap.appendChild(table);
      box.appendChild(wrap);
      grid.appendChild(box);
    });
    var uni = str(mv.universe, 300);
    if (perps || uni) {
      var both = document.createDocumentFragment();
      add(both, el('p', 'tfPerpNote small', (perps ? PERP_WORDS + ' ' : '') + uni), grid);
      swap(ui.mov.body, both);
      return;
    }
    swap(ui.mov.body, grid);
  }

  // The yield curve: tenors evenly spaced along the bottom, yield up the side.
  var yieldPts = [];
  function niceStep(span) {
    var raw = span / 4, mag = Math.pow(10, Math.floor(Math.log(raw) / Math.LN10)), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * mag;
  }
  function drawCurve() {
    var box = $('tfCurve');
    if (!box || yieldPts.length < 2) return;
    var W = Math.max(260, box.clientWidth || 0), H = 230, L = 42, R = 14, T = 20, B = 30;
    if (box.dataset.w === String(W) && box.dataset.sig === st.sigs['ov.yld']) return;
    box.dataset.w = String(W); box.dataset.sig = st.sigs['ov.yld'];
    var vals = yieldPts.map(function (p) { return p.value; });
    var lo = Math.min.apply(null, vals), hi = Math.max.apply(null, vals);
    var step = niceStep((hi - lo) || 0.5);
    lo = Math.floor((lo - step * 0.2) / step) * step; hi = Math.ceil((hi + step * 0.2) / step) * step;
    var x = function (i) { return L + i * (W - L - R) / (yieldPts.length - 1); };
    var y = function (v) { return T + (hi - v) / (hi - lo) * (H - T - B); };
    var s = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true', focusable: 'false' });
    for (var g = lo; g <= hi + step / 2; g += step) {
      s.appendChild(svg('line', { x1: L, x2: W - R, y1: y(g), y2: y(g), 'class': 'tfGrid' }));
      var lab = svg('text', { x: L - 8, y: y(g) + 4, 'text-anchor': 'end', 'class': 'tfAxis' });
      lab.textContent = g.toFixed(step < 1 ? (step < 0.1 ? 2 : 1) : 0) + '%';
      s.appendChild(lab);
    }
    var every = (W - L - R) / (yieldPts.length - 1) < 34 ? 2 : 1;
    yieldPts.forEach(function (p, i) {
      if (every === 2 && i % 2 && i !== yieldPts.length - 1) return;
      if (every === 2 && i === yieldPts.length - 2 && (yieldPts.length - 1) % 2) return;
      var t = svg('text', { x: x(i), y: H - 8, 'text-anchor': 'middle', 'class': 'tfAxis' });
      t.textContent = p.tenor;
      s.appendChild(t);
    });
    s.appendChild(svg('polyline', { points: yieldPts.map(function (p, i) { return x(i).toFixed(1) + ',' + y(p.value).toFixed(1); }).join(' '), 'class': 'tfLine', fill: 'none' }));
    yieldPts.forEach(function (p, i) { s.appendChild(svg('circle', { cx: x(i), cy: y(p.value), r: 3.5, 'class': 'tfDot' })); });
    box.replaceChildren(s);
  }
  function tenorWords(t) { var m = /^(\d+)([MY])$/.exec(t); return m ? m[1] + (m[2] === 'M' ? '-month' : '-year') : t; }
  function spreadText(pts) {
    var two = pts.filter(function (p) { return p.tenor === '2Y'; })[0], ten = pts.filter(function (p) { return p.tenor === '10Y'; })[0];
    if (!two || !ten) return 'The 2-year and 10-year yields are both needed to state the spread; at least one is missing.';
    var gapPts = ten.value - two.value, size = Math.abs(gapPts).toFixed(2);
    var pair = ' (' + ten.value.toFixed(2) + '% against ' + two.value.toFixed(2) + '%)';
    if (Math.abs(gapPts) < 0.005) return 'The 10-year yield equals the 2-year' + pair + ': the curve is flat between them.';
    return gapPts > 0
      ? 'The 10-year yield is ' + size + ' percentage points above the 2-year' + pair + ': the curve slopes upward between them.'
      : 'The 10-year yield is ' + size + ' percentage points below the 2-year' + pair + ': the curve is inverted between them.';
  }
  function drawYields(d) {
    var y = obj(d.yields);
    var pts = arr(y.points).map(obj).map(function (p) { return { tenor: str(p.tenor, 6).toUpperCase(), value: num(p.value) }; })
      .filter(function (p) { return /^\d{1,2}[MY]$/.test(p.tenor) && p.value != null; });
    var asOf = when(y.asOf);
    setNote(ui.yld.note, d, /treasury|yield/i, asOf && pts.length ? 'As of ' + asOf : '');
    if (!changed('ov.yld', [pts, y.asOf, pts.length ? 0 : pick(d)])) return;
    if (pts.length < 2) { yieldPts = []; swap(ui.yld.body, sayBox(gap(d, /treasury|yield/i, 'Treasury yields', 'are'))); return; }
    yieldPts = pts;
    var frag = document.createDocumentFragment();
    var box = el('div', 'tfCurve'); box.id = 'tfCurve';
    box.setAttribute('role', 'img');
    box.setAttribute('aria-label', 'Line chart of US Treasury yields by maturity, from ' + tenorWords(pts[0].tenor) + ' at ' + pts[0].value.toFixed(2) + '% to ' + tenorWords(pts[pts.length - 1].tenor) + ' at ' + pts[pts.length - 1].value.toFixed(2) + '%. The figures are in the table below.');
    frag.appendChild(box);
    frag.appendChild(el('p', 'tfSpread', spreadText(pts)));
    var table = el('table', 'screener tfYields');
    table.appendChild(el('caption', 'sr', 'Treasury yields by maturity, in percent'));
    var h = el('tr'), v = el('tr');
    var h0 = el('th', null, 'Maturity'); h0.scope = 'row'; h.appendChild(h0);
    var v0 = el('th', null, 'Yield, %'); v0.scope = 'row'; v.appendChild(v0);
    pts.forEach(function (p) { var th = el('th', 'mono', p.tenor); th.scope = 'col'; h.appendChild(th); v.appendChild(el('td', 'mono', p.value.toFixed(2))); });
    var tb = el('tbody'); add(tb, h, v); table.appendChild(tb);
    var wrap = el('div', 'tableWrap'); wrap.appendChild(table);
    frag.appendChild(wrap);
    swap(ui.yld.body, frag);
    drawCurve();
  }
  function drawMacro(d) {
    var list = arr(d.macro).map(obj).filter(function (m) { return str(m.name); });
    setNote(ui.mac.note, d, /fred|bls|bea|macro|federal|labor|economic|treasury/i);
    if (!changed('ov.mac', [list, list.length ? 0 : pick(d)])) return;
    if (!list.length) { swap(ui.mac.body, sayBox(gap(d, /fred|bls|bea|macro|federal|labor|economic/i, 'Macro figures', 'are'))); return; }
    var grid = el('div', 'tfTiles');
    list.forEach(function (m) {
      var t = tile(str(m.name, 70), withUnit(m.value, m.unit), str(m.period, 30) ? 'Period: ' + period(m.period) : '');
      t.appendChild(el('span', 'muted small', 'Previous: ' + (m.previous == null ? DASH : withUnit(m.previous, m.unit))));
      grid.appendChild(t);
    });
    // FRED's terms ask for its notice wherever its figures are shown.
    var fred = pick(d).filter(function (x) { return x.state === 'ok' && /^FRED/.test(str(x.name)) && /FRED/.test(str(x.note)); })[0];
    if (fred) {
      var both = document.createDocumentFragment(), np = el('p', 'muted small tfFred', str(fred.note, 240) + ' ');
      np.appendChild(outLink('https://fred.stlouisfed.org/docs/api/terms_of_use.html', 'FRED terms of use'));
      add(both, grid, np);
      swap(ui.mac.body, both);
      return;
    }
    swap(ui.mac.body, grid);
  }
  function drawOverview() {
    var d = st.ov;
    if (!d) return;
    ui.ovState.hidden = true;
    drawIndexes(d); drawSectors(d); drawMap(d); drawMovers(d); drawYields(d); drawMacro(d);
    if (!st.co.on) setNote(ui.sHead.at, d, null, 'Overview');
  }
  function loadOverview() {
    api('/overview').then(function (d) {
      st.ov = d;
      if (st.view === 'stocks' && !st.co.on) drawOverview();
    }).catch(function (err) {
      if (st.ov) return; // keep what is on screen; its age keeps counting
      ui.ovState.hidden = false;
      ui.ovState.textContent = failed(err, 'The market overview');
    });
  }

  // ----- watchlist -----
  function watching(s) { return st.watch.indexOf(s) !== -1; }
  function addWatch(s) {
    s = sym(s);
    if (!s) return false;
    if (watching(s)) { ui.watMsg.textContent = s + ' is already in your watchlist.'; return false; }
    if (st.watch.length >= MAXW) { ui.watMsg.textContent = 'A watchlist holds ' + MAXW + ' companies. Remove one to add another.'; return false; }
    st.watch.push(s);
    ui.watMsg.textContent = s + ' added to your watchlist.';
    saveWatch(); drawWatch(); loadWatch();
    return true;
  }
  function removeWatch(s) {
    st.watch = st.watch.filter(function (x) { return x !== s; });
    delete st.quotes[s];
    ui.watMsg.textContent = s + ' removed from your watchlist.';
    saveWatch(); drawWatch();
  }
  function drawWatch() {
    setNote(ui.wat.note, st.wq, /quote|price|market|perpetual|hyperliquid|finnhub|twelve/i, st.watch.length + ' of ' + MAXW);
    var rows = st.watch.map(function (s) { return [s, st.quotes[s] || null]; });
    if (!changed('ov.wat', [rows, st.wErr])) return;
    var frag = document.createDocumentFragment();
    if (!st.watch.length) {
      frag.appendChild(el('p', 'emptyBox', 'Your watchlist is empty. Add companies with the box above, or with the button on any company page. The list is kept in this browser only.'));
      swap(ui.watBody, frag);
      return;
    }
    if (st.wErr) frag.appendChild(el('p', 'muted small tfWarn', st.wErr));
    var table = el('table', 'screener tfRows tfWatch');
    table.appendChild(el('caption', 'sr', 'Your watchlist'));
    var head = el('tr');
    ['Company', 'Price', 'Change', ''].forEach(function (l, i) {
      var th = el('th', null, l); th.scope = 'col';
      if (i === 3) th.appendChild(el('span', 'sr', 'Remove'));
      head.appendChild(th);
    });
    var thead = el('thead'); thead.appendChild(head); table.appendChild(thead);
    var body = el('tbody');
    rows.forEach(function (r) {
      var s = r[0], q = r[1];
      var tr = el('tr');
      var name = el('th'); name.scope = 'row';
      var a = symLink(s, q ? (q.unknown ? 'Not a listed symbol here' : [str(q.name, 60), isPerp(q) ? 'perpetual price, 24h change' : q.delayed ? 'delayed' : '', num(q.price) == null ? 'no price source connected' : ''].filter(Boolean).join(' · ')) : 'Waiting for a quote');
      a.dataset.fk = fk('w-' + s);
      name.appendChild(a);
      var rm = el('button', 'xpRemove tfRm', '×');
      rm.type = 'button';
      rm.dataset.fk = fk('wr-' + s);
      rm.setAttribute('aria-label', 'Remove ' + s + ' from your watchlist');
      rm.addEventListener('click', function () { removeWatch(s); ui.watAdd.input.focus(); });
      var last = el('td'); last.appendChild(rm);
      add(tr, name, el('td', 'mono', q ? px(q.price) : DASH), chgNode('td', q ? q.changePct : null), last);
      body.appendChild(tr);
    });
    table.appendChild(body);
    var wrap = el('div', 'tableWrap'); wrap.appendChild(table);
    frag.appendChild(wrap);
    if (rows.some(function (r) { return isPerp(r[1]); })) frag.appendChild(el('p', 'tfPerpNote small', PERP_WORDS));
    swap(ui.watBody, frag);
  }
  function quoteBatch(list) {
    return api('/quote?symbols=' + encodeURIComponent(list.join(','))).catch(function (err) {
      // One symbol the server does not know should not blank the rest: ask for them singly.
      if (err.status !== 400 || list.length === 1) { err.symbols = list; throw err; }
      return Promise.all(list.map(function (s) {
        return api('/quote?symbols=' + encodeURIComponent(s)).catch(function (e) {
          if (e.status === 400) return { quotes: [{ symbol: s, unknown: true }] };
          throw e;
        });
      })).then(function (parts) {
        var out = { quotes: [] };
        parts.forEach(function (p) { out.at = p.at || out.at; out.demo = p.demo || out.demo; out.sources = p.sources || out.sources; out.quotes = out.quotes.concat(arr(p.quotes)); });
        return out;
      });
    });
  }
  function loadWatch() {
    if (!st.watch.length) { drawWatch(); return; }
    var seq = ++st.wSeq, list = st.watch.slice(), parts = [];
    for (var i = 0; i < list.length; i += 20) parts.push(quoteBatch(list.slice(i, i + 20)));
    Promise.all(parts).then(function (answers) {
      if (seq !== st.wSeq) return;
      st.wErr = '';
      answers.forEach(function (d) {
        st.wq = d;
        arr(d.quotes).map(obj).forEach(function (q) { var s = sym(q.symbol); if (s && watching(s)) st.quotes[s] = q; });
        if (!arr(d.quotes).length && pick(d).some(function (s) { return s.state !== 'ok'; })) st.wErr = gap(d, /quote|price|market|perpetual|hyperliquid|finnhub|twelve/i, 'Quotes', 'are');
      });
      if (st.view === 'stocks' && !st.co.on) drawWatch();
    }).catch(function (err) {
      if (seq !== st.wSeq) return;
      st.wErr = err.status === 400 && err.symbols && err.symbols.length === 1 ? '' : failed(err, 'Quotes');
      if (err.status === 400 && err.symbols && err.symbols.length === 1) st.quotes[err.symbols[0]] = { symbol: err.symbols[0], unknown: true };
      if (st.view === 'stocks' && !st.co.on) drawWatch();
    });
  }

  // ----- company: quote -----
  function priceLabel(q) {
    if (isPerp(q)) return 'Perpetual contract price';
    if (q.delayed === 'eod' || q.eod === true || q.endOfDay === true || /end.?of.?day|eod|close/i.test(str(q.session) + str(q.priceType))) return 'End of day';
    return q.delayed ? 'Delayed' : '';
  }
  function drawQuote() {
    var d = st.co.qData, q = st.co.quote, s = st.sym;
    setNote(ui.quote.note, d, /quote|price|market|perpetual|hyperliquid|finnhub|twelve/i);
    if (!changed('co.quote', [q, watching(s), d ? pick(d) : 0, st.co.qErr])) return;
    var frag = document.createDocumentFragment();
    var top = el('div', 'tfQuoteTop');
    var left = el('div', 'tfPriceBox');
    if (q) {
      var label = priceLabel(q), asOf = when(q.asOf);
      add(left, el('b', 'tfPrice mono', px(q.price)), chgNode('span', q.changePct, 'tfChg'));
      if (label) left.appendChild(el('span', 'stPill wait', label));
      var sub = el('p', 'muted small', 'US dollars' + (isPerp(q) ? ' · ' + (str(q.source, 80) || 'Hyperliquid perpetual') + ' · change over 24 hours' : label ? ' · ' + label.toLowerCase() + ' price' : '') + (asOf ? ' · as of ' + asOf : ''));
      var wrapL = el('div'); add(wrapL, left, sub); top.appendChild(wrapL);
    } else {
      top.appendChild(el('p', 'emptyBox', st.co.qErr || (d ? gap(d, /quote|price|market|perpetual|hyperliquid|finnhub|twelve/i, 'Prices', 'are') : 'Loading the price…')));
    }
    var on = watching(s);
    var w = el('button', 'btn toggle' + (on ? ' on' : ''), on ? '✓ In your watchlist' : '+ Add to watchlist');
    w.type = 'button';
    w.id = 'tfWatchBtn';
    w.dataset.fk = 'co-watch';
    w.setAttribute('aria-pressed', String(on));
    w.setAttribute('aria-label', on ? 'Remove ' + s + ' from your watchlist' : 'Add ' + s + ' to your watchlist');
    w.addEventListener('click', function () {
      if (watching(s)) { st.watch = st.watch.filter(function (x) { return x !== s; }); saveWatch(); }
      else if (st.watch.length >= MAXW) { ui.coMsg = 'A watchlist holds ' + MAXW + ' companies. Remove one on the Stocks page to add another.'; }
      else { st.watch.push(s); saveWatch(); }
      forget('ov.wat');
      drawQuote();
    });
    top.appendChild(w);
    frag.appendChild(top);
    if (ui.coMsg) { var m = el('p', 'tfMsg'); m.setAttribute('role', 'status'); m.textContent = ui.coMsg; frag.appendChild(m); ui.coMsg = ''; }
    if (q && isPerp(q)) {
      frag.appendChild(el('p', 'tfPerpNote small', PERP_WORDS + ' No exchange price source is connected for this share, so there is no open, day range, previous close, share volume or market value to show.'));
      var pg = el('div', 'mStats flush');
      add(pg, tile('Traded in 24 hours', money(q.volumeUsd), 'US dollars, in the perpetual contract'), tile('Exchange price', 'Not connected', 'Needs a share-price source'));
      frag.appendChild(pg);
    } else if (q) {
      var grid = el('div', 'mStats flush');
      var lo = num(q.low), hi = num(q.high);
      add(grid,
        tile('Day range', lo != null && hi != null ? px(lo) + ' – ' + px(hi) : DASH, 'Low to high'),
        tile('Open', px(q.open)),
        tile('Previous close', px(q.previousClose)),
        tile('Volume', num(q.volume) == null ? DASH : compact(q.volume), 'Shares'),
        tile('Market value', money(q.marketCap), 'Share price × shares outstanding'));
      frag.appendChild(grid);
    }
    swap(ui.quote.body, frag);
  }
  function loadQuote() {
    var s = st.sym, seq = st.co.seq;
    if (!s || st.co.unknown) return;
    api('/quote?symbols=' + encodeURIComponent(s)).then(function (d) {
      if (seq !== st.co.seq || s !== st.sym) return;
      var q = arr(d.quotes).map(obj).filter(function (x) { return sym(x.symbol) === s; })[0] || null;
      st.co.qData = d; st.co.quote = q; st.co.qErr = '';
      drawQuote();
    }).catch(function (err) {
      if (seq !== st.co.seq || s !== st.sym || st.co.quote) return;
      st.co.qErr = err.status === 400 ? 'No price is available for ' + s + '.' : failed(err, 'The price');
      drawQuote();
    });
  }

  // ----- company: chart -----
  var RANGES = [['1m', '1M'], ['6m', '6M'], ['1y', '1Y'], ['5y', '5Y'], ['max', 'Max']];
  var RANGE_WORDS = { '1m': 'the last month', '6m': 'the last 6 months', '1y': 'the last year', '5y': 'the last 5 years', max: 'the longest history available' };
  var SIZES = [['d', 'Daily'], ['w', 'Weekly'], ['m', 'Monthly']];
  var SIZE_WORDS = { d: 'daily', w: 'weekly', m: 'monthly' };
  // Weekly and monthly candles are built here from the daily ones. A week starts on Monday
  // (UTC) and a month is a calendar month; open is the first day's open, close the last
  // day's close, high and low the extremes, volume the sum. Each is stamped with the day
  // its period starts. The newest candle covers a period still in progress.
  function bucket(sec, size) {
    var d = Math.floor(sec / 86400);
    if (size === 'w') return (d - (((d + 4) % 7) + 6) % 7) * 86400; // day 0 of 1970 was a Thursday
    var t = new Date(sec * 1000);
    return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), 1) / 1000;
  }
  function resample(list, size) {
    if (size === 'd') return list;
    var out = [], cur = null;
    list.forEach(function (c) {
      var k = bucket(c.time, size);
      if (!cur || cur.time !== k) { cur = { time: k, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }; out.push(cur); return; }
      cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; cur.volume += c.volume;
    });
    return out;
  }
  function drawRanges() {
    var box = seg('Chart range', RANGES, st.co.range, 'rg-', function (r) {
      if (r === st.co.range) return;
      st.co.range = r;
      drawRanges();
      refocus(ui.ranges, 'rg-' + r);
      loadCandles();
    });
    var sizes = seg('Candle size', SIZES, st.co.size, 'cs-', function (z) {
      if (z === st.co.size) return;
      st.co.size = z;
      drawRanges();
      refocus(ui.ranges, 'cs-' + z);
      forget('co.table');
      drawCandles();
    });
    var frag = document.createDocumentFragment();
    add(frag, box, sizes);
    ui.ranges.replaceChildren(frag);
  }
  // The candles on the chart, as numbers. Built only while it is open.
  function drawCandleTable() {
    var c = st.co.candles;
    if (!ui.chartData.open) return;
    var list = c ? resample(c.list, st.co.size) : [];
    if (!changed('co.table', [st.sym, c ? c.range : '', st.co.size, list.length, list.length ? list[list.length - 1] : 0])) return;
    if (!list.length) { ui.chartTable.replaceChildren(el('p', 'muted small', 'No candles to list.')); return; }
    var table = el('table', 'screener tfCandles');
    table.id = 'tfCandles';
    var shown = list.slice(-120).reverse();
    table.appendChild(el('caption', 'tfCap muted small', 'The ' + SIZE_WORDS[st.co.size] + ' candles on the chart, newest first' + (list.length > shown.length ? ' (the newest ' + shown.length + ' of ' + list.length + ')' : '') + '. ' +
      (st.co.size === 'd' ? 'Dates are UTC days.' : st.co.size === 'w' ? 'Each week starts on the Monday shown (UTC).' : 'Each month is a calendar month (UTC).')));
    var hr = el('tr');
    [st.co.size === 'd' ? 'Day' : st.co.size === 'w' ? 'Week of' : 'Month', 'Open', 'High', 'Low', 'Close', 'Volume'].forEach(function (l) { var th = el('th', null, l); th.scope = 'col'; hr.appendChild(th); });
    var thead = el('thead'); thead.appendChild(hr); table.appendChild(thead);
    var body = el('tbody');
    shown.forEach(function (x) {
      var tr = el('tr');
      var d = new Date(x.time * 1000);
      var th = el('th', 'mono', st.co.size === 'm' ? MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear() : utcDay(x.time)); th.scope = 'row';
      add(tr, th, el('td', 'mono', px(x.open)), el('td', 'mono', px(x.high)), el('td', 'mono', px(x.low)), el('td', 'mono', px(x.close)), el('td', 'mono', trim(x.volume, 0)));
      body.appendChild(tr);
    });
    table.appendChild(body);
    var wrap = el('div', 'tableWrap tfCandleWrap'); wrap.appendChild(table);
    ui.chartTable.replaceChildren(wrap);
  }
  function cssVar(name, fallback) {
    var v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }
  function alpha(color, a) {
    var m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color);
    if (!m) return color;
    var h = m[1].length === 3 ? m[1].replace(/./g, '$&$&') : m[1];
    return 'rgba(' + parseInt(h.slice(0, 2), 16) + ', ' + parseInt(h.slice(2, 4), 16) + ', ' + parseInt(h.slice(4, 6), 16) + ', ' + a + ')';
  }
  var tone = null;
  function ensureChart() {
    if (st.chart || !window.LightweightCharts) return;
    var LC = window.LightweightCharts;
    // The chart needs literal colours, so they are read from the theme once, here.
    tone = { text: cssVar('--text-2', '#444'), faint: cssVar('--text-3', '#777'), line: cssVar('--line', '#ccc'), up: cssVar('--up', '#1E8E4E'), down: cssVar('--down', '#C8452C'), warn: cssVar('--warn', '#B7791F') };
    var chartTime = window.HL && window.HL.chartTime ? window.HL.chartTime(function () { return '1d'; }) : null;
    st.chart = LC.createChart(ui.chartBox, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: tone.text, fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { vertLines: { color: alpha(tone.line, 0.5) }, horzLines: { color: alpha(tone.line, 0.5) } },
      rightPriceScale: { borderColor: tone.line },
      timeScale: { borderColor: tone.line, timeVisible: false, tickMarkFormatter: chartTime ? chartTime.tickMarkFormatter : undefined },
      localization: chartTime ? { timeFormatter: chartTime.timeFormatter } : {},
      crosshair: { mode: 0 }
    });
    st.series = st.chart.addCandlestickSeries({ upColor: tone.up, borderUpColor: tone.up, wickUpColor: tone.up, downColor: tone.down, borderDownColor: tone.down, wickDownColor: tone.down });
    st.volume = st.chart.addHistogramSeries({ priceScaleId: '', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    st.volume.priceScale().applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    var lineOpts = { lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false };
    st.ema50 = st.chart.addLineSeries(Object.assign({ color: tone.text, lineStyle: 0 }, lineOpts));
    st.ema200 = st.chart.addLineSeries(Object.assign({ color: tone.warn, lineStyle: 2 }, lineOpts));
  }
  function clearChart() {
    st.co.candles = null; st.co.shown = '';
    forget('co.candles');
    if (st.series) { st.series.setData([]); st.volume.setData([]); st.ema50.setData([]); st.ema200.setData([]); }
    ui.chartBox.setAttribute('aria-label', 'Price chart');
    ui.chartCard.h.textContent = 'Price chart';
  }
  function utcDay(sec) { var d = new Date(sec * 1000); return d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()] + ' ' + d.getUTCFullYear(); }
  function drawCandles() {
    var c = st.co.candles;
    if (!c) return;
    var name = st.co.data ? str(st.co.data.name, 80) : '';
    var who = (name ? name + ' (' + st.sym + ')' : st.sym);
    if (!c.list.length) {
      if (st.series) { st.series.setData([]); st.volume.setData([]); st.ema50.setData([]); st.ema200.setData([]); }
      ui.chartSum.textContent = c.message || 'No price history is available for this range.';
      ui.chartBox.setAttribute('aria-label', 'Price chart for ' + who + ': no data for ' + RANGE_WORDS[c.range] + '.');
      drawCandleTable();
      return;
    }
    var list = resample(c.list, st.co.size), first = list[0], last = list[list.length - 1];
    var size = SIZE_WORDS[st.co.size];
    var closes = list.map(function (x) { return x.close; });
    var ema = window.Indicators && window.Indicators.ema;
    var e50 = ema ? ema(closes, 50) : [], e200 = ema ? ema(closes, 200) : [];
    var hi = Math.max.apply(null, list.map(function (x) { return x.high; })), lo = Math.min.apply(null, list.map(function (x) { return x.low; }));
    var move = first.close ? (last.close - first.close) / first.close * 100 : null;
    var l50 = e50.length ? e50[e50.length - 1] : null, l200 = e200.length ? e200[e200.length - 1] : null;
    var reach = c.range !== 'max' ? '' : c.capped ? ' The source returns at most ' + c.list.length.toLocaleString('en-US') + ' daily candles in one answer, so earlier history may exist that is not shown.' : ' This is all the history the source holds: it starts on ' + utcDay(c.list[0].time) + '.';
    var text = (c.perp ? 'Perpetual contract prices from Hyperliquid, not stock exchange prices. ' : '') + who + ', ' + RANGE_WORDS[c.range] + ': ' + list.length + ' ' + size + (list.length === 1 ? ' candle' : ' candles') + (st.co.size === 'd' ? '' : ' built from ' + c.list.length + ' daily ones') + ', from ' + utcDay(c.list[0].time) + ' to ' + utcDay(c.list[c.list.length - 1].time) +
      '. Latest close ' + px(last.close) + '; change over the range ' + chg(move) + '; high ' + px(hi) + ', low ' + px(lo) +
      '. EMA 50 of ' + size + ' closes: ' + (l50 == null ? 'needs 50 candles, not drawn here' : px(l50)) + '. EMA 200: ' + (l200 == null ? 'needs 200 candles, not drawn here' : px(l200)) + '.' + (c.note ? ' ' + c.note : '') +
      reach + (c.delayed ? ' Prices are delayed.' : '') + (c.demo ? ' Demo: invented prices.' : '');
    ui.chartCard.h.textContent = c.perp ? 'Price chart: perpetual contract, not the exchange price' : 'Price chart';
    ui.chartSum.textContent = text;
    ui.chartBox.setAttribute('aria-label', 'Candlestick price chart with volume bars and two moving averages. ' + text);
    ensureChart();
    if (!st.chart) { ui.chartSum.textContent = 'The chart library did not load. ' + text; return; }
    st.series.setData(list.map(function (x) { return { time: x.time, open: x.open, high: x.high, low: x.low, close: x.close }; }));
    st.volume.setData(list.map(function (x) { return { time: x.time, value: x.volume, color: alpha(x.close >= x.open ? tone.up : tone.down, 0.3) }; }));
    var line = function (vals) { var out = []; vals.forEach(function (v, i) { if (v != null) out.push({ time: list[i].time, value: v }); }); return out; };
    st.ema50.setData(line(e50));
    st.ema200.setData(line(e200));
    var key = st.sym + c.range + st.co.size;
    if (st.co.shown !== key) {
      st.co.shown = key;
      st.chart.timeScale().fitContent();
      // Once more when the chart has measured its box: a chart made a moment ago has no width yet.
      requestAnimationFrame(function () { if (st.chart && st.co.shown === key) st.chart.timeScale().fitContent(); });
    }
    drawCandleTable();
  }
  function loadCandles() {
    var s = st.sym, range = st.co.range, seq = ++st.co.cSeq;
    if (!s || st.co.unknown) return;
    ui.chartCard.sec.setAttribute('aria-busy', 'true');
    var note = '';
    api('/candles?symbol=' + encodeURIComponent(s) + '&range=' + range).then(function (d) {
      if (seq !== st.co.cSeq || s !== st.sym) return; // the viewer has moved on to another company or range
      ui.chartCard.sec.removeAttribute('aria-busy');
      var seen = {};
      var list = arr(d.candles).map(obj).filter(function (c) {
        var ok = num(c.time) > 0 && [c.open, c.high, c.low, c.close].every(function (n) { return num(n) != null && n > 0; });
        if (!ok || seen[c.time]) return false;
        seen[c.time] = true;
        return true;
      }).map(function (c) { return { time: c.time, open: c.open, high: c.high, low: c.low, close: c.close, volume: num(c.volume) || 0 }; })
        .sort(function (a, b) { return a.time - b.time; });
      setNote(ui.chartCard.note, d, /candle|price|quote|market|history|perpetual|hyperliquid|twelve/i, isPerp(d) ? 'Perpetual contract' : d.delayed ? 'Delayed' : '');
      st.co.candles = { range: range, list: list, note: note, delayed: Boolean(d.delayed), demo: Boolean(d.demo), perp: isPerp(d), capped: d.capped === true, message: list.length ? '' : gap(d, /candle|price|quote|market|history|perpetual|hyperliquid|twelve/i, 'Price history', 'is') };
      if (changed('co.candles', [s, range, list, note, isPerp(d), d.capped === true])) drawCandles();
    }).catch(function (err) {
      if (seq !== st.co.cSeq || s !== st.sym) return;
      ui.chartCard.sec.removeAttribute('aria-busy');
      if (st.co.candles && st.co.candles.range === range && st.co.candles.list.length) return;
      st.co.candles = { range: range, list: [], message: failed(err, 'Price history') };
      forget('co.candles');
      drawCandles();
    });
  }

  // ----- company: facts, statements, filings -----
  function drawFacts(d) {
    var list = arr(d.facts).map(obj).filter(function (f) { return str(f.label); });
    setNote(ui.facts.note, d, /sec|edgar|filing|fact|fundamental/i);
    if (!changed('co.facts', list)) return;
    if (!list.length) { swap(ui.facts.body, sayBox(gap(d, /sec|edgar|filing|fact|fundamental/i, 'Key facts', 'are'))); return; }
    var grid = el('div', 'tfTiles');
    var any = false;
    list.forEach(function (f) {
      var mark = isComputed(f);
      any = any || mark;
      var t = tile(str(f.label, 80).replace(/\s*\(computed[^)]*\)/i, '') + (mark ? ' †' : ''), withUnit(f.value, f.unit), period(f.period));
      grid.appendChild(t);
    });
    var frag = document.createDocumentFragment();
    frag.appendChild(grid);
    if (any) frag.appendChild(el('p', 'muted small', '† Worked out here from reported figures, not reported by the company.'));
    swap(ui.facts.body, frag);
  }
  function isComputed(r) { return r.computed === true || r.derived === true || /\bcomputed\b/i.test(str(r.label)); }
  var TABS = [['income', 'Income'], ['balance', 'Balance sheet'], ['cashflow', 'Cash flow']];
  var TAB_WORDS = { income: 'Income statement', balance: 'Balance sheet', cashflow: 'Cash flow statement' };
  var PERS = [['annual', 'Annual'], ['quarterly', 'Quarterly']];
  function walk(rows, fn, depth, parent) {
    arr(rows).forEach(function (r) {
      r = obj(r);
      if (!str(r.label) && !str(r.key)) return;
      fn(r, depth || 0, parent || null);
      if (depth < 3 || !depth) walk(r.children, fn, (depth || 0) + 1, r);
    });
  }
  function scaleFor(rows, unit) {
    var max = 0;
    walk(rows, function (r) { if (r.unit === unit) arr(r.values).forEach(function (v) { v = num(v); if (v != null && Math.abs(v) > max) max = Math.abs(v); }); });
    if (unit === 'shares') return max >= 1e6 ? { div: 1e6, dp: 1, word: 'millions' } : { div: 1, dp: 0, word: '' };
    if (max >= 1e11) return { div: 1e9, dp: 2, word: 'billions' };
    if (max >= 1e6) return { div: 1e6, dp: max >= 1e9 ? 0 : 1, word: 'millions' };
    if (max >= 1e4) return { div: 1e3, dp: 0, word: 'thousands' };
    return { div: 1, dp: 0, word: '' };
  }
  // Negatives in parentheses, as on a printed statement; an en dash where nothing was reported.
  function stmtVal(v, unit, sc) {
    v = num(v);
    if (v == null) return DASH;
    var n = unit === 'USD/share' ? v : v / sc.div, dp = unit === 'USD/share' ? 2 : sc.dp;
    var s = fix(Math.abs(n), dp);
    return n < 0 && Number(Math.abs(n).toFixed(dp)) !== 0 ? '(' + s + ')' : s;
  }
  // Which column holds the same period a year before column i. With period end dates this is
  // the column ending 350 to 380 days earlier, wherever it sits: a missing quarter or a
  // changed year-end must not make "a year earlier" mean some other period. Without dates
  // it is the column `lag` places on, as before.
  function yearBefore(ends, i, lag, count) {
    var a = ymd(ends[i]);
    if (!a) return ends.length ? -1 : (i + lag < count ? i + lag : -1);
    var t = Date.UTC(a.y, a.m, a.d);
    for (var j = i + 1; j < ends.length; j++) {
      var b = ymd(ends[j]);
      if (!b) continue;
      var days = (t - Date.UTC(b.y, b.m, b.d)) / 86400000;
      if (days >= 350 && days <= 380) return j;
    }
    return -1;
  }
  function yoy(values, i, at) {
    var cur = num(values[i]), base = at < 0 ? null : num(values[at]);
    if (cur == null || base == null) return { text: DASH, cls: '', label: 'No figure a year earlier' };
    if (base <= 0) return { text: 'n/m', cls: '', label: 'Not meaningful: the year-earlier figure was zero or negative' };
    var p = (cur - base) / base * 100;
    return { text: chg(p, 1), cls: dir(p), label: '' };
  }
  function trend(values) {
    var v = arr(values).map(num).reverse(); // oldest on the left
    var known = v.filter(function (n) { return n != null; });
    if (known.length < 2) return null;
    var hi = Math.max.apply(null, known), lo = Math.min.apply(null, known);
    // Rows that stay on one side of zero are drawn over their own range (with a fifth of it
    // as a floor) so the shape shows; rows that cross zero keep zero as the baseline.
    if (lo >= 0) lo = Math.max(0, lo - (hi - lo) * 0.25); else if (hi <= 0) hi = Math.min(0, hi + (hi - lo) * 0.25); 
    var span = hi - lo || 1;
    var W = v.length * 7 - 2, H = 22, zero = lo >= 0 ? H : hi <= 0 ? 0 : hi / span * H;
    var s = svg('svg', { width: W, height: H, viewBox: '0 0 ' + W + ' ' + H, 'aria-hidden': 'true', focusable: 'false' });
    s.setAttribute('class', 'tfTrend');
    s.appendChild(svg('line', { x1: 0, x2: W, y1: zero, y2: zero, 'class': 'tfBase' }));
    v.forEach(function (n, i) {
      if (n == null) return;
      var h = Math.max(2, (lo >= 0 ? n - lo : hi <= 0 ? hi - n : Math.abs(n)) / span * H);
      s.appendChild(svg('rect', { x: i * 7, y: n >= 0 ? zero - h : zero, width: 5, height: h, 'class': n >= 0 ? 'tfBarPos' : 'tfBarNeg' }));
    });
    return s;
  }
  function drawStatements(force) {
    var d = st.co.data;
    if (!d) return;
    var all = obj(d.statements), S = obj(all[st.co.per]);
    var periods = arr(S.periods).map(function (p) { return str(p, 16); });
    var rows = arr(S[st.co.tab]);
    setNote(ui.stmt.note, d, /sec|edgar|filing|statement|fundamental/i);
    if (!changed('co.stmt', [st.co.tab, st.co.per, periods, S.periodEnds, rows, st.co.open, d.statementsNote]) && !force) return;
    var frag = document.createDocumentFragment();
    var bar = el('div', 'row between tfStmtBar');
    var segs = el('div', 'tfSegs');
    add(segs,
      seg('Statement', TABS, st.co.tab, 'tab-', function (t) { st.co.tab = t; drawStatements(); refocus(ui.stmt.body, 'tab-' + t); }),
      seg('Period length', PERS, st.co.per, 'per-', function (p) { st.co.per = p; drawStatements(); refocus(ui.stmt.body, 'per-' + p); }));
    bar.appendChild(segs);
    var parents = [];
    walk(rows, function (r) { if (arr(r.children).length) parents.push(fk(r.key || r.label)); });
    if (parents.length) {
      var allOpen = parents.every(function (k) { return st.co.open[k]; });
      var ex = el('button', 'linkBtn tfExpand', allOpen ? 'Collapse all rows' : 'Expand all rows');
      ex.type = 'button';
      ex.dataset.fk = 'st-all';
      ex.addEventListener('click', function () { parents.forEach(function (k) { if (allOpen) delete st.co.open[k]; else st.co.open[k] = true; }); drawStatements(); });
      bar.appendChild(ex);
    }
    frag.appendChild(bar);
    if (!periods.length || !rows.length) {
      frag.appendChild(sayBox(pick(d, /sec|edgar|filing|statement|fundamental/i).some(function (s) { return s.state !== 'ok'; })
        ? gap(d, /sec|edgar|filing|statement|fundamental/i, 'Financial statements', 'are')
        : str(d.statementsNote, 300) || 'No ' + st.co.per + ' ' + TAB_WORDS[st.co.tab].toLowerCase() + ' has been reported for this company.'));
      swap(ui.stmt.body, frag);
      return;
    }
    var usd = scaleFor(rows, 'USD'), shares = scaleFor(rows, 'shares');
    var hasShare = false, hasCount = false, marked = false;
    walk(rows, function (r) { if (r.unit === 'USD/share') hasShare = true; if (r.unit === 'shares') hasCount = true; });
    var lag = st.co.per === 'quarterly' ? 4 : 1;
    var ends = arr(S.periodEnds).map(function (e) { return str(e, 10); });
    var before = yearBefore(ends, 0, lag, periods.length);
    var table = el('table', 'screener tfStmt');
    table.id = 'tfStmtTable';
    var cap = TAB_WORDS[st.co.tab] + ', ' + (st.co.per === 'annual' ? 'by fiscal year' : 'by fiscal quarter') + ', newest first. US dollars' + (usd.word ? ' in ' + usd.word : '') +
      (hasShare ? ', except per-share figures' : '') + (hasCount ? '; share counts' + (shares.word ? ' in ' + shares.word : '') : '') +
      '. Negative figures are in parentheses; an en dash means nothing was reported.';
    table.appendChild(el('caption', 'tfCap muted small', cap));
    var hr = el('tr');
    var h0 = el('th', null, 'Line item'); h0.scope = 'col'; hr.appendChild(h0);
    var hT = el('th', null, 'Trend'); hT.scope = 'col'; hT.appendChild(el('span', 'sr', ', oldest period on the left')); hr.appendChild(hT);
    periods.forEach(function (p, i) {
      var th = el('th', 'mono'); th.scope = 'col';
      th.appendChild(el('span', 'tfPer', p));
      // A fiscal year is the company's own: the day it ends is printed under its name.
      if (ymd(ends[i])) { th.appendChild(el('span', 'sr', ', ending ')); th.appendChild(el('span', 'tfPerEnd muted', day(ends[i]))); }
      hr.appendChild(th);
      if (i === 0) { var hy = el('th', null, 'Change'); hy.scope = 'col'; hy.appendChild(el('span', 'sr', ' from a year earlier')); if (before >= 0) hy.appendChild(el('span', 'tfPerEnd muted', 'vs ' + periods[before])); hy.title = 'Newest period against the same period a year earlier'; hr.appendChild(hy); }
    });
    var thead = el('thead'); thead.appendChild(hr); table.appendChild(thead);
    var body = el('tbody');
    walk(rows, function (r, depth, parent) {
      var key = fk(r.key || r.label), kids = arr(r.children).length;
      var tr = el('tr', 'tfLv' + Math.min(depth, 3) + (kids ? ' tfParent' : ''));
      tr.id = 'tfr-' + key;
      // A child shows only while every row above it is open.
      var up = parent, shown = true;
      if (parent) { tr.dataset.parent = fk(parent.key || parent.label); }
      while (up) { if (!st.co.open[fk(up.key || up.label)]) shown = false; up = up._p; }
      r._p = parent;
      tr.hidden = !shown;
      var th = el('th'); th.scope = 'row';
      var mark = isComputed(r);
      var label = str(r.label, 120) || str(r.key, 60);
      if (kids) {
        var b = el('button', 'tfDisc');
        b.type = 'button';
        b.dataset.fk = 'st-' + key;
        b.setAttribute('aria-expanded', String(Boolean(st.co.open[key])));
        b.setAttribute('aria-controls', arr(r.children).map(function (c) { return 'tfr-' + fk(obj(c).key || obj(c).label); }).join(' '));
        var chev = el('span', 'tfChev', st.co.open[key] ? '▾' : '▸'); chev.setAttribute('aria-hidden', 'true');
        add(b, chev, el('span', null, label));
        b.addEventListener('click', function () { if (st.co.open[key]) delete st.co.open[key]; else st.co.open[key] = true; drawStatements(); });
        th.appendChild(b);
      } else {
        th.appendChild(el('span', 'tfLeaf', label));
      }
      if (mark) { marked = true; add(th, el('sup', 'tfMark', '†')); th.appendChild(el('span', 'sr', ' (computed)')); }
      tr.appendChild(th);
      var tcell = el('td', 'tfTrendCell'); add(tcell, trend(r.values)); tr.appendChild(tcell);
      var sc = r.unit === 'shares' ? shares : usd;
      periods.forEach(function (p, i) {
        var td = el('td', 'mono', stmtVal(arr(r.values)[i], r.unit, sc));
        if (Array.isArray(r.derived) && r.derived[i] && num(arr(r.values)[i]) != null) { marked = true; add(td, el('sup', 'tfMark', '†')); td.appendChild(el('span', 'sr', ' (computed)')); }
        tr.appendChild(td);
        if (i === 0) {
          var c = yoy(arr(r.values), 0, before);
          var cy = el('td', 'mono tfYoy ' + c.cls, c.text);
          if (c.label) cy.title = c.label;
          tr.appendChild(cy);
        }
      });
      body.appendChild(tr);
    });
    walk(rows, function (r) { delete r._p; });
    table.appendChild(body);
    var wrap = el('div', 'tableWrap'); wrap.appendChild(table);
    frag.appendChild(wrap);
    var foot = 'Trend bars run from the oldest period to the newest and are scaled to each row’s own range, so they show direction, not size. Change compares the newest period with the same period a year earlier' + (before >= 0 ? ' (' + periods[before] + ')' : ', which is not among the periods shown') + '; “n/m” means not meaningful because the earlier figure was zero or negative.';
    if (marked) foot = '† Worked out here from reported figures, not reported by the company in this form. ' + foot;
    frag.appendChild(el('p', 'muted small tfFoot', foot));
    swap(ui.stmt.body, frag);
  }
  function drawFilings(d) {
    var list = arr(d.filings).map(obj).filter(function (f) { return str(f.form) || str(f.title); });
    setNote(ui.fil.note, d, /sec|edgar|filing/i);
    if (!changed('co.fil', list)) return;
    if (!list.length) { swap(ui.fil.body, sayBox(pick(d, /sec|edgar|filing/i).some(function (s) { return s.state !== 'ok'; }) ? gap(d, /sec|edgar|filing/i, 'Filings', 'are') : 'No recent filings are listed for this company.')); return; }
    var ul = el('ul', 'tfFilings');
    list.slice(0, 40).forEach(function (f) {
      var li = el('li', 'tfFiling');
      var form = str(f.form, 16), title = str(f.title, 160), url = safeUrl(f.url, SEC);
      add(li, el('span', 'stPill wait', form || 'Filing'), el('span', 'tfFilTitle', title || form), el('span', 'mono muted small', when(f.filedAt) || DASH));
      if (url) li.appendChild(outLink(url, 'Open on SEC.gov', 'Open ' + (form || 'the filing') + ' filed ' + when(f.filedAt) + ' on SEC.gov'));
      else li.appendChild(el('span', 'muted small', d.demo ? 'Demo: no document' : 'No link'));
      ul.appendChild(li);
    });
    swap(ui.fil.body, ul);
  }
  function drawCompany() {
    var d = st.co.data;
    if (!d) return;
    ui.coState.hidden = true;
    ui.coMain.hidden = false;
    var name = str(d.name, 100) || st.sym;
    ui.sHead.h.textContent = name;
    var bits = [st.sym, str(d.exchange, 30), str(d.industry, 80)].filter(Boolean);
    var fye = str(d.fiscalYearEnd, 20), md = /^(\d{2})-(\d{2})$/.exec(fye);
    if (fye) bits.push('fiscal year ends ' + (md && MONTHS[+md[1] - 1] ? +md[2] + ' ' + MONTHS[+md[1] - 1] : fye));
    setNote(ui.sHead.at, d, null, bits.join(' · '));
    document.title = name + ' (' + st.sym + ') · Halftone';
    drawQuote(); drawFacts(d); drawStatements(); drawFilings(d);
    if (st.co.candles) drawCandles(); // the chart's description carries the company name
  }
  function loadCompany() {
    var s = st.sym, seq = st.co.seq;
    if (window.HalftoneFunds && !/^HL:/.test(s)) window.HalftoneFunds.company(ui.own, s);
    api('/company?symbol=' + encodeURIComponent(s)).then(function (d) {
      if (seq !== st.co.seq || s !== st.sym) return;
      st.co.data = d; st.co.unknown = false;
      drawCompany();
    }).catch(function (err) {
      if (seq !== st.co.seq || s !== st.sym) return;
      if (st.co.data && err.status !== 400) return; // keep the page; a refresh failed
      coProblem(err.status === 400 ? 'unknown' : 'error', err);
    });
  }
  function coProblem(kind, err) {
    st.co.data = null;
    st.co.unknown = kind === 'unknown';
    ui.coMain.hidden = true;
    ui.coState.hidden = false;
    var frag = document.createDocumentFragment();
    if (kind === 'unknown') {
      ui.sHead.h.textContent = 'No company found';
      ui.sHead.at.textContent = '';
      frag.appendChild(el('span', null, 'No listed company with the symbol “' + (st.symRaw || st.sym) + '” was found. Check the ticker, or use the search box above to find the company by name.'));
    } else {
      ui.sHead.h.textContent = st.sym;
      frag.appendChild(el('span', null, failed(err, 'This company’s page').replace(' Trying again shortly.', '') + ' '));
      var again = el('button', 'linkBtn', 'Try again');
      again.type = 'button';
      again.addEventListener('click', function () { ui.coState.textContent = 'Loading ' + st.sym + '…'; loadCompany(); loadQuote(); loadCandles(); });
      frag.appendChild(again);
    }
    ui.coState.replaceChildren(frag);
    if (kind === 'unknown') ui.search.input.focus({ preventScroll: true });
  }
  function openCompany(s, raw) {
    st.sym = s; st.symRaw = raw; st.co.raw = raw;
    st.co.seq++; st.co.cSeq++;
    st.co.data = null; st.co.quote = null; st.co.qData = null; st.co.qErr = ''; st.co.unknown = false; st.co.open = {};
    forget('co.');
    clearChart();
    ui.chartSum.textContent = 'Loading the price history…';
    ui.sHead.h.textContent = s || 'No company found';
    ui.sHead.at.textContent = '';
    ui.coMain.hidden = true;
    ui.coState.hidden = false;
    ui.coState.textContent = 'Loading ' + s + '…';
    [ui.quote, ui.facts, ui.stmt, ui.own, ui.fil].forEach(function (c) { c.body.replaceChildren(); c.note.replaceChildren(); });
    if (window.HalftoneFunds) window.HalftoneFunds.reset();
    if (!s) coProblem('unknown');
  }

  // =====================================================================================
  // CALENDAR
  // =====================================================================================
  var KINDS = [['earnings', 'Earnings', 'earnings dates'], ['ipo', 'IPOs', 'IPO dates'], ['economic', 'Economic', 'economic releases'], ['central-bank', 'Central bank', 'central-bank dates']];
  var KIND_WORD = { earnings: 'Earnings', ipo: 'IPO', economic: 'Economic', 'central-bank': 'Central bank' };
  var IMPORTANCE = ['', 'Low importance', 'Medium importance', 'High importance'];
  var SESSION = { bmo: 'Before the open', amc: 'After the close', 'before-open': 'Before the open', 'after-close': 'After the close', 'pre-market': 'Before the open', 'post-market': 'After the close', 'during-market': 'During trading', dmh: 'During trading' };
  function buildCalendar() {
    var view = $('view-calendar');
    ui.cHead = header(view, 'Calendar', 'What is scheduled, day by day');
    var pad = el('div', 'pad');
    ui.cal = card('Agenda', 'tfCal');
    ui.calBar = el('div', 'tfCalBar');
    ui.calChips = el('div', 'tfChips'); ui.calChips.setAttribute('role', 'group'); ui.calChips.setAttribute('aria-label', 'Kinds of event shown');
    var nav = el('div', 'tfPager');
    ui.calPrev = el('button', 'btn', '← Previous 30 days'); ui.calPrev.type = 'button'; ui.calPrev.id = 'tfCalPrev';
    ui.calNext = el('button', 'btn', 'Next 30 days →'); ui.calNext.type = 'button'; ui.calNext.id = 'tfCalNext';
    ui.calToday = el('button', 'btn', 'Today'); ui.calToday.type = 'button'; ui.calToday.id = 'tfCalToday';
    ui.calPrev.addEventListener('click', function () { pageCal(st.cal.page - 1); });
    ui.calNext.addEventListener('click', function () { pageCal(st.cal.page + 1); });
    ui.calToday.addEventListener('click', function () { pageCal(0); });
    add(nav, ui.calPrev, ui.calToday, ui.calNext);
    add(ui.calBar, ui.calChips, nav);
    ui.calRange = el('p', 'tfRange'); ui.calRange.id = 'tfCalRange'; ui.calRange.setAttribute('role', 'status');
    ui.calList = el('div', 'tfAgenda'); ui.calList.id = 'tfAgenda';
    add(ui.cal.body, ui.calBar, ui.calRange, ui.calList);
    ui.ipoC = card('IPO pipeline', 'tfIpoC');
    add(pad, ui.cal.sec, ui.ipoC.sec);
    view.appendChild(pad);
    drawChips();
  }
  var CAL_PAGES = 12;
  function calWindow() {
    var now = new Date(), from = new Date(now.getFullYear(), now.getMonth(), now.getDate() + st.cal.page * 30);
    var to = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 29);
    return { from: isoLocal(from), to: isoLocal(to), today: isoLocal(now) };
  }
  function pageCal(n) {
    st.cal.page = Math.max(-CAL_PAGES, Math.min(CAL_PAGES, n)); // the server knows about a year either side of today
    st.cal.data = null;
    forget('cal.');
    drawCalendar();
    loadCalendar();
  }
  function evKind(e) { var k = str(e.kind, 20); return has(KIND_WORD, k) ? k : ''; }
  // An event with a real moment is shown in the viewer's zone and filed under their date;
  // a session word ("after the close") or nothing at all stays under the date given.
  function evWhen(e, zone) {
    var t = e.time, date = ymd(e.date) ? str(e.date, 10) : '';
    var ms = typeof t === 'number' ? (t < 1e11 ? t * 1000 : t) : NaN;
    if (typeof t === 'string') {
      var key = t.trim().toLowerCase();
      if (has(SESSION, key)) return { date: date, text: SESSION[key], sort: key.charAt(0) === 'a' || /post/.test(key) ? 1e6 : -1 };
      if (/^\d{4}-\d{2}-\d{2}T/.test(t)) ms = Date.parse(/Z|[+-]\d{2}:?\d{2}$/.test(t) ? t : t + 'Z');
      else {
        // A clock time is read in the zone the answer names ("timezone"), or UTC when it says so.
        var m = /^(\d{1,2}):(\d{2})(?::\d{2})?\s*(Z|UTC)?$/i.exec(t.trim());
        if (m && date && (m[3] || zone)) ms = m[3] ? Date.UTC(ymd(date).y, ymd(date).m, ymd(date).d, +m[1], +m[2]) : zoned(date, +m[1], +m[2], zone);
        if (!isFinite(ms) && t.trim()) return { date: date, text: str(t, 24), sort: m ? +m[1] * 60 + +m[2] : 5e5, raw: Boolean(m) };
      }
    }
    if (isFinite(ms)) { var d = new Date(ms); return { date: isoLocal(d), text: clock(d), sort: d.getHours() * 60 + d.getMinutes(), timed: true }; }
    return { date: date, text: '', sort: -2 };
  }
  function drawChips() {
    var counts = Object.create(null);
    arr(st.cal.data && st.cal.data.events).forEach(function (e) { var k = evKind(obj(e)); if (k) counts[k] = (counts[k] || 0) + 1; });
    var frag = document.createDocumentFragment();
    KINDS.forEach(function (k) {
      var on = st.cal.on[k[0]];
      var b = el('button', 'btn toggle tfChip' + (on ? ' on' : ''));
      b.type = 'button';
      b.dataset.fk = 'ck-' + k[0];
      b.dataset.kind = k[0];
      b.setAttribute('aria-pressed', String(on));
      var mark = el('span', 'tfTick', on ? '✓' : ''); mark.setAttribute('aria-hidden', 'true');
      add(b, mark, document.createTextNode(k[1]));
      if (st.cal.data) b.appendChild(el('span', 'n', String(counts[k[0]] || 0)));
      b.addEventListener('click', function () { st.cal.on[k[0]] = !st.cal.on[k[0]]; drawCalendar(); });
      frag.appendChild(b);
    });
    swap(ui.calChips, frag);
  }
  function listWords(list) { return list.length < 2 ? list.join('') : list.slice(0, -1).join(', ') + ' or ' + list[list.length - 1]; }
  function drawCalendar() {
    var w = calWindow(), d = st.cal.data;
    var zone = d ? str(d.timezone || d.timeZone, 40) : '';
    ui.calRange.textContent = day(w.from) + ' to ' + day(w.to) + (st.cal.page === 0 ? ' (the next 30 days)' : '') + '. ' +
      (d && !zone ? 'Times are as published: the source did not name their time zone.' : 'Times are shown in your time zone, ' + ZONE + '.');
    ui.calToday.disabled = st.cal.page === 0;
    ui.calPrev.disabled = st.cal.page <= -CAL_PAGES;
    ui.calNext.disabled = st.cal.page >= CAL_PAGES;
    setNote(ui.cal.note, d, null);
    setNote(ui.cHead.at, d, null, 'Agenda');
    if (!changed('cal.list', [w, d ? d.events : null, d ? pick(d) : st.cal.err, st.cal.on])) return;
    drawChips();
    if (!d) { swap(ui.calList, sayBox(st.cal.err || 'Loading the agenda…')); return; }
    var events = arr(d.events).map(obj).map(function (e) { return { e: e, kind: evKind(e), when: evWhen(e, zone) }; })
      .filter(function (x) { return x.kind && x.when.date && str(x.e.title); });
    var shown = events.filter(function (x) { return st.cal.on[x.kind]; });
    var frag = document.createDocumentFragment();
    var off = pick(d).filter(function (s) { return s.state !== 'ok'; });
    off.forEach(function (s) {
      frag.appendChild(el('p', 'muted small tfWarn', s.state === 'off'
        ? str(s.name, 60) + ' is not connected on this server, so its dates are missing from the agenda' + (str(s.note) ? ' (' + str(s.note, 160).replace(/[.\s]+$/, '') + ').' : '.')
        : str(s.name, 60) + ' could not be read, so its dates may be missing' + (str(s.note) ? ': ' + str(s.note, 160).replace(/[.\s]+$/, '') + '.' : '.')));
    });
    if (!shown.length) {
      var onKinds = KINDS.filter(function (k) { return st.cal.on[k[0]]; });
      frag.appendChild(sayBox(!onKinds.length ? 'Every kind of event is switched off. Turn one on above to see the agenda.'
        : 'No ' + listWords(onKinds.map(function (k) { return k[2]; })) + ' between ' + day(w.from) + ' and ' + day(w.to) + '.' + (events.length ? ' ' + events.length + ' other event' + (events.length === 1 ? ' is' : 's are') + ' hidden by the filters above.' : '')));
      swap(ui.calList, frag);
      return;
    }
    var days = Object.create(null);
    shown.forEach(function (x) { (days[x.when.date] = days[x.when.date] || []).push(x); });
    Object.keys(days).sort().forEach(function (date) {
      var p = ymd(date), wd = DAYS[new Date(Date.UTC(p.y, p.m, p.d)).getUTCDay()];
      var sec = el('section', 'tfDay' + (date === w.today ? ' today' : ''));
      var h = el('h3', 'tfDayHead');
      h.id = 'tfDay-' + date;
      add(h, el('span', null, wd + ' ' + p.d + ' ' + MONTHS[p.m]));
      if (date === w.today) h.appendChild(el('span', 'stPill good', 'Today'));
      h.appendChild(el('span', 'muted small', days[date].length + (days[date].length === 1 ? ' event' : ' events')));
      sec.setAttribute('aria-labelledby', h.id);
      sec.appendChild(h);
      var ul = el('ul', 'tfEvents');
      days[date].sort(function (a, b) { return a.when.sort - b.when.sort || (num(b.e.importance) || 0) - (num(a.e.importance) || 0); }).forEach(function (x) {
        var e = x.e, li = el('li', 'tfEvent');
        li.dataset.kind = x.kind;
        var time = el('span', 'mono tfTime', x.when.text || DASH);
        if (!x.when.text) time.appendChild(el('span', 'sr', ' no time given'));
        var imp = Math.max(1, Math.min(3, Math.round(num(e.importance) || 1)));
        var dots = el('span', 'tfImp tfImp' + imp, '●●●'.slice(0, imp) + '○○○'.slice(0, 3 - imp)); dots.setAttribute('aria-hidden', 'true');
        dots.title = IMPORTANCE[imp];
        var main = el('div', 'tfEvMain');
        var title = el('span', 'tfEvTitle');
        var s = sym(e.symbol);
        if (x.kind === 'earnings' && s) { var a = el('a', 'tfEvLink', str(e.title, 140)); a.href = '#stocks/' + encodeURIComponent(s); a.dataset.fk = fk('ev-' + date + '-' + s); title.appendChild(a); }
        else title.textContent = str(e.title, 140);
        main.appendChild(title);
        var meta = el('span', 'muted small tfEvMeta');
        var bits = [str(e.detail, 200), str(e.source, 60) ? 'Source: ' + str(e.source, 60) : ''].filter(Boolean);
        meta.textContent = bits.join(' · ');
        var url = safeUrl(e.url, OFFICIAL);
        if (url) { if (bits.length) meta.appendChild(document.createTextNode(' · ')); meta.appendChild(outLink(url, 'Official page', 'Official page for ' + str(e.title, 80))); }
        if (meta.childNodes.length) main.appendChild(meta);
        var tag = el('span', 'tfKind', KIND_WORD[x.kind]);
        add(li, time, add(el('span', 'tfImpBox'), dots, el('span', 'sr', IMPORTANCE[imp] + '. ')), tag, main);
        ul.appendChild(li);
      });
      sec.appendChild(ul);
      frag.appendChild(sec);
    });
    swap(ui.calList, frag);
  }
  function loadCalendar() {
    var w = calWindow(), seq = ++st.cal.seq;
    api('/calendar?from=' + w.from + '&to=' + w.to).then(function (d) {
      if (seq !== st.cal.seq) return; // the viewer has paged on
      st.cal.data = d; st.cal.err = '';
      if (st.view === 'calendar') drawCalendar();
    }).catch(function (err) {
      if (seq !== st.cal.seq || st.cal.data) return;
      st.cal.err = failed(err, 'The agenda');
      if (st.view === 'calendar') drawCalendar();
    });
  }

  // ----- the IPO pipeline, shown on Calendar and on Private -----
  var STATUS = { filed: ['Filed', 'wait'], expected: ['Expected', 'good'], priced: ['Priced', 'good'], withdrawn: ['Withdrawn', 'bad'] };
  function rangeText(r) {
    if (typeof r === 'string') return str(r, 40) || DASH;
    r = obj(r);
    var lo = num(r.low), hi = num(r.high);
    if (lo != null && hi != null) return '$' + fix(lo, 2) + ' – $' + fix(hi, 2);
    return lo != null ? '$' + fix(lo, 2) : hi != null ? '$' + fix(hi, 2) : DASH;
  }
  function drawIpos(c, name) {
    var d = st.ipo;
    setNote(c.note, d, /sec|edgar|ipo|registration|finnhub/i);
    if (!changed(name, d ? [d.pipeline, pick(d)] : st.ipoErr || 'wait')) return;
    if (!d) { swap(c.body, sayBox(st.ipoErr || 'Loading the IPO pipeline…')); return; }
    var list = arr(d.pipeline).map(obj).filter(function (r) { return str(r.company); });
    if (!list.length) { swap(c.body, sayBox(pick(d).some(function (s) { return s.state !== 'ok'; }) ? gap(d, /sec|edgar|ipo|registration|finnhub/i, 'The IPO pipeline', 'is') : 'No companies are in the IPO pipeline right now.')); return; }
    list.sort(function (a, b) { return cmp(str(a.expectedDate, 10), str(b.expectedDate, 10), 1) || cmp(str(a.filedAt, 30), str(b.filedAt, 30), -1); });
    var table = el('table', 'screener stTable tfIpo');
    table.appendChild(el('caption', 'sr', 'Companies that have filed to go public'));
    var hr = el('tr');
    ['Company', 'Exchange', 'Status', 'Expected date', 'Price range', 'Filing'].forEach(function (l) { var th = el('th', null, l); th.scope = 'col'; hr.appendChild(th); });
    var thead = el('thead'); thead.appendChild(hr); table.appendChild(thead);
    var body = el('tbody');
    list.forEach(function (r) {
      var tr = el('tr');
      var name = el('th'); name.scope = 'row';
      add(name, el('b', null, str(r.company, 100)));
      if (str(r.symbol)) name.appendChild(el('span', 'mono muted small tfTick', str(r.symbol, 12)));
      var stt = has(STATUS, str(r.status, 12)) ? STATUS[str(r.status, 12)] : [str(r.status, 20) || 'Unknown', 'wait'];
      var sc = el('td'); sc.appendChild(el('span', 'stPill ' + stt[1], stt[0]));
      var fc = el('td'), url = safeUrl(r.url, SEC), form = str(r.form, 16) || 'Filing', filed = when(r.filedAt);
      if (url) fc.appendChild(outLink(url, form, 'Open the ' + form + ' filing by ' + str(r.company, 80) + ' on SEC.gov'));
      else fc.appendChild(el('span', null, form));
      if (filed) fc.appendChild(el('span', 'muted small', ' filed ' + filed));
      add(tr, name, el('td', null, str(r.exchange, 24) || DASH), sc, el('td', 'mono', ymd(r.expectedDate) ? day(r.expectedDate) : DASH), el('td', 'mono', r.priceRange == null ? DASH : rangeText(r.priceRange)), fc);
      body.appendChild(tr);
    });
    table.appendChild(body);
    var wrap = el('div', 'tableWrap'); wrap.appendChild(table);
    var frag = document.createDocumentFragment();
    frag.appendChild(wrap);
    frag.appendChild(el('p', 'muted small', 'Drawn from registration statements filed with the SEC. An expected date or price range can change or be withdrawn before a listing.'));
    swap(c.body, frag);
  }
  function showIpos() {
    if (st.view === 'calendar') drawIpos(ui.ipoC, 'ipo.cal');
    if (st.view === 'private') drawIpos(ui.ipoP, 'ipo.pv');
  }
  function loadIpos() {
    api('/ipos').then(function (d) { st.ipo = d; st.ipoErr = ''; showIpos(); }).catch(function (err) {
      if (st.ipo) return;
      st.ipoErr = failed(err, 'The IPO pipeline');
      showIpos();
    });
  }

  // =====================================================================================
  // PRIVATE
  // =====================================================================================
  var PCOLS = [
    { id: 'issuer', label: 'Issuer', text: true }, { id: 'industry', label: 'Industry', text: true }, { id: 'state', label: 'State', text: true },
    { id: 'amountOffered', label: 'Offered' }, { id: 'amountSold', label: 'Sold' }, { id: 'firstSale', label: 'First sale' }, { id: 'filedAt', label: 'Filed' }, { label: 'Filing' }
  ];
  function buildPrivate() {
    var view = $('view-private');
    ui.pHead = header(view, 'Private', 'Who is raising, and who has filed to list');
    var pad = el('div', 'pad');
    pad.appendChild(el('p', 'tfLede', 'This page shows fundraising that private companies have disclosed to the SEC on Form D, and companies that have filed to go public. It does not show valuations, and it is not a complete record of private deals: most private financing is never filed anywhere.'));
    ui.ipoP = card('IPO pipeline', 'tfIpoP');
    ui.pv = card('Private raises disclosed on Form D', 'tfPv');
    var bar = el('div', 'tfPvBar');
    var lab = el('label', null, 'Industry'); lab.htmlFor = 'tfPvInd';
    ui.pvInd = el('select', 'select'); ui.pvInd.id = 'tfPvInd';
    var lab2 = el('label', 'sr', 'Filter by issuer name'); lab2.htmlFor = 'tfPvQ';
    ui.pvQ = el('input', 'scFilter'); ui.pvQ.id = 'tfPvQ'; ui.pvQ.type = 'search'; ui.pvQ.placeholder = 'Filter by issuer'; ui.pvQ.maxLength = 40; ui.pvQ.autocomplete = 'off';
    ui.pvInd.addEventListener('change', function () { st.pv.industry = ui.pvInd.value; drawPrivate(); });
    ui.pvQ.addEventListener('input', function () { st.pv.q = ui.pvQ.value; drawPrivate(); });
    add(bar, lab, ui.pvInd, lab2, ui.pvQ);
    ui.pvSum = el('p', 'tfRange'); ui.pvSum.id = 'tfPvSum'; ui.pvSum.setAttribute('role', 'status');
    ui.pvBody = el('div'); ui.pvBody.id = 'tfPvBody';
    add(ui.pv.body, bar, ui.pvSum, ui.pvBody);
    add(pad, ui.ipoP.sec, ui.pv.sec);
    view.appendChild(pad);
  }
  function amount(v) { return typeof v === 'string' && v ? str(v, 20) : money(v); }
  // A filing whose own document has not been read (yet, or at all): its amounts are unknown,
  // which is not the same as the form saying "Indefinite".
  function unread(r) { return r.detail === false; }
  function drawPrivate() {
    var d = st.pv.data;
    setNote(ui.pv.note, d, /sec|edgar|form d/i);
    setNote(ui.pHead.at, d, null, 'Form D and registration filings');
    if (!changed('pv.list', [d ? d.raises : st.pv.err || 'wait', d ? pick(d) : 0, d ? d.detailsPending : 0, st.pv.sort, st.pv.dir, st.pv.industry, st.pv.q])) return;
    if (!d) { ui.pvSum.textContent = ''; swap(ui.pvBody, sayBox(st.pv.err || 'Loading private raises…')); return; }
    var all = arr(d.raises).map(obj).filter(function (r) { return str(r.issuer); });
    // The industry list is built from what the filings themselves say.
    var inds = Object.create(null);
    all.forEach(function (r) { var i = str(r.industry, 60); if (i) inds[i] = (inds[i] || 0) + 1; });
    var names = Object.keys(inds).sort();
    if (changed('pv.inds', names)) {
      if (st.pv.industry && names.indexOf(st.pv.industry) === -1) st.pv.industry = '';
      var opts = document.createDocumentFragment();
      var o0 = el('option', null, 'All industries (' + all.length + ')'); o0.value = ''; opts.appendChild(o0);
      names.forEach(function (n) { var o = el('option', null, n + ' (' + inds[n] + ')'); o.value = n; opts.appendChild(o); });
      ui.pvInd.replaceChildren(opts);
      ui.pvInd.value = st.pv.industry;
    }
    if (!all.length) { ui.pvSum.textContent = ''; swap(ui.pvBody, sayBox(pick(d).some(function (s) { return s.state !== 'ok'; }) ? gap(d, /sec|edgar|form d/i, 'Form D filings', 'are') : 'No Form D filings are listed right now.')); return; }
    var q = st.pv.q.trim().toLowerCase();
    var rows = all.filter(function (r) { return (!st.pv.industry || str(r.industry, 60) === st.pv.industry) && (!q || str(r.issuer).toLowerCase().indexOf(q) !== -1); });
    var key = st.pv.sort, text = key === 'issuer' || key === 'industry' || key === 'state' || key === 'firstSale' || key === 'filedAt';
    rows.sort(function (a, b) { return cmp(text ? str(a[key], 100) : num(a[key]), text ? str(b[key], 100) : num(b[key]), st.pv.dir); });
    var offered = 0, sold = 0, noOffer = 0;
    var unreadN = 0;
    rows.forEach(function (r) { if (unread(r)) { unreadN++; return; } if (num(r.amountOffered) == null) noOffer++; else offered += r.amountOffered; sold += num(r.amountSold) || 0; });
    ui.pvSum.textContent = rows.length + (rows.length === all.length ? '' : ' of ' + all.length) + (rows.length === 1 ? ' filing' : ' filings') + ' shown: ' + money(offered) + ' offered, ' + money(sold) + ' sold' +
      (noOffer ? ' (' + noOffer + (noOffer === 1 ? ' filing states' : ' filings state') + ' no fixed amount offered and ' + (noOffer === 1 ? 'is' : 'are') + ' left out of the offered total)' : '') + '.' +
      (unreadN ? ' ' + unreadN + (unreadN === 1 ? ' filing is' : ' filings are') + ' listed without amounts' + (num(d.detailsPending) > 0 ? ' while the details are read from the SEC; this list will fill in shortly.' : ': the details could not be read, or only the newest filings are opened.') : '');
    if (!rows.length) { swap(ui.pvBody, sayBox('No filings match this filter. ' + all.length + ' are listed in all.')); return; }
    var table = el('table', 'screener tfRaises');
    table.id = 'tfRaises';
    table.appendChild(el('caption', 'sr', 'Private fundraising disclosed to the SEC on Form D'));
    table.appendChild(sortHead(PCOLS, st.pv, 'pv-', drawPrivate));
    var body = el('tbody');
    rows.forEach(function (r) {
      var tr = el('tr');
      var name = el('th', null, str(r.issuer, 120)); name.scope = 'row';
      var fc = el('td'), url = safeUrl(r.url, SEC), form = str(r.form, 12) || 'Form D';
      if (url) fc.appendChild(outLink(url, form, 'Open the ' + form + ' filing by ' + str(r.issuer, 80) + ' on SEC.gov'));
      else fc.appendChild(el('span', 'muted', form));
      add(tr, name, el('td', 'tfWrapCell', str(r.industry, 60) || DASH), el('td', null, str(r.state, 20) || DASH),
        el('td', 'mono', unread(r) ? 'Not read' : r.amountOffered == null ? 'Indefinite' : amount(r.amountOffered)), el('td', 'mono', unread(r) ? 'Not read' : amount(r.amountSold)),
        el('td', 'mono', ymd(r.firstSale) ? day(r.firstSale) : (str(r.firstSale, 24) || DASH)), el('td', 'mono', when(r.filedAt) || DASH), fc);
      body.appendChild(tr);
    });
    table.appendChild(body);
    var foot = el('tfoot'), ft = el('tr');
    var fh = el('th', null, 'Total shown (' + rows.length + ')'); fh.scope = 'row'; fh.colSpan = 3;
    add(ft, fh, el('td', 'mono', money(offered)), el('td', 'mono', money(sold)), el('td'), el('td'), el('td'));
    foot.appendChild(ft); table.appendChild(foot);
    var wrap = el('div', 'tableWrap'); wrap.appendChild(table);
    var frag = document.createDocumentFragment();
    frag.appendChild(wrap);
    frag.appendChild(el('p', 'muted small', 'Amounts are what each issuer stated on its form: the total it set out to raise and the amount sold by the filing date. “Indefinite” means the form set no fixed total.'));
    swap(ui.pvBody, frag);
  }
  function loadPrivate() {
    clearTimeout(st.pv.soon);
    api('/private').then(function (d) {
      st.pv.data = d; st.pv.err = '';
      if (st.view !== 'private') return;
      drawPrivate();
      // The server reads each filing's details in the background the first time: look again soon, a few times.
      if (num(d.detailsPending) > 0 && (st.pv.tries = (st.pv.tries || 0) + 1) <= 8) st.pv.soon = setTimeout(function () { if (st.view === 'private' && !document.hidden) loadPrivate(); }, 4000);
      else if (!(num(d.detailsPending) > 0)) st.pv.tries = 0;
    }).catch(function (err) {
      if (st.pv.data) return;
      st.pv.err = failed(err, 'Private raises');
      if (st.view === 'private') drawPrivate();
    });
  }

  // =====================================================================================
  // lifecycle
  // =====================================================================================
  function stop() { st.timers.forEach(clearInterval); st.timers = []; clearTimeout(st.pv.soon); }
  function start() {
    stop();
    if (document.hidden) return;
    if (st.view === 'stocks') {
      if (st.co.on) {
        if (!st.sym) return; // not a symbol: the message and the search box are on screen
        // Opening the page, or coming back to the tab, reads the company again; no timer does.
        loadCompany(); loadQuote();
        if (!st.co.candles || st.co.candles.range !== st.co.range || !st.co.candles.list.length) loadCandles();
        st.timers.push(setInterval(loadQuote, 20000));
      } else {
        drawOverview(); drawWatch();
        loadOverview(); loadWatch();
        st.timers.push(setInterval(loadOverview, 30000), setInterval(loadWatch, 30000));
      }
    } else if (st.view === 'calendar') {
      drawCalendar(); showIpos();
      loadCalendar(); loadIpos();
      st.timers.push(setInterval(function () { loadCalendar(); loadIpos(); }, 300000));
    } else if (st.view === 'private') {
      showIpos(); drawPrivate();
      loadIpos(); loadPrivate();
      st.timers.push(setInterval(function () { loadIpos(); loadPrivate(); }, 300000));
    } else return;
    st.timers.push(setInterval(tickAges, 10000));
  }
  // "#stocks/ABCD" is a company; "#stocks" is the overview.
  function readHash() {
    var raw = (location.hash || '').slice(1).split('/');
    if (raw[0] !== 'stocks' || raw.length < 2 || !raw[1]) return null;
    var part = raw.slice(1).join('/');
    try { part = decodeURIComponent(part); } catch (e) { /* shown as typed */ }
    return { sym: sym(part), raw: part.slice(0, 24) };
  }
  function sync(view) {
    var h = view === 'stocks' ? readHash() : null;
    var route = view + (h ? '/' + h.raw : '');
    var same = route === st.route;
    st.view = view; st.route = route;
    if (view === 'stocks') {
      st.co.on = Boolean(h);
      // Coming back to the company already on screen keeps its open rows and its chart.
      if (h && h.raw !== st.co.raw) openCompany(h.sym, h.raw);
      ui.ov.hidden = st.co.on;
      ui.co.hidden = !st.co.on;
      ui.back.hidden = !st.co.on;
      if (!st.co.on) { ui.sHead.h.textContent = 'The stock market at a glance'; forget('ov.wat'); }
      else if (st.co.data) { forget('co.quote'); drawCompany(); }
    }
    document.title = view === 'stocks' && st.co.on && st.co.data ? (str(st.co.data.name, 100) || st.sym) + ' (' + st.sym + ') · Halftone' : document.title.indexOf(' · Halftone') === -1 ? document.title : 'Halftone';
    if (same && st.timers.length) return; // the same page announced twice
    start();
  }
  buildStocks(); buildCalendar(); buildPrivate();
  document.addEventListener('nt:view', function (e) { sync(e.detail); });
  // The router announces every hash change with nt:view; this also catches a company link
  // followed while already on the page, whichever listener runs first.
  window.addEventListener('hashchange', function () { if (st.view === 'stocks' && (location.hash || '').slice(1).split('/')[0] === 'stocks') sync('stocks'); });
  document.addEventListener('visibilitychange', function () { if (st.view === 'stocks' || st.view === 'calendar' || st.view === 'private') start(); });
  if (window.ResizeObserver) new ResizeObserver(function () { if (st.view === 'stocks' && !st.co.on) { drawCurve(); layMap(); } }).observe($('view-stocks'));
})();
