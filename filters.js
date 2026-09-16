/* ============================================================
   B 侧 — 渲染模块
   B2：分层合成  背景(video/深色) → 三面片（各自固定滤镜）
   B3：三面片几何（契约 §5 顶点顺序，处理凹/蝴蝶结/退化）
   B4/B5/B6：红色半调 / 蓝色冷调 / 绿色伪彩 三个滤镜，各绑定一块面片
   B7（遮罩羽化）后续接入 drawFilteredQuad。
   性能：按 任务分工.md 约定，只在面片「包围盒」内做像素处理。
   ============================================================ */

// 关键点索引：优先用 A 挂到 window 的常量，缺省时本地兜底（契约 §4）
const LM = (typeof window !== "undefined" && window.LM) || {
  WRIST: 0, THUMB_TIP: 4, INDEX_TIP: 8, MIDDLE_TIP: 12, RING_TIP: 16, PINKY_TIP: 20,
};

// 三面片顶点约定（契约 §5，写死不改）
const QUADS = {
  red:   { a: LM.THUMB_TIP,  b: LM.INDEX_TIP  },   // 拇指4 + 食指8
  blue:  { a: LM.INDEX_TIP,  b: LM.MIDDLE_TIP },   // 食指8 + 中指12
  green: { a: LM.MIDDLE_TIP, b: LM.PINKY_TIP  },   // 中指12 + 小指20
};

// 面片描边色（与 styles.css 的 --filter-* 一致）
const QUAD_COLORS = {
  red:   "#ff5d5d",
  blue:  "#5d8bff",
  green: "#5dff9a",
};

const QUAD_KEYS = ["red", "blue", "green"];

// 手部骨架连线（标准 MediaPipe 21 点拓扑，索引与 LM 一致）
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],          // 拇指
  [0, 5], [5, 6], [6, 7], [7, 8],          // 食指
  [5, 9], [9, 10], [10, 11], [11, 12],     // 中指
  [9, 13], [13, 14], [14, 15], [15, 16],   // 无名指
  [13, 17], [17, 18], [18, 19], [19, 20],  // 小指
  [0, 17],                                  // 掌心
];

/* ===================== 几何工具 ===================== */

function px(p, f) {
  return { x: p.x * f.w, y: p.y * f.h };
}

// 线段严格相交检测（含端点在线段上，用于蝴蝶结判断）
function segInt(p1, p2, p3, p4) {
  function cross(o, a, b) {
    return (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  }
  function onSeg(o, a, b) {
    return Math.min(a.x, b.x) <= o.x && o.x <= Math.max(a.x, b.x) &&
           Math.min(a.y, b.y) <= o.y && o.y <= Math.max(a.y, b.y);
  }
  const d1 = cross(p3, p4, p1), d2 = cross(p3, p4, p2);
  const d3 = cross(p1, p2, p3), d4 = cross(p1, p2, p4);
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
      ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
  if (d1 === 0 && onSeg(p1, p3, p4)) return true;
  if (d2 === 0 && onSeg(p2, p3, p4)) return true;
  if (d3 === 0 && onSeg(p3, p1, p2)) return true;
  if (d4 === 0 && onSeg(p4, p1, p2)) return true;
  return false;
}

// 多边形有向面积（鞋带公式）的绝对值
function polyArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return Math.abs(s) / 2;
}

// 由左右手关键点构建某块面片的 4 个像素顶点（契约 §5 顺序），不可画返回 null
function quadCorners(f, key) {
  const q = QUADS[key];
  const L = f.hands.left, R = f.hands.right;
  if (!L || !R) return null;

  const A = L.pts[q.a], B = L.pts[q.b];
  const C = R.pts[q.b], D = R.pts[q.a];
  if (!A || !B || !C || !D) return null;

  // [A, B, C, D] = [left.a, left.b, right.b, right.a]
  let pts = [px(A, f), px(B, f), px(C, f), px(D, f)];

  // 蝴蝶结（自交）：两条「跨手」边 (B-C) 与 (D-A) 相交时交换右手 a/b
  if (segInt(pts[1], pts[2], pts[3], pts[0])) {
    pts = [pts[0], pts[1], pts[3], pts[2]];
  }
  return pts;
}

