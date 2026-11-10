// BlockDrop オンライン対戦（P2P）
// 合言葉 → SHA-256 → 部屋ID。最初に来た人がその部屋IDでホストとして待ち、
// 次に来た人は「ID使用中」エラーを受けてゲストとしてホストに接続する。
// シグナリングは PeerJS の公開サーバー、以降のデータはブラウザ間で直接(WebRTC)やり取りする。
(function () {
  'use strict';
  const PREFIX = 'blockdrop-v1-';
  const CONNECT_TIMEOUT_MS = 15000;
  const UNITY_OBJECT = 'BlockDropGame';

  let peer = null, conn = null, role = null, matched = false, timer = null, busy = false;

  const $ = (id) => document.getElementById(id);

  function toUnity(method, arg) {
    if (window.unityInstance) window.unityInstance.SendMessage(UNITY_OBJECT, method, arg == null ? '' : String(arg));
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

  function cleanup() {
    clearTimeout(timer);
    if (conn) { try { conn.close(); } catch (e) {} }
    if (peer) { try { peer.destroy(); } catch (e) {} }
    conn = null; peer = null; role = null; matched = false;
  }

  function fail(msg) {
    cleanup();
    setBusy(false);
    setStatus(msg, true);
  }

  function onMatched() {
    matched = true;
    clearTimeout(timer);
    $('mm').hidden = true;
    const c = $('c'); if (c) c.focus();
    toUnity('OnPeerConnected', role);
  }

  function attachData(c) {
    c.on('data', (d) => {
      if (typeof d !== 'string') return;
      if (!matched) {
        // ゲスト側の接続確認
        if (d === '{"t":"_welcome"}') onMatched();
        else if (d === '{"t":"_full"}') fail('この合言葉の部屋はすでに対戦中です。別の合言葉を使ってください。');
        return;
      }
      toUnity('OnPeerData', d);
    });
    c.on('close', () => {
      if (conn !== c) return;
      const wasMatched = matched;
      conn = null;
      if (wasMatched) { matched = false; toUnity('OnPeerDisconnected'); }
      else if (role === 'guest') fail('相手との接続が切れました。もう一度お試しください。');
    });
    c.on('error', () => {});
  }

  // ---- ホスト（先に来た人） ----
  function tryHost(id) {
    role = 'host';
    peer = new Peer(id, { debug: 0 });
    peer.on('open', () => {
      setStatus('相手を待っています…\n相手にも同じ合言葉を入力してもらってください。');
    });
    peer.on('connection', (c) => {
      if (conn) {
        // すでに対戦相手がいる → 満員を伝えて切る
        c.on('open', () => { c.send('{"t":"_full"}'); setTimeout(() => c.close(), 500); });
        return;
      }
      conn = c;
      attachData(c);
      c.on('open', () => { c.send('{"t":"_welcome"}'); onMatched(); });
    });
    peer.on('disconnected', () => {
      // シグナリングサーバーとの接続が切れても、対戦中のデータ通信は続く
      if (!matched && peer && !peer.destroyed) peer.reconnect();
    });
    peer.on('error', (e) => {
      if (e.type === 'unavailable-id') {
        // 同じ合言葉で待っている人がいる → ゲストとして接続
        try { peer.destroy(); } catch (x) {}
        peer = null;
        tryGuest(id);
      } else if (!matched) {
        fail(errorText(e));
      }
    });
  }

  // ---- ゲスト（後から来た人） ----
  function tryGuest(id) {
    role = 'guest';
    peer = new Peer({ debug: 0 });
    peer.on('open', () => {
      setStatus('相手が見つかりました。接続中…');
      const c = peer.connect(id, { reliable: true });
      conn = c;
      attachData(c);
      timer = setTimeout(() => {
        if (!matched) fail('接続できませんでした。ネットワーク環境によっては直接つながらない場合があります。');
      }, CONNECT_TIMEOUT_MS);
    });
    peer.on('error', (e) => {
      if (matched) return;
      if (e.type === 'peer-unavailable') {
        // 待っていた人が抜けた → 自分がホストになって待つ
        cleanup();
        setTimeout(() => { if (busy) tryHost(id); }, 500);
      } else {
        fail(errorText(e));
      }
    });
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

  async function start() {
    const phrase = $('mm-input').value.trim();
    if (!phrase) { setStatus('合言葉を入力してください。', true); return; }
    if (typeof Peer === 'undefined') { setStatus('通信ライブラリを読み込めませんでした。', true); return; }
    cleanup();
    setBusy(true);
    setStatus('マッチングサーバーに接続中…');
    tryHost(await roomId(phrase));
  }

  function cancel() {
    cleanup();
    setBusy(false);
    $('mm').hidden = true;
    const c = $('c'); if (c) c.focus();
    toUnity('OnMatchCancel');
  }

  window.BlockDropNet = {
    openDialog() {
      cleanup();
      setBusy(false);
      setStatus('');
      $('mm').hidden = false;
      setTimeout(() => $('mm-input').focus(), 0);
    },
    send(msg) {
      if (conn && conn.open) conn.send(msg);
    },
    close() {
      cleanup();
    },
  };

  window.addEventListener('DOMContentLoaded', () => {
    $('mm-go').addEventListener('click', start);
    $('mm-cancel').addEventListener('click', cancel);
    $('mm-input').addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.isComposing) start();
      if (e.key === 'Escape') cancel();
    });
  });
  window.addEventListener('beforeunload', cleanup);
})();
