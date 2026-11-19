// Paper trading: go long or short on the Halftone indexes with pretend money.
// Nothing here is real. No funds move, no orders reach any exchange, and the account lives
// only in this browser. It exists so the idea of trading these indexes can be tried.
(function () {
  'use strict';
  var START = 100000, FEE = 0.0005, MAX_LEV = 10, KEY = 'nt.paper';
  // A position is closed out once it has lost this share of the money put up for it.
  var WIPE = 0.9;

  // ---------- the account, as plain functions (tested without a browser) ----------
  function fresh(now) { return { cash: START, positions: [], history: [], startedAt: now, v: 1 }; }
  function valid(a) {
    return a && typeof a === 'object' && isFinite(a.cash) && Array.isArray(a.positions) && Array.isArray(a.history) &&
      a.positions.every(function (p) { return p && typeof p.market === 'string' && (p.side === 'long' || p.side === 'short') && p.qty > 0 && p.entry > 0 && p.margin > 0 && p.leverage >= 1; });
  }
  function pnlOf(p, price) { return (price - p.entry) * p.qty * (p.side === 'long' ? 1 : -1); }
  function liqPrice(p) { var move = WIPE / p.leverage; return p.side === 'long' ? p.entry * (1 - move) : p.entry * (1 + move); }
  // Opens a position, or adds to one on the same side. `margin` is the money put up;
  // the position is margin times leverage. Returns { account } or { error }.
  function open(acct, o) {
    var margin = Number(o.margin), lev = Number(o.leverage), price = Number(o.price);
    if (!(price > 0)) return { error: 'This index has no value to trade against right now.' };
    if (!(margin > 0)) return { error: 'Enter an amount above zero.' };
    if (!(lev >= 1) || lev > MAX_LEV) return { error: 'Leverage is between 1x and ' + MAX_LEV + 'x.' };
    if (o.side !== 'long' && o.side !== 'short') return { error: 'Choose long or short.' };
    var notional = margin * lev, fee = notional * FEE;
    if (margin + fee > acct.cash + 1e-9) return { error: 'Not enough paper cash: this needs $' + (margin + fee).toFixed(2) + '.' };
    var a = JSON.parse(JSON.stringify(acct)), qty = notional / price;
    var held = a.positions.filter(function (p) { return p.market === o.market; })[0];
    if (held && held.side !== o.side) return { error: 'You already hold the opposite side of this index. Close it first.' };
    a.cash -= margin + fee;
    if (held) {
      var total = held.qty + qty;
      held.entry = (held.entry * held.qty + price * qty) / total;
      held.qty = total;
      held.margin += margin;
      held.leverage = held.entry * held.qty / held.margin;
    } else a.positions.push({ market: o.market, name: o.name || o.market, side: o.side, qty: qty, entry: price, margin: margin, leverage: lev, openedAt: o.now });
    a.history.unshift({ at: o.now, market: o.market, name: o.name || o.market, action: 'Opened ' + o.side, price: price, notional: notional, fee: fee, pnl: null });
    a.history = a.history.slice(0, 200);
    return { account: a };
  }
  // Closes a whole position at `price`. `why` is 'Closed' or 'Closed out'.
  function close(acct, market, price, now, why) {
    var a = JSON.parse(JSON.stringify(acct));
    var p = a.positions.filter(function (x) { return x.market === market; })[0];
    if (!p) return { error: 'No position in that index.' };
    if (!(price > 0)) return { error: 'This index has no value to close against right now.' };
    var pnl = pnlOf(p, price), fee = p.qty * price * FEE;
    // A paper account cannot lose more on a position than was put up for it.
    var back = Math.max(0, p.margin + pnl - fee);
    a.cash += back;
    a.positions = a.positions.filter(function (x) { return x.market !== market; });
    a.history.unshift({ at: now, market: market, name: p.name, action: (why || 'Closed') + ' ' + p.side, price: price, notional: p.qty * price, fee: fee, pnl: back - p.margin });
    a.history = a.history.slice(0, 200);
    return { account: a };
  }
  // Applies the latest values: any position past its close-out price is closed there.
  function mark(acct, prices, now) {
    var a = acct, closed = [];
    acct.positions.forEach(function (p) {
      var px = prices[p.market];
      if (!(px > 0)) return;
      var lp = liqPrice(p);
      if ((p.side === 'long' && px <= lp) || (p.side === 'short' && px >= lp)) { a = close(a, p.market, lp, now, 'Closed out').account; closed.push(p.name); }
    });
    return { account: a, closed: closed };
  }
  function summary(acct, prices) {
    var open = 0, margin = 0;
    acct.positions.forEach(function (p) { var px = prices[p.market]; margin += p.margin; if (px > 0) open += pnlOf(p, px); });
    var equity = acct.cash + margin + open;
    return { cash: acct.cash, margin: margin, openPnl: open, equity: equity, returnPct: (equity / START - 1) * 100 };
  }
  var Engine = { START: START, FEE: FEE, MAX_LEV: MAX_LEV, fresh: fresh, valid: valid, open: open, close: close, mark: mark, summary: summary, pnlOf: pnlOf, liqPrice: liqPrice };
  if (typeof window === 'undefined' || !window.document) { if (typeof window !== 'undefined') window.Paper = { engine: Engine }; return; }

  // ---------- the page ----------
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; }
  function usd(n) { return (n < 0 ? '-$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function num(n) { return n.toLocaleString('en-US', { maximumFractionDigits: n >= 100 ? 2 : 4 }); }
  function signed(n) { var t = n.toFixed(2); if (t === '-0.00') t = '0.00'; return (n > 0 && t !== '0.00' ? '+' : '') + t + '%'; }
  var st = { acct: null, markets: [], prices: {}, onPage: false, timer: null, tickets: [], msg: '' };
  function load() {
    try { var a = JSON.parse(localStorage.getItem(KEY) || 'null'); if (valid(a)) return a; } catch (e) { /* damaged or unavailable: start over */ }
    return fresh(Date.now());
  }
  function save() { try { localStorage.setItem(KEY, JSON.stringify(st.acct)); } catch (e) { /* ignore */ } }
  st.acct = load();

  function refresh() {
    return fetch('/api/indexes/', { headers: { accept: 'application/json' }, signal: window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (d) {
        st.demo = Boolean(d.demo);
        st.markets = (d.indexes || []).filter(function (x) { return x && typeof x.id === 'string'; });
        st.prices = Object.create(null);
        st.markets.forEach(function (m) { if (m.state === 'ok' && m.value > 0) st.prices[m.id] = m.value; });
        var res = mark(st.acct, st.prices, Date.now());
        if (res.closed.length) { st.acct = res.account; save(); st.msg = 'Closed out after losing ' + (WIPE * 100) + '% of the money put up: ' + res.closed.join(', ') + '.'; }
        st.failed = false;
      }).catch(function () { st.failed = true; })
      .then(function () { if (st.onPage) render(); st.tickets.forEach(function (t) { t.update(); }); });
  }

  // A small order form. Used on the Paper page and can be placed on any index page:
  // window.Paper.ticket(container, { id, name }).
  function ticket(box, market) {
    var side = 'long';
    box.textContent = '';
    box.classList.add('ppTicket');
    box.appendChild(el('p', 'ppTag', 'Paper trading: pretend money, no real orders'));
    var sides = el('div', 'seg ppSides'); sides.setAttribute('role', 'group'); sides.setAttribute('aria-label', 'Direction');
    var bLong = el('button', null, '▲ Long'), bShort = el('button', null, '▼ Short');
    [bLong, bShort].forEach(function (b) { b.type = 'button'; sides.appendChild(b); });
    box.appendChild(sides);
    var form = el('div', 'ppForm');
    var field = function (label, value, attrs) {
      var l = el('label', null, label), i = el('input');
      i.type = 'number'; i.value = value; i.inputMode = 'decimal';
      Object.keys(attrs).forEach(function (k) { i.setAttribute(k, attrs[k]); });
      l.appendChild(i); form.appendChild(l); return i;
    };
    var amt = field('Amount to put up ($)', '1000', { min: '1', step: '100' });
    var lev = field('Leverage (1 to ' + MAX_LEV + 'x)', '2', { min: '1', max: String(MAX_LEV), step: '1' });
    box.appendChild(form);
    var info = el('p', 'muted small'); box.appendChild(info);
    var go = el('button', 'btn primary ppGo'); go.type = 'button'; box.appendChild(go);
    var note = el('p', 'chatError'); note.setAttribute('role', 'status'); box.appendChild(note);
    function update() {
      var px = st.prices[market.id];
      bLong.className = side === 'long' ? 'on' : ''; bShort.className = side === 'short' ? 'on' : '';
      bLong.setAttribute('aria-pressed', String(side === 'long')); bShort.setAttribute('aria-pressed', String(side === 'short'));
      go.textContent = (side === 'long' ? 'Go long ' : 'Go short ') + market.name;
      go.disabled = !(px > 0);
      var m = Number(amt.value), l = Number(lev.value);
      if (!(px > 0)) info.textContent = 'This index is not connected, so it cannot be traded yet.';
      else if (m > 0 && l >= 1 && l <= MAX_LEV) {
        var liq = liqPrice({ side: side, entry: px, leverage: l });
        info.textContent = 'Index at ' + num(px) + '. Position size ' + usd(m * l) + '. ' + (side === 'long' ? 'You gain if the index rises.' : 'You gain if the index falls.') +
          ' Closed out at ' + num(liq) + ' (' + signed((liq / px - 1) * 100) + '). Paper cash available: ' + usd(st.acct.cash) + '.';
      } else info.textContent = 'Paper cash available: ' + usd(st.acct.cash) + '.';
    }
    bLong.addEventListener('click', function () { side = 'long'; update(); });
    bShort.addEventListener('click', function () { side = 'short'; update(); });
    amt.addEventListener('input', update); lev.addEventListener('input', update);
    go.addEventListener('click', function () {
      var res = open(st.acct, { market: market.id, name: market.name, side: side, margin: amt.value, leverage: lev.value, price: st.prices[market.id], now: Date.now() });
      if (res.error) { note.textContent = res.error; return; }
      st.acct = res.account; save();
      note.textContent = 'Opened. See it under Paper.';
      update(); if (st.onPage) render();
    });
    var t = { update: update, box: box };
    st.tickets = st.tickets.filter(function (x) { return document.body.contains(x.box) && x.box !== box; });
    st.tickets.push(t);
    update();
    if (!st.markets.length) refresh();
    return t;
  }

  function render() {
    var root = $('view-paper');
    if (!root.dataset.built) {
      root.dataset.built = '1';
      var head = el('div', 'breakHead'), hl = el('div');
      hl.appendChild(el('p', 'kicker', 'Paper trading'));
      hl.appendChild(el('h1', 'display', 'Trade the indexes with pretend money'));
      head.appendChild(hl);
      head.appendChild(el('p', 'muted', 'A preview of a compute exchange: long or short on GPU, compute, inference, energy and data-center indexes. Nothing here is real. No money moves and no order reaches any exchange.'));
      root.appendChild(head);
      var pad = el('div', 'pad');
      ['ppMsg:emptyBox notice', 'ppSum:mStats flush', 'ppMarkets:card', 'ppPos:card', 'ppHist:card', 'ppFoot:card'].forEach(function (x) {
        var p = x.split(':'), n = el(p[0] === 'ppMsg' ? 'p' : 'section', p[1]); n.id = p[0]; pad.appendChild(n);
      });
      root.appendChild(pad);
    }
    var s = summary(st.acct, st.prices);
    $('ppMsg').hidden = !(st.msg || st.failed);
    $('ppMsg').textContent = st.msg || (st.failed ? 'Index values could not be loaded. Positions keep their last known value; trying again shortly.' : '');
    var tiles = document.createDocumentFragment();
    [['Account value', usd(s.equity), signed(s.returnPct) + ' since you started with ' + usd(START)], ['Paper cash', usd(s.cash), 'Free to use'], ['In positions', usd(s.margin), st.acct.positions.length + (st.acct.positions.length === 1 ? ' position' : ' positions')], ['Open gain or loss', usd(s.openPnl), s.openPnl >= 0 ? '▲ ahead' : '▼ behind']].forEach(function (t) {
      var d = el('div', 'stTile'); d.appendChild(el('span', 'statLabel', t[0])); d.appendChild(el('b', 'statValue', t[1])); d.appendChild(el('span', 'muted small', t[2])); tiles.appendChild(d);
    });
    $('ppSum').replaceChildren(tiles);

    // Markets: built once per list of indexes, so typing in a ticket is never interrupted.
    var sig = st.markets.map(function (m) { return m.id + ':' + m.state; }).join('|');
    var mk = $('ppMarkets');
    if (mk.dataset.sig !== sig) {
      mk.dataset.sig = sig;
      mk.textContent = '';
      var h = el('div', 'sideHead padHead'); h.appendChild(el('h2', null, 'Indexes you can trade')); h.appendChild(el('span', 'muted small', 'Halftone indexes, not official benchmarks' + (st.demo ? '. Demo: invented figures' : '')));
      mk.appendChild(h);
      if (!st.markets.length) mk.appendChild(el('p', 'muted', st.failed ? 'The indexes could not be loaded.' : 'Loading the indexes…'));
      var grid = el('div', 'ppGrid');
      st.markets.forEach(function (m) {
        var c = el('div', 'ppMarket');
        var top = el('div', 'ppTop'); var a = el('a', 'link strong', m.name); a.href = '#indexes/' + encodeURIComponent(m.id); top.appendChild(a);
        var v = el('span', 'mono ppVal'); v.dataset.market = m.id; top.appendChild(v);
        c.appendChild(top);
        if (m.meaning) c.appendChild(el('p', 'muted small', m.meaning));
        var tb = el('div'); c.appendChild(tb); ticket(tb, { id: m.id, name: m.name });
        grid.appendChild(c);
      });
      mk.appendChild(grid);
    }
    mk.querySelectorAll('.ppVal').forEach(function (v) { var px = st.prices[v.dataset.market]; v.textContent = px > 0 ? num(px) : 'not connected'; });

    var pos = $('ppPos'); pos.textContent = '';
    var ph = el('div', 'sideHead padHead'); ph.appendChild(el('h2', null, 'Your positions')); pos.appendChild(ph);
    if (!st.acct.positions.length) pos.appendChild(el('p', 'muted', 'No positions yet. Pick an index above and go long if you think it will rise, short if you think it will fall.'));
    else {
      var wrap = el('div', 'tableWrap'), table = el('table', 'screener');
      var hr = el('tr'); ['Index', 'Side', 'Size', 'Entry', 'Now', 'Closed out at', 'Gain or loss', ''].forEach(function (t) { var th = el('th', null, t); th.scope = 'col'; hr.appendChild(th); }); table.appendChild(hr);
      st.acct.positions.forEach(function (p) {
        var px = st.prices[p.market], pnl = px > 0 ? pnlOf(p, px) : null, tr = el('tr');
        var n = el('td'); n.appendChild(el('b', null, p.name)); tr.appendChild(n);
        tr.appendChild(el('td', null, (p.side === 'long' ? '▲ Long ' : '▼ Short ') + p.leverage.toFixed(1) + 'x'));
        tr.appendChild(el('td', 'mono', usd(p.qty * p.entry)));
        tr.appendChild(el('td', 'mono', num(p.entry)));
        tr.appendChild(el('td', 'mono', px > 0 ? num(px) : 'n/a'));
        tr.appendChild(el('td', 'mono', num(liqPrice(p))));
        tr.appendChild(el('td', 'mono ' + (pnl > 0 ? 'up' : pnl < 0 ? 'down' : ''), pnl == null ? 'n/a' : (pnl >= 0 ? '▲ ' : '▼ ') + usd(pnl) + ' (' + signed(pnl / p.margin * 100) + ')'));
        var act = el('td'), b = el('button', 'btn', 'Close'); b.type = 'button'; b.disabled = !(px > 0);
        b.setAttribute('aria-label', 'Close ' + p.name);
        b.addEventListener('click', function () { var r = close(st.acct, p.market, st.prices[p.market], Date.now()); if (!r.error) { st.acct = r.account; save(); st.msg = ''; render(); st.tickets.forEach(function (t) { t.update(); }); } });
        act.appendChild(b); tr.appendChild(act);
        table.appendChild(tr);
      });
      wrap.appendChild(table); pos.appendChild(wrap);
    }
    var hist = $('ppHist'); hist.textContent = '';
    var hh = el('div', 'sideHead padHead'); hh.appendChild(el('h2', null, 'History')); hist.appendChild(hh);
    if (!st.acct.history.length) hist.appendChild(el('p', 'muted', 'Nothing yet.'));
    else {
      var w2 = el('div', 'tableWrap'), t2 = el('table', 'screener');
      var h2 = el('tr'); ['When', 'Index', 'What', 'At', 'Size', 'Result'].forEach(function (t) { var th = el('th', null, t); th.scope = 'col'; h2.appendChild(th); }); t2.appendChild(h2);
      st.acct.history.slice(0, 50).forEach(function (x) {
        var tr = el('tr');
        tr.appendChild(el('td', 'mono', new Date(x.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })));
        tr.appendChild(el('td', null, x.name)); tr.appendChild(el('td', null, x.action));
        tr.appendChild(el('td', 'mono', num(x.price))); tr.appendChild(el('td', 'mono', usd(x.notional)));
        tr.appendChild(el('td', 'mono ' + (x.pnl > 0 ? 'up' : x.pnl < 0 ? 'down' : ''), x.pnl == null ? '' : (x.pnl >= 0 ? '▲ ' : '▼ ') + usd(x.pnl)));
        t2.appendChild(tr);
      });
      w2.appendChild(t2); hist.appendChild(w2);
    }
    var foot = $('ppFoot');
    if (!foot.dataset.built) {
      foot.dataset.built = '1';
      foot.appendChild(el('h2', null, 'How paper trading works here'));
      foot.appendChild(el('p', 'muted small', 'You start with ' + usd(START) + ' of pretend money, kept in this browser only. A position is the amount you put up times the leverage you choose; a fee of ' + (FEE * 100) + '% of the position is charged when it opens and closes. A position is closed out when it has lost ' + (WIPE * 100) + '% of the money put up. Values are checked against the latest index reading while this site is open, so a move that happens and reverses while it is closed is not seen. Some indexes update daily or less often. Real markets have costs and risks this does not model: funding, slippage, gaps, and the chance of losing real money. This is a way to try an idea, not advice and not a forecast of results.'));
      var reset = el('button', 'btn', 'Start over with ' + usd(START)); reset.type = 'button';
      reset.addEventListener('click', function () {
        if (reset.dataset.sure) { st.acct = fresh(Date.now()); save(); st.msg = 'Paper account reset.'; delete reset.dataset.sure; reset.textContent = 'Start over with ' + usd(START); render(); st.tickets.forEach(function (t) { t.update(); }); }
        else { reset.dataset.sure = '1'; reset.textContent = 'Press again to erase the paper account'; }
      });
      foot.appendChild(reset);
    }
  }
  function stop() { clearInterval(st.timer); st.timer = null; }
  function start() {
    stop();
    if (!st.onPage || document.hidden) return;
    render(); refresh();
    st.timer = setInterval(refresh, 30000);
  }
  document.addEventListener('nt:view', function (e) { st.onPage = e.detail === 'paper'; start(); });
  document.addEventListener('visibilitychange', start);
  window.Paper = { engine: Engine, ticket: ticket, refresh: refresh };
})();