// 顶点包围盒（钳制到画布内）
function boundingBox(pts, w, h) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of pts) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  minX = Math.max(0, Math.floor(minX)); minY = Math.max(0, Math.floor(minY));
  maxX = Math.min(w, Math.ceil(maxX));  maxY = Math.min(h, Math.ceil(maxY));
  return { x: minX, y: minY, w: Math.max(0, maxX - minX), h: Math.max(0, maxY - minY) };
}

function traceQuad(ctx, pts) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

/* ===================== 离屏画布 ===================== */
// srcCanvas：纯背景快照（供三块面片读取像素，避免相互污染）
// tmpCanvas：滤镜结果临时画布
const srcCanvas = document.createElement("canvas");
// willReadFrequently：每帧多次 getImageData 读取背景，提示浏览器优化（消除控制台性能告警）
const srcCtx = srcCanvas.getContext("2d", { willReadFrequently: true });
const tmpCanvas = document.createElement("canvas");
const tmpCtx = tmpCanvas.getContext("2d");
const featherCanvas = document.createElement("canvas"); // 羽化 alpha（四边形 × mask）
const featherCtx = featherCanvas.getContext("2d");

/* ===================== 颜色工具 ===================== */

function lum(r, g, b) {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

// 多段色带插值，t ∈ [0,1]
function ramp(stops, t) {
  t = Math.max(0, Math.min(1, t));
  const seg = t * (stops.length - 1);
  const i = Math.min(Math.floor(seg), stops.length - 2);
  const f = seg - i;
  const a = stops[i], b = stops[i + 1];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

// 确定性颗粒（按坐标，帧间稳定不闪烁），返回 0~1
function grain(x, y) {
  const n = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

/* ===================== B4/B5/B6 滤镜 ===================== */
// 三个滤镜统一签名：原地修改 ImageData.data（RGBA）

// B4 红色半调：网点/颗粒/印刷，亮度分档 → 网点大小
function filterRedHalftone(data, w, h) {
  const cell = 6;                       // 网点间距
  const ink = [255, 92, 92];            // 红色网点
  const bg  = [34, 6, 6];               // 深红近黑底
  for (let y = 0; y < h; y += cell) {
    for (let x = 0; x < w; x += cell) {
      const x2 = Math.min(x + cell, w), y2 = Math.min(y + cell, h);
      let sum = 0, n = 0;
      for (let yy = y; yy < y2; yy++) for (let xx = x; xx < x2; xx++) {
        const i = (yy * w + xx) * 4;
        sum += lum(data[i], data[i + 1], data[i + 2]); n++;
      }
      const t = n ? (sum / n) / 255 : 0;   // 0~1 亮度
      const q = Math.round(t * 4) / 4;      // 亮度分档（4 档）
      const r = (1 - q) * cell * 0.62;      // 越暗网点越大
      const cx = x + cell * 0.5, cy = y + cell * 0.5;
      for (let yy = y; yy < y2; yy++) for (let xx = x; xx < x2; xx++) {
        const i = (yy * w + xx) * 4;
        const dx = xx - cx, dy = yy - cy;
        const inside = (dx * dx + dy * dy) <= r * r;
        data[i]     = inside ? ink[0] : bg[0];
        data[i + 1] = inside ? ink[1] : bg[1];
        data[i + 2] = inside ? ink[2] : bg[2];
        data[i + 3] = 255;
      }
    }
  }
}

// B5 蓝色冷调：双色调（深蓝→电蓝→青白）+ 旧电视扫描线，人物细节清晰
function filterBlueCold(data, w, h) {
  const stops = [
    [10, 16, 48],
    [34, 90, 190],
    [170, 235, 255],
  ];
  for (let y = 0; y < h; y++) {
    const scan = (y % 3 === 0) ? 0.82 : 1.0;   // 扫描线
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = lum(data[i], data[i + 1], data[i + 2]) / 255;
      const c = ramp(stops, t);
      data[i]     = c[0] * scan;
      data[i + 1] = c[1] * scan;
      data[i + 2] = c[2] * scan;
      data[i + 3] = 255;
    }
  }
}

// B6 绿色伪彩：暗部偏青→中部绿→亮部黄绿（非纯绿）+ 纸张颗粒
function filterGreenFalse(data, w, h) {
  const stops = [
    [8, 28, 12],
    [36, 180, 90],
    [214, 250, 120],
  ];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      const t = lum(data[i], data[i + 1], data[i + 2]) / 255;
      const c = ramp(stops, t);
      const gz = 1 + (grain(x, y) - 0.5) * 0.25;   // ±12.5% 颗粒
      data[i]     = Math.min(255, c[0] * gz);
      data[i + 1] = Math.min(255, c[1] * gz);
      data[i + 2] = Math.min(255, c[2] * gz);
      data[i + 3] = 255;
    }
  }
}

