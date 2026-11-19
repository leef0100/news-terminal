// My panel: a personal feed of X accounts. The viewer's list lives in this browser; the
// server fetches each account once and shares it with everyone who follows it here.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  var MAX = 20;
  // Two ways to read: "deck" is X's own embedded timelines, one column per account, free
  // and shown by X to anyone signed in to X; "feed" is one merged list through the paid API.
  var st = { handles: [], only: '', data: null, timer: null, onPage: false, seq: 0, mode: 'deck', allowed: false, drawn: '', watcher: null };
  try { st.allowed = localStorage.getItem('nt.xembed') === 'yes'; if (localStorage.getItem('nt.xmode') === 'feed') st.mode = 'feed'; } catch (e) { /* ignore */ }
  try {
    var saved = JSON.parse(localStorage.getItem('nt.xpanel') || '[]');
    if (Array.isArray(saved)) st.handles = saved.filter(function (h) { return typeof h === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(h); }).slice(0, MAX);
  } catch (e) { /* storage unavailable or damaged: start empty */ }
  function save() { try { localStorage.setItem('nt.xpanel', JSON.stringify(st.handles)); } catch (e) { /* ignore */ } }

  function ago(ts) {
    var s = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (s < 60) return s + 's';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    return Math.floor(s / 86400) + 'd';
  }
  var STATE = {
    ok: '', demo: 'placeholder', waiting: 'first check pending', notfound: 'no such account', error: 'could not be read',
    full: 'server is following its limit of accounts', off: ''
  };

  function renderList() {
    var list = $('xpList');
    var info = {};
    ((st.data && st.data.accounts) || []).forEach(function (a) { info[String(a.handle).toLowerCase()] = a; });
    var frag = document.createDocumentFragment();
    st.handles.forEach(function (h) {
      var a = info[h.toLowerCase()] || {};
      var li = el('li', 'xpAcct' + (st.only === h ? ' on' : ''));
      var pick = el('button', 'xpPick');
      pick.type = 'button';
      pick.dataset.fk = 'xp-' + h;
      pick.setAttribute('aria-pressed', String(st.only === h));
      pick.appendChild(el('b', null, '@' + (a.state === 'ok' && a.handle ? a.handle : h)));
      var note = a.name && a.name !== '@' + h && a.state === 'ok' ? a.name : STATE[a.state] || '';
      if (note) pick.appendChild(el('span', 'muted small' + (a.state === 'notfound' || a.state === 'error' || a.state === 'full' ? ' bad' : ''), note));
      pick.addEventListener('click', function () { st.only = st.only === h ? '' : h; render(); refocus('xp-' + h); });
      var rm = el('button', 'xpRemove', '×');
      rm.type = 'button';
      rm.setAttribute('aria-label', 'Remove @' + h);
      rm.addEventListener('click', function () {
        st.handles = st.handles.filter(function (x) { return x !== h; });
        if (st.only === h) st.only = '';
        save(); render(); load();
        $('xpInput').focus();
      });
      li.appendChild(pick); li.appendChild(rm);
      frag.appendChild(li);
    });
    list.replaceChildren(frag);
    $('xpCount').textContent = st.handles.length + ' of ' + MAX;
  }
  function refocus(key) { var n = document.querySelector('[data-fk="' + key + '"]'); if (n) n.focus(); }

  function renderPosts() {
    var d = st.data, box = $('xpPosts'), empty = $('xpEmpty'), notice = $('xpNotice');
    var msg = '';
    if (d && !d.enabled) msg = 'The merged feed is switched off on this server: it reads X through X\'s paid service, which needs a key. "Columns from X" above is free and works now.';
    else if (d && d.demo) msg = 'Demo mode: these are placeholders, not real posts. Nothing here was said by the account named.';
    else if (d && d.paused === 'budget') msg = 'Today\'s limit on posts read from X has been reached, so the feed is paused until midnight UTC. Posts already loaded stay below.';
    else if (d && d.paused === 'rate') msg = 'X asked this server to slow down. The feed will resume shortly.';
    notice.hidden = !msg;
    notice.textContent = msg;

    var posts = ((d && d.posts) || []).filter(function (p) { return !st.only || String(p.handle).toLowerCase() === st.only.toLowerCase(); });
    var frag = document.createDocumentFragment();
    posts.forEach(function (p) {
      var card = el('article', 'card xpPost' + (p.placeholder ? ' placeholder' : ''));
      var meta = el('div', 'meta');
      meta.appendChild(el('span', 'strong', p.name || '@' + p.handle));
      meta.appendChild(el('span', 'muted', '@' + p.handle));
      var time = el('time', 'mono', ago(p.ts));
      time.dateTime = new Date(p.ts).toISOString();
      time.title = new Date(p.ts).toLocaleString();
      meta.appendChild(time);
      card.appendChild(meta);
      card.appendChild(el('p', 'xpText', p.text));
      if (!p.placeholder && /^https:\/\/x\.com\//.test(p.url || '')) {
        var a = el('a', 'link', 'Open on X');
        a.href = p.url; a.target = '_blank'; a.rel = 'noopener noreferrer';
        card.appendChild(a);
      }
      frag.appendChild(card);
    });
    box.replaceChildren(frag);
    var why = '';
    if (!st.handles.length) why = 'Add up to ' + MAX + ' X usernames on the right to build your own feed: founders, traders, reporters, anyone whose posts you want in one place.';
    else if (!d) why = 'Loading your panel…';
    else if (d.enabled && !posts.length) why = st.only ? 'No posts loaded from @' + st.only + ' yet.' : 'No posts loaded yet. New accounts are checked within about a minute.';
    empty.hidden = !why;
    empty.textContent = why;
    $('xpAt').textContent = d && d.enabled && !d.demo ? 'Checked ' + new Date().toLocaleTimeString([], { hour12: false }) + ' · posts arrive within about a minute of being sent' : '';
  }
  // ---------- deck: X's own embeds ----------
  var scriptAsked = false;
  function loadX(done) {
    if (window.twttr && window.twttr.widgets) return done();
    if (!scriptAsked) {
      scriptAsked = true;
      var sc = document.createElement('script');
      sc.src = 'https://platform.x.com/widgets.js';
      sc.async = true;
      sc.onerror = function () { scriptAsked = false; $('xpDeckNote').hidden = false; $('xpDeckNote').textContent = 'X could not be reached from this browser. A content blocker may be stopping it.'; };
      document.head.appendChild(sc);
    }
    var tries = 0, wait = setInterval(function () {
      tries += 1;
      if (window.twttr && window.twttr.widgets) { clearInterval(wait); done(); }
      else if (tries > 60) clearInterval(wait);
    }, 250);
  }
  function fillColumn(body) {
    if (body.dataset.filled) return;
    body.dataset.filled = '1';
    loadX(function () {
      window.twttr.widgets.createTimeline({ sourceType: 'profile', screenName: body.dataset.handle }, body, { height: 640, chrome: 'noheader nofooter', dnt: true, theme: 'light' });
    });
  }
  function renderDeck(force) {
    var shown = st.handles.filter(function (h) { return !st.only || h === st.only; });
    $('xpGate').hidden = st.allowed;
    $('xpRefresh').hidden = !st.allowed || !shown.length;
    $('xpDeckNote').hidden = !st.allowed || !shown.length;
    var key = st.allowed + '|' + shown.join(',');
    if (!force && key === st.drawn) return;
    st.drawn = key;
    if (st.watcher) st.watcher.disconnect();
    var deck = $('xpDeck'), frag = document.createDocumentFragment();
    if (st.allowed) shown.forEach(function (h) {
      var col = el('section', 'xpCol');
      var head = el('div', 'xpColHead');
      head.appendChild(el('b', null, '@' + h));
      var a = el('a', 'link', 'Open on X');
      a.href = 'https://x.com/' + encodeURIComponent(h); a.target = '_blank'; a.rel = 'noopener noreferrer';
      head.appendChild(a);
      col.appendChild(head);
      var body = el('div', 'xpColBody');
      body.dataset.handle = h;
      col.appendChild(body);
      frag.appendChild(col);
    });
    deck.replaceChildren(frag);
    // A column is only asked for when it comes into view: twenty at once would be slow.
    if (st.allowed && 'IntersectionObserver' in window) {
      st.watcher = new IntersectionObserver(function (entries) { entries.forEach(function (en) { if (en.isIntersecting) fillColumn(en.target); }); }, { root: null, rootMargin: '200px' });
      deck.querySelectorAll('.xpColBody').forEach(function (b) { st.watcher.observe(b); });
    } else deck.querySelectorAll('.xpColBody').forEach(fillColumn);
  }
  function renderMode() {
    var box = $('xpMode');
    box.textContent = '';
    [['deck', 'Columns from X (free)'], ['feed', 'One merged feed']].forEach(function (m) {
      var b = el('button', st.mode === m[0] ? 'on' : '', m[1]);
      b.type = 'button';
      b.dataset.fk = 'xm-' + m[0];
      b.setAttribute('aria-pressed', String(st.mode === m[0]));
      b.addEventListener('click', function () {
        st.mode = m[0];
        try { localStorage.setItem('nt.xmode', m[0]); } catch (e) { /* ignore */ }
        start();
        refocus('xm-' + m[0]);
      });
      box.appendChild(b);
    });
  }
  $('xpAllow').addEventListener('click', function () {
    st.allowed = true;
    try { localStorage.setItem('nt.xembed', 'yes'); } catch (e) { /* ignore */ }
    renderDeck();
    $('xpRefresh').focus();
  });
  $('xpRefresh').addEventListener('click', function () { renderDeck(true); });

  function render() {
    renderList();
    renderMode();
    var deck = st.mode === 'deck';
    $('xpDeckBox').hidden = !deck;
    $('xpPosts').hidden = deck;
    if (deck) {
      $('xpNotice').hidden = true;
      $('xpEmpty').hidden = st.handles.length > 0;
      $('xpEmpty').textContent = 'Add up to ' + MAX + ' X usernames on the right to build your own deck: founders, traders, reporters, anyone whose posts you want side by side.';
      $('xpAt').textContent = '';
      $('xpDeckBox').hidden = !st.handles.length;
      renderDeck();
    } else renderPosts();
  }

  function load() {
    if (st.mode !== 'feed') return;
    if (!st.handles.length) { st.data = null; render(); return; }
    var seq = ++st.seq;
    // Sorted, so two people with the same list share one cached answer.
    var q = st.handles.map(function (h) { return h.toLowerCase(); }).sort().join(',');
    fetch('/api/x?handles=' + encodeURIComponent(q), { headers: { accept: 'application/json' } })
      .then(function (r) { return r.json().then(function (d) { if (!r.ok) throw new Error(d.error || 'HTTP ' + r.status); return d; }); })
      .then(function (d) { if (seq !== st.seq) return; st.data = d; $('xpErr').textContent = ''; if (st.onPage) render(); })
      .catch(function (err) { if (seq === st.seq) $('xpErr').textContent = 'Could not load the panel: ' + err.message + '.'; });
  }

  $('xpForm').addEventListener('submit', function (e) {
    e.preventDefault();
    var input = $('xpInput'), err = $('xpErr');
    // Accepts "@name", "name" or a pasted profile link.
    var raw = input.value.trim().replace(/^https?:\/\/(www\.)?(x|twitter)\.com\//i, '').replace(/^@/, '').split(/[/?#]/)[0];
    if (!/^[A-Za-z0-9_]{1,15}$/.test(raw)) { err.textContent = 'A username is up to 15 letters, numbers or underscores.'; return; }
    if (st.handles.some(function (h) { return h.toLowerCase() === raw.toLowerCase(); })) { err.textContent = '@' + raw + ' is already in your panel.'; return; }
    if (st.handles.length >= MAX) { err.textContent = 'A panel holds ' + MAX + ' accounts. Remove one to add another.'; return; }
    err.textContent = '';
    st.handles.push(raw);
    input.value = '';
    save(); render(); load();
  });

  function stop() { clearInterval(st.timer); st.timer = null; }
  function start() {
    stop();
    if (!st.onPage || document.hidden) return;
    render();
    // Only the merged feed asks this server for anything; the columns come from X itself.
    if (st.mode !== 'feed') return;
    load();
    st.timer = setInterval(load, 10000);
  }
  document.addEventListener('nt:view', function (e) { st.onPage = e.detail === 'panel'; start(); });
  document.addEventListener('visibilitychange', function () { if (st.onPage) start(); });
})();
