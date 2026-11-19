// Personal X panels: each viewer picks up to twenty accounts and sees their posts together.
//
// Reading X costs money (there is no free read access), so this is built to spend as
// little as possible:
//   - every account is fetched once and shared by everyone who follows it here
//   - only posts newer than the last one seen are asked for
//   - an account nobody has asked about for ten minutes is no longer checked
//   - a daily cap on posts read stops the bill running away
// Without a key (X_BEARER_TOKEN) the panel says so; it never invents posts.
//
// This polls, so a post appears within the checking interval, not the instant it is sent.

const API = 'https://api.x.com/2';
export const validHandle = (h) => typeof h === 'string' && /^[A-Za-z0-9_]{1,15}$/.test(h);

export function createXPanel({
  token = '', demo = false, fetchImpl = fetch, now = Date.now, log = console,
  maxAccounts = 300, perTick = 5, tickMs = 5000, minGapMs = 20000, idleMs = 600000, dailyPosts = 2000, timeoutMs = 8000
} = {}) {
  const enabled = Boolean(token) || demo;
  const accounts = new Map(); // handle (lower case) -> record
  let timer = null;
  let pausedUntil = 0;
  let lastError = null;
  let day = '';
  let readToday = 0;

  const today = () => new Date(now()).toISOString().slice(0, 10);
  const budgetLeft = () => { if (day !== today()) { day = today(); readToday = 0; } return dailyPosts - readToday; };

  async function call(path) {
    const res = await fetchImpl(API + path, { headers: { authorization: 'Bearer ' + token }, signal: AbortSignal.timeout(timeoutMs) });
    if (res.status === 429) {
      // Told to slow down: wait until the time X gives, or a minute.
      const reset = Number(res.headers?.get?.('x-rate-limit-reset')) * 1000;
      pausedUntil = Number.isFinite(reset) && reset > now() ? Math.min(reset, now() + 900000) : now() + 60000;
      throw new Error('X asked us to slow down');
    }
    if (!res.ok) throw new Error('X HTTP ' + res.status);
    return res.json();
  }

  // Turns names into account ids, many at a time. Names that do not exist are marked so.
  async function resolve(list) {
    const data = await call('/users/by?usernames=' + list.map((a) => a.handle).join(',') + '&user.fields=name,username');
    const found = new Map((data?.data || []).map((u) => [String(u.username).toLowerCase(), u]));
    for (const a of list) {
      const u = found.get(a.key);
      if (u) { a.id = String(u.id); a.name = String(u.name || u.username); a.handle = String(u.username); a.state = 'waiting'; }
      else a.state = 'notfound';
    }
  }

  async function refresh(a) {
    a.lastPoll = now();
    const q = `/users/${a.id}/tweets?max_results=5&exclude=retweets&tweet.fields=created_at` + (a.sinceId ? '&since_id=' + a.sinceId : '');
    const data = await call(q);
    const fresh = (data?.data || []).map((t) => ({
      id: String(t.id), handle: a.handle, name: a.name, text: String(t.text || ''),
      ts: Date.parse(t.created_at) || now(), url: `https://x.com/${a.handle}/status/${t.id}`
    }));
    readToday += fresh.length;
    if (fresh.length) {
      const have = new Set(a.posts.map((p) => p.id));
      a.posts = [...fresh.filter((p) => !have.has(p.id)), ...a.posts].sort((x, y) => y.ts - x.ts).slice(0, 20);
      // Ids are numbers too long for ordinary arithmetic, so they are compared as such.
      a.sinceId = fresh.map((p) => p.id).reduce((m, id) => (BigInt(id) > BigInt(m) ? id : m), a.sinceId || '0');
    }
    a.state = 'ok';
    a.lastOk = now();
  }

  // One round at a time: a second call while one is under way waits for the same round.
  let round = null;
  function tick() {
    if (!round) round = runRound().finally(() => { round = null; });
    return round;
  }
  async function runRound() {
    if (demo || !token || now() < pausedUntil) return;
    const t = now();
    const wanted = [...accounts.values()].filter((a) => t - a.lastWanted < idleMs);
    try {
      const unknown = wanted.filter((a) => a.state === 'new').slice(0, 100);
      if (unknown.length) await resolve(unknown);
      if (budgetLeft() <= 0) return;
      const due = wanted.filter((a) => a.id && t - (a.lastPoll || 0) >= minGapMs).sort((x, y) => (x.lastPoll || 0) - (y.lastPoll || 0)).slice(0, perTick);
      for (const a of due) {
        try { await refresh(a); } catch (err) { a.state = a.posts.length ? 'ok' : 'error'; throw err; }
      }
      lastError = null;
    } catch (err) {
      lastError = String(err.message || err);
      log.warn('[x] ' + lastError);
    }
  }

  function ensureRunning() {
    if (timer || demo || !token) return;
    timer = setInterval(() => { tick(); }, tickMs);
    timer.unref?.();
    tick();
  }

  // What one viewer's panel shows right now. Asking is also what keeps an account checked.
  function panel(handles) {
    const t = now();
    const keys = [...new Set(handles.filter(validHandle).map((h) => h.toLowerCase()))].slice(0, 20);
    if (!enabled) return { enabled: false, demo: false, reason: 'No X API key is set on this server.', accounts: keys.map((k) => ({ handle: k, state: 'off' })), posts: [] };
    if (demo) {
      // Placeholders, plainly labelled. Nothing here is presented as something a person said.
      return {
        enabled: true, demo: true, accounts: keys.map((k) => ({ handle: k, name: '@' + k, state: 'demo' })),
        posts: keys.map((k, i) => ({ id: 'demo-' + k, handle: k, name: '@' + k, placeholder: true, ts: t - (i + 1) * 60000, url: 'https://x.com/' + k, text: 'Placeholder. Posts from @' + k + ' appear here once this server has an X API key.' }))
      };
    }
    const out = [];
    const list = keys.map((k) => {
      let a = accounts.get(k);
      if (!a) {
        if (accounts.size >= maxAccounts) {
          // Make room by forgetting the account nobody has asked about for longest, if it is idle.
          const oldest = [...accounts.values()].sort((x, y) => x.lastWanted - y.lastWanted)[0];
          if (oldest && t - oldest.lastWanted >= idleMs) accounts.delete(oldest.key);
        }
        if (accounts.size >= maxAccounts) return { handle: k, state: 'full' };
        a = { key: k, handle: k, name: '@' + k, id: null, state: 'new', posts: [], sinceId: '', lastWanted: t, lastPoll: 0, lastOk: null };
        accounts.set(k, a);
      }
      a.lastWanted = t;
      out.push(...a.posts);
      return { handle: a.handle, name: a.name, state: a.state === 'new' ? 'waiting' : a.state, lastChecked: a.lastPoll || null };
    });
    ensureRunning();
    return {
      enabled: true, demo: false, accounts: list, posts: out.sort((x, y) => y.ts - x.ts).slice(0, 100),
      paused: budgetLeft() <= 0 ? 'budget' : now() < pausedUntil ? 'rate' : null, error: lastError
    };
  }

  return {
    enabled, panel, tick,
    health: () => ({ enabled, demo, accounts: accounts.size, postsReadToday: budgetLeft() >= 0 ? readToday : readToday, dailyPosts, pausedUntil: now() < pausedUntil ? pausedUntil : null, error: lastError }),
    stop() { clearInterval(timer); timer = null; }
  };
}
