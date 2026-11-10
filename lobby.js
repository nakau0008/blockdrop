// BlockDrop ロビー（オンライン人数・待機中人数）
// 公開MQTTブローカーに「自分はいる / 待機中 / 対戦中」を数秒ごとに知らせ合い、人数を数える。
// 送るのはランダムなIDと状態だけ（個人情報は送らない）。
(function () {
  'use strict';
  const BROKERS = ['wss://broker.hivemq.com:8884/mqtt', 'wss://broker.emqx.io:8084/mqtt'];
  const BASE = 'bdgame-x7k2/v1/presence/';
  const ID = Math.random().toString(36).slice(2, 10);
  const HEARTBEAT_MS = 4000, EXPIRE_MS = 13000;
  const UNITY_OBJECT = 'BlockDropGame';

  let client = null, brokerIdx = 0, connected = false, retrying = false;
  let state = 'idle', slot = -1, since = Date.now();
  const seen = new Map(); // id -> { s, slot, since, at }

  function toUnity(method, arg) {
    if (window.unityInstance) window.unityInstance.SendMessage(UNITY_OBJECT, method, arg);
  }

  function publish(s) {
    if (!client || !connected) return;
    try { client.publish(BASE + ID, JSON.stringify({ s: s || state, slot, since }), { qos: 0 }); } catch (e) {}
  }

  function connect() {
    if (typeof mqtt === 'undefined') return;
    if (client) { try { client.end(true); } catch (e) {} client = null; }
    let c;
    try {
      c = mqtt.connect(BROKERS[brokerIdx], {
        clientId: 'bd_' + ID + '_' + Math.floor(Math.random() * 1e4),
        clean: true, reconnectPeriod: 0, connectTimeout: 8000, keepalive: 30,
      });
    } catch (e) { retry(); return; }
    client = c;
    c.on('connect', () => {
      if (client !== c) return;
      connected = true;
      c.subscribe(BASE + '+');
      publish();
    });
    c.on('message', (topic, payload) => {
      const id = topic.slice(BASE.length);
      if (id === ID) return;
      try {
        const d = JSON.parse(payload.toString());
        if (d.s === 'gone') seen.delete(id);
        else seen.set(id, { s: d.s, slot: d.slot, since: d.since || 0, at: Date.now() });
      } catch (e) {}
    });
    c.on('close', () => {
      if (client !== c) return;
      connected = false;
      retry();
    });
    c.on('error', () => { try { c.end(true); } catch (e) {} });
  }

  function retry() {
    if (retrying) return;
    retrying = true;
    setTimeout(() => {
      retrying = false;
      brokerIdx = (brokerIdx + 1) % BROKERS.length;
      connect();
    }, 5000);
  }

  function prune() {
    const now = Date.now();
    for (const [id, v] of seen) if (now - v.at > EXPIRE_MS) seen.delete(id);
  }

  function counts() {
    prune();
    let waiting = state === 'waiting' ? 1 : 0;
    for (const v of seen.values()) if (v.s === 'waiting') waiting++;
    return { online: seen.size + 1, waiting, connected };
  }

  window.BlockDropLobby = {
    setState(s, sl) {
      state = s;
      slot = typeof sl === 'number' ? sl : -1;
      since = Date.now();
      publish();
    },
    // ランダムマッチで待っている人の席番号（古い順）
    waitingSlots() {
      prune();
      return [...seen.values()]
        .filter((v) => v.s === 'waiting' && typeof v.slot === 'number' && v.slot >= 0)
        .sort((a, b) => a.since - b.since)
        .map((v) => v.slot);
    },
    counts,
  };

  setInterval(publish, HEARTBEAT_MS);
  setInterval(() => {
    const c = counts();
    if (c.connected) toUnity('OnLobbyStats', c.online + ',' + c.waiting);
    if (window.BlockDropNet && window.BlockDropNet.onLobby) window.BlockDropNet.onLobby(c);
  }, 2000);
  window.addEventListener('beforeunload', () => publish('gone'));
  window.addEventListener('DOMContentLoaded', connect);
})();
