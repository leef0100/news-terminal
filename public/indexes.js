// Indexes: Halftone's house indexes for AI infrastructure. Everything here is drawn from
// the answers under /api/indexes. Every index is our own construction and says so; each
// block names its source and its age; an index whose inputs are missing says "not
// connected" and why, and never shows a figure in its place. Demo answers are labelled as
// invented. Nothing is fetched while the page is hidden or the tab is in the background.
(function () {
  'use strict';
  var view = document.getElementById('view-indexes');
  if (!view) return;
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var SVG = 'http://www.w3.org/2000/svg';
  function svg(tag, attrs, text) {
    var n = document.createElementNS(SVG, tag);
    Object.keys(attrs || {}).forEach(function (k) { n.setAttribute(k, attrs[k]); });
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
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 300) : typeof v === 'number' && isFinite(v) ? String(v) : ''; }
  function has(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  var ID = /^[a-z0-9-]{1,40}$/;
  function isDay(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s); }
  // Links go only to the official pages the figures were read from.
  var HOSTS = ['https://www.sec.gov/', 'https://www.eia.gov/', 'https://fred.stlouisfed.org/', 'https://learn.microsoft.com/', 'https://developers.openai.com/', 'https://platform.claude.com/', 'https://ai.google.dev/'];
  function safeUrl(u) {
    if (typeof u !== 'string' || u.length > 400 || /[\s<>"'`\\]/.test(u)) return '';
    for (var i = 0; i < HOSTS.length; i++) if (u.indexOf(HOSTS[i]) === 0) return u;
    return '';
  }
  function outLink(url, text, label) {
    var a = el('a', 'link ixOut', text);
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    a.setAttribute('aria-label', (label || text) + ' (opens in a new tab)');
    return a;
  }
  function limit() { return window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(15000) : undefined; }
  function api(path) {
    return fetch('/api/indexes' + path, { headers: { accept: 'application/json' }, signal: limit() }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        d = obj(d);
        if (!r.ok) { var e = new Error(str(d.error, 240) || 'HTTP ' + r.status); e.status = r.status; throw e; }
        return d;
      });
    });
  }

  // ---------- numbers and dates for people ----------
  function fix(n, d) { return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }); }
  function level(n) { n = num(n); return n == null ? DASH : fix(n, 2); }
  function compact(n) {
    var a = Math.abs(n);
    if (a >= 999.995e9) return fix(n / 1e12, 2) + 'T';
    if (a >= 999.95e6) return fix(n / 1e9, 2) + 'B';
    if (a >= 999.5e3) return fix(n / 1e6, 1) + 'M';
    if (a >= 1e4) return fix(n / 1e3, 0) + 'K';
    return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }
  function money(n) { n = num(n); return n == null ? DASH : (n < 0 ? '-$' : '$') + compact(Math.abs(n)); }
  // A price that may be a fraction of a cent or thousands of dollars.
  function price(n) {
    n = num(n);
    if (n == null) return DASH;
    var a = Math.abs(n);
    return '$' + (a >= 1e6 ? compact(n) : n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: a < 1 ? 4 : a < 100 ? 3 : 2 }));
  }
  function dir(n) { return n > 0 ? 'up' : n < 0 ? 'down' : ''; }
  // The arrow and the sign carry the direction; colour only repeats it.
  function chg(n, unit) {
    n = num(n);
    if (n == null) return DASH;
    return (n > 0 ? '▲ +' : n < 0 ? '▼ ' : '') + n.toFixed(2) + (unit == null ? '%' : unit);
  }
  function chgNode(tag, n, unit) { return el(tag, 'mono ' + dir(num(n) || 0), chg(n, unit)); }
  function day(s) { return isDay(s) ? +s.slice(8) + ' ' + MONTHS[+s.slice(5, 7) - 1] + ' ' + s.slice(0, 4) : DASH; }
  // A date as the index's own rhythm reads it: a day, a month or a quarter.
  function when(s, freq) {
    if (!isDay(s)) return DASH;
    if (freq === 'monthly') return MONTHS[+s.slice(5, 7) - 1] + ' ' + s.slice(0, 4);
    if (freq === 'quarterly') return 'Q' + Math.ceil(+s.slice(5, 7) / 3) + ' ' + s.slice(0, 4);
    return day(s);
  }
  function withUnit(v, unit) {
    v = num(v); unit = str(unit, 40);
    if (v == null) return DASH;
    if (unit === 'USD') return Math.abs(v) >= 1e6 ? money(v) : price(v);
    if (unit === '%') return chg(v);
    if (/^USD per/.test(unit)) return price(v) + unit.slice(3);
    if (unit === 'cents per kWh') return fix(v, 2) + '¢ per kWh';
    return fix(v, 2) + (unit && unit !== 'index' ? ' ' + unit : '');
  }
  function ago(ms) {
    var s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 5) return 'just now';
    if (s < 90) return s + ' seconds ago';
    var m = Math.round(s / 60);
    return m < 90 ? m + ' minutes ago' : Math.round(m / 60) + ' hours ago';
  }
  var STATE = { ok: 'Connected', off: 'Not connected', pending: 'Reading inputs', error: 'Source failing' };
  function stateOf(v) { return has(STATE, v) ? v : 'error'; }
  function badge(state) {
    state = stateOf(state);
    var b = el('span', 'ixState ixState-' + state, STATE[state]);
    return b;
  }

  // ---------- state ----------
  var st = {
    on: false, id: '', range: '', timers: [],
    list: null, listAt: 0, listKey: '', listErr: '',
    capex: null, capexKey: '', capexErr: '',
    ser: null, serKey: '', serErr: '', serFor: '',
    chart: null, line: null, tone: null, drawnCapex: ''
  };
  var ui = {};

  // The line every block carries: where its figures come from and how old the answer is.
  function sourceLine(node, d, at) {
    var names = arr(d && d.sources).map(function (s) { s = obj(s); return str(s.name, 60) + (s.state === 'off' ? ' (not connected)' : s.state === 'error' ? ' (failing)' : ''); }).filter(Boolean);
    node.dataset.at = String(at || 0);
    node.dataset.src = (names.length ? 'Source: ' + names.slice(0, 5).join(', ') + (names.length > 5 ? ' and ' + (names.length - 5) + ' more' : '') : 'Source: none connected') ;
    node.dataset.demo = d && d.demo ? '1' : '';
    tick(node);
  }
  function tick(node) {
    var at = +node.dataset.at;
    node.textContent = node.dataset.src + (at ? ' · updated ' + ago(at) : '') + (node.dataset.demo ? ' · Demo: invented figures' : '');
  }
  function tickAll() { Array.prototype.forEach.call(view.querySelectorAll('[data-src]'), tick); }
  function sayBox(text) { var p = el('p', 'emptyBox', text); p.setAttribute('role', 'status'); return p; }
  function card(title, id) {
    var sec = el('section', 'card ixBlock');
    sec.id = id;
    sec.setAttribute('aria-labelledby', id + 'T');
    var head = el('div', 'sideHead padHead');
    var h = el('h2', null, title); h.id = id + 'T';
    var note = el('span', 'muted small ixNote');
    add(head, h, note);
    var body = el('div', 'ixBody');
    add(sec, head, body);
    return { sec: sec, body: body, note: note, h: h };
  }
  function failed(err, what) {
    return what + ' could not be loaded' + (err && err.status === 429 ? ': too many requests from this address. It will be tried again shortly.' : err && err.message && !/^HTTP|fetch|abort|timeout/i.test(err.message) ? ': ' + str(err.message, 200) : '. It will be tried again shortly.');
  }

  // ---------- the page ----------
  function build() {
    var head = el('div', 'breakHead');
    var left = el('div');
    ui.title = el('h1', 'display', 'AI infrastructure indexes');
    add(left, el('p', 'kicker ixKick', 'Indexes'), ui.title);
    ui.headNote = el('p', 'muted ixHeadNote');
    add(head, left, ui.headNote);
    view.appendChild(head);

    // ----- every index -----
    ui.listBox = el('div', 'ixPad'); ui.listBox.id = 'ixList';
    ui.lede = el('p', 'ixLede', 'Halftone’s own measures of the price of compute, the demand for AI chips, the cost of power and the companies building data centers. Each one is a Halftone index, not an official benchmark: its method and inputs are published on its page, and an index whose inputs are not connected says so and shows nothing in their place.');
    ui.listState = sayBox('Loading the indexes…');
    ui.grid = el('ul', 'ixGrid'); ui.grid.setAttribute('aria-label', 'Halftone indexes');
    ui.capexCard = card('AI capital spending tracker', 'ixCapex');
    ui.capexBody = ui.capexCard.body;
    add(ui.listBox, ui.lede, ui.listState, ui.grid, ui.capexCard.sec);
    view.appendChild(ui.listBox);

    // ----- one index -----
    ui.one = el('div', 'ixPad'); ui.one.id = 'ixOne'; ui.one.hidden = true;
    ui.back = el('a', 'btn ghost backBtn ixBack', '← All indexes'); ui.back.href = '#indexes';
    ui.oneState = sayBox('');
    ui.oneMain = el('div', 'ixStack');
    ui.intro = el('div', 'ixIntro');
    ui.tiles = el('div', 'ixTiles');
    ui.chartCard = card('Index', 'ixChartC');
    ui.ranges = el('div', 'ixSegs');
    ui.chartBox = el('div', 'ixChart'); ui.chartBox.id = 'ixChart';
    ui.chartBox.setAttribute('role', 'img');
    ui.chartBox.setAttribute('aria-label', 'Index chart');
    ui.chartSum = el('p', 'small ixChartSum'); ui.chartSum.id = 'ixChartSum';
    ui.chartTable = el('details', 'ixDetails');
    add(ui.chartCard.body, ui.ranges, ui.chartBox, ui.chartSum, ui.chartTable);
    ui.trade = card('Trade it on paper', 'ixTrade');
    ui.parts = card('What it is made of', 'ixParts');
    ui.extra = el('div', 'ixStack');
    ui.capexSlot = el('div', 'ixStack');
    ui.how = card('How this is calculated', 'ixHow');
    ui.inputs = card('Inputs, sources and dates', 'ixInputs');
    ui.limits = card('What it does not capture', 'ixLimits');
    add(ui.oneMain, ui.intro, ui.tiles, ui.chartCard.sec, ui.trade.sec, ui.parts.sec, ui.capexSlot, ui.extra, ui.how.sec, ui.inputs.sec, ui.limits.sec);
    add(ui.one, ui.back, ui.oneState, ui.oneMain);
    view.appendChild(ui.one);
  }

  // ---------- list ----------
  function spark(values, cls) {
    var v = arr(values).filter(function (x) { return num(x) != null; });
    var s = svg('svg', { class: 'ixSpark ' + cls, viewBox: '0 0 120 34', preserveAspectRatio: 'none', 'aria-hidden': 'true', focusable: 'false' });
    if (v.length < 2) return s;
    var lo = Math.min.apply(null, v), hi = Math.max.apply(null, v), span = hi - lo || 1;
    s.appendChild(svg('polyline', { fill: 'none', 'vector-effect': 'non-scaling-stroke', points: v.map(function (y, i) { return (i / (v.length - 1) * 120).toFixed(1) + ',' + (31 - (y - lo) / span * 28).toFixed(1); }).join(' ') }));
    return s;
  }
  var CHANGE_WORDS = { d1: '1 day', m1: '1 month', y1: '1 year' };
  function changeLine(ix) {
    var c = obj(ix.change), row = el('p', 'ixChgs');
    var any = false;
    ['d1', 'm1', 'y1'].forEach(function (k) {
      if (num(c[k]) == null) return;
      any = true;
      var s = el('span', 'ixChg');
      add(s, el('span', 'muted', CHANGE_WORDS[k] + ' '), chgNode('b', c[k]));
      row.appendChild(s);
    });
    var p = obj(c.previous);
    if (!any && num(p.pct) != null) {
      var s2 = el('span', 'ixChg');
      add(s2, el('span', 'muted', 'Since ' + when(str(p.since, 10), str(ix.frequency, 12)) + ' '), chgNode('b', p.pct));
      row.appendChild(s2);
      any = true;
    }
    if (!any) row.appendChild(el('span', 'muted', num(ix.value) == null ? '' : 'No earlier point to compare with yet'));
    return row;
  }
  function drawList() {
    var d = st.list;
    if (!d) { ui.listState.hidden = false; ui.listState.textContent = st.listErr || 'Loading the indexes…'; ui.grid.replaceChildren(); return; }
    ui.listState.hidden = true;
    st.drawnList = st.listKey;
    sourceLine(ui.headNote, d, st.listAt);
    var frag = document.createDocumentFragment();
    arr(d.indexes).forEach(function (raw) {
      var ix = obj(raw), id = str(ix.id, 40);
      if (!ID.test(id)) return;
      var state = stateOf(ix.state), v = num(ix.value);
      var li = el('li', 'ixCardLi');
      var a = el('a', 'card ixCard ixCard-' + state);
      a.href = '#indexes/' + id;
      a.dataset.id = id;
      var top = el('div', 'ixCardTop');
      add(top, el('h2', 'ixName', str(ix.name, 80)), badge(state));
      var tag = el('p', 'ixTag', d.demo ? 'Halftone index · demo, invented figures' : 'Halftone index');
      var val = el('p', 'ixVal mono', v == null ? DASH : level(v));
      var first = arr(ix.spark)[0], lastV = arr(ix.spark)[arr(ix.spark).length - 1];
      add(a, top, tag, val);
      if (state === 'ok' && v != null) {
        add(a, changeLine(ix), spark(ix.spark, dir((num(lastV) || 0) - (num(first) || 0))));
        add(a, el('p', 'muted small', 'As of ' + when(str(ix.asOf, 10), str(ix.frequency, 12)) + (obj(ix.base).t ? ' · 100 = ' + when(str(obj(ix.base).t, 10), str(ix.frequency, 12)) : '')));
        if (str(ix.note)) add(a, el('p', 'small ixCardNote', str(ix.note, 260)));
      } else {
        add(a, el('p', 'small ixWhy', str(ix.note, 420) || 'No value: its inputs are not connected.'));
      }
      add(a, el('p', 'small ixMeaning', str(ix.meaning, 200)));
      add(a, el('span', 'ixMore', 'Method, inputs and parts →'));
      li.appendChild(a);
      frag.appendChild(li);
    });
    ui.grid.replaceChildren(frag);
  }

  // ---------- capital spending tracker ----------
  function quarterWords(q) { var m = /^(\d{4})-Q([1-4])$/.exec(str(q, 8)); return m ? 'Q' + m[2] + ' ' + m[1] : str(q, 8); }
  function quarterShort(q) { var m = /^(\d{4})-Q([1-4])$/.exec(str(q, 8)); return m ? 'Q' + m[2] + ' ’' + m[1].slice(2) : str(q, 8); }
  function capexChart(d, width) {
    var companies = arr(d.companies).map(obj), quarters = arr(d.quarters), values = obj(d.values), totals = arr(d.totals);
    var box = el('div', 'ixBars');
    box.setAttribute('role', 'img');
    var sums = quarters.map(function (_, i) { return companies.reduce(function (s, c) { var v = num(arr(values[str(c.symbol, 12)])[i]); return s + (v || 0); }, 0); });
    var top = Math.max.apply(null, sums.concat([0]));
    if (!quarters.length || !(top > 0)) { box.setAttribute('aria-label', 'Capital spending chart: no figures to draw.'); return box; }
    var W = Math.max(280, Math.round(width)), H = W < 520 ? 250 : 320, L = 46, R = 8, T = 22, B = 40;
    var slot = (W - L - R) / quarters.length, bar = Math.min(64, slot * 0.68);
    // A round number above the tallest bar, and four steps up to it.
    var pow = Math.pow(10, Math.floor(Math.log(top) / Math.LN10)), step = [1, 2, 2.5, 5, 10].map(function (k) { return k * pow / 4; }).filter(function (s) { return s * 4 >= top; })[0] || pow * 2.5;
    var max = step * 4, y = function (v) { return T + (H - T - B) * (1 - v / max); };
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, 'aria-hidden': 'true', focusable: 'false' });
    for (var g = 0; g <= 4; g++) {
      s.appendChild(svg('line', { class: 'ixGridLine', x1: L, x2: W - R, y1: y(step * g), y2: y(step * g) }));
      s.appendChild(svg('text', { class: 'ixAxis', x: L - 6, y: y(step * g) + 4, 'text-anchor': 'end' }, g ? '$' + compact(step * g) : '0'));
    }
    quarters.forEach(function (q, i) {
      var x = L + slot * i + (slot - bar) / 2, base = 0;
      companies.forEach(function (c, k) {
        var v = num(arr(values[str(c.symbol, 12)])[i]);
        if (!(v > 0)) return;
        var y1 = y(base + v), h = y(base) - y1;
        // A hairline of background between segments keeps neighbours apart whatever their colours.
        s.appendChild(svg('rect', { class: 'ixSeg ixS' + (k % 6), x: x.toFixed(1), y: y1.toFixed(1), width: bar.toFixed(1), height: Math.max(0, h - 1).toFixed(1), rx: 2 }));
        base += v;
      });
      var total = num(totals[i]), mid = (x + bar / 2).toFixed(1), tight = slot < 52;
      // On a narrow screen there is room for a figure above every third bar; all of them are in the table.
      if (!tight || (quarters.length - 1 - i) % 3 === 0) s.appendChild(svg('text', { class: 'ixBarTop', x: mid, y: (y(base) - 6).toFixed(1), 'text-anchor': 'middle' }, total == null ? 'part' : '$' + compact(total)));
      var qm = /^(\d{4})-Q([1-4])$/.exec(str(q, 8));
      var yy = num(arr(d.yoy)[i]);
      if (tight && qm) {
        s.appendChild(svg('text', { class: 'ixAxis', x: mid, y: H - B + 16, 'text-anchor': 'middle' }, 'Q' + qm[2]));
        s.appendChild(svg('text', { class: 'ixAxis', x: mid, y: H - B + 31, 'text-anchor': 'middle' }, '’' + qm[1].slice(2)));
      } else {
        s.appendChild(svg('text', { class: 'ixAxis', x: mid, y: H - B + 16, 'text-anchor': 'middle' }, quarterShort(q)));
        if (yy != null) s.appendChild(svg('text', { class: 'ixAxis ixYoy ' + dir(yy), x: mid, y: H - B + 31, 'text-anchor': 'middle' }, (yy > 0 ? '+' : '') + yy.toFixed(0) + '%'));
      }
    });
    box.appendChild(s);
    var lastFull = -1;
    totals.forEach(function (t, i) { if (num(t) != null) lastFull = i; });
    var words = 'Stacked bar chart of quarterly capital expenditure for ' + companies.length + ' companies over ' + quarters.length + ' calendar quarters, ' + quarterWords(quarters[0]) + ' to ' + quarterWords(quarters[quarters.length - 1]) + '.';
    if (lastFull >= 0) words += ' Total in ' + quarterWords(quarters[lastFull]) + ': ' + money(totals[lastFull]) + (num(arr(d.yoy)[lastFull]) != null ? ', ' + chg(arr(d.yoy)[lastFull]) + ' from a year earlier' : '') + '.';
    box.setAttribute('aria-label', words + ' Every figure is in the table below.');
    return box;
  }
  function capexTable(d) {
    var companies = arr(d.companies).map(obj), quarters = arr(d.quarters), values = obj(d.values), derived = obj(d.derived);
    var table = el('table', 'screener ixCapexTable');
    table.appendChild(el('caption', 'sr', 'Capital expenditure by company and calendar quarter, in US dollars'));
    var hr = el('tr');
    var h0 = el('th', null, 'Company'); h0.scope = 'col'; hr.appendChild(h0);
    quarters.forEach(function (q) { var th = el('th', 'mono', quarterWords(q)); th.scope = 'col'; hr.appendChild(th); });
    add(table, add(el('thead'), hr));
    var body = el('tbody'), anyDerived = false;
    companies.forEach(function (c, k) {
      var sym = str(c.symbol, 12), tr = el('tr');
      var th = el('th'); th.scope = 'row';
      add(th, el('span', 'ixSw ixS' + (k % 6)), el('b', 'mono', sym), el('span', 'muted small ixCoName', ' ' + str(c.name, 60)));
      tr.appendChild(th);
      quarters.forEach(function (_, i) {
        var v = num(arr(values[sym])[i]), dv = Boolean(arr(derived[sym])[i]);
        if (dv && v != null) anyDerived = true;
        tr.appendChild(el('td', 'mono', v == null ? DASH : money(v) + (dv ? ' †' : '')));
      });
      body.appendChild(tr);
    });
    table.appendChild(body);
    var foot = el('tfoot');
    function row(label, list, fmt, cls) {
      var tr = el('tr');
      var th = el('th', null, label); th.scope = 'row'; tr.appendChild(th);
      quarters.forEach(function (_, i) { var v = num(arr(list)[i]); var td = el('td', 'mono ' + (cls && v != null ? dir(v) : ''), v == null ? DASH : fmt(v)); tr.appendChild(td); });
      foot.appendChild(tr);
    }
    row('Total', d.totals, money);
    row('Change from a year earlier', d.yoy, function (v) { return chg(v); }, true);
    row('Trailing four quarters', d.trailing, money);
    row('Index (first trailing total = 100)', d.index, function (v) { return fix(v, 2); });
    table.appendChild(foot);
    var wrap = el('div', 'tableWrap'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Capital expenditure table, scrolls sideways');
    wrap.appendChild(table);
    var notes = el('p', 'muted small', 'A dash means no figure. A total is shown only for quarters in which every company has one.' + (anyDerived ? ' † worked out as the difference between two year-to-date figures in the filings.' : ''));
    var out = document.createDocumentFragment();
    add(out, wrap, notes);
    return out;
  }
  function capexLegend(d) {
    var ul = el('ul', 'ixLegend');
    ul.setAttribute('aria-label', 'Companies, in the order they are stacked from the bottom of each bar');
    arr(d.companies).map(obj).forEach(function (c, k) {
      var li = el('li');
      add(li, el('span', 'ixSw ixS' + (k % 6)), el('b', 'mono', str(c.symbol, 12)), el('span', 'muted', ' ' + str(c.name, 60)));
      if (c.state !== 'ok') li.appendChild(el('span', 'ixWhy small', ' ' + (str(c.note, 200) || 'No figures.')));
      ul.appendChild(li);
    });
    return ul;
  }
  // Draws the tracker into `into`; `full` adds the companies' reasons.
  function drawCapex(into, noteNode, full) {
    var d = st.capex;
    if (!d) { into.replaceChildren(sayBox(st.capexErr || 'Loading the capital spending tracker…')); return; }
    if (noteNode) sourceLine(noteNode, d, st.capexAt);
    var frag = document.createDocumentFragment();
    frag.appendChild(el('p', 'ixTag', str(d.label, 120)));
    if (stateOf(d.state) !== 'ok' && !arr(d.quarters).length) {
      var p = el('p', 'ixWhy'); add(p, badge(d.state), document.createTextNode(' ' + (str(d.note, 420) || 'Its inputs are not connected.')));
      frag.appendChild(p);
      into.replaceChildren(frag);
      return;
    }
    frag.appendChild(el('p', 'small ixMeaning', str(d.meaning, 200) + ' Bars are stacked from the bottom in the order of the list beneath. The figure above a bar is that quarter’s total; the change from a year earlier is in the table, and under each quarter where there is room.'));
    if (str(d.note)) frag.appendChild(el('p', 'ixWhy small', str(d.note, 420)));
    var holder = el('div', 'ixBarsHold');
    frag.appendChild(holder);
    frag.appendChild(capexLegend(d));
    frag.appendChild(capexTable(d));
    if (!full) { var more = el('a', 'link ixMoreLink', 'How the tracker is calculated, and its index →'); more.href = '#indexes/capex'; frag.appendChild(more); }
    into.replaceChildren(frag);
    holder.appendChild(capexChart(d, holder.clientWidth || 600));
    into.dataset.w = String(holder.clientWidth);
  }
  function redrawBars() {
    [ui.capexBody, ui.capexSlot].forEach(function (into) {
      var holder = into.querySelector('.ixBarsHold');
      if (!holder || !st.capex || !holder.clientWidth || String(holder.clientWidth) === into.dataset.w) return;
      into.dataset.w = String(holder.clientWidth);
      holder.replaceChildren(capexChart(st.capex, holder.clientWidth));
    });
  }

  // ---------- one index ----------
  var RANGE_WORDS = { '1m': 'the past month', '6m': 'the past six months', '1y': 'the past year', '5y': 'the past five years', max: 'all the history there is' };
  var RANGE_LIST = [['1m', '1M'], ['6m', '6M'], ['1y', '1Y'], ['5y', '5Y'], ['max', 'Max']];
  function drawRanges() {
    var box = el('div', 'seg');
    box.setAttribute('role', 'group');
    box.setAttribute('aria-label', 'Period shown');
    RANGE_LIST.forEach(function (o) {
      var b = el('button', o[0] === st.range ? 'on' : '', o[1]);
      b.type = 'button';
      b.dataset.range = o[0];
      b.setAttribute('aria-pressed', String(o[0] === st.range));
      b.setAttribute('aria-label', 'Show ' + RANGE_WORDS[o[0]]);
      b.addEventListener('click', function () { if (st.range === o[0]) return; st.range = o[0]; st.rangeById[st.id] = o[0]; drawRanges(); loadSeries(); });
      box.appendChild(b);
    });
    ui.ranges.replaceChildren(box, el('span', 'muted small', 'The line is set to 100 at the start of the period shown.'));
    var f = document.activeElement && document.activeElement.dataset ? document.activeElement.dataset.range : null;
    if (f) { var again = box.querySelector('[data-range="' + st.range + '"]'); if (again) again.focus(); }
  }
  st.rangeById = {};
  function cssVar(name, fallback) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback; }
  function alpha(color, a) {
    var m = /^#([0-9a-f]{6})$/i.exec(color);
    return m ? 'rgba(' + parseInt(m[1].slice(0, 2), 16) + ', ' + parseInt(m[1].slice(2, 4), 16) + ', ' + parseInt(m[1].slice(4, 6), 16) + ', ' + a + ')' : color;
  }
  function ensureChart() {
    if (st.chart || !window.LightweightCharts) return;
    // The chart needs literal colours, so they are read from the theme once, here.
    var t = st.tone = { text: cssVar('--text-2', '#444'), line: cssVar('--line', '#ccc'), accent: cssVar('--accent', '#0B7A42'), faint: cssVar('--text-3', '#777') };
    st.chart = window.LightweightCharts.createChart(ui.chartBox, {
      autoSize: true,
      layout: { background: { color: 'transparent' }, textColor: t.text, fontFamily: 'Inter, system-ui, sans-serif' },
      grid: { vertLines: { color: alpha(t.line, 0.5) }, horzLines: { color: alpha(t.line, 0.5) } },
      rightPriceScale: { borderColor: t.line },
      timeScale: { borderColor: t.line, timeVisible: false },
      crosshair: { mode: 0 }, handleScroll: false, handleScale: false
    });
    st.line = st.chart.addLineSeries({ color: t.accent, lineWidth: 2, priceLineVisible: false, lastValueVisible: true });
  }
  function drawChart(d) {
    var freq = str(d.frequency, 12), pts = arr(d.series).map(obj).filter(function (p) { return isDay(p.t) && num(p.r) != null; });
    var name = str(d.name, 80);
    ui.chartCard.h.textContent = name + ', set to 100 at the start of the period';
    var table = el('table', 'screener ixSeries');
    if (pts.length < 2) {
      if (st.line) st.line.setData([]);
      ui.chartBox.hidden = true;
      var why = stateOf(d.state) !== 'ok' ? 'No line to draw: ' + (str(d.note, 300) || 'the inputs are not connected.') : pts.length === 1 ? 'One point so far (' + when(pts[0].t, freq) + ', index ' + level(obj(arr(d.series)[0]).v) + '), so there is no line to draw yet.' : 'No points in ' + RANGE_WORDS[st.range] + '. Try a longer period.';
      ui.chartSum.textContent = why;
      ui.chartBox.setAttribute('aria-label', name + ' chart. ' + why);
      ui.chartTable.replaceChildren();
      ui.chartTable.hidden = true;
      return;
    }
    ui.chartBox.hidden = false;
    var first = pts[0], lastP = pts[pts.length - 1];
    var hi = pts.reduce(function (a, p) { return p.r > a.r ? p : a; }), lo = pts.reduce(function (a, p) { return p.r < a.r ? p : a; });
    var text = name + ' over ' + RANGE_WORDS[st.range] + ': ' + pts.length + ' ' + (freq === 'daily' ? 'daily' : freq === 'monthly' ? 'monthly' : freq === 'quarterly' ? 'quarterly' : 'dated') + ' points from ' + when(first.t, freq) + ' to ' + when(lastP.t, freq) +
      '. Set to 100 at the start, it ends at ' + fix(lastP.r, 2) + ' (' + chg(num(d.changePct)) + '); highest ' + fix(hi.r, 2) + ' on ' + when(hi.t, freq) + ', lowest ' + fix(lo.r, 2) + ' on ' + when(lo.t, freq) +
      '. On its own base the index reads ' + level(num(lastP.v)) + '.' + (d.demo ? ' Demo: invented figures.' : '');
    ui.chartSum.textContent = text;
    ui.chartBox.setAttribute('aria-label', 'Line chart. ' + text + ' The figures are in the table below.');
    ensureChart();
    if (st.chart) {
      st.line.applyOptions({ pointMarkersVisible: pts.length <= 40 });
      st.line.setData(pts.map(function (p) { return { time: p.t, value: p.r }; }));
      st.chart.timeScale().fitContent();
      // The chart takes its size a frame later when it has just been shown; fit again then.
      setTimeout(function () { if (st.chart) st.chart.timeScale().fitContent(); }, 60);
    } else ui.chartSum.textContent = 'The chart library did not load. ' + text;
    // The same figures as a table. A long daily series is listed every fifth point, and says so.
    var every = pts.length > 400 ? 5 : 1, rows = pts.filter(function (_, i) { return (pts.length - 1 - i) % every === 0; });
    table.appendChild(el('caption', 'sr', name + ': index values'));
    var hr = el('tr');
    ['Date', 'Set to 100 at start', 'Index on its own base'].forEach(function (t) { var th = el('th', null, t); th.scope = 'col'; hr.appendChild(th); });
    add(table, add(el('thead'), hr));
    var body = el('tbody');
    rows.slice().reverse().forEach(function (p) {
      var tr = el('tr');
      var th = el('th', 'mono', when(p.t, freq)); th.scope = 'row';
      add(tr, th, el('td', 'mono', fix(p.r, 2)), el('td', 'mono', level(num(p.v))));
      body.appendChild(tr);
    });
    table.appendChild(body);
    var wasOpen = ui.chartTable.open;
    var wrap = el('div', 'tableWrap ixSeriesWrap'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Index values, scrolls');
    wrap.appendChild(table);
    ui.chartTable.replaceChildren(el('summary', null, 'Show these figures as a table (' + rows.length + ' rows' + (every > 1 ? ', every fifth day' : '') + ')'), wrap);
    ui.chartTable.hidden = false;
    ui.chartTable.open = wasOpen;
  }
  function tile(label, value, sub, cls) {
    var d = el('div', 'stTile ixTile');
    add(d, el('span', 'statLabel', label), el('b', 'ixTileVal mono ' + (cls || ''), value));
    if (sub) d.appendChild(el('span', 'muted small', sub));
    return d;
  }
  function latestWords(l, freq) {
    l = obj(l);
    if (num(l.value) == null) return DASH;
    return withUnit(l.value, str(l.unit, 40));
  }
  function drawParts(d) {
    var list = arr(d.constituents).map(obj), freq = str(d.frequency, 12);
    ui.parts.sec.hidden = !list.length;
    if (!list.length) return;
    var table = el('table', 'screener stTable ixPartsTable');
    table.appendChild(el('caption', 'sr', 'Constituents, weights and contributions'));
    var hr = el('tr');
    ['Constituent', 'Why it is here', 'Weight', 'Latest', 'Change over the period', 'Contribution to the index'].forEach(function (t, i) { var th = el('th', i > 1 ? 'ixNum' : null, t); th.scope = 'col'; hr.appendChild(th); });
    add(table, add(el('thead'), hr));
    var body = el('tbody'), sum = 0, counted = 0;
    list.forEach(function (c) {
      var tr = el('tr');
      var th = el('th'); th.scope = 'row';
      var id = str(c.id, 60), link = str(c.link, 40), name = str(c.name, 120);
      var isTicker = /^#stocks\/[A-Z0-9.\-]{1,12}$/.test(link);
      if (isTicker) { var a = el('a', 'ixSym'); a.href = link; add(a, el('b', 'mono', id), el('span', 'muted small', name)); a.setAttribute('aria-label', id + ', ' + name + ': open the company page'); th.appendChild(a); }
      else { add(th, el('b', null, name), str(c.group) && str(c.group) !== str(c.reason) ? el('span', 'muted small ixGroup', ' ' + str(c.group, 40)) : null); }
      tr.appendChild(th);
      var ok = c.state === 'ok';
      var why = el('td', 'ixWrap small', str(c.reason, 240));
      if (!ok) { why.appendChild(el('br')); var w = el('span', 'ixWhy'); add(w, el('b', null, c.state === 'pending' ? 'Not read yet. ' : 'Not in the index. '), document.createTextNode(str(c.note, 300))); why.appendChild(w); }
      else if (str(c.note)) { why.appendChild(el('br')); why.appendChild(el('span', 'muted', str(c.note, 200))); }
      tr.appendChild(why);
      tr.appendChild(el('td', 'mono ixNum', num(c.weightPct) == null ? DASH : fix(c.weightPct, 1) + '%'));
      var lt = el('td', 'mono ixNum', latestWords(c.latest, freq));
      if (obj(c.latest).asOf) lt.appendChild(el('span', 'muted small ixSub', when(str(obj(c.latest).asOf, 10), obj(c.latest).month ? 'monthly' : freq === 'quarterly' ? 'quarterly' : 'daily') + (str(obj(c.latest).what, 40) ? ', ' + str(obj(c.latest).what, 40) : '')));
      tr.appendChild(lt);
      tr.appendChild(chgNode('td', c.changePct)).classList.add('ixNum');
      var ct = chgNode('td', c.contributionPts, ' pts'); ct.classList.add('ixNum');
      tr.appendChild(ct);
      if (num(c.contributionPts) != null) { sum += c.contributionPts; counted++; }
      body.appendChild(tr);
    });
    table.appendChild(body);
    if (counted) {
      var foot = el('tfoot'), fr = el('tr');
      var fh = el('th', null, 'Index over the period'); fh.scope = 'row'; fh.colSpan = 4;
      add(fr, fh, chgNode('td', num(d.changePct)), chgNode('td', Math.round(sum * 100) / 100, ' pts'));
      fr.lastChild.classList.add('ixNum'); fr.children[1].classList.add('ixNum');
      foot.appendChild(fr); table.appendChild(foot);
    }
    var wrap = el('div', 'tableWrap'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Constituents table, scrolls sideways');
    wrap.appendChild(table);
    var note = el('p', 'muted small', (str(d.weightNote, 300) ? str(d.weightNote, 300) + ' ' : '') + (counted ? 'Contribution is how many of the index’s percentage points over the period came from each part; they add up to the index’s move, give or take rounding.' : 'Contributions appear once there are two points in the period.'));
    ui.parts.body.replaceChildren(wrap, note);
    sourceLine(ui.parts.note, d, st.serAt);
  }
  function cell(v, kind) {
    if (kind === 'link') {
      var o = obj(v), u = safeUrl(o.url);
      var td = el('td');
      if (u) td.appendChild(outLink(u, str(o.text, 40) || 'Source')); else td.textContent = DASH;
      return td;
    }
    if (kind === 'usd') return el('td', 'mono ixNum', money(v));
    if (kind === 'price') return el('td', 'mono ixNum', typeof v === 'string' ? str(v, 200) : price(v));
    return el('td', 'ixWrap', v == null ? DASH : str(v, 300));
  }
  function drawExtra(d) {
    var frag = document.createDocumentFragment();
    var facts = arr(d.facts).map(obj).filter(function (f) { return num(f.value) != null; });
    arr(d.tables).map(obj).forEach(function (t, n) {
      var c = card(str(t.title, 120), 'ixTab' + n);
      var cols = arr(t.columns).map(obj);
      var table = el('table', 'screener stTable');
      table.appendChild(el('caption', 'sr', str(t.title, 120)));
      var hr = el('tr');
      cols.forEach(function (col) { var th = el('th', col.kind === 'usd' || col.kind === 'price' ? 'ixNum' : null, str(col.label, 60)); th.scope = 'col'; hr.appendChild(th); });
      add(table, add(el('thead'), hr));
      var body = el('tbody');
      arr(t.rows).slice(0, 60).forEach(function (r) {
        var tr = el('tr');
        cols.forEach(function (col, i) { tr.appendChild(cell(arr(r)[i], str(col.kind, 10))); });
        body.appendChild(tr);
      });
      table.appendChild(body);
      var wrap = el('div', 'tableWrap'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', str(t.title, 120) + ', scrolls sideways');
      wrap.appendChild(table);
      add(c.body, wrap, str(t.note) ? el('p', 'muted small', str(t.note, 400)) : null);
      sourceLine(c.note, d, st.serAt);
      frag.appendChild(c.sec);
    });
    ui.extra.replaceChildren(frag);
    return facts;
  }
  function drawOne() {
    var d = st.ser;
    ui.back.hidden = false;
    if (!d || st.serFor !== st.id) {
      ui.oneState.hidden = false;
      ui.oneState.textContent = st.serErr || (ID.test(st.id) ? 'Loading this index…' : 'There is no index by that name. Use “All indexes” to see the list.');
      ui.oneMain.hidden = true;
      ui.title.textContent = 'AI infrastructure indexes';
      return;
    }
    ui.oneState.hidden = true;
    ui.oneMain.hidden = false;
    var state = stateOf(d.state), freq = str(d.frequency, 12), name = str(d.name, 80);
    ui.title.textContent = name;
    document.title = name + ' · Halftone';
    sourceLine(ui.headNote, d, st.serAt);

    var intro = document.createDocumentFragment();
    var tagRow = el('p', 'ixTagRow');
    add(tagRow, el('span', 'ixTag', str(d.label, 140)), badge(state));
    add(intro, tagRow, el('p', 'ixLede', str(d.meaning, 240) + ' ' + str(d.summary, 400)));
    if (str(d.note)) { var n = el('p', state === 'ok' ? 'ixCardNote' : 'ixWhy'); n.textContent = str(d.note, 500); n.setAttribute('role', 'status'); intro.appendChild(n); }
    ui.intro.replaceChildren(intro);
    // The paper-trading ticket for this index, built once per index so typing is not interrupted.
    if (window.Paper && ui.trade.body.dataset.market !== String(d.id)) { ui.trade.body.dataset.market = String(d.id); window.Paper.ticket(ui.trade.body, { id: String(d.id), name: name }); window.Paper.refresh(); }

    var facts = drawExtra(d);
    var tiles = document.createDocumentFragment();
    var c = obj(d.change);
    if (num(d.value) != null) {
      tiles.appendChild(tile('Index', level(d.value), 'As of ' + when(str(d.asOf, 10), freq) + (obj(d.base).t ? ' · 100 = ' + when(str(obj(d.base).t, 10), freq) : '')));
      tiles.appendChild(tile('Over ' + RANGE_WORDS[st.range], chg(num(d.changePct)), isDay(d.from) ? 'From ' + when(d.from, freq) : '', dir(num(d.changePct) || 0)));
      ['d1', 'm1', 'y1'].forEach(function (k) { if (num(c[k]) != null) tiles.appendChild(tile(CHANGE_WORDS[k], chg(c[k]), '', dir(c[k]))); });
      if (num(c.d1) == null && num(c.m1) == null && num(obj(c.previous).pct) != null) tiles.appendChild(tile('Since the previous point', chg(obj(c.previous).pct), when(str(obj(c.previous).since, 10), freq), dir(obj(c.previous).pct)));
    } else {
      tiles.appendChild(tile('Index', STATE[state], 'No value is shown without its inputs.'));
    }
    facts.forEach(function (f) { tiles.appendChild(tile(str(f.label, 80), withUnit(f.value, str(f.unit, 40)), '', str(f.unit) === '%' ? dir(f.value) : '')); });
    ui.tiles.replaceChildren(tiles);

    sourceLine(ui.chartCard.note, d, st.serAt);
    drawChart(d);
    drawParts(d);

    var how = document.createDocumentFragment();
    var ol = el('ol', 'ixMethod');
    arr(d.method).forEach(function (m) { ol.appendChild(el('li', null, str(m, 600))); });
    if (str(d.methodNote)) how.appendChild(el('p', 'ixWhy small', str(d.methodNote, 400)));
    add(how, ol);
    if (str(d.history)) how.appendChild(el('p', 'ixHist', str(d.history, 400)));
    how.appendChild(el('p', 'muted small', 'The method and the basket are published in config/indexes.json; this text is read from it.'));
    ui.how.body.replaceChildren(how);
    ui.how.note.textContent = str(d.label, 140);

    var ins = arr(d.inputs).map(obj);
    if (ins.length) {
      var table = el('table', 'screener stTable');
      table.appendChild(el('caption', 'sr', 'Inputs with their sources and dates'));
      var hr = el('tr');
      ['Input', 'Source', 'First date', 'Latest date', 'Note'].forEach(function (t) { var th = el('th', null, t); th.scope = 'col'; hr.appendChild(th); });
      add(table, add(el('thead'), hr));
      var body = el('tbody');
      ins.forEach(function (i) {
        var tr = el('tr');
        var th = el('th', null, str(i.name, 160)); th.scope = 'row';
        var src = el('td', 'ixWrap'), u = safeUrl(i.url);
        if (u) src.appendChild(outLink(u, str(i.source, 80) || 'Source')); else src.textContent = str(i.source, 80) || DASH;
        add(tr, th, src, el('td', 'mono', day(str(i.from, 10))), el('td', 'mono', day(str(i.asOf, 10))), el('td', 'ixWrap small', str(i.note, 240) || DASH));
        body.appendChild(tr);
      });
      table.appendChild(body);
      var wrap = el('div', 'tableWrap'); wrap.tabIndex = 0; wrap.setAttribute('role', 'region'); wrap.setAttribute('aria-label', 'Inputs table, scrolls sideways');
      wrap.appendChild(table);
      ui.inputs.body.replaceChildren(wrap);
    } else {
      ui.inputs.body.replaceChildren(el('p', 'ixWhy', 'No input has been read. ' + (str(d.note, 400) || '')));
    }
    var srcs = el('ul', 'ixSources');
    arr(d.sources).map(obj).forEach(function (s) {
      var li = el('li', 'small');
      add(li, el('b', null, str(s.name, 80) + ': '), document.createTextNode((s.state === 'off' ? 'not connected. ' : s.state === 'error' ? 'failing. ' : 'connected. ') + str(s.note, 400)));
      srcs.appendChild(li);
    });
    ui.inputs.body.appendChild(srcs);
    sourceLine(ui.inputs.note, d, st.serAt);

    var ul = el('ul', 'ixLimits');
    arr(d.limits).forEach(function (m) { ul.appendChild(el('li', null, str(m, 600))); });
    ui.limits.body.replaceChildren(ul);
    ui.limits.sec.hidden = !arr(d.limits).length;

    if (st.id === 'capex') {
      if (!ui.capexFull) { ui.capexFull = card('Spending by company and quarter', 'ixCapexFull'); ui.capexSlot.replaceChildren(ui.capexFull.sec); }
      drawCapex(ui.capexFull.body, ui.capexFull.note, true);
      ui.capexSlot.dataset.w = ui.capexFull.body.dataset.w || '';
    } else { ui.capexSlot.replaceChildren(); ui.capexFull = null; }
  }

  // ---------- loading ----------
  // An answer is redrawn only if something other than its timestamp changed.
  function keyOf(d) { var c = Object.assign({}, d); delete c.at; return JSON.stringify(c); }
  function loadList() {
    if (!st.on || st.id || document.hidden) return;
    api('/').then(function (d) {
      st.listErr = ''; st.listAt = Date.now();
      var k = keyOf(d), same = k === st.drawnList;
      st.list = d; st.listKey = k;
      if (!st.on || st.id) return;
      if (same) { ui.headNote.dataset.at = String(st.listAt); tick(ui.headNote); return; }
      drawList();
    }).catch(function (err) {
      if (st.list) return;
      st.listErr = failed(err, 'The indexes');
      if (st.on && !st.id) drawList();
    });
  }
  function loadCapex() {
    if (!st.on || (st.id && st.id !== 'capex') || document.hidden) return;
    api('/capex').then(function (d) {
      st.capexErr = ''; st.capexAt = Date.now();
      var k = keyOf(d), same = k === st.capexKey;
      st.capex = d; st.capexKey = k;
      if (!st.on) return;
      var target = st.id === 'capex' ? (ui.capexFull && ui.capexFull.body) : !st.id ? ui.capexBody : null;
      if (!target) return;
      if (same && target.dataset.key === k) { var n = st.id ? ui.capexFull.note : ui.capexCard.note; n.dataset.at = String(st.capexAt); tick(n); return; }
      target.dataset.key = k;
      if (st.id === 'capex') drawCapex(ui.capexFull.body, ui.capexFull.note, true); else drawCapex(ui.capexBody, ui.capexCard.note, false);
    }).catch(function (err) {
      if (st.capex) return;
      st.capexErr = failed(err, 'The capital spending tracker');
      if (st.on && !st.id) drawCapex(ui.capexBody, ui.capexCard.note, false);
    });
  }
  function loadSeries() {
    if (!st.on || !ID.test(st.id) || document.hidden) return;
    var id = st.id, range = st.range;
    api('/series?id=' + encodeURIComponent(id) + '&range=' + encodeURIComponent(range)).then(function (d) {
      if (!st.on || st.id !== id || st.range !== range) return;
      st.serErr = ''; st.serAt = Date.now();
      var k = keyOf(d), same = k === st.serKey && st.serFor === id;
      st.ser = d; st.serKey = k; st.serFor = id;
      if (same) { tickAll(); Array.prototype.forEach.call(ui.one.querySelectorAll('[data-src]'), function (n) { n.dataset.at = String(st.serAt); tick(n); }); ui.headNote.dataset.at = String(st.serAt); tick(ui.headNote); return; }
      drawOne();
      // An index still reading its inputs is looked at again soon.
      clearTimeout(st.soon);
      if (d.state === 'pending') st.soon = setTimeout(function () { if (st.on && st.id === id && !document.hidden) loadSeries(); }, 8000);
    }).catch(function (err) {
      if (!st.on || st.id !== id) return;
      if (st.ser && st.serFor === id && err.status !== 400) return;
      st.ser = null; st.serFor = '';
      st.serErr = err.status === 400 ? 'There is no index by that name. Use “All indexes” to see the list.' : failed(err, 'This index');
      drawOne();
    });
  }

  // ---------- lifecycle ----------
  function stop() { st.timers.forEach(clearInterval); st.timers = []; clearTimeout(st.soon); }
  function start() {
    stop();
    if (!st.on || document.hidden) return;
    if (st.id) {
      drawOne();
      loadSeries();
      if (st.id === 'capex') loadCapex();
      st.timers.push(setInterval(function () { loadSeries(); if (st.id === 'capex') loadCapex(); }, 60000));
    } else {
      // Cards already showing the latest answer are left as they are.
      if (!st.list || st.drawnList !== st.listKey) drawList(); else sourceLine(ui.headNote, st.list, st.listAt);
      if (!st.capex) drawCapex(ui.capexBody, ui.capexCard.note, false);
      loadList(); loadCapex();
      st.timers.push(setInterval(loadList, 60000), setInterval(loadCapex, 300000));
    }
    st.timers.push(setInterval(tickAll, 10000));
  }
  var DEFAULT_RANGE = { 'data-center': '1y', semis: '1y', 'ai-crypto': '1y', compute: '1y', energy: '5y' };
  // "#indexes/compute" is one index; "#indexes" is the list.
  function readHash() {
    var raw = (location.hash || '').slice(1).split('/');
    if (raw[0] !== 'indexes' || raw.length < 2 || !raw[1]) return '';
    var part = raw.slice(1).join('/');
    try { part = decodeURIComponent(part); } catch (e) { /* shown as typed */ }
    part = part.trim().toLowerCase();
    return ID.test(part) ? part : '?';
  }
  function sync(viewName) {
    var on = viewName === 'indexes';
    if (!on) { if (st.on) { st.on = false; stop(); if (/ · Halftone$/.test(document.title) && st.titled) { document.title = 'Halftone'; st.titled = false; } } return; }
    var id = readHash();
    var same = st.on && id === st.id;
    st.on = true;
    if (id !== st.id) {
      st.id = id;
      st.range = st.rangeById[id] || DEFAULT_RANGE[id] || 'max';
      st.ser = null; st.serFor = ''; st.serErr = ''; st.serKey = '';
    }
    ui.listBox.hidden = Boolean(id);
    ui.one.hidden = !id;
    if (id) { drawRanges(); st.titled = true; }
    else {
      ui.title.textContent = 'AI infrastructure indexes';
      if (st.titled) { document.title = 'Halftone'; st.titled = false; }
      // The bars were drawn for the other place; make sure the list's copy exists.
      if (st.capex && ui.capexBody.dataset.key !== st.capexKey) { ui.capexBody.dataset.key = st.capexKey; drawCapex(ui.capexBody, ui.capexCard.note, false); }
    }
    if (same && st.timers.length) return; // the same page announced twice
    start();
    if (id) { var h = ui.title; h.tabIndex = -1; }
  }
  build();
  document.addEventListener('nt:view', function (e) { sync(e.detail); });
  // The router announces every hash change with nt:view; this also catches a link to another
  // index followed while already on the page, whichever listener runs first.
  window.addEventListener('hashchange', function () { if ((location.hash || '').slice(1).split('/')[0] === 'indexes' && st.on) sync('indexes'); });
  document.addEventListener('visibilitychange', function () { if (st.on) start(); });
  if (window.ResizeObserver) new ResizeObserver(function () { if (st.on) redrawBars(); }).observe(view);
})();
