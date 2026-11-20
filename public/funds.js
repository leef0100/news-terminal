// Funds: what large managers (Form 13F) and insiders (Forms 3, 4 and 5) reported to the SEC,
// drawn from the answers under /api/tradfi. A 13F is a late, partial record, and the page
// says so before it shows a single figure. Every block names its source and its age, demo
// answers are labelled as invented, and nothing is fetched while the page is hidden or the
// tab is in the background. The same file draws the "Who holds it and who is trading it"
// block on a company page, when tradfi.js asks for it.
(function () {
  'use strict';
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function add(parent) {
    for (var i = 1; i < arguments.length; i++) if (arguments[i]) parent.appendChild(arguments[i]);
    return parent;
  }
  var DASH = '–';
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  // ---------- what the server sends is not trusted ----------
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 200) : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  var SYM = /^[A-Z0-9.\-:]{1,12}$/;
  function sym(v) { var s = typeof v === 'string' ? v.trim().toUpperCase() : ''; return SYM.test(s) ? s : ''; }
  function mid(v) { var s = str(v, 12); return /^\d{1,10}$/.test(s) ? ('0000000000' + s).slice(-10) : ''; }
  function fk(s) { return String(s).replace(/[^\w:.-]/g, ''); }
  // Links leave the site only for the SEC's own pages.
  function secUrl(u) { return typeof u === 'string' && u.length <= 600 && !/[\s<>"'`\\]/.test(u) && u.indexOf('https://www.sec.gov/') === 0 ? u : ''; }
  function outLink(url, text, label) {
    var a = el('a', 'link', text);
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    if (label) a.setAttribute('aria-label', label);
    return a;
  }
  function api(path) {
    var signal = window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(20000) : undefined;
    return fetch('/api/tradfi' + path, { headers: { accept: 'application/json' }, signal: signal }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        d = obj(d);
        if (!r.ok) { var e = new Error(str(d.error, 160) || 'HTTP ' + r.status); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  // ---------- numbers and dates for people ----------
  function fix(n, d) { return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function whole(n) { n = num(n); return n == null ? DASH : n.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
  function compact(n) {
    var a = Math.abs(n);
    if (a >= 999.995e9) return fix(n / 1e12, 2) + 'T';
    if (a >= 999.95e6) return fix(n / 1e9, 2) + 'B';
    if (a >= 999.5e3) return fix(n / 1e6, 1) + 'M';
    if (a >= 1e4) return fix(n / 1e3, 0) + 'K';
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function money(n) { n = num(n); return n == null ? DASH : (n < 0 ? '-$' : '$') + compact(Math.abs(n)); }
  function price(n) { n = num(n); return n == null || n <= 0 ? DASH : '$' + fix(n, 2); }
  function pct(n) { n = num(n); return n == null ? DASH : fix(n, 2) + '%'; }
  function ymd(s) {
    var m = typeof s === 'string' ? /^(\d{4})-(\d{2})-(\d{2})/.exec(s) : null;
    return m && MONTHS[+m[2] - 1] ? { y: +m[1], m: +m[2] - 1, d: +m[3] } : null;
  }
  function day(s) { var p = ymd(s); return p ? p.d + ' ' + MONTHS[p.m] + ' ' + p.y : DASH; }
  // Whole days from a filing date to today, as the viewer's calendar has it.
  function daysSince(s) {
    var p = ymd(s);
    if (!p) return null;
    var t = new Date();
    return Math.round((Date.UTC(t.getFullYear(), t.getMonth(), t.getDate()) - Date.UTC(p.y, p.m, p.d)) / 86400000);
  }
  function daysAgo(s) {
    var n = daysSince(s);
    return n == null ? '' : n <= 0 ? 'today' : n === 1 ? '1 day ago' : whole(n) + ' days ago';
  }
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 5) return 'just now';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }

  // ---------- sources and the sentences shown when something is missing ----------
  function sources(d) { return arr(d && d.sources).filter(function (s) { return s && typeof s === 'object'; }); }
  function offNote(d) {
    var s = sources(d).filter(function (x) { return x.state === 'off'; })[0];
    return s ? (str(s.name, 60) || 'The source') + ' is not connected on this server' + (str(s.note, 240) ? ': ' + str(s.note, 240).replace(/[.\s]+$/, '') : '') + '.' : '';
  }
  function failed(err, noun) {
    if (err && err.name === 'TimeoutError') return noun + ' did not answer in time. Trying again shortly.';
    if (err && err.status === 502) return noun + ' could not be loaded: the SEC’s filing system did not answer. Trying again shortly.';
    if (err && err.status === 429) return noun + ' could not be loaded: too many requests from this address in the last minute. Trying again shortly.';
    return noun + ' could not be loaded. Trying again shortly.';
  }
  function setNote(node, d, extra) {
    var frag = document.createDocumentFragment();
    if (extra) frag.appendChild(el('span', null, extra + (d ? ' · ' : '')));
    if (d) {
      var names = sources(d).filter(function (s) { return s.state === 'ok'; }).map(function (s) { return str(s.name, 60); }).filter(Boolean);
      if (names.length) frag.appendChild(el('span', null, 'Source: ' + names.slice(0, 3).join(', ') + ' · '));
      var at = num(d.at);
      if (at) { var age = el('span', 'fnAge', 'updated ' + ago(at)); age.dataset.at = String(at); frag.appendChild(age); }
      if (d.demo) frag.appendChild(el('span', 'tfDemo', ' · Demo: invented managers, people and filings'));
    }
    node.replaceChildren(frag);
  }
  function tickAges() {
    document.querySelectorAll('.fnAge').forEach(function (n) { var at = Number(n.dataset.at); if (at) n.textContent = 'updated ' + ago(at); });
  }

  // ---------- small parts ----------
  var sigs = {};
  function changed(name, value) { var v = JSON.stringify(value); if (sigs[name] === v) return false; sigs[name] = v; return true; }
  function forget(prefix) { Object.keys(sigs).forEach(function (k) { if (k.indexOf(prefix) === 0) delete sigs[k]; }); }
  function swap(box, node) {
    var a = document.activeElement, key = a && a.dataset && box.contains(a) ? a.dataset.fk : null;
    var lefts = Array.prototype.map.call(box.querySelectorAll('.tableWrap'), function (w) { return w.scrollLeft; });
    box.replaceChildren(node);
    box.querySelectorAll('.tableWrap').forEach(function (w, i) { if (lefts[i]) w.scrollLeft = lefts[i]; });
    if (key) { var n = box.querySelector('[data-fk="' + fk(key) + '"]'); if (n) n.focus({ preventScroll: true }); }
  }
  function sayBox(text) { var p = el('p', 'emptyBox', text); p.setAttribute('role', 'status'); return p; }
  function card(title, id) {
    var sec = el('section', 'card tfBlock fnBlock');
    sec.id = id;
    sec.setAttribute('aria-labelledby', id + 'T');
    var head = el('div', 'sideHead padHead');
    var h = el('h2', null, title); h.id = id + 'T';
    var note = el('span', 'muted small tfNote');
    add(head, h, note);
    var body = el('div', 'tfBody');
    add(sec, head, body);
    return { sec: sec, body: body, note: note, h: h };
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
  function tile(label, value, sub) {
    var d = el('div', 'stTile tfTile');
    d.appendChild(el('span', 'statLabel', label));
    d.appendChild(el('b', 'tfVal', value));
    if (sub) d.appendChild(el('span', 'muted small', sub));
    return d;
  }
  function cmp(a, b, d) {
    var na = a == null || a === '', nb = b == null || b === '';
    if (na || nb) return na && nb ? 0 : na ? 1 : -1;
    if (typeof a === 'string' || typeof b === 'string') return d * String(a).localeCompare(String(b));
    return d * (a - b);
  }
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
  function plainHead(labels) {
    var tr = el('tr');
    labels.forEach(function (l) { var th = el('th', null, l); th.scope = 'col'; tr.appendChild(th); });
    var head = el('thead');
    head.appendChild(tr);
    return head;
  }
  function table(cls, caption, head, rows) {
    var t = el('table', 'screener ' + cls);
    t.appendChild(el('caption', 'sr', caption));
    t.appendChild(head);
    var body = el('tbody');
    rows.forEach(function (r) { body.appendChild(r); });
    t.appendChild(body);
    // Headings sit over their column: right over figures, left over words.
    var first = rows.filter(function (r) { return !r.querySelector('[colspan]'); })[0] || rows[0];
    if (first) Array.prototype.forEach.call(head.querySelectorAll('th'), function (th, i) { var c = first.children[i]; if (c && /\bmono\b/.test(c.className)) th.classList.add('fnNum'); });
    var wrap = el('div', 'tableWrap');
    wrap.appendChild(t);
    return wrap;
  }
  // The issuer as the filing names it. A ticker, and a link to the company page, only where
  // the server matched the name to a listed company with certainty.
  function issuerCell(r, tag) {
    var c = el(tag || 'th', 'fnIssuer');
    if (!tag) c.scope = 'row';
    var s = sym(r.symbol), name = str(r.issuer, 120) || 'Not named';
    if (s) {
      var a = el('a', 'tfSym');
      a.href = '#stocks/' + encodeURIComponent(s);
      a.appendChild(el('b', 'mono', s));
      a.appendChild(el('span', 'muted small fnName', name));
      c.appendChild(a);
    } else c.appendChild(el('span', 'fnName', name));
    var cls = str(r.titleOfClass, 40);
    if (cls && !/^com(mon)?( stock)?$/i.test(cls)) c.appendChild(el('span', 'muted small fnClass', cls));
    return c;
  }
  // Words first; the arrow repeats them and colour only repeats the arrow.
  function changeText(r) {
    var was = num(r.previousShares), now = num(r.shares), kind = str(r.change, 12);
    if (!kind && was != null && now != null) kind = was === 0 ? 'new' : now > was ? 'increase' : now < was ? 'decrease' : 'unchanged';
    if (kind === 'new') return ['New position', 'up'];
    if (kind === 'unchanged') return ['No change', ''];
    if ((kind === 'increase' || kind === 'decrease') && was > 0 && now != null) {
      var p = (now - was) / was * 100;
      return [(kind === 'increase' ? '▲ Added ' : '▼ Reduced ') + fix(Math.abs(p), Math.abs(p) < 10 ? 1 : 0) + '% (' + (now > was ? '+' : '−') + compact(Math.abs(now - was)) + ' shares)', kind === 'increase' ? 'up' : 'down'];
    }
    return [DASH, ''];
  }

  // ---------- the caveats, stated once ----------
  var CAVEATS = [
    ['It is old when it arrives.', 'Managers report once a quarter and have up to 45 days after the quarter ends to file. A position listed here may have been sold weeks or months ago.'],
    ['It is only part of the book.', 'A 13F lists US-listed shares and some options. It leaves out short positions, futures, swaps, bonds, crypto, cash and holdings listed abroad, so it cannot show a manager’s real exposure, or whether a holding is hedged.'],
    ['For a market maker it is inventory.', 'Firms that make markets hold shares and options to fill other people’s orders and to hedge them. Their list is mostly stock in trade and hedges, not a view on any company.'],
    ['It is a record, not a signal.', 'This page shows what was reported as held on one past date. It says nothing about what is held now or why, and it is not a suggestion to buy or sell anything.']
  ];
  function caveats() {
    var sec = el('section', 'card fnCaveat');
    sec.id = 'fnCaveat';
    sec.setAttribute('aria-labelledby', 'fnCaveatT');
    var h = el('h2', null, 'Read this before the numbers'); h.id = 'fnCaveatT';
    var ul = el('ul', 'fnCaveats');
    CAVEATS.forEach(function (c) { var li = el('li'); add(li, el('b', null, c[0] + ' '), el('span', null, c[1])); ul.appendChild(li); });
    add(sec, h, el('p', 'tfLede', 'The holdings below come from Form 13F, which large investment managers file with the US Securities and Exchange Commission. Insider transactions come from Forms 3, 4 and 5, which are filed within days and are far more timely.'), ul);
    return sec;
  }

  // =====================================================================================
  // the page
  // =====================================================================================
  var view = document.getElementById('view-funds');
  var st = { on: false, id: '', raw: '', timers: [], soon: null, list: null, listErr: '', sort: { sort: 'value', dir: -1 }, ins: null, insErr: '', only: 'all', tries: 0, one: null, oneErr: null, seq: 0 };
  var ui = {};
  function build() {
    var head = el('div', 'breakHead');
    var left = el('div');
    ui.h = el('h1', 'display', 'What large managers and insiders reported');
    ui.at = el('p', 'muted tfHeadNote');
    add(left, el('p', 'kicker tfKick', 'Funds'), ui.h);
    add(head, left, ui.at);
    var pad = el('div', 'pad');
    ui.back = el('a', 'btn backBtn fnBack', '← All managers');
    ui.back.href = '#funds';
    ui.back.hidden = true;
    // list
    ui.listBox = el('div', 'fnStack'); ui.listBox.id = 'fnList';
    ui.mgr = card('Large managers tracked', 'fnMgr');
    ui.insCard = card('Latest insider filings', 'fnIns');
    ui.insBar = el('div', 'fnBar');
    ui.insSum = el('p', 'tfRange'); ui.insSum.setAttribute('role', 'status');
    ui.insBody = el('div'); ui.insBody.id = 'fnInsBody';
    add(ui.insCard.body, ui.insBar, ui.insSum, ui.insBody);
    add(ui.listBox, ui.mgr.sec, ui.insCard.sec);
    // one manager
    ui.oneBox = el('div', 'fnStack'); ui.oneBox.id = 'fnOne'; ui.oneBox.hidden = true;
    ui.state = el('p', 'emptyBox'); ui.state.id = 'fnState'; ui.state.setAttribute('role', 'status');
    ui.main = el('div', 'fnStack'); ui.main.id = 'fnMain'; ui.main.hidden = true;
    ui.sum = el('section', 'card fnSum'); ui.sum.id = 'fnSum';
    ui.hold = card('Largest reported holdings', 'fnHold');
    ui.chg = card('Changes from the previous filing', 'fnChg');
    ui.opt = card('Options, listed apart', 'fnOpt');
    add(ui.main, ui.sum, ui.hold.sec, ui.chg.sec, ui.opt.sec);
    add(ui.oneBox, ui.state, ui.main);
    add(pad, ui.back, caveats(), ui.listBox, ui.oneBox);
    add(view, head, pad);
  }

  // ---------- the managers ----------
  var MCOLS = [{ id: 'name', label: 'Manager', text: true }, { id: 'period', label: 'Holdings as of' }, { id: 'filedAt', label: 'Filed' }, { id: 'value', label: 'Reported value' }, { id: 'positions', label: 'Positions' }, { id: 'optionPositions', label: 'Option rows' }];
  function drawList() {
    var d = st.list;
    setNote(ui.mgr.note, d, 'Form 13F');
    if (!changed('fn.list', [d ? d.managers : st.listErr || 'wait', d ? d.pending : 0, d ? sources(d) : 0, st.sort.sort, st.sort.dir])) return;
    if (!d) { swap(ui.mgr.body, sayBox(st.listErr || 'Loading the managers…')); return; }
    var off = offNote(d);
    var all = arr(d.managers).map(obj).filter(function (m) { return mid(m.id) && str(m.name); });
    if (!all.length) { swap(ui.mgr.body, sayBox(off || 'No managers are listed right now.')); return; }
    var key = st.sort.sort, text = key === 'name' || key === 'period' || key === 'filedAt';
    var rows = all.slice().sort(function (a, b) { return cmp(text ? str(a[key], 120) : num(a[key]), text ? str(b[key], 120) : num(b[key]), st.sort.dir); });
    var frag = document.createDocumentFragment();
    if (off) frag.appendChild(sayBox('Holdings are not shown. ' + off));
    var pending = num(d.pending) || 0;
    if (pending > 0) { var p = el('p', 'tfRange', pending + ' of ' + all.length + ' managers’ filings are still being read from the SEC. They fill in a few at a time; this list updates by itself.'); p.setAttribute('role', 'status'); frag.appendChild(p); }
    var trs = rows.map(function (m) {
      var tr = el('tr');
      var th = el('th', 'fnIssuer'); th.scope = 'row';
      var a = el('a', 'tfSym fnMgrLink');
      a.href = '#funds/' + mid(m.id);
      a.appendChild(el('b', null, str(m.name, 100)));
      if (m.marketMaker === true) a.appendChild(el('span', 'muted small', 'Market maker: mostly inventory and hedges'));
      th.appendChild(a);
      var state = str(m.state, 12);
      if (state === 'ready') {
        var n = daysSince(m.filedAt);
        var filed = el('td', 'mono', day(m.filedAt));
        if (n != null) filed.appendChild(el('span', 'muted small fnSub', daysAgo(m.filedAt)));
        add(tr, th, el('td', 'mono', day(m.period)), filed, el('td', 'mono', money(m.value)), el('td', 'mono', whole(m.positions)), el('td', 'mono', num(m.optionPositions) ? whole(m.optionPositions) : DASH));
      } else {
        var td = el('td', 'muted tfWrapCell', state === 'off' ? 'Not connected' : state === 'loading' ? 'Still being read from the SEC…' : state === 'none' ? (str(m.note, 200) || 'No 13F holdings report on file.') : 'Could not be read' + (str(m.note, 200) ? ': ' + str(m.note, 200) : '.'));
        td.colSpan = 5;
        add(tr, th, td);
      }
      return tr;
    });
    frag.appendChild(table('fnMgrTable', 'Large managers and their latest Form 13F', sortHead(MCOLS, st.sort, 'fm-', drawList), trs));
    frag.appendChild(el('p', 'muted small tfFoot', '“Reported value” is the total of the filing’s table, options included at the value of the shares they are written on. It is not the manager’s assets, and it leaves out everything a 13F does not cover.'));
    swap(ui.mgr.body, frag);
    var t = ui.mgr.body.querySelector('table'); if (t) t.id = 'fnMgrTable';
  }
  function loadList() {
    api('/funds').then(function (d) {
      st.list = d; st.listErr = '';
      if (st.on && !st.id) drawList();
      clearTimeout(st.soon);
      // The server reads the filings in the background: look again soon while some are missing.
      if (num(d.pending) > 0 && st.on && !st.id) st.soon = setTimeout(function () { if (st.on && !st.id && !document.hidden) loadList(); }, 8000);
    }).catch(function (err) {
      if (st.list) return;
      st.listErr = failed(err, 'The list of managers');
      if (st.on && !st.id) drawList();
    });
  }

  // ---------- insider filings (the market-wide list, and the rows shared with company pages) ----------
  function insiderRow(r, withCompany) {
    var tr = el('tr');
    var filed = el('td', 'mono', day(r.filedAt));
    var url = secUrl(r.url), form = 'Form ' + (str(r.form, 6) || '4');
    var link = el('td');
    if (url) link.appendChild(outLink(url, form, 'Open ' + form + ' filed ' + day(r.filedAt) + ' on SEC.gov'));
    else link.appendChild(el('span', 'muted', form));
    var who = el('td', 'tfWrapCell');
    who.appendChild(el('span', 'fnName', str(r.owner, 100) || 'Not read'));
    var role = str(r.role, 80) + (num(r.moreOwners) > 0 ? (str(r.role, 80) ? ' · ' : '') + 'and ' + r.moreOwners + ' more' : '');
    if (role) who.appendChild(el('span', 'muted small fnSub', role));
    var cells = [filed];
    if (withCompany) cells.push(issuerCell(r));
    cells.push(who);
    if (r.detail === false) {
      var td = el('td', 'muted tfWrapCell', 'The filing has not been opened yet, so its transactions are not listed.');
      td.colSpan = 5;
      cells.push(td, link);
    } else {
      var what = el('td', 'tfWrapCell');
      var kind = str(r.kind, 12);
      what.appendChild(el('span', 'fnWhat ' + (kind === 'purchase' ? 'up' : kind === 'sale' ? 'down' : ''), str(r.meaning, 80) || 'Not stated'));
      var bits = [];
      if (ymd(r.date)) bits.push('on ' + day(r.date));
      if (r.derivative === true) bits.push('derivative: ' + (str(r.security, 60) || 'not named'));
      if (r.planned === true) bits.push('under a pre-arranged trading plan');
      if (r.direct === false) bits.push('held indirectly');
      if (bits.length) what.appendChild(el('span', 'muted small fnSub', bits.join(' · ')));
      var sh = num(r.shares);
      cells.push(what, el('td', 'mono', sh == null ? DASH : (r.acquired === true ? '+' : r.acquired === false ? '−' : '') + whole(sh)), el('td', 'mono', price(r.price)), el('td', 'mono', num(r.value) ? money(r.value) : DASH), el('td', 'mono', whole(r.sharesAfter)), link);
    }
    cells.forEach(function (c) { tr.appendChild(c); });
    return tr;
  }
  var INS_HEAD = ['Transaction', 'Shares', 'Price', 'Value', 'Owned after', 'Filing'];
  function isPurchase(r) { return r.detail !== false && r.kind === 'purchase' && r.derivative !== true; }
  function drawInsiders() {
    var d = st.ins;
    setNote(ui.insCard.note, d, 'Forms 3, 4 and 5');
    if (!changed('fn.ins', [d ? d.transactions : st.insErr || 'wait', d ? d.detailsPending : 0, d ? sources(d) : 0, st.only])) return;
    swap(ui.insBar, seg('Which transactions to show', [['all', 'All transactions'], ['buys', 'Purchases only']], st.only, 'fi-', function (v) { st.only = v; drawInsiders(); }));
    if (!d) { ui.insSum.textContent = ''; swap(ui.insBody, sayBox(st.insErr || 'Loading the latest insider filings…')); return; }
    var all = arr(d.transactions).map(obj);
    if (!all.length) { ui.insSum.textContent = ''; swap(ui.insBody, sayBox(offNote(d) || 'No insider filings are listed right now.')); return; }
    var rows = st.only === 'buys' ? all.filter(isPurchase) : all;
    var unread = all.filter(function (r) { return r.detail === false; }).length;
    ui.insSum.textContent = rows.length + (st.only === 'buys' ? (rows.length === 1 ? ' purchase' : ' purchases') + ' among ' + all.length + ' rows' : rows.length === 1 ? ' row' : ' rows') + ' from the newest filings.' +
      (unread ? ' ' + unread + (unread === 1 ? ' filing has' : ' filings have') + ' not been opened' + (num(d.detailsPending) > 0 ? ' yet; they fill in shortly.' : '.') : '') +
      ' Most insider sales are routine: pay in shares, taxes and planned sales. A row here is a filing, not an opinion.';
    if (!rows.length) { swap(ui.insBody, sayBox('No purchases are among the newest ' + all.length + ' rows. Purchases are much rarer than grants and sales.')); return; }
    var wrap = table('fnInsTable', 'Latest insider transactions reported to the SEC', plainHead(['Filed', 'Company', 'Insider'].concat(INS_HEAD)), rows.map(function (r) { return insiderRow(r, true); }));
    swap(ui.insBody, wrap);
    wrap.querySelector('table').id = 'fnInsTable';
  }
  function loadInsiders() {
    api('/insiders/latest').then(function (d) {
      st.ins = d; st.insErr = '';
      if (st.on && !st.id) drawInsiders();
      clearTimeout(st.insSoon);
      if (num(d.detailsPending) > 0 && (st.tries += 1) <= 8) st.insSoon = setTimeout(function () { if (st.on && !st.id && !document.hidden) loadInsiders(); }, 5000);
      else if (!(num(d.detailsPending) > 0)) st.tries = 0;
    }).catch(function (err) {
      if (st.ins) return;
      st.insErr = failed(err, 'The latest insider filings');
      if (st.on && !st.id) drawInsiders();
    });
  }

  // ---------- one manager ----------
  function drawOne() {
    var d = st.one;
    if (!d) return;
    var name = str(d.name, 100) || 'Manager';
    ui.h.textContent = name;
    document.title = name + ' · Funds · Halftone';
    setNote(ui.at, d, 'Form 13F');
    if (!changed('fn.one', [d.id, d.state, d.filing, d.totals, d.holdings, d.changes, d.options, d.notes, sources(d)])) return;
    var state = str(d.state, 12), f = obj(d.filing), tot = obj(d.totals);
    if (state !== 'ready') {
      ui.main.hidden = true; ui.state.hidden = false;
      ui.state.textContent = state === 'off' ? 'Holdings are not shown. ' + (offNote(d) || 'The SEC’s filing system is not connected on this server.')
        : state === 'none' ? (str(arr(d.notes)[0], 240) || 'No 13F holdings report is on file for this manager.')
        : 'This manager’s filing could not be read' + (str(arr(d.notes)[0], 240) ? ': ' + str(arr(d.notes)[0], 240) : '.');
      return;
    }
    ui.state.hidden = true; ui.main.hidden = false;
    // The dates come first, and large: they are the most important thing on the page.
    var sum = document.createDocumentFragment();
    var asOf = el('p', 'fnAsOf'); asOf.id = 'fnAsOf';
    var n = daysSince(f.filedAt), held = daysSince(f.period);
    add(asOf, el('span', 'fnAsOfMain', 'Holdings as of ' + day(f.period)), el('span', 'fnAsOfSub', 'filed ' + day(f.filedAt) + (n != null ? ', ' + daysAgo(f.filedAt) : '')));
    sum.appendChild(asOf);
    if (held != null && held > 0) sum.appendChild(el('p', 'fnOld', 'These positions are ' + whole(held) + ' days old. What the manager holds today is not known.'));
    if (d.marketMaker === true) sum.appendChild(el('p', 'tfWarn fnMm', 'This firm makes markets. Its 13F is mostly inventory held to fill orders and the hedges against it, not a view on any company.'));
    var tiles = el('div', 'tfTiles');
    add(tiles, tile('Reported value', money(tot.value), 'the filing’s table total'), tile('Share positions', whole(tot.positions), money(tot.holdingsValue) + ' reported'),
      tile('Option rows', whole(tot.optionPositions), num(tot.optionPositions) ? money(tot.optionsValue) + ' of underlying shares' : 'none reported'),
      tile('Form', str(f.form, 12) || '13F-HR', f.amended === true ? 'with an amendment' : 'as first filed'));
    sum.appendChild(tiles);
    var links = el('p', 'fnLinks');
    var url = secUrl(f.url);
    if (url) links.appendChild(outLink(url, 'Open this filing on SEC.gov', 'Open the ' + (str(f.form, 12) || '13F') + ' filed ' + day(f.filedAt) + ' on SEC.gov'));
    else links.appendChild(el('span', 'muted small', d.demo ? 'Demo: there is no real filing to open.' : 'No link to the filing.'));
    var prev = obj(d.previous), purl = secUrl(prev.url);
    if (ymd(prev.period)) {
      links.appendChild(el('span', 'muted small', ' · compared with the filing for ' + day(prev.period) + ' '));
      if (purl) links.appendChild(outLink(purl, 'Open that filing', 'Open the previous 13F, for ' + day(prev.period) + ', on SEC.gov'));
    }
    sum.appendChild(links);
    var notes = arr(d.notes).map(function (x) { return str(x, 400); }).filter(Boolean);
    if (notes.length) {
      var ul = el('ul', 'fnNotes');
      notes.forEach(function (x) { ul.appendChild(el('li', null, x)); });
      sum.appendChild(ul);
    }
    ui.sum.replaceChildren(sum);

    // holdings, with a bar for the share of the reported total
    var hs = arr(d.holdings).map(obj);
    setNote(ui.hold.note, d);
    if (!hs.length) swap(ui.hold.body, sayBox('No share positions are in this filing.'));
    else {
      var top = Math.max.apply(null, hs.map(function (r) { return num(r.pct) || 0; })) || 1;
      var trs = hs.map(function (r, i) {
        var tr = el('tr');
        var share = el('td', 'fnShare');
        var bar = el('span', 'fnBarTrack'); var fill = el('span', 'fnBarFill');
        fill.style.width = Math.max(1, Math.min(100, (num(r.pct) || 0) / top * 100)).toFixed(1) + '%';
        bar.setAttribute('aria-hidden', 'true');
        bar.appendChild(fill);
        add(share, el('span', 'mono fnPct', pct(r.pct)), bar);
        var c = changeText(r);
        add(tr, el('td', 'mono muted', String(i + 1)), issuerCell(r), share, el('td', 'mono', money(r.value)), el('td', 'mono', whole(r.shares) + (r.unit === 'PRN' ? ' (principal)' : '')), el('td', 'fnChange ' + c[1], c[0]));
        return tr;
      });
      var frag = document.createDocumentFragment();
      frag.appendChild(el('p', 'tfRange', (num(tot.positions) > hs.length ? 'The largest ' + hs.length + ' of ' + whole(tot.positions) : 'All ' + hs.length) + ' share positions by reported value. The share is of the filing’s table total, options included.'));
      frag.appendChild(table('fnHoldTable', 'Largest reported holdings of ' + name, plainHead(['#', 'Issuer', 'Share of reported total', 'Value', 'Shares', 'Against previous filing']), trs));
      frag.appendChild(el('p', 'muted small tfFoot', 'A ticker is shown, and linked, only where the issuer’s name matches exactly one listed company. Filings identify securities by CUSIP, and the SEC publishes no CUSIP-to-ticker list, so other rows show the name as filed.'));
      swap(ui.hold.body, frag);
      ui.hold.body.querySelector('table').id = 'fnHoldTable';
    }

    // changes
    var ch = d.changes ? obj(d.changes) : null;
    setNote(ui.chg.note, d, 'by share count');
    if (!ch) swap(ui.chg.body, sayBox('Changes are not shown for this filing. The notes above say why.'));
    else {
      var counts = obj(ch.counts);
      var grid = el('div', 'fnChgGrid');
      [['new', 'New positions', 'Not in the previous filing.'], ['exits', 'Positions no longer listed', 'In the previous filing, not in this one.'], ['increases', 'Largest increases', 'More shares than before.'], ['decreases', 'Largest decreases', 'Fewer shares than before.']].forEach(function (k) {
        var list = arr(ch[k[0]]).map(obj), total = num(counts[k[0]]);
        var box = el('div', 'fnChgBox'); box.id = 'fnChg-' + k[0];
        box.appendChild(el('h3', null, k[1] + (total != null ? ' (' + whole(total) + ')' : '')));
        box.appendChild(el('p', 'muted small', k[2] + (total > list.length ? ' The largest ' + list.length + ' are listed.' : '')));
        if (!list.length) { box.appendChild(el('p', 'muted fnNone', 'None.')); grid.appendChild(box); return; }
        var rows = list.map(function (r) {
          var tr = el('tr');
          var delta = num(r.sharesDelta), p = num(r.sharesChangePct);
          var txt = k[0] === 'new' ? whole(r.shares) + ' shares · ' + money(r.value)
            : k[0] === 'exits' ? whole(r.previousShares) + ' shares before · ' + money(r.previousValue) + ' then'
            : (delta > 0 ? '▲ +' : '▼ −') + whole(Math.abs(delta)) + ' shares' + (p != null ? ' (' + (p > 0 ? '+' : '−') + fix(Math.abs(p), Math.abs(p) < 10 ? 1 : 0) + '%)' : '') + ' · now ' + whole(r.shares);
          add(tr, issuerCell(r), el('td', 'mono tfWrapCell ' + (k[0] === 'increases' ? 'up' : k[0] === 'decreases' ? 'down' : ''), txt));
          return tr;
        });
        box.appendChild(table('fnChgTable', k[1], plainHead(['Issuer', k[0] === 'new' ? 'Reported' : k[0] === 'exits' ? 'Previously reported' : 'Change in shares']), rows));
        grid.appendChild(box);
      });
      var cf = document.createDocumentFragment();
      cf.appendChild(el('p', 'tfRange', 'Compared by number of shares, not by value, so a change in price is not counted as buying or selling.' + (num(counts.unchanged) != null ? ' ' + whole(counts.unchanged) + ' positions show the same share count as before.' : '')));
      cf.appendChild(grid);
      swap(ui.chg.body, cf);
    }

    // options
    var os = arr(d.options).map(obj);
    setNote(ui.opt.note, d);
    ui.opt.sec.hidden = !os.length && !num(tot.optionPositions);
    if (os.length) {
      var of = document.createDocumentFragment();
      of.appendChild(el('p', 'tfWarn', 'These rows are options, not shares. The value and share count are those of the shares the options are written on (notional exposure), not what the options cost or are worth. A put and a call on the same share are separate rows; only options the manager holds are reported, never those it has written.'));
      of.appendChild(table('fnOptTable', 'Options reported by ' + name, plainHead(['Underlying share', 'Type', 'Value of underlying', 'Underlying shares', 'Share of reported total']), os.map(function (r) {
        var tr = el('tr');
        var pc = str(r.putCall, 6);
        add(tr, issuerCell(r), el('td', null, pc === 'Put' ? 'Put option' : pc === 'Call' ? 'Call option' : 'Option'), el('td', 'mono', money(r.value)), el('td', 'mono', whole(r.shares)), el('td', 'mono', pct(r.pct)));
        return tr;
      })));
      swap(ui.opt.body, of);
      ui.opt.body.querySelector('table').id = 'fnOptTable';
    }
  }
  function oneProblem(text, retry) {
    st.one = null;
    ui.main.hidden = true; ui.state.hidden = false;
    var frag = document.createDocumentFragment();
    frag.appendChild(el('span', null, text + ' '));
    if (retry) {
      var again = el('button', 'linkBtn', 'Try again');
      again.type = 'button';
      again.addEventListener('click', function () { ui.state.textContent = 'Loading the filing…'; loadOne(); });
      frag.appendChild(again);
    }
    ui.state.replaceChildren(frag);
  }
  function loadOne() {
    var id = st.id, seq = st.seq;
    if (!id) return;
    api('/fund?id=' + id).then(function (d) {
      if (seq !== st.seq || id !== st.id) return;
      st.one = d;
      drawOne();
    }).catch(function (err) {
      if (seq !== st.seq || id !== st.id || (st.one && err.status !== 400)) return;
      ui.h.textContent = err.status === 400 ? 'No manager found' : 'Manager';
      if (err.status === 400) oneProblem('No tracked manager has the number “' + st.raw + '”. Only the managers in the list are followed.', false);
      else oneProblem(failed(err, 'This manager’s filing').replace(' Trying again shortly.', ''), true);
    });
  }
  function openOne(id, raw) {
    st.id = id; st.raw = raw; st.seq += 1; st.one = null;
    forget('fn.one');
    ui.h.textContent = 'Manager';
    ui.at.textContent = '';
    // Nothing of the manager shown before stays behind, even out of sight.
    ui.sum.replaceChildren(); [ui.hold, ui.chg, ui.opt].forEach(function (c) { c.body.replaceChildren(); c.note.replaceChildren(); });
    ui.main.hidden = true; ui.state.hidden = false;
    ui.state.textContent = 'Loading the filing… The first time a manager is opened its filings are read from the SEC, which can take a few seconds for a long table.';
    if (!id) { ui.h.textContent = 'No manager found'; oneProblem('“' + raw + '” is not a manager’s number. Pick a manager from the list.', false); }
  }

  // ---------- lifecycle ----------
  function stop() { st.timers.forEach(clearInterval); st.timers = []; clearTimeout(st.soon); clearTimeout(st.insSoon); }
  function start() {
    stop();
    if (!st.on || document.hidden) return;
    if (st.raw) { if (st.id) loadOne(); }
    else {
      drawList(); drawInsiders();
      loadList(); loadInsiders();
      st.timers.push(setInterval(loadList, 300000), setInterval(loadInsiders, 120000));
    }
    st.timers.push(setInterval(tickAges, 10000));
  }
  function readHash() {
    var raw = (location.hash || '').slice(1).split('/');
    if (raw[0] !== 'funds' || raw.length < 2 || !raw[1]) return null;
    var part = raw.slice(1).join('/');
    try { part = decodeURIComponent(part); } catch (e) { /* shown as typed */ }
    return { id: mid(part), raw: part.slice(0, 24) };
  }
  function sync(name) {
    var was = st.on, h = name === 'funds' ? readHash() : null;
    st.on = name === 'funds';
    if (!st.on) { if (was) stop(); return; }
    var raw = h ? h.raw : '';
    var same = was && raw === st.raw;
    if (raw !== st.raw || (h && !was && !st.one)) { if (h) openOne(h.id, h.raw); else { st.id = ''; st.raw = ''; st.seq += 1; } }
    ui.listBox.hidden = Boolean(h);
    ui.oneBox.hidden = !h;
    ui.back.hidden = !h;
    if (!h) { ui.h.textContent = 'What large managers and insiders reported'; setNote(ui.at, st.list, 'SEC filings'); forget('fn.list'); forget('fn.ins'); }
    else if (st.one) { forget('fn.one'); drawOne(); }
    if (same && st.timers.length) return;
    start();
  }
  if (view) {
    build();
    document.addEventListener('nt:view', function (e) { sync(e.detail); });
    window.addEventListener('hashchange', function () { if ((location.hash || '').slice(1).split('/')[0] === 'funds') sync('funds'); });
    document.addEventListener('visibilitychange', function () { if (st.on) start(); });
  }

  // =====================================================================================
  // the block on a company page (called by tradfi.js; it decides when, this draws)
  // =====================================================================================
  var co = { sym: '', seq: 0, holders: null, insiders: null, hErr: '', iErr: '', card: null };
  function drawCompany() {
    var c = co.card;
    if (!c) return;
    var h = co.holders, ins = co.insiders;
    setNote(c.note, h || ins, 'SEC filings');
    if (!changed('fn.co', [co.sym, h, ins, co.hErr, co.iErr])) return;
    var frag = document.createDocumentFragment();
    // managers
    var a = el('div', 'fnCoPart'); a.id = 'fnCoHolders';
    a.appendChild(el('h3', null, 'Large managers that reported holding it'));
    if (!h) a.appendChild(sayBox(co.hErr || 'Loading…'));
    else {
      var hs = arr(h.holders).map(obj), note = str(h.note, 300), off = offNote(h);
      var lede = el('p', 'muted small', 'From the latest Form 13F of the ' + (num(h.tracked) || '') + ' managers this terminal tracks, not every holder. Each figure is as of the date shown and may be months old; a 13F leaves out short positions and hedges. ');
      var more = el('a', 'link', 'What a 13F can and cannot show'); more.href = '#funds';
      lede.appendChild(more);
      a.appendChild(lede);
      if (off) a.appendChild(sayBox('Holders are not shown. ' + off));
      else if (!hs.length) a.appendChild(sayBox(note || 'None of the tracked managers listed this share in its latest 13F.'));
      else {
        if (note) a.appendChild(el('p', 'tfRange', note));
        a.appendChild(table('fnCoHoldTable', 'Tracked managers that reported holding ' + co.sym, plainHead(['Manager', 'As of', 'Shares', 'Value', 'Share of its reported total', 'Against its previous filing']), hs.map(function (r) {
          var tr = el('tr');
          var th = el('th', 'fnIssuer'); th.scope = 'row';
          var l = el('a', 'tfSym'); l.href = '#funds/' + mid(r.id);
          l.appendChild(el('b', null, str(r.name, 100)));
          if (r.marketMaker === true) l.appendChild(el('span', 'muted small', 'Market maker: inventory and hedges'));
          th.appendChild(l);
          var ct = changeText(r);
          var asOf = el('td', 'mono', day(r.period));
          asOf.appendChild(el('span', 'muted small fnSub', 'filed ' + day(r.filedAt)));
          add(tr, th, asOf, el('td', 'mono', whole(r.shares)), el('td', 'mono', money(r.value)), el('td', 'mono', pct(r.pct)), el('td', 'fnChange ' + ct[1], ct[0]));
          return tr;
        })));
      }
    }
    // insiders
    var b = el('div', 'fnCoPart'); b.id = 'fnCoInsiders';
    b.appendChild(el('h3', null, 'Recent insider transactions'));
    if (!ins) b.appendChild(sayBox(co.iErr || 'Loading…'));
    else {
      var rows = arr(ins.transactions).map(obj), ioff = offNote(ins);
      b.appendChild(el('p', 'muted small', 'Officers, directors and holders of more than 10% report their own dealings on Forms 3, 4 and 5 within days. Most sales are routine: pay in shares, taxes and planned sales.'));
      if (!rows.length) b.appendChild(sayBox(ioff ? 'Insider transactions are not shown. ' + ioff : 'No insider filings are among this company’s recent filings.'));
      else b.appendChild(table('fnCoInsTable', 'Recent insider transactions in ' + co.sym, plainHead(['Filed', 'Insider'].concat(INS_HEAD)), rows.slice(0, 15).map(function (r) { return insiderRow(r, false); })));
      if (rows.length > 15) b.appendChild(el('p', 'muted small', 'The newest 15 of ' + rows.length + ' rows.'));
    }
    // stakes
    var s = el('div', 'fnCoPart'); s.id = 'fnCoStakes';
    s.appendChild(el('h3', null, 'Stakes above 5% (Schedules 13D and 13G)'));
    if (ins) {
      var stakes = arr(ins.stakes).map(obj);
      if (!stakes.length) s.appendChild(el('p', 'muted fnNone', offNote(ins) ? 'Not shown: the source is not connected.' : 'No Schedule 13D or 13G is among this company’s recent filings.'));
      else {
        var ul = el('ul', 'tfFilings');
        stakes.slice(0, 12).forEach(function (f) {
          var li = el('li', 'tfFiling');
          var form = str(f.form, 18), url = secUrl(f.url);
          add(li, el('span', 'stPill wait', str(f.kind, 4) === '13D' ? '13D' : '13G'), el('span', 'tfFilTitle', str(f.title, 200) || form), el('span', 'mono muted small', day(f.filedAt)));
          if (url) li.appendChild(outLink(url, 'Open on SEC.gov', 'Open the ' + form + ' filed ' + day(f.filedAt) + ' on SEC.gov'));
          else li.appendChild(el('span', 'muted small', ins.demo ? 'Demo: no document' : 'No link'));
          ul.appendChild(li);
        });
        s.appendChild(ul);
      }
    } else s.appendChild(el('p', 'muted fnNone', co.iErr ? 'Not loaded.' : 'Loading…'));
    add(frag, a, b, s);
    swap(c.body, frag);
  }
  window.HalftoneFunds = {
    // Called when a company page is opened or refreshed, and only while it is visible.
    company: function (cardParts, symbol) {
      symbol = sym(symbol);
      if (!cardParts || !symbol) return;
      if (co.card !== cardParts || co.sym !== symbol) { co.card = cardParts; co.sym = symbol; co.seq += 1; co.holders = null; co.insiders = null; co.hErr = ''; co.iErr = ''; forget('fn.co'); }
      var seq = co.seq;
      drawCompany();
      api('/holders?symbol=' + encodeURIComponent(symbol)).then(function (d) { if (seq === co.seq) { co.holders = d; drawCompany(); } })
        .catch(function (err) { if (seq === co.seq && !co.holders) { co.hErr = err.status === 400 ? 'No 13F data for this symbol.' : failed(err, 'The managers holding this share'); drawCompany(); } });
      api('/insiders?symbol=' + encodeURIComponent(symbol)).then(function (d) { if (seq === co.seq) { co.insiders = d; drawCompany(); } })
        .catch(function (err) { if (seq === co.seq && !co.insiders) { co.iErr = err.status === 400 ? 'No insider filings for this symbol.' : failed(err, 'Insider transactions'); drawCompany(); } });
    },
    reset: function () { co.sym = ''; co.seq += 1; co.holders = null; co.insiders = null; forget('fn.co'); }
  };
})();
