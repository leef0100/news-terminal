// Voices: a reading list of public market writing. Titles, dates and links come from each
// author's own public feed through /api/voices and go to the author's site. Nothing on
// this page is Halftone's view: a line here means "this person published this", no more.
// Everything from the server is drawn as text. Nothing is fetched while the page is hidden
// or the tab is in the background.
(function () {
  'use strict';
  var root = document.getElementById('view-voices');
  if (!root) return;
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

  // ---------- what the server sends is not trusted ----------
  function arr(v) { return Array.isArray(v) ? v : []; }
  function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; }
  function str(v, max) { return typeof v === 'string' ? v.slice(0, max || 200) : ''; }
  function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }
  var HANDLE = /^[A-Za-z0-9_]{1,15}$/;
  function handle(v) { return typeof v === 'string' && HANDLE.test(v) ? v : ''; }
  function slug(v) { return typeof v === 'string' && /^[a-z0-9][a-z0-9-]{0,39}$/.test(v) ? v : ''; }
  // A link is made only to a plain http(s) address, whatever the feed or the server said.
  function safeHttp(u) {
    if (typeof u !== 'string' || u.length > 600 || /[\s<>"'`\\]/.test(u)) return '';
    try {
      var p = new URL(u);
      return (p.protocol === 'https:' || p.protocol === 'http:') && !p.username && !p.password ? p.href : '';
    } catch (e) { return ''; }
  }
  function hostOf(u) { try { return new URL(u).hostname.replace(/^www\./, ''); } catch (e) { return ''; } }
  function outLink(url, text, cls, label) {
    var a = el('a', cls || 'link', text);
    a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
    if (label) a.setAttribute('aria-label', label);
    return a;
  }
  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 3600) return Math.max(1, Math.floor(s / 60)) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 86400 * 60) return Math.floor(s / 86400) + 'd ago';
    return new Date(ts).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
  }
  function when(ts) {
    ts = num(ts);
    if (ts == null) return el('span', 'vcWhen muted', 'undated');
    var t = el('time', 'vcWhen mono', ago(ts));
    t.dateTime = new Date(ts).toISOString();
    t.title = new Date(ts).toLocaleString();
    t.dataset.ts = String(ts);
    return t;
  }

  // ---------- My panel: the same list, format and limit as panel.js ----------
  // localStorage "nt.xpanel" holds a JSON array of handles (strings, no "@"), at most 20.
  var MAX = 20, KEY = 'nt.xpanel';
  function readPanel() {
    try {
      var saved = JSON.parse(localStorage.getItem(KEY) || '[]');
      if (Array.isArray(saved)) return saved.filter(function (h) { return typeof h === 'string' && HANDLE.test(h); }).slice(0, MAX);
    } catch (e) { /* storage unavailable or damaged: empty, as panel.js treats it */ }
    return [];
  }
  function inPanel(list, h) { h = h.toLowerCase(); return list.some(function (x) { return x.toLowerCase() === h; }); }
  // Adds one handle. Returns 'added', 'dup', 'full', 'bad' or 'blocked'.
  function addToPanel(h) {
    if (!HANDLE.test(h)) return 'bad';
    var list = readPanel();
    if (inPanel(list, h)) return 'dup';
    if (list.length >= MAX) return 'full';
    // My panel is loaded on the same page and holds its own copy of the list. Its own form
    // is used when it is there, so that copy, its checks and what it saves all stay in step.
    var form = document.getElementById('xpForm'), input = document.getElementById('xpInput');
    if (form && input) {
      var typed = input.value;
      try {
        input.value = h;
        form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
      } catch (e) { /* fall through to writing the list directly */ }
      input.value = typed;
    }
    // What is saved must be the list as it was plus this one account. If My panel was not
    // there, or held an older copy of the list (changed in another tab), it is put right.
    try {
      var want = list.concat([h]);
      if (JSON.stringify(readPanel()) !== JSON.stringify(want)) localStorage.setItem(KEY, JSON.stringify(want));
    } catch (e) { return 'blocked'; }
    return inPanel(readPanel(), h) ? 'added' : 'blocked';
  }
  var FULL = 'My panel is full (' + MAX + ' of ' + MAX + '). Remove an account there to add another.';
  var BLOCKED = 'This browser is not letting the page save your panel.';
  function addOne(h) {
    var r = addToPanel(h);
    if (r === 'added') return '@' + h + ' added to My panel (' + readPanel().length + ' of ' + MAX + ').';
    if (r === 'dup') return '@' + h + ' is already in your panel.';
    if (r === 'full') return FULL;
    return r === 'blocked' ? BLOCKED : 'That is not a usable X username.';
  }
  function addMany(handles) {
    var added = 0, dup = 0, left = 0, blocked = false;
    handles.forEach(function (h) {
      var r = addToPanel(h);
      if (r === 'added') added += 1; else if (r === 'dup') dup += 1; else if (r === 'full') left += 1; else if (r === 'blocked') blocked = true;
    });
    if (blocked && !added) return BLOCKED;
    var n = readPanel().length;
    var msg = 'Added ' + added + ' of ' + handles.length + ' to My panel (' + n + ' of ' + MAX + ').';
    if (dup) msg += ' ' + dup + (dup === 1 ? ' was' : ' were') + ' already there.';
    if (left) msg += ' The panel is full, so ' + left + (left === 1 ? ' was' : ' were') + ' left out.';
    return msg;
  }

  // ---------- state ----------
  var st = { onPage: false, dir: null, latest: null, err: '', group: '', q: '', more: false, timers: [], seq: 0, sig: {}, msgs: {}, loadedAt: 0 };
  var ui = {};
  var STREAM_FIRST = 14;

  function say(key, text) { st.msgs[key] = text; var n = root.querySelector('[data-msg="' + key + '"]'); if (n) n.textContent = text; }
  function msgLine(key) { var p = el('p', 'vcMsg', st.msgs[key] || ''); p.setAttribute('role', 'status'); p.dataset.msg = key; return p; }
  function refocus(key) { var n = root.querySelector('[data-fk="' + key + '"]'); if (n) n.focus(); }

  // ---------- the fixed parts of the page ----------
  function build() {
    var head = el('div', 'breakHead');
    var left = el('div');
    add(left, el('p', 'kicker vcKick', 'Voices'), el('h1', 'display', 'What market writers are publishing'));
    ui.note = el('p', 'muted vcHeadNote');
    add(head, left, ui.note);

    var pad = el('div', 'pad vcPad');
    var lede = el('p', 'vcLede', 'A reading list of public writing by market writers, researchers and commentators. Titles and links come from each author’s own public feed and open on the author’s site. Opinions belong to the people who wrote them: nothing here is Halftone’s view, a recommendation or advice, and nobody is rated or ranked.');
    ui.demo = el('p', 'vcDemo');
    ui.demo.hidden = true;
    ui.err = el('p', 'emptyBox vcErr');
    ui.err.setAttribute('role', 'alert');
    ui.err.hidden = true;

    // suggested panel
    ui.sug = el('section', 'card vcSug');
    ui.sug.setAttribute('aria-labelledby', 'vcSugTitle');
    ui.sug.hidden = true;

    // filters
    var bar = el('div', 'vcBar');
    ui.chips = el('div', 'chips vcChips');
    ui.chips.setAttribute('role', 'group');
    ui.chips.setAttribute('aria-label', 'Show one group');
    var search = el('div', 'vcSearch');
    var lab = el('label', 'sr', 'Search names and titles');
    lab.htmlFor = 'vcQ';
    ui.q = el('input');
    ui.q.id = 'vcQ'; ui.q.type = 'search'; ui.q.placeholder = 'Search names and titles'; ui.q.maxLength = 60;
    ui.q.autocomplete = 'off'; ui.q.spellcheck = false;
    ui.q.addEventListener('input', function () { st.q = ui.q.value.trim().toLowerCase().slice(0, 60); st.more = false; draw(); });
    add(search, lab, ui.q);
    add(bar, ui.chips, search);

    var split = el('div', 'vcSplit');
    var sec = el('section', 'vcStreamBox');
    sec.setAttribute('aria-labelledby', 'vcLatestTitle');
    var sh = el('div', 'sideHead');
    var h2 = el('h2', null, 'Latest');
    h2.id = 'vcLatestTitle';
    ui.count = el('span', 'muted small');
    add(sh, h2, ui.count);
    ui.stream = el('ol', 'vcStream');
    ui.streamEmpty = el('p', 'emptyBox');
    ui.streamEmpty.hidden = true;
    ui.moreBtn = el('button', 'btn vcMore', 'Show more');
    ui.moreBtn.type = 'button';
    ui.moreBtn.hidden = true;
    ui.moreBtn.addEventListener('click', function () { st.more = !st.more; draw(); ui.moreBtn.focus(); });
    add(sec, sh, ui.stream, ui.streamEmpty, ui.moreBtn);

    var dirBox = el('section', 'vcDirBox');
    dirBox.setAttribute('aria-labelledby', 'vcDirTitle');
    var dh = el('h2', 'vcDirTitle', 'Directory');
    dh.id = 'vcDirTitle';
    ui.dir = el('div', 'vcDir');
    ui.dirEmpty = el('p', 'emptyBox');
    ui.dirEmpty.hidden = true;
    add(dirBox, dh, ui.dir, ui.dirEmpty);
    add(split, sec, dirBox);

    add(pad, lede, ui.demo, ui.err, ui.sug, bar, split);
    add(root, head, pad);
  }

  // ---------- drawing ----------
  function groupsOf() { return arr(obj(st.dir).groups).map(obj).filter(function (g) { return slug(g.id); }); }
  function matches(text) { return !st.q || text.toLowerCase().indexOf(st.q) !== -1; }

  function drawChips() {
    var gs = groupsOf();
    var sig = st.group + '|' + gs.map(function (g) { return g.id + ':' + str(g.name, 60); }).join(',');
    if (sig === st.sig.chips) return;
    st.sig.chips = sig;
    var frag = document.createDocumentFragment();
    [{ id: '', name: 'All' }].concat(gs).forEach(function (g) {
      var b = el('button', 'chip vcChip' + (st.group === g.id ? ' on' : ''), str(g.name, 60));
      b.type = 'button';
      b.dataset.fk = 'chip-' + g.id;
      b.dataset.group = g.id;
      b.setAttribute('aria-pressed', String(st.group === g.id));
      b.addEventListener('click', function () { st.group = g.id; st.more = false; draw(); refocus('chip-' + g.id); });
      frag.appendChild(b);
    });
    ui.chips.replaceChildren(frag);
  }

  function xNode(h, demo) {
    // A demo handle is a placeholder: shown, never linked.
    if (demo) return el('span', 'vcX muted', '@' + h + ' (placeholder)');
    return outLink('https://x.com/' + h, '@' + h + ' on X', 'link vcX', '@' + h + ' on X, opens in a new tab');
  }
  function panelBtn(h, key) {
    var b = el('button', 'btn vcAdd', 'Add to My panel');
    b.type = 'button';
    b.dataset.fk = key;
    b.dataset.handle = h;
    b.addEventListener('click', function () { say(key, addOne(h)); markPanel(); });
    return b;
  }
  // Buttons say whether the account is already in the panel; read again each time, since
  // the list can change on the My panel page.
  function markPanel() {
    var list = readPanel();
    root.querySelectorAll('button.vcAdd[data-handle]').forEach(function (b) {
      var on = inPanel(list, b.dataset.handle);
      b.classList.toggle('on', on);
      b.textContent = on ? 'In My panel' : 'Add to My panel';
      b.setAttribute('aria-label', (on ? 'In My panel: @' : 'Add @') + b.dataset.handle + (on ? '' : ' to My panel'));
    });
  }

  function drawSuggested() {
    var d = obj(st.dir);
    var list = arr(d.suggested).map(obj).filter(function (s) { return handle(s.x); }).slice(0, 8);
    var sig = (d.demo ? 'd' : 'l') + list.map(function (s) { return s.x + ':' + str(s.name, 80); }).join(',');
    if (sig === st.sig.sug) return;
    st.sig.sug = sig;
    ui.sug.hidden = !list.length;
    if (!list.length) { ui.sug.replaceChildren(); return; }
    var top = el('div', 'vcSugTop');
    var words = el('div');
    var h = el('h2', null, 'Suggested panel');
    h.id = 'vcSugTitle';
    add(words, h, el('p', 'muted small', 'A starter set of ' + list.length + (list.length === 1 ? ' account' : ' accounts') + ' for My panel, where each account’s posts appear in its own column. Your list is kept in this browser only; it holds ' + MAX + '.'));
    var acts = el('div', 'vcSugActs');
    var b = el('button', 'btn primary', 'Add these ' + list.length + ' to My panel');
    b.type = 'button';
    b.id = 'vcSugAdd';
    b.addEventListener('click', function () { say('sug', addMany(list.map(function (s) { return s.x; }))); markPanel(); });
    var go = el('a', 'btn', 'Open My panel');
    go.href = '#panel';
    add(acts, b, go);
    add(top, words, acts);
    var ul = el('ul', 'vcSugList');
    list.forEach(function (s) {
      var li = el('li', 'chip');
      add(li, el('b', null, '@' + s.x), el('span', 'muted', str(s.name, 80)));
      ul.appendChild(li);
    });
    ui.sug.replaceChildren(top, ul, msgLine('sug'));
  }

  function titleNode(it, cls) {
    var title = str(it.title, 300);
    var url = safeHttp(it.url);
    return url ? outLink(url, title, 'vcTitle ' + (cls || ''), title + ' (opens the author’s site in a new tab)') : el('span', 'vcTitle ' + (cls || ''), title);
  }

  function drawStream() {
    var d = obj(st.latest);
    var names = {};
    groupsOf().forEach(function (g) { names[g.id] = str(g.name, 60); });
    var all = arr(d.items).map(obj).filter(function (it) {
      if (!str(it.title, 300) || !slug(it.voice)) return false;
      if (st.group && it.group !== st.group) return false;
      return matches(str(it.name, 80) + ' ' + str(it.publication, 80) + ' ' + str(it.title, 300));
    });
    var shown = st.more ? all : all.slice(0, STREAM_FIRST);
    var sig = JSON.stringify([shown.map(function (it) { return [it.voice, it.title, it.url, it.ts, it.excerpt]; }), all.length, st.more, Boolean(st.latest), st.err]);
    if (sig === st.sig.stream) return;
    st.sig.stream = sig;
    var frag = document.createDocumentFragment();
    shown.forEach(function (it) {
      var li = el('li', 'vcItem');
      var meta = el('div', 'vcMeta');
      add(meta, el('span', 'strong', str(it.name, 80)), el('span', 'muted', 'wrote in ' + str(it.publication, 80)), when(it.ts));
      add(li, meta, titleNode(it));
      var ex = str(it.excerpt, 200);
      if (ex) add(li, el('p', 'vcExcerpt muted', ex));
      frag.appendChild(li);
    });
    ui.stream.replaceChildren(frag);
    ui.count.textContent = all.length ? (shown.length < all.length ? shown.length + ' of ' + all.length : all.length + (all.length === 1 ? ' piece' : ' pieces')) : '';
    ui.moreBtn.hidden = all.length <= STREAM_FIRST;
    ui.moreBtn.textContent = st.more ? 'Show fewer' : 'Show all ' + all.length;
    var why = '';
    if (!st.latest) why = st.err ? '' : 'Loading the latest pieces…';
    else if (!all.length) why = st.q ? 'No piece matches “' + st.q + '”.' : 'No dated pieces have been read yet' + (st.group ? ' for ' + (names[st.group] || 'this group') : '') + '. Feeds are checked every few minutes.';
    ui.streamEmpty.hidden = !why;
    ui.streamEmpty.textContent = why;
  }

  var STATE = {
    waiting: 'First check of this feed is pending.',
    error: 'This feed could not be read just now.',
    nofeed: 'No public feed on file. Follow on X or visit the site.'
  };
  function card(v, demo) {
    var h = handle(v.x), id = slug(v.id);
    var c = el('article', 'card vcCard');
    c.dataset.voice = id;
    var hd = el('div', 'vcCardHead');
    add(hd, el('h4', 'vcName', str(v.name, 80)), el('p', 'vcPub', str(v.publication, 80)));
    add(c, hd, el('p', 'vcCovers muted', 'Covers: ' + str(v.covers, 120)));
    var items = arr(v.items).map(obj).filter(function (it) { return str(it.title, 300); }).slice(0, 3);
    if (items.length) {
      var ul = el('ul', 'vcCardItems');
      items.forEach(function (it) {
        var li = el('li');
        add(li, titleNode(it, 'small'), when(it.ts));
        ul.appendChild(li);
      });
      c.appendChild(ul);
    }
    var state = str(v.state, 12);
    var note = STATE[state] && (state !== 'nofeed' || !items.length) ? STATE[state] : (!items.length ? 'Nothing read from this feed yet.' : '');
    if (demo && !items.length) note = '';
    if (note) c.appendChild(el('p', 'vcState small ' + (state === 'error' ? 'bad' : 'muted'), note));
    var foot = el('div', 'vcFoot');
    var site = safeHttp(v.site);
    if (site) foot.appendChild(outLink(site, hostOf(site), 'link vcSite', str(v.publication, 80) + ' site, opens in a new tab'));
    if (h) foot.appendChild(xNode(h, demo));
    if (foot.childNodes.length) c.appendChild(foot);
    if (h) add(c, panelBtn(h, 'v-' + id), msgLine('v-' + id));
    return c;
  }
  function drawDirectory() {
    var d = obj(st.dir), demo = d.demo === true;
    var groups = groupsOf().filter(function (g) { return !st.group || g.id === st.group; }).map(function (g) {
      var voices = arr(g.voices).map(obj).filter(function (v) {
        return slug(v.id) && matches(str(v.name, 80) + ' ' + str(v.publication, 80) + ' ' + str(v.covers, 120) + ' ' + arr(v.items).map(function (it) { return str(obj(it).title, 300); }).join(' '));
      });
      return { id: g.id, name: str(g.name, 60), voices: voices };
    }).filter(function (g) { return g.voices.length; });
    var sig = JSON.stringify([demo, groups.map(function (g) { return [g.id, g.name, g.voices.map(function (v) { return [v.id, v.name, v.publication, v.covers, v.x, v.site, v.state, arr(v.items).slice(0, 3)]; })]; }), Boolean(st.dir), st.q, st.err]);
    if (sig !== st.sig.dir) {
      st.sig.dir = sig;
      var frag = document.createDocumentFragment();
      groups.forEach(function (g) {
        var sec = el('section', 'vcGroup');
        sec.dataset.group = g.id;
        var gh = el('div', 'vcGroupHead');
        var h3 = el('h3', null, g.name);
        var hs = g.voices.map(function (v) { return handle(v.x); }).filter(Boolean);
        add(gh, h3);
        if (hs.length) {
          var b = el('button', 'btn vcAddAll', 'Add all to My panel');
          b.type = 'button';
          b.dataset.fk = 'g-' + g.id;
          b.setAttribute('aria-label', 'Add all ' + hs.length + ' accounts in ' + g.name + ' to My panel');
          b.addEventListener('click', function () { say('g-' + g.id, addMany(hs)); markPanel(); });
          gh.appendChild(b);
        }
        var grid = el('div', 'vcGrid');
        g.voices.forEach(function (v) { grid.appendChild(card(v, demo)); });
        add(sec, gh, msgLine('g-' + g.id), grid);
        frag.appendChild(sec);
      });
      var had = document.activeElement && root.contains(document.activeElement) ? document.activeElement.dataset.fk : '';
      ui.dir.replaceChildren(frag);
      if (had) refocus(had);
    }
    var why = '';
    if (!st.dir) why = st.err ? '' : 'Loading the directory…';
    else if (!groups.length) why = st.q ? 'No writer or title matches “' + st.q + '”.' : 'Nobody is listed here yet.';
    ui.dirEmpty.hidden = !why;
    ui.dirEmpty.textContent = why;
    markPanel();
  }

  function drawHead() {
    var d = obj(st.dir), demo = d.demo === true;
    ui.demo.hidden = !demo;
    ui.demo.textContent = demo ? 'Demo: every writer, publication, handle and title below is invented. None of these people or publications exist, and nothing here was written by anyone.' : '';
    var src = obj(arr(d.sources)[0]);
    var bits = [];
    if (st.dir) {
      if (demo) bits.push('Demo data');
      else if (str(src.name, 60)) bits.push('Source: ' + str(src.name, 60).toLowerCase() + (str(src.note, 160) ? ' · ' + str(src.note, 160) : ''));
      if (st.loadedAt) bits.push('checked ' + new Date(st.loadedAt).toLocaleTimeString([], { hour12: false, hour: '2-digit', minute: '2-digit' }));
    }
    ui.note.textContent = bits.join(' · ');
    ui.err.hidden = !st.err;
    ui.err.textContent = st.err;
  }
  function draw() { drawHead(); drawChips(); drawSuggested(); drawStream(); drawDirectory(); }
  function tick() { root.querySelectorAll('time[data-ts]').forEach(function (t) { var s = ago(Number(t.dataset.ts)); if (t.textContent !== s) t.textContent = s; }); }

  // ---------- loading ----------
  function limit() { return window.AbortSignal && AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined; }
  function api(path) {
    return fetch('/api/voices' + path, { headers: { accept: 'application/json' }, signal: limit() }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (d) {
        d = obj(d);
        if (!r.ok) { var e = new Error(str(d.error, 160) || 'HTTP ' + r.status); e.status = r.status; throw e; }
        return d;
      });
    });
  }
  function load() {
    if (!st.onPage || document.hidden) return;
    var seq = ++st.seq;
    Promise.all([api('/'), api('/latest')]).then(function (res) {
      if (seq !== st.seq) return;
      st.dir = res[0]; st.latest = res[1]; st.err = ''; st.loadedAt = Date.now();
      // Feeds still being read for the first time: look again soon, once.
      var waiting = groupsOf().some(function (g) { return arr(g.voices).some(function (v) { return obj(v).state === 'waiting'; }); });
      if (waiting) st.timers.push(setTimeout(load, 8000));
      if (st.onPage) draw();
    }).catch(function (err) {
      if (seq !== st.seq) return;
      var why = err && err.status ? str(err.message, 160) : 'The server could not be reached.';
      st.err = st.dir ? 'Could not refresh: ' + why + ' Showing what was loaded earlier.' : 'Voices could not be loaded. ' + why;
      if (st.onPage) draw();
    });
  }

  // ---------- lifecycle ----------
  function stop() { st.timers.forEach(function (t) { clearInterval(t); clearTimeout(t); }); st.timers = []; st.seq += 1; }
  function start() {
    stop();
    if (!st.onPage || document.hidden) return;
    draw();
    load();
    st.timers.push(setInterval(load, 300000), setInterval(tick, 60000));
  }
  build();
  document.addEventListener('nt:view', function (e) {
    var on = e.detail === 'voices';
    if (on === st.onPage && (!on || st.timers.length)) return;
    st.onPage = on;
    start();
  });
  document.addEventListener('visibilitychange', function () { if (st.onPage) start(); });
})();
