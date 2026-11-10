// BlockDrop オンライン対戦（P2P）
// ・合言葉マッチ: 合言葉 → SHA-256 → 部屋ID。先に来た人がホストとして待ち、次の人がそこへ接続する。
// ・ランダムマッチ: 決まった数の「席」(rnd-0～7) を使う。待っている人の席を探して入り、
//   誰もいなければ空いている席で待つ。待っている席は lobby.js から教えてもらう。
// シグナリングは PeerJS の公開サーバー、以降のデータはブラウザ間で直接(WebRTC)やり取りする。
(function () {
  'use strict';
  const PREFIX = 'blockdrop-v1-';
  const SLOTS = 8;
  const CONNECT_TIMEOUT_MS = 8000;
  const UNITY_OBJECT = 'BlockDropGame';
  const WELCOME = '{"t":"_welcome"}', FULL = '{"t":"_full"}';

  let peer = null, conn = null, role = null, matched = false, busy = false, mode = 'phrase';
  let attempt = null;

  const $ = (id) => document.getElementById(id);

  function toUnity(method, arg) {
    if (window.unityInstance) window.unityInstance.SendMessage(UNITY_OBJECT, method, arg == null ? '' : String(arg));
  }
  function lobby(s, slot) {
    if (window.BlockDropLobby) window.BlockDropLobby.setState(s, slot);
  }
  function lobbyCounts() {
    return window.BlockDropLobby ? window.BlockDropLobby.counts() : { connected: false };
  }

  function setStatus(text, isError) {
    const el = $('mm-status');
    el.textContent = text;
    el.className = isError ? 'err' : '';
  }

  function setBusy(b) {
    busy = b;
    $('mm-input').disabled = b;
    $('mm-go').disabled = b;
  }

  async function roomId(phrase) {
    const data = new TextEncoder().encode('blockdrop:' + phrase.trim());
    const hash = await crypto.subtle.digest('SHA-256', data);
    return PREFIX + Array.from(new Uint8Array(hash)).slice(0, 12)
      .map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const slotId = (i) => PREFIX + 'rnd-' + i;

  function destroyPeer() {
    if (attempt) { clearTimeout(attempt.timer); attempt = null; }
    if (conn) { try { conn.close(); } catch (e) {} }
    if (peer) { try { peer.destroy(); } catch (e) {} }
    conn = null; peer = null;
  }

  function cleanup() {
    destroyPeer();
    role = null;
    matched = false;
    lobby('idle');
  }

  function fail(msg) {
    cleanup();
    setBusy(false);
    setStatus(msg, true);
  }

  function errorText(e) {
    switch (e.type) {
      case 'network': case 'server-error': case 'socket-error': case 'socket-closed':
        return 'マッチングサーバーに接続できませんでした。時間をおいて再度お試しください。';
      case 'browser-incompatible':
        return 'このブラウザはオンライン対戦に対応していません。';
      default:
        return 'エラーが発生しました (' + e.type + ')';
    }
  }

  function onMatched(c) {
    matched = true;
    conn = c;
    if (attempt) { clearTimeout(attempt.timer); attempt = null; }
    $('mm').hidden = true;
    const cv = $('c'); if (cv) cv.focus();
    lobby('playing');
    toUnity('OnPeerConnected', role);
  }

  // 対戦が始まった接続: データを Unity へ流し、切断を知らせる
  function bindLive(c) {
    c.on('data', (d) => {
      if (typeof d !== 'string' || !matched || conn !== c) return;
      if (d.startsWith('{"t":"_')) return;
      toUnity('OnPeerData', d);
    });
    c.on('close', () => {
      if (conn !== c) return;
      conn = null;
      if (matched) { matched = false; lobby('idle'); toUnity('OnPeerDisconnected'); }
    });
    c.on('error', () => {});
  }

  // ---- ホストとして id で待つ。使用中なら onTaken() ----
  function hostAt(id, waitingText, lobbyState, slot, onTaken) {
    destroyPeer();
    role = 'host';
    const p = new Peer(id, { debug: 0 });
    peer = p;
    p.on('open', () => {
      if (peer !== p) return;
      setStatus(waitingText());
      lobby(lobbyState, slot);
    });
    p.on('connection', (c) => {
      c.on('open', () => {
        if (conn || matched || peer !== p) {
          // すでに対戦相手がいる → 満員を伝えて切る
          c.send(FULL);
          setTimeout(() => c.close(), 500);
          return;
        }
        c.send(WELCOME);
        bindLive(c);
        onMatched(c);
      });
    });
    p.on('disconnected', () => {
      // シグナリングサーバーとの接続が切れても、対戦中のデータ通信は続く
      if (!matched && peer === p && !p.destroyed) p.reconnect();
    });
    p.on('error', (e) => {
      if (peer !== p) return;
      if (e.type === 'unavailable-id') { destroyPeer(); onTaken(); }
      else if (!matched) fail(errorText(e));
    });
  }

  // ---- ゲストとして id のホストに接続する。だめなら onFail(理由) ----
  function guestTo(id, onFail) {
    const go = () => {
      const c = peer.connect(id, { reliable: true });
      const a = {
        fail: (reason) => {
          if (attempt !== a) return;
          clearTimeout(a.timer);
          attempt = null;
          try { c.close(); } catch (e) {}
          onFail(reason || 'none');
        },
      };
      a.timer = setTimeout(() => a.fail('timeout'), CONNECT_TIMEOUT_MS);
      attempt = a;
      c.on('data', (d) => {
        if (typeof d !== 'string' || matched || attempt !== a) return;
        if (d === WELCOME) { clearTimeout(a.timer); attempt = null; bindLive(c); onMatched(c); }
        else if (d === FULL) a.fail('full');
      });
      c.on('close', () => { if (!matched && attempt === a) a.fail('closed'); });
    };

    if (peer && role === 'guest' && !peer.destroyed && peer.open) { go(); return; }
    destroyPeer();
    role = 'guest';
    const p = new Peer({ debug: 0 });
    peer = p;
    p.on('open', () => { if (peer === p && busy) go(); });
    p.on('error', (e) => {
      if (peer !== p) return;
      if (e.type === 'peer-unavailable') { if (attempt) attempt.fail('none'); }
      else if (!matched) fail(errorText(e));
    });
  }

  // ===== 合言葉マッチ =====
  async function startPhrase() {
    const phrase = $('mm-input').value.trim();
    if (!phrase) { setStatus('合言葉を入力してください。', true); return; }
    if (typeof Peer === 'undefined') { setStatus('通信ライブラリを読み込めませんでした。', true); return; }
    cleanup();
    setBusy(true);
    setStatus('マッチングサーバーに接続中…');
    const id = await roomId(phrase);
    const tryHost = () => hostAt(id,
      () => '相手を待っています…\n相手にも同じ合言葉を入力してもらってください。',
      'phrase', -1,
      () => {
        setStatus('相手が見つかりました。接続中…');
        guestTo(id, (reason) => {
          if (!busy) return;
          if (reason === 'full') { fail('この合言葉の部屋はすでに対戦中です。別の合言葉を使ってください。'); return; }
          if (reason === 'timeout') { fail('接続できませんでした。ネットワーク環境によっては直接つながらない場合があります。'); return; }
          // 待っていた人が抜けた → 自分がホストになって待つ
          setTimeout(() => { if (busy) tryHost(); }, 600);
        });
      });
    tryHost();
  }

  // ===== ランダムマッチ =====
  function randomWaitingText() {
    const c = lobbyCounts();
    let s = '対戦相手を待っています…';
    if (c.connected) s += `\n現在オンライン: ${c.online}人 / 待機中: ${c.waiting}人`;
    return s;
  }

  function startRandom() {
    if (typeof Peer === 'undefined') { setStatus('通信ライブラリを読み込めませんでした。', true); return; }
    cleanup();
    setBusy(true);
    mode = 'random';
    setStatus('対戦相手を探しています…');
    const advertised = window.BlockDropLobby ? window.BlockDropLobby.waitingSlots() : [];
    const order = [...new Set([...advertised, 0, 1, 2, 3])];
    scan(order, 0);
  }

  function scan(order, k) {
    if (!busy) return;
    if (k >= order.length) { hostSlot(0); return; }
    guestTo(slotId(order[k]), () => scan(order, k + 1));
  }

  function hostSlot(i) {
    if (!busy) return;
    if (i >= SLOTS) { fail('混み合っています。しばらくしてからお試しください。'); return; }
    hostAt(slotId(i), randomWaitingText, 'waiting', i, () => {
      // その席で誰かが待っている → 入ってみる。だめなら次の席
      guestTo(slotId(i), () => hostSlot(i + 1));
    });
  }

  function cancel() {
    cleanup();
    setBusy(false);
    $('mm').hidden = true;
    const c = $('c'); if (c) c.focus();
    toUnity('OnMatchCancel');
  }

  function showDialog(random) {
    cleanup();
    setBusy(false);
    setStatus('');
    mode = random ? 'random' : 'phrase';
    $('mm-title').textContent = random ? 'ランダムマッチ' : '合言葉マッチ';
    $('mm-sub').textContent = random
      ? '同じタイミングで探している人と自動でつながります。'
      : '相手と同じ合言葉を入力すると、つながります。';
    $('mm-phrase').hidden = random;
    $('mm-go').hidden = random;
    $('mm').hidden = false;
  }

  window.BlockDropNet = {
    openDialog() {
      showDialog(false);
      setTimeout(() => $('mm-input').focus(), 0);
    },
    openRandom() {
      showDialog(true);
      startRandom();
    },
    send(msg) {
      if (conn && conn.open) conn.send(msg);
    },
    close() {
      cleanup();
    },
    // lobby.js から2秒ごとに呼ばれる: 待機中の表示を更新
    onLobby() {
      if (busy && !matched && mode === 'random' && role === 'host' && peer && peer.open) setStatus(randomWaitingText());
    },
  };

  window.addEventListener('DOMContentLoaded', () => {
    $('mm-go').addEventListener('click', startPhrase);
    $('mm-cancel').addEventListener('click', cancel);
    $('mm-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) startPhrase();
      if (e.key === 'Escape') cancel();
    });
  });
  window.addEventListener('beforeunload', cleanup);
})();
