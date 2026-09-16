/* =========================================================================
 * tracking.js — A 侧：识别与数据管线
 * 实现 window.AR 接口（契约见 接口约定.md）
 * 依赖 @mediapipe/tasks-vision（经 CDN 加载，首次运行需联网）
 * ========================================================================= */

import {
  FilesetResolver,
  HandLandmarker,
  ImageSegmenter,
} from "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.2";

const WASM_BASE =
  "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.2/wasm";
const MODEL_HAND =
  "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const MODEL_SELFIE =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

// —— 关键点索引（与 B 共用）——
const LM = {
  WRIST: 0, THUMB_TIP: 4, INDEX_TIP: 8, MIDDLE_TIP: 12, RING_TIP: 16, PINKY_TIP: 20,
};

// —— 错误码 ——
const ERR = {
  CAMERA_PERMISSION_DENIED: "camera-permission-denied",
  CAMERA_NOT_FOUND: "camera-not-found",
  CAMERA_IN_USE: "camera-in-use",
  MODEL_LOAD_FAILED: "model-load-failed",
};

function createAR() {
  // ---- 状态 ----
  let currentState = "idle"; // idle | loading | camera | demo | error
  const listeners = { status: [], error: [], handCount: [], stateChange: [] };
  let frameCallback = null;

  // ---- 资源 ----
  let canvas = null;
  let videoEl = null;
  let stream = null;
  let handLandmarker = null;
  let segmenter = null;
  let modelsPromise = null;
  let rafId = 0;

  // ---- 坐标变换（video 像素 -> 显示归一化）----
  const tx = { W: 1, H: 1, vw: 640, vh: 480, scale: 1, srcX: 0, srcY: 0 };

  // ---- 平滑状态（video 像素坐标，未镜像）----
  let smooth = 0.6;
  let smoothLeft = null;
  let smoothRight = null;
  let lastHandCount = -1;

  // ---- 离屏画布 ----
  const videoCanvas = document.createElement("canvas");
  const maskCanvas = document.createElement("canvas");
  const maskTempCanvas = document.createElement("canvas");
  const featherCanvas = document.createElement("canvas");

  // ---- 事件工具 ----
  function emit(type, payload) {
    for (const fn of listeners[type] || []) {
      try { fn(payload); } catch (e) { console.error("[AR]", e); }
    }
  }
  function setState(s) { currentState = s; emit("stateChange", { state: s }); }
  function status(text) { emit("status", { text }); }
  function fail(code, message) { setState("error"); emit("error", { code, message }); }

  // ---- 尺寸同步（显示画布 = CSS 像素，不启用 DPR）----
  function syncCanvasSize() {
    const W = canvas.clientWidth || window.innerWidth || 1280;
    const H = canvas.clientHeight || window.innerHeight || 720;
    if (canvas.width !== W) canvas.width = W;
    if (canvas.height !== H) canvas.height = H;
    tx.W = W; tx.H = H;
    if (videoCanvas.width !== W || videoCanvas.height !== H) {
      videoCanvas.width = W; videoCanvas.height = H;
    }
    if (maskCanvas.width !== W || maskCanvas.height !== H) {
      maskCanvas.width = W; maskCanvas.height = H;
    }
    if (featherCanvas.width !== W || featherCanvas.height !== H) {
      featherCanvas.width = W; featherCanvas.height = H;
    }
  }

  function recomputeTransform() {
    const vw = videoEl.videoWidth || 640;
    const vh = videoEl.videoHeight || 480;
    tx.vw = vw; tx.vh = vh;
    const scale = Math.max(tx.W / vw, tx.H / vh);
    tx.scale = scale;
    tx.srcX = (vw - tx.W / scale) / 2;
    tx.srcY = (vh - tx.H / scale) / 2;
  }

  // video 像素 -> 显示归一化（含水平镜像）
  function toDisplay(vx, vy) {
    const x = ((tx.vw - vx) - tx.srcX) * tx.scale / tx.W;
    const y = (vy - tx.srcY) * tx.scale / tx.H;
    return { x, y };
  }

  // ---- 手部处理：左右排序 + 插值平滑 ----
  function avgX(pts) { let s = 0; for (const p of pts) s += p.x; return s / pts.length; }

  function smoothSlot(prev, targetPts) {
    if (!targetPts) return null;              // 手消失 -> 清空
    if (!prev) return targetPts.map(p => ({ x: p.x, y: p.y })); // 新手 -> 直接取
    const k = 1 - 0.85 * smooth;              // 低通系数，smooth 越大 k 越小（越平滑）
    return targetPts.map((p, i) => ({
      x: prev[i].x + (p.x - prev[i].x) * k,
      y: prev[i].y + (p.y - prev[i].y) * k,
    }));
  }

  function toHandData(pts) {
    return { pts: pts.map(p => toDisplay(p.x, p.y)), score: 1 };
  }

  function processHands(raw) {
    // raw: [[{x,y,z}×21], ...]，按平均 x 排序（画面左 = left）
    const sorted = raw
      .map(pts => ({ pts, ax: avgX(pts) }))
      .sort((a, b) => a.ax - b.ax);

    const count = sorted.length;
    if (count !== lastHandCount) {
      lastHandCount = count;
      emit("handCount", { count });
    }

    const left = sorted[0] ? sorted[0].pts : null;
    const right = sorted[1] ? sorted[1].pts : null;
    smoothLeft = smoothSlot(smoothLeft, left);
    smoothRight = smoothSlot(smoothRight, right);

    return {
      left: smoothLeft ? toHandData(smoothLeft) : null,
      right: smoothRight ? toHandData(smoothRight) : null,
    };
  }

  // ---- 视频帧（镜像 + cover 裁切）----
  function drawVideo() {
    const ctx = videoCanvas.getContext("2d");
    const visibleW = tx.W / tx.scale;
    const visibleH = tx.H / tx.scale;
    ctx.clearRect(0, 0, tx.W, tx.H);
    ctx.save();
    ctx.translate(tx.W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(videoEl, tx.srcX, tx.srcY, visibleW, visibleH, 0, 0, tx.W, tx.H);
    ctx.restore();
  }

  // ---- 人物遮罩（镜像 + cover 裁切，alpha = 人物置信度 0~255）----
  function buildMask(ts) {
    if (!segmenter) return;
    let res;
    try { res = segmenter.segmentForVideo(videoEl, ts); } catch (e) { return; }
    if (!res || !res.confidenceMasks || !res.confidenceMasks.length) return;

    const m = res.confidenceMasks[0];
    const mw = m.width, mh = m.height;
    const data = m.getAsUint8Array
      ? m.getAsUint8Array()
      : Float32Array.from(m.getAsFloat32Array()).map(v => Math.round(v * 255));

    maskTempCanvas.width = mw; maskTempCanvas.height = mh;
    const tctx = maskTempCanvas.getContext("2d");
    const img = tctx.createImageData(mw, mh);
    for (let i = 0; i < mw * mh; i++) {
      const a = data[i];
      const o = i * 4;
      img.data[o] = 255; img.data[o + 1] = 255; img.data[o + 2] = 255; img.data[o + 3] = a;
    }
    tctx.putImageData(img, 0, 0);

    const visibleW = tx.W / tx.scale;
    const visibleH = tx.H / tx.scale;
    const sx = tx.srcX * mw / tx.vw;
    const sy = tx.srcY * mh / tx.vh;
    const sw = visibleW * mw / tx.vw;
    const sh = visibleH * mh / tx.vh;

    const mctx = maskCanvas.getContext("2d");
    mctx.clearRect(0, 0, tx.W, tx.H);
    mctx.save();
    mctx.translate(tx.W, 0);
    mctx.scale(-1, 1);
    mctx.drawImage(maskTempCanvas, sx, sy, sw, sh, 0, 0, tx.W, tx.H);
    mctx.restore();
    featherMask();
  }

  // ---- 人物遮罩羽化（高斯模糊柔边，消除锯齿/硬边/轮廓闪烁）----
  function featherMask() {
    if (!("filter" in CanvasRenderingContext2D.prototype)) return;
    const px = Math.max(3, Math.round(Math.min(tx.W, tx.H) * 0.01));
    const fctx = featherCanvas.getContext("2d");
    fctx.clearRect(0, 0, tx.W, tx.H);
    fctx.filter = "blur(" + px + "px)";
    fctx.drawImage(maskCanvas, 0, 0);
    const mctx = maskCanvas.getContext("2d");
    mctx.save();
    mctx.filter = "none";
    mctx.clearRect(0, 0, tx.W, tx.H);
    mctx.drawImage(featherCanvas, 0, 0);
    mctx.restore();
  }

  // ---- 演示模式：合成假手 ----
  function makeDemoHand(cx, cy, s, t, phase) {
    const pts = new Array(21);
    pts[0] = { x: cx, y: cy + 0.10 * s }; // 手腕
    const fingers = [
      { a: -1.2, len: 0.16 }, // 拇指
      { a: -0.28, len: 0.22 }, // 食指
      { a: 0.0, len: 0.25 }, // 中指
      { a: 0.28, len: 0.22 }, // 无名指
      { a: 0.62, len: 0.18 }, // 小指
    ];
    let idx = 1;
    for (let f = 0; f < 5; f++) {
      for (let j = 1; j <= 4; j++) {
        const r = fingers[f].len * s * (j / 4);
        let x = cx + Math.sin(fingers[f].a) * r;
        let y = cy - Math.cos(fingers[f].a) * r;
        if (j === 4) { // 指尖轻微抖动，让面片可见地运动
          x += Math.sin(t * 0.004 + phase + f * 1.3) * 0.012;
          y += Math.cos(t * 0.005 + phase + f * 0.9) * 0.010;
        }
        pts[idx++] = { x, y };
      }
    }
    return pts;
  }

  function demoHands(t) {
    return {
      left: { pts: makeDemoHand(0.30, 0.56, 0.30, t, 0), score: 1 },
      right: { pts: makeDemoHand(0.70, 0.56, 0.30, t, Math.PI), score: 1 },
    };
  }

  // ---- 主循环 ----
  function loop(t) {
    rafId = requestAnimationFrame(loop);
    syncCanvasSize();

    if (currentState === "camera") {
      if (videoEl.readyState < 2) return;
      recomputeTransform();

      let raw = [];
      try { raw = handLandmarker.detectForVideo(videoEl, t).landmarks || []; } catch (e) {}

      const hands = processHands(raw);
      buildMask(t);
      drawVideo();
      if (frameCallback) {
        frameCallback({ t, w: tx.W, h: tx.H, video: videoCanvas, mask: maskCanvas, hands });
      }
    } else if (currentState === "demo") {
      if (frameCallback) {
        frameCallback({ t, w: tx.W, h: tx.H, video: null, mask: null, hands: demoHands(t) });
      }
    }
  }

  function startLoop() { if (!rafId) rafId = requestAnimationFrame(loop); }
  function stopLoop() { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }

  // ---- 模型加载（GPU 优先，失败回退 CPU）----
  async function withDelegateFallback(factory) {
    try { return await factory("GPU"); }
    catch (e) { console.warn("[AR] GPU 初始化失败，回退 CPU：", e); return await factory("CPU"); }
  }

  async function ensureModels() {
    if (!modelsPromise) {
      modelsPromise = (async () => {
        const vision = await FilesetResolver.forVisionTasks(WASM_BASE);
        status("正在加载手部模型…");
        handLandmarker = await withDelegateFallback((d) =>
          HandLandmarker.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_HAND, delegate: d },
            runningMode: "VIDEO",
            numHands: 2,
          })
        );
        status("正在加载人像分割模型…");
        segmenter = await withDelegateFallback((d) =>
          ImageSegmenter.createFromOptions(vision, {
            baseOptions: { modelAssetPath: MODEL_SELFIE, delegate: d },
            runningMode: "VIDEO",
            outputCategoryMask: false,
            outputConfidenceMasks: true,
          })
        );
      })().catch((err) => {
        modelsPromise = null; // 允许下次重试
        throw {
          code: ERR.MODEL_LOAD_FAILED,
          message: "MediaPipe 模型加载失败：" + ((err && err.message) || err),
        };
      });
    }
    return modelsPromise;
  }

  // ---- 摄像头 ----
  async function getUserMediaSafe() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw { code: ERR.CAMERA_NOT_FOUND, message: "当前浏览器不支持摄像头访问" };
    }
    try {
      return await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (e) {
      const n = (e && e.name) || "";
      if (n === "NotAllowedError" || n === "SecurityError" || n === "PermissionDeniedError") {
        throw { code: ERR.CAMERA_PERMISSION_DENIED, message: "摄像头权限被拒绝，请在浏览器地址栏允许访问摄像头" };
      } else if (n === "NotFoundError" || n === "DevicesNotFoundError" || n === "OverconstrainedError") {
        throw { code: ERR.CAMERA_NOT_FOUND, message: "没有找到摄像头" };
      } else if (n === "NotReadableError" || n === "TrackStartError" || n === "AbortError") {
        throw { code: ERR.CAMERA_IN_USE, message: "摄像头被其他软件占用" };
      }
      throw { code: ERR.CAMERA_NOT_FOUND, message: "无法访问摄像头：" + n };
    }
  }

  function waitForVideo(v) {
    return new Promise((resolve) => {
      if (v.readyState >= 2) return resolve();
      v.onloadedmetadata = resolve;
      v.onloadeddata = resolve;
      setTimeout(resolve, 3000);
    });
  }

  function stopCameraStream() {
    if (stream) { stream.getTracks().forEach(tr => tr.stop()); stream = null; }
    if (videoEl) videoEl.srcObject = null;
  }

  // ---- 对外接口 ----
  async function init(opts) {
    canvas = (opts && opts.canvas) || document.querySelector("canvas");
    if (!canvas) throw new Error("AR.init 需要一个 <canvas> 元素");
    videoEl = document.createElement("video");
    videoEl.setAttribute("playsinline", "");
    videoEl.muted = true;
    syncCanvasSize();
    window.addEventListener("resize", syncCanvasSize);
    return true;
  }

  async function startCamera() {
    if (currentState === "camera") return;
    setState("loading");
    try {
      await ensureModels();
      status("正在启动摄像头…");
      stream = await getUserMediaSafe();
      videoEl.srcObject = stream;
      await videoEl.play();
      await waitForVideo(videoEl);
      syncCanvasSize();
      recomputeTransform();
      smoothLeft = smoothRight = null;
      lastHandCount = -1;
      setState("camera");
      startLoop();
    } catch (err) {
      fail(err && err.code ? err.code : ERR.MODEL_LOAD_FAILED, (err && err.message) || String(err));
    }
  }

  function startDemo() {
    if (currentState === "demo") return;
    stopCameraStream();
    setState("demo");
    syncCanvasSize();
    smoothLeft = smoothRight = null;
    lastHandCount = -1;
    emit("handCount", { count: 2 });
    startLoop();
  }

  function reset() {
    stopLoop();
    stopCameraStream();
    setState("idle");
  }

  function setSmooth(v) {
    const n = Number(v);
    smooth = Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0.6;
  }

  return {
    init, startCamera, startDemo, reset, setSmooth,
    setFrameCallback(cb) { frameCallback = cb; },
    on(type, fn) { if (listeners[type]) listeners[type].push(fn); },
    get canvas() { return canvas; },
    get state() { return currentState; },
  };
}

const AR = createAR();

export { AR, LM, ERR };

if (typeof window !== "undefined") {
  window.AR = AR;
  window.LM = LM;
  window.ERR = ERR;
}
