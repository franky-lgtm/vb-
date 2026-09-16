/* ============================================================
   B — UI 接线骨架（B1 / B8）
   职责：按钮、滑块、状态/错误/单手提示 与 window.AR 的接线。
   渲染逻辑（合成管线 / 三面片 / 滤镜）在后续步骤的 filters.js。
   ============================================================ */

(() => {
  "use strict";

  const $ = (id) => document.getElementById(id);

  const els = {
    stage:     $("stage"),
    ui:        $("ui"),
    stateDot:  $("state-dot"),
    stateText: $("state-text"),
    notice:    $("notice"),
    handHint:  $("hand-hint"),
    btnCamera: $("btn-camera"),
    btnDemo:   $("btn-demo"),
    btnFilter: $("btn-filter"),
    btnReset:  $("btn-reset"),
    smooth:    $("smooth"),
    smoothVal: $("smooth-val"),
  };

  /* ---- B 侧共享状态：渲染层(filters.js) 与 UI 层共用 ---- */
  window.B = window.B || {};
  const B = window.B;
  B.showFilters = B.showFilters !== false;   // 三块面片滤镜显隐（默认开）
  B.smooth = B.smooth ?? 0.6;

  /* ---- 滤镜开关（三块面片各自固定滤镜，按钮只管显隐）---- */
  function setFilterLabel() {
    els.btnFilter.textContent = B.showFilters ? "🎨 滤镜：开" : "🎨 滤镜：关";
  }

  /* ---- 状态文案 ---- */
  const STATE_TEXT = {
    idle:    "空闲",
    loading: "模型加载中…",
    camera:  "摄像头运行中",
    demo:    "演示模式",
    error:   "出错",
  };

  function setState(state) {
    els.ui.dataset.state = state;
    els.stateDot.dataset.state = state;
    els.stateText.textContent = STATE_TEXT[state] || state;
  }

  function showNotice(text, isError) {
    els.notice.hidden = !text;
    els.notice.classList.toggle("is-error", !!isError);
    els.notice.textContent = text || "";
  }

  function showHandHint(count) {
    els.handHint.hidden = count !== 1;
  }

  /* ---- 接线（AR 由 tracking.js 挂到 window，首次 CDN 加载约 10 秒，故轮询等待）---- */
  function wireUI(AR) {
    els.btnCamera.addEventListener("click", () => AR.startCamera());
    els.btnDemo.addEventListener("click", () => AR.startDemo());
    els.btnReset.addEventListener("click", () => AR.reset());
    els.btnFilter.addEventListener("click", () => {
      B.showFilters = !B.showFilters;
      setFilterLabel();
    });
    els.smooth.addEventListener("input", () => {
      B.smooth = parseFloat(els.smooth.value);
      els.smoothVal.textContent = els.smooth.value;
      AR.setSmooth(B.smooth);
    });

    AR.on("status",      ({ text }) => showNotice(text, false));
    AR.on("error",       ({ code, message }) => showNotice(`${message}（${code}）`, true));
    AR.on("handCount",   ({ count }) => showHandHint(count));
    AR.on("stateChange", ({ state }) => setState(state));
  }

  function boot(AR) {
    showNotice("", false);   // AR 就绪，清除「正在加载 AR 管线…」提示
    wireUI(AR);
    setState("idle");
    setFilterLabel();
    els.smooth.value = B.smooth;
    els.smoothVal.textContent = B.smooth.toFixed(2);
    AR.init({ canvas: els.stage }).catch(() => {});
  }

  if (window.AR) {
    boot(window.AR);
  } else {
    // tracking.js 尚未执行完成（MediaPipe 正在从 CDN 下载），轮询等待其挂好 window.AR
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (window.AR) {
        clearInterval(timer);
        boot(window.AR);
      } else if (Date.now() - t0 > 30000) {
        clearInterval(timer);
        setState("error");
        showNotice("AR 管线加载失败：请确认能联网访问 CDN，或按 F12 查看控制台", true);
      }
    }, 200);
  }
})();
