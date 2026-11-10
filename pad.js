// BlockDrop スマホ用タッチボタン
// タッチ主体の端末でだけボタンを表示し、押下/離しを Unity の OnVirtualKey に "left,1" の形で伝える。
(function () {
  'use strict';
  const UNITY_OBJECT = 'BlockDropGame';
  const isTouch = window.matchMedia('(pointer: coarse)').matches;

  function toUnity(method, arg) {
    if (window.unityInstance) window.unityInstance.SendMessage(UNITY_OBJECT, method, arg);
  }

  function bind(btn) {
    const key = btn.dataset.k;
    let active = null; // 押している指の pointerId

    const down = (e) => {
      e.preventDefault();
      if (active !== null) return;
      active = e.pointerId;
      try { btn.setPointerCapture(e.pointerId); } catch (x) {}
      btn.classList.add('on');
      toUnity('OnVirtualKey', key + ',1');
      if (navigator.vibrate) navigator.vibrate(8);
    };
    const up = (e) => {
      if (active === null || (e && e.pointerId !== undefined && e.pointerId !== active)) return;
      active = null;
      btn.classList.remove('on');
      toUnity('OnVirtualKey', key + ',0');
    };

    btn.addEventListener('pointerdown', down);
    btn.addEventListener('pointerup', up);
    btn.addEventListener('pointercancel', up);
    btn.addEventListener('lostpointercapture', up);
    btn.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  window.BlockDropPad = {
    // Unity の読み込み完了後に呼ぶ
    onUnityReady() {
      if (isTouch) toUnity('OnTouchDevice', '1');
    },
  };

  window.addEventListener('DOMContentLoaded', () => {
    if (!isTouch) return;
    document.body.classList.add('touch');
    document.querySelectorAll('#pad [data-k]').forEach(bind);
    // ダブルタップでの拡大やスクロールを防ぐ
    document.addEventListener('touchmove', (e) => { if (!e.target.closest('#mm')) e.preventDefault(); }, { passive: false });
    document.addEventListener('dblclick', (e) => e.preventDefault());
  });
})();
