// Board = canvas + viewport + 渲染。
//
// 笔画存 *世界坐标*。viewport = {tx, ty, scale}, screen = world * scale + t.
// scale = 1 时一个 world unit = 一个 CSS px。
//
// 笔画对象 (内存形态):
//   { id, color, width, points: Float32Array [x,y,p,x,y,p,...], bbox: [x0,y0,x1,y1] }
//
// 渲染时按当前主题解析 "ink" → 当前 ink 色 (theme swap 时自动重渲)。

import { getMeta, setMeta, debounce } from "./db.js";

export const GRID_MODES = ["none", "dots", "squares", "lines"]; // 4 档循环
const GRID_SIZE_WORLD = 32; // 一个网格 = 32 world units

export class Board {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.strokes = [];                  // 已 commit 的笔画
    this.liveStrokes = new Map();       // pointerId → 正在画的 stroke (未入库)
    this.viewport = { tx: 0, ty: 0, scale: 1 };
    this.gridMode = "dots";
    this.minScale = 0.1;
    this.maxScale = 8;
    this._raf = null;
    this._inkColor = "#1b1b1b";
    this._bgColor = "#f6f4ef";
    this._gridColor = "#d8d2c4";

    this.resize();
    window.addEventListener("resize", () => this.resize());
    this._persistViewport = debounce(() => {
      setMeta("viewport", { ...this.viewport, gridMode: this.gridMode }).catch(() => {});
    }, 300);
  }

  setStrokes(strokes) {
    this.strokes = strokes.map((s) => ensureBbox(s));
    this.requestRender();
  }

  async restoreViewport() {
    const v = await getMeta("viewport").catch(() => null);
    if (v && typeof v.tx === "number") {
      this.viewport = { tx: v.tx, ty: v.ty, scale: clamp(v.scale, this.minScale, this.maxScale) };
      if (v.gridMode && GRID_MODES.includes(v.gridMode)) this.gridMode = v.gridMode;
    }
    this.requestRender();
  }

  resetViewport() {
    this.viewport = { tx: this.canvas.clientWidth / 2, ty: this.canvas.clientHeight / 2, scale: 1 };
    this._persistViewport();
    this.requestRender();
  }

  setGridMode(mode) {
    if (!GRID_MODES.includes(mode)) return;
    this.gridMode = mode;
    this._persistViewport();
    this.requestRender();
  }

  cycleGridMode() {
    const i = GRID_MODES.indexOf(this.gridMode);
    this.setGridMode(GRID_MODES[(i + 1) % GRID_MODES.length]);
    return this.gridMode;
  }

  setThemeColors({ ink, bg, line }) {
    this._inkColor = ink;
    this._bgColor = bg;
    this._gridColor = line;
    this.requestRender();
  }

  // 屏幕 ↔ 世界
  screenToWorld(sx, sy) {
    const { tx, ty, scale } = this.viewport;
    return { x: (sx - tx) / scale, y: (sy - ty) / scale };
  }
  worldToScreen(wx, wy) {
    const { tx, ty, scale } = this.viewport;
    return { x: wx * scale + tx, y: wy * scale + ty };
  }

  // 平移 (屏幕 px 增量)
  pan(dx, dy) {
    this.viewport.tx += dx;
    this.viewport.ty += dy;
    this._persistViewport();
    this.requestRender();
  }

  // 以屏幕坐标 anchor 缩放 (factor > 1 放大)
  zoomAt(anchorX, anchorY, factor) {
    const oldScale = this.viewport.scale;
    const newScale = clamp(oldScale * factor, this.minScale, this.maxScale);
    if (newScale === oldScale) return;
    const k = newScale / oldScale;
    this.viewport.tx = anchorX - (anchorX - this.viewport.tx) * k;
    this.viewport.ty = anchorY - (anchorY - this.viewport.ty) * k;
    this.viewport.scale = newScale;
    this._persistViewport();
    this.requestRender();
  }

  // 直接设 viewport (gesture pan+zoom 用)
  setViewport(tx, ty, scale) {
    this.viewport.tx = tx;
    this.viewport.ty = ty;
    this.viewport.scale = clamp(scale, this.minScale, this.maxScale);
    this._persistViewport();
    this.requestRender();
  }

  // ---- live stroke (画的过程中) ----
  beginStroke(pointerId, color, width, x, y, pressure) {
    const s = {
      color,
      width,
      points: [x, y, pressure],
      bbox: [x, y, x, y],
    };
    this.liveStrokes.set(pointerId, s);
    this.requestRender();
    return s;
  }
  extendStroke(pointerId, x, y, pressure) {
    const s = this.liveStrokes.get(pointerId);
    if (!s) return;
    s.points.push(x, y, pressure);
    if (x < s.bbox[0]) s.bbox[0] = x;
    if (y < s.bbox[1]) s.bbox[1] = y;
    if (x > s.bbox[2]) s.bbox[2] = x;
    if (y > s.bbox[3]) s.bbox[3] = y;
    this.requestRender();
  }
  endStroke(pointerId) {
    const s = this.liveStrokes.get(pointerId);
    if (!s) return null;
    this.liveStrokes.delete(pointerId);
    // 转 Float32Array 节省内存
    const arr = new Float32Array(s.points);
    s.points = arr;
    this.strokes.push(s);
    this.requestRender();
    return s;
  }
  cancelStroke(pointerId) {
    if (this.liveStrokes.has(pointerId)) {
      this.liveStrokes.delete(pointerId);
      this.requestRender();
    }
  }

  // ---- 擦除 (世界半径 r 内的笔画整条删) ----
  hitStrokesAt(wx, wy, r) {
    const r2 = r * r;
    const hits = [];
    for (const s of this.strokes) {
      // bbox 快筛
      if (wx < s.bbox[0] - r || wx > s.bbox[2] + r ||
          wy < s.bbox[1] - r || wy > s.bbox[3] + r) continue;
      // 逐段精测
      const p = s.points;
      const N = p.length / 3;
      let hit = false;
      if (N === 1) {
        const dx = p[0] - wx, dy = p[1] - wy;
        if (dx*dx + dy*dy <= r2) hit = true;
      } else {
        for (let i = 0; i < N - 1; i++) {
          const ax = p[i*3], ay = p[i*3+1];
          const bx = p[(i+1)*3], by = p[(i+1)*3+1];
          if (segDistSq(wx, wy, ax, ay, bx, by) <= r2) { hit = true; break; }
        }
      }
      if (hit) hits.push(s);
    }
    return hits;
  }

  removeStrokesByIds(ids) {
    if (!ids.length) return;
    const set = new Set(ids);
    this.strokes = this.strokes.filter((s) => !set.has(s.id));
    this.requestRender();
  }

  // 整体 bbox (导出 "全部内容" 用)
  computeBoundingBox() {
    if (!this.strokes.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of this.strokes) {
      if (s.bbox[0] < x0) x0 = s.bbox[0];
      if (s.bbox[1] < y0) y0 = s.bbox[1];
      if (s.bbox[2] > x1) x1 = s.bbox[2];
      if (s.bbox[3] > y1) y1 = s.bbox[3];
    }
    return { x0, y0, x1, y1 };
  }

  // ---- 渲染 ----
  resize() {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = Math.round(w * this.dpr);
    this.canvas.height = Math.round(h * this.dpr);
    // 第一次启动时 viewport 是 (0,0) → 把世界原点放到屏幕中心
    if (this.viewport.tx === 0 && this.viewport.ty === 0 && !this._initialized) {
      this.viewport.tx = w / 2;
      this.viewport.ty = h / 2;
    }
    this._initialized = true;
    this.requestRender();
  }

  requestRender() {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.render();
    });
  }

  render() {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this._bgColor;
    ctx.fillRect(0, 0, W, H);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this._drawGrid();

    // 视口的 *世界* 边界 (做 bbox 剔除)
    const wView = this._worldViewport();

    for (const s of this.strokes) {
      if (!aabbIntersect(s.bbox, wView)) continue;
      this._drawStroke(s);
    }
    for (const s of this.liveStrokes.values()) {
      this._drawStroke(s);
    }
  }

  _worldViewport() {
    const w = this.canvas.clientWidth || this.canvas.width / this.dpr;
    const h = this.canvas.clientHeight || this.canvas.height / this.dpr;
    const { tx, ty, scale } = this.viewport;
    return [
      (0 - tx) / scale, (0 - ty) / scale,
      (w - tx) / scale, (h - ty) / scale,
    ];
  }

  _drawStroke(s) {
    drawStroke(this.ctx, s, this.viewport, this._inkColor);
  }

  _drawGrid() {
    if (this.gridMode === "none") return;
    const ctx = this.ctx;
    const { tx, ty, scale } = this.viewport;
    const w = this.canvas.clientWidth || this.canvas.width / this.dpr;
    const h = this.canvas.clientHeight || this.canvas.height / this.dpr;

    // grid 间距：scale 太小时跳大格，太大时跳小格 — 永远显示 ~16-64 px
    let step = GRID_SIZE_WORLD;
    let stepScreen = step * scale;
    while (stepScreen < 16) { step *= 2; stepScreen *= 2; }
    while (stepScreen > 64) { step /= 2; stepScreen /= 2; }

    const startX = Math.floor((0 - tx) / stepScreen) * stepScreen + tx;
    const startY = Math.floor((0 - ty) / stepScreen) * stepScreen + ty;

    ctx.strokeStyle = this._gridColor;
    ctx.fillStyle = this._gridColor;

    if (this.gridMode === "dots") {
      const r = Math.max(0.5, Math.min(1.5, stepScreen / 40));
      ctx.beginPath();
      for (let x = startX; x < w + stepScreen; x += stepScreen) {
        for (let y = startY; y < h + stepScreen; y += stepScreen) {
          ctx.moveTo(x + r, y);
          ctx.arc(x, y, r, 0, Math.PI * 2);
        }
      }
      ctx.fill();
    } else if (this.gridMode === "squares") {
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = startX; x < w + stepScreen; x += stepScreen) {
        ctx.moveTo(Math.round(x) + 0.5, 0);
        ctx.lineTo(Math.round(x) + 0.5, h);
      }
      for (let y = startY; y < h + stepScreen; y += stepScreen) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
      }
      ctx.stroke();
    } else if (this.gridMode === "lines") {
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let y = startY; y < h + stepScreen; y += stepScreen) {
        ctx.moveTo(0, Math.round(y) + 0.5);
        ctx.lineTo(w, Math.round(y) + 0.5);
      }
      ctx.stroke();
    }

    // 原点十字 (淡，只在 scale 接近 1 时显示)
    if (scale > 0.4 && scale < 4) {
      ctx.strokeStyle = this._gridColor;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(tx - 8, ty); ctx.lineTo(tx + 8, ty);
      ctx.moveTo(tx, ty - 8); ctx.lineTo(tx, ty + 8);
      ctx.stroke();
    }
  }
}

