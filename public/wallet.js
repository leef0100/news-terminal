// Wallet connect: Solana wallets (Phantom, Solflare, Backpack) and any Ethereum-style wallet
// that announces itself (MetaMask, Coinbase Wallet, Rabby and others).
//
// Connect only: this reads the public address the wallet agrees to share. It never asks for
// a signature or a transaction. The address is not proof of ownership, since nothing is signed.
(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var KEY = 'nt.wallet';
  var evm = [];
  var active = null; // { kind, id, name, address }

  var GET = [
    { match: 'phantom', name: 'Phantom', url: 'https://phantom.com/' },
    { match: 'metamask', name: 'MetaMask', url: 'https://metamask.io/' },
    { match: 'coinbase', name: 'Coinbase Wallet', url: 'https://www.coinbase.com/wallet' }
  ];

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }
  function short(a) { return a.length > 12 ? a.slice(0, 4) + '…' + a.slice(-4) : a; }
  function remember(w) { try { w ? localStorage.setItem(KEY, JSON.stringify({ kind: w.kind, id: w.id, rdns: w.rdns || '' })) : localStorage.removeItem(KEY); } catch (e) { /* ignore */ } }
  function remembered() { try { return JSON.parse(localStorage.getItem(KEY)); } catch (e) { return null; } }

  function solanaWallets() {
    var out = [];
    var ph = (window.phantom && window.phantom.solana) || (window.solana && window.solana.isPhantom ? window.solana : null);
    if (ph) out.push({ kind: 'solana', id: 'phantom', name: 'Phantom', chain: 'Solana', provider: ph });
    if (window.solflare && window.solflare.isSolflare) out.push({ kind: 'solana', id: 'solflare', name: 'Solflare', chain: 'Solana', provider: window.solflare });
    if (window.backpack && window.backpack.solana) out.push({ kind: 'solana', id: 'backpack', name: 'Backpack', chain: 'Solana', provider: window.backpack.solana });
    return out;
  }
  function evmWallets() {
    if (evm.length) return evm;
    // Older wallets that do not announce themselves.
    return window.ethereum ? [{ kind: 'evm', id: 'injected', name: window.ethereum.isMetaMask ? 'MetaMask' : 'Browser wallet', chain: 'Ethereum', provider: window.ethereum }] : [];
  }
  function all() { return solanaWallets().concat(evmWallets()); }

  function setActive(w, address) {
    active = w && address ? { kind: w.kind, id: w.id, rdns: w.rdns || '', name: w.name, chain: w.chain, address: String(address), provider: w.provider } : null;
    remember(active);
    var btn = $('walletBtn');
    btn.textContent = active ? short(active.address) : 'Connect wallet';
    btn.className = 'btn walletBtn' + (active ? ' on' : '');
    btn.title = active ? active.name + ' · ' + active.chain : '';
    // Offer the address as the chat name, unless the person already chose their own.
    var handle = $('handle');
    if (active && handle && /^anon-\d+$/.test(handle.value)) handle.value = short(active.address);
    document.dispatchEvent(new CustomEvent('nt:wallet', { detail: active ? { kind: active.kind, name: active.name, address: active.address } : null }));
  }

  function connect(w, silent) {
    var p;
    if (w.kind === 'solana') {
      p = w.provider.connect(silent ? { onlyIfTrusted: true } : undefined).then(function (res) {
        var key = (res && res.publicKey) || w.provider.publicKey;
        return key ? key.toString() : null;
      });
    } else {
      p = w.provider.request({ method: silent ? 'eth_accounts' : 'eth_requestAccounts' }).then(function (accts) { return accts && accts[0]; });
    }
    return p.then(function (address) {
      if (!address) throw new Error('The wallet did not share an address.');
      setActive(w, address);
      if (w.kind === 'evm' && w.provider.on && !w.listening) {
        w.listening = true;
        w.provider.on('accountsChanged', function (accts) {
          if (active && active.id === w.id) setActive(accts && accts[0] ? w : null, accts && accts[0]);
        });
      }
    });
  }

  function disconnect() {
    var w = active;
    setActive(null);
    if (w && w.kind === 'solana' && w.provider.disconnect) { try { w.provider.disconnect(); } catch (e) { /* ignore */ } }
  }

  function render() {
    var box = $('walletList');
    box.textContent = '';
    $('walletErr').textContent = '';
    if (active) {
      var cur = el('div', 'walletRow on');
      var info = el('span', 'wInfo');
      info.appendChild(el('b', null, active.name + ' · ' + active.chain));
      info.appendChild(el('span', 'mono small', active.address));
      cur.appendChild(info);
      var off = el('button', 'btn', 'Disconnect');
      off.type = 'button';
      off.addEventListener('click', function () { disconnect(); render(); });
      cur.appendChild(off);
      box.appendChild(cur);
    }
    var found = all();
    found.forEach(function (w) {
      if (active && active.id === w.id && active.kind === w.kind) return;
      var b = el('button', 'walletRow');
      b.type = 'button';
      var info = el('span', 'wInfo');
      info.appendChild(el('b', null, w.name));
      info.appendChild(el('span', 'muted small', w.chain));
      b.appendChild(info);
      b.appendChild(el('span', 'pill', 'Detected'));
      b.addEventListener('click', function () {
        $('walletErr').textContent = '';
        connect(w, false).then(function () { $('walletDlg').close(); }).catch(function (err) {
          $('walletErr').textContent = err && err.code === 4001 ? 'Connection was declined in the wallet.' : 'Could not connect: ' + ((err && err.message) || 'unknown error');
        });
      });
      box.appendChild(b);
    });
    var names = found.map(function (w) { return (w.name + ' ' + w.id).toLowerCase(); }).join(' ');
    GET.forEach(function (g) {
      if (names.indexOf(g.match) !== -1) return;
      var a = el('a', 'walletRow');
      a.href = g.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      var info = el('span', 'wInfo');
      info.appendChild(el('b', null, g.name));
      info.appendChild(el('span', 'muted small', 'Not found in this browser'));
      a.appendChild(info);
      a.appendChild(el('span', 'pill quiet', 'Get it'));
      box.appendChild(a);
    });
    if (!found.length) box.appendChild(el('p', 'muted small', 'No wallet was found. On a phone, open this site from inside your wallet app\'s browser.'));
  }

  // Ethereum-style wallets announce themselves on request (EIP-6963).
  window.addEventListener('eip6963:announceProvider', function (e) {
    var d = e.detail;
    if (!d || !d.info || !d.provider || evm.some(function (w) { return w.id === d.info.uuid; })) return;
    var w = { kind: 'evm', id: String(d.info.uuid), rdns: String(d.info.rdns || ''), name: String(d.info.name || 'Wallet').slice(0, 40), chain: 'Ethereum', provider: d.provider };
    evm.push(w);
    var r = remembered();
    if (!active && r && r.kind === 'evm' && (r.id === w.id || (r.rdns && r.rdns === w.rdns))) connect(w, true).catch(function () {});
    if ($('walletDlg').open) render();
  });
  window.dispatchEvent(new Event('eip6963:requestProvider'));

  $('walletBtn').addEventListener('click', function () {
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    render();
    $('walletDlg').showModal();
  });
  $('walletClose').addEventListener('click', function () { $('walletDlg').close(); });

  // Quietly restore a wallet the person connected before; never opens a prompt.
  window.addEventListener('load', function () {
    var r = remembered();
    if (!r || active) return;
    var w = all().filter(function (x) { return x.kind === r.kind && x.id === r.id; })[0];
    if (w) connect(w, true).catch(function () { remember(null); });
  });
})();