// 每块面片固定的滤镜
const FILTERS = {
  red:   filterRedHalftone,
  blue:  filterBlueCold,
  green: filterGreenFalse,
};

/* ===================== 合成管线 ===================== */

function layerBackground(ctx, f) {
  if (srcCanvas.width !== f.w || srcCanvas.height !== f.h) {
    srcCanvas.width = f.w; srcCanvas.height = f.h;
  }
  if (f.video) {
    srcCtx.drawImage(f.video, 0, 0, f.w, f.h);
  } else {
    srcCtx.fillStyle = "#0d0d0f";           // 演示模式深色背景（契约 §7）
    srcCtx.fillRect(0, 0, f.w, f.h);
  }
  ctx.drawImage(srcCanvas, 0, 0);
}

// 羽化参数（px）：四边形软边 / 遮罩柔化
const FEATHER = 8;
const MASK_BLUR = 4;

// 渲染单块面片：包围盒内读背景 → 应用该面片滤镜 → 羽化（blur 四边形 × mask）后画回
function drawFilteredQuad(ctx, f, key) {
  const pts = quadCorners(f, key);
  if (!pts || polyArea(pts) < 1) return;

  // 包围盒向外扩 feather，容纳羽化软边（钳制画布内）
  const box = boundingBox(pts, f.w, f.h);
  // 羽化半径自适应：面片太薄时（如食指↔中指间距很小）减小 blur，避免整块被羽化抹掉
  const feather = Math.max(1, Math.min(FEATHER, Math.min(box.w, box.h) * 0.4));
  const x0 = Math.max(0, box.x - feather);
  const y0 = Math.max(0, box.y - feather);
  const bw = Math.min(f.w, box.x + box.w + feather) - x0;
  const bh = Math.min(f.h, box.y + box.h + feather) - y0;
  if (bw < 1 || bh < 1) return;

  // 1. 背景像素 → 滤镜
  const img = srcCtx.getImageData(x0, y0, bw, bh);
  FILTERS[key](img.data, img.width, img.height);

  // 2. 滤镜结果放入 tmpCanvas
  tmpCanvas.width = bw; tmpCanvas.height = bh;
  tmpCtx.globalCompositeOperation = "source-over";
  tmpCtx.putImageData(img, 0, 0);

  // 3. 羽化 alpha：blur(四边形) [× blur(mask)]
  featherCanvas.width = bw; featherCanvas.height = bh;
  featherCtx.globalCompositeOperation = "source-over";
  featherCtx.clearRect(0, 0, bw, bh);
  featherCtx.fillStyle = "#fff";
  if ("filter" in featherCtx) featherCtx.filter = `blur(${feather}px)`;
  featherCtx.beginPath();
  featherCtx.moveTo(pts[0].x - x0, pts[0].y - y0);
  for (let i = 1; i < pts.length; i++) featherCtx.lineTo(pts[i].x - x0, pts[i].y - y0);
  featherCtx.closePath();
  featherCtx.fill();
  featherCtx.filter = "none";

  if (f.mask) {
    // 遮罩羽化：person 置信度（mask alpha）柔化后与四边形 alpha 相乘
    featherCtx.globalCompositeOperation = "destination-in";
    if ("filter" in featherCtx) featherCtx.filter = `blur(${MASK_BLUR}px)`;
    featherCtx.drawImage(f.mask, x0, y0, bw, bh, 0, 0, bw, bh);
    featherCtx.filter = "none";
  }

  // 4. 用羽化 alpha 裁 tmpCanvas，再画回主画布（无需 clip，边缘自然过渡）
  tmpCtx.globalCompositeOperation = "destination-in";
  tmpCtx.drawImage(featherCanvas, 0, 0);
  ctx.drawImage(tmpCanvas, x0, y0);

  // 5. 淡描边，保持三块面片轮廓可读
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  traceQuad(ctx, pts);
  ctx.strokeStyle = QUAD_COLORS[key];
  ctx.lineWidth = 1.5;
  ctx.stroke();
  ctx.globalAlpha = 1;
}