// ---- 渲染 ----
//
// 自动按存的压感数据选路径：
//   uniform (所有 pressure 都 = 1)  → 单条 Path2D 描边 + quadratic 中点平滑
//                                    完全靠浏览器原生 stroke 抗锯齿，最干净
//   variable (有变化)               → 变宽填充丝带 (左右偏移点 + quadratic + 两头圆 cap)
//                                    压感→宽度: (0.3 + 0.7 * p^0.6)，动态范围 ≈3.3x
//
// 压感开关 = 数据层 (写新笔画时 pressure=1)，不是渲染层。

export function drawStroke(ctx, s, viewport, inkColor) {
  const { tx, ty, scale } = viewport;
  const color = s.color === "ink" ? inkColor : s.color;
  const p = s.points;
  const N = p.length / 3;
  if (N === 0) return;

  ctx.fillStyle = color;
  ctx.strokeStyle = color;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // 屏幕坐标
  const sx = new Float64Array(N);
  const sy = new Float64Array(N);
  let uniform = true;
  for (let i = 0; i < N; i++) {
    sx[i] = p[i*3]   * scale + tx;
    sy[i] = p[i*3+1] * scale + ty;
    if (p[i*3+2] !== 1) uniform = false;
  }

  if (uniform) {
    const lw = Math.max(0.5, s.width * scale);
    if (N === 1) {
      ctx.beginPath();
      ctx.arc(sx[0], sy[0], lw * 0.5, 0, Math.PI * 2);
      ctx.fill();
      return;
    }
    ctx.lineWidth = lw;
    ctx.beginPath();
    ctx.moveTo(sx[0], sy[0]);
    for (let i = 1; i < N - 1; i++) {
      const mx = (sx[i] + sx[i+1]) * 0.5;
      const my = (sy[i] + sy[i+1]) * 0.5;
      ctx.quadraticCurveTo(sx[i], sy[i], mx, my);
    }
    ctx.lineTo(sx[N-1], sy[N-1]);
    ctx.stroke();
    return;
  }

  // 压感模式：变宽丝带
  const hw = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    const pr = Math.max(0.05, Math.min(1, p[i*3+2]));
    hw[i] = Math.max(0.25, s.width * (0.3 + 0.7 * Math.pow(pr, 0.6)) * scale * 0.5);
  }

  if (N === 1) {
    ctx.beginPath();
    ctx.arc(sx[0], sy[0], hw[0], 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  const lx = new Float64Array(N), ly = new Float64Array(N);
  const rx = new Float64Array(N), ry = new Float64Array(N);
  for (let i = 0; i < N; i++) {
    let dxT, dyT;
    if (i === 0) { dxT = sx[1] - sx[0]; dyT = sy[1] - sy[0]; }
    else if (i === N - 1) { dxT = sx[N-1] - sx[N-2]; dyT = sy[N-1] - sy[N-2]; }
    else { dxT = sx[i+1] - sx[i-1]; dyT = sy[i+1] - sy[i-1]; }
    const len = Math.hypot(dxT, dyT) || 1;
    const nx = -dyT / len, ny = dxT / len;
    lx[i] = sx[i] + nx * hw[i];
    ly[i] = sy[i] + ny * hw[i];
    rx[i] = sx[i] - nx * hw[i];
    ry[i] = sy[i] - ny * hw[i];
  }

  ctx.beginPath();
  ctx.moveTo(lx[0], ly[0]);
  for (let i = 1; i < N - 1; i++) {
    const mx = (lx[i] + lx[i+1]) * 0.5;
    const my = (ly[i] + ly[i+1]) * 0.5;
    ctx.quadraticCurveTo(lx[i], ly[i], mx, my);
  }
  ctx.lineTo(lx[N-1], ly[N-1]);
  ctx.lineTo(rx[N-1], ry[N-1]);
  for (let i = N - 2; i > 0; i--) {
    const mx = (rx[i] + rx[i-1]) * 0.5;
    const my = (ry[i] + ry[i-1]) * 0.5;
    ctx.quadraticCurveTo(rx[i], ry[i], mx, my);
  }
  ctx.lineTo(rx[0], ry[0]);
  ctx.closePath();
  ctx.fill();

  ctx.beginPath();
  ctx.arc(sx[0],   sy[0],   hw[0],   0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(sx[N-1], sy[N-1], hw[N-1], 0, Math.PI * 2);
  ctx.fill();
}

// ---- 工具函数 ----

function clamp(x, lo, hi) { return Math.max(lo, Math.min(hi, x)); }

function aabbIntersect(b, v) {
  // b = [x0,y0,x1,y1], v 同
  return !(b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3]);
}

function segDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) {
    const ex = px - ax, ey = py - ay;
    return ex*ex + ey*ey;
  }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const ex = px - cx, ey = py - cy;
  return ex*ex + ey*ey;
}

function ensureBbox(s) {
  if (s.bbox && s.bbox.length === 4) return s;
  const p = s.points;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i+1];
    if (x < x0) x0 = x;
    if (y < y0) y0 = y;
    if (x > x1) x1 = x;
    if (y > y1) y1 = y;
  }
  s.bbox = [x0, y0, x1, y1];
  return s;
}