function layerQuads(ctx, f) {
  const L = f.hands.left, R = f.hands.right;
  if (!L || !R) return;                          // 任一手缺失 → 本帧不画面片
  const B = window.B || {};
  if (B.showFilters === false) return;           // 滤镜关 → 只显示背景
  for (const key of QUAD_KEYS) drawFilteredQuad(ctx, f, key);
}

// 单只手骨架：连线 + 关键点圆点（覆盖在面片之上；深色光晕保证在亮/暗背景上都清晰）
function drawHandSkeleton(ctx, hand, f, color) {
  if (!hand || !hand.pts || hand.pts.length < 21) return;
  const pts = hand.pts;
  const lw = Math.max(2, f.h * 0.004);      // 骨架线宽
  const r = Math.max(2.5, f.h * 0.007);     // 关键点半径

  const traceConnections = () => {
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(pts[a].x * f.w, pts[a].y * f.h);
      ctx.lineTo(pts[b].x * f.w, pts[b].y * f.h);
    }
  };

  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // 1) 深色光晕（略粗）：在亮视频背景下描出暗边，保证骨架可见
  ctx.strokeStyle = "rgba(0, 0, 0, 0.55)";
  ctx.lineWidth = lw + 3;
  traceConnections();
  ctx.stroke();
  ctx.fillStyle = "rgba(0, 0, 0, 0.55)";
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x * f.w, p.y * f.h, r + 1.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // 2) 彩色骨架 + 圆点
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  traceConnections();
  ctx.stroke();
  ctx.fillStyle = color;
  for (const p of pts) {
    ctx.beginPath();
    ctx.arc(p.x * f.w, p.y * f.h, r, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// 手部骨架层：左右手各自独立绘制（单手也显示，便于确认识别状态）
function layerHands(ctx, f) {
  if (f.hands.left)  drawHandSkeleton(ctx, f.hands.left,  f, "#66e0ff"); // 左手：青
  if (f.hands.right) drawHandSkeleton(ctx, f.hands.right, f, "#ffb64d"); // 右手：橙
}

// 每帧渲染入口：背景 → 三面片滤镜 → 手部骨架
function drawFrame(ctx, f) {
  ctx.clearRect(0, 0, f.w, f.h);
  layerBackground(ctx, f);
  layerQuads(ctx, f);
  layerHands(ctx, f);
}

/* ===================== 启动 ===================== */

function setupRender() {
  const AR = window.AR;
  if (!AR) return false;
  const canvas = AR.canvas || document.getElementById("stage");
  if (!canvas) return false;
  const ctx = canvas.getContext("2d");
  AR.setFrameCallback((f) => drawFrame(ctx, f));
  return true;
}

if (!setupRender()) {
  // tracking.js 是 module，首次需从 CDN 下载 MediaPipe（约 10 秒）；
  // 轮询等待 window.AR 就绪后再注册渲染回调。
  const t0 = Date.now();
  const timer = setInterval(() => {
    if (setupRender() || Date.now() - t0 > 30000) clearInterval(timer);
  }, 200);
}
