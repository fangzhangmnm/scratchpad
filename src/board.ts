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
import { StrokeStore } from "./stroke-store.js";
import type {
  Viewport,
  GridMode,
  ThemeColors,
  WorldBox,
  Point,
  InkStroke,
  Stroke,
} from "./types.js";

export const GRID_MODES: GridMode[] = ["none", "dots", "squares", "lines"]; // 4 档循环
const GRID_SIZE_WORLD = 32; // 一个网格 = 32 world units

export class Board {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  dpr: number;
  store: StrokeStore;
  liveStrokes: Map<number, InkStroke>;
  viewport: Viewport;
  gridMode: GridMode;
  minScale: number;
  maxScale: number;
  _raf: number | null;
  private _inkColor: string;
  private _bgColor: string;
  private _gridColor: string;
  private _selColor: string;
  selection: Stroke[];
  _lassoWorld: number[] | null;
  onSelectionChange: (() => void) | null;
  onStrokesMoved: (() => void) | null;
  _renderListeners: Array<() => void> = []; // 渲染后回调（app 层挂：浮层同步 + HUD 更新），取代旧的 board.render 猴补丁
  _persistViewport: () => void;
  _initialized?: boolean;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false })!;
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.store = new StrokeStore();     // 已 commit 的笔画（唯一属主）
    this.store.onChange = () => this.requestRender();
    this.liveStrokes = new Map();       // pointerId → 正在画的 stroke (未入库)
    this.viewport = { tx: 0, ty: 0, scale: 1 };
    this.gridMode = "dots";
    this.minScale = 0.1;
    this.maxScale = 8;
    this._raf = null;
    this._inkColor = "#1b1b1b";
    this._bgColor = "#f6f4ef";
    this._gridColor = "#d8d2c4";
    this._selColor = "#3a86ff";         // 套索 / 选区高亮色 (主题无关，够醒目即可)

    // ---- 选区 (套索工具) ----
    // selection = 已选中的 stroke 对象数组 (手写 + 文字混装，都靠 id + bbox 统一处理)。
    // _lassoWorld = 正在拖的套索多边形 (世界坐标 flat [x,y,...])，松手即清。
    this.selection = [];
    this._lassoWorld = null;
    this.onSelectionChange = null;      // app 层挂：选区变了 → 重定位删除 chip
    this.onStrokesMoved = null;         // app 层挂：translateStrokes 后 → 刷新文字 DOM 位置

    this.resize();
    window.addEventListener("resize", () => this.resize());
    // iOS / iPad PWA：地址栏 / 状态栏推送或键盘弹出会改 visualViewport，但不一定
    // 触发 window.resize。如果不响应，canvas 内部 pixel buffer 还是旧尺寸被 CSS
    // 拉伸到新 viewport → 渲染像素和 clientX/Y 错位 → 笔迹和落点 drift。借鉴
    // WebPaint v54 教训 (docs/20260529-canvas-resize.md)。
    if (window.visualViewport) {
      window.visualViewport.addEventListener("resize", () => this.resize());
      window.visualViewport.addEventListener("scroll", () => this.resize());
    }
    // 兜底：直接观察 canvas 的 CSS 尺寸变化 (Safari URL bar 推送 / PWA 容器 reflow
    // / 折叠屏旋转等都会动 canvas 而不动 window)
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => this.resize());
      ro.observe(this.canvas);
    }
    this._persistViewport = debounce(() => {
      setMeta("viewport", { ...this.viewport, gridMode: this.gridMode }).catch(() => {});
    }, 300);
  }

  setStrokes(strokes: Stroke[]): void {
    this.store.replace(strokes);   // store emit change → requestRender
  }

  async restoreViewport(): Promise<void> {
    const v = await getMeta("viewport").catch(() => null);
    if (v && typeof v.tx === "number") {
      this.viewport = { tx: v.tx, ty: v.ty, scale: clamp(v.scale, this.minScale, this.maxScale) };
      if (v.gridMode && GRID_MODES.includes(v.gridMode)) this.gridMode = v.gridMode;
    }
    this.requestRender();
  }

  resetViewport(): void {
    this.viewport = { tx: this.canvas.clientWidth / 2, ty: this.canvas.clientHeight / 2, scale: 1 };
    this._persistViewport();
    this.requestRender();
  }

  setGridMode(mode: GridMode): void {
    if (!GRID_MODES.includes(mode)) return;
    this.gridMode = mode;
    this._persistViewport();
    this.requestRender();
  }

  cycleGridMode(): GridMode {
    const i = GRID_MODES.indexOf(this.gridMode);
    this.setGridMode(GRID_MODES[(i + 1) % GRID_MODES.length]);
    return this.gridMode;
  }

  setThemeColors({ ink, bg, line }: ThemeColors): void {
    this._inkColor = ink;
    this._bgColor = bg;
    this._gridColor = line;
    this.requestRender();
  }

  // 主题色快照（导出等外部渲染取色的唯一入口；私有色字段不再外泄）。
  getThemeColors(): ThemeColors {
    return { ink: this._inkColor, bg: this._bgColor, line: this._gridColor };
  }

  // 屏幕 ↔ 世界
  screenToWorld(sx: number, sy: number): Point {
    const { tx, ty, scale } = this.viewport;
    return { x: (sx - tx) / scale, y: (sy - ty) / scale };
  }
  worldToScreen(wx: number, wy: number): Point {
    const { tx, ty, scale } = this.viewport;
    return { x: wx * scale + tx, y: wy * scale + ty };
  }

  // 平移 (屏幕 px 增量)
  pan(dx: number, dy: number): void {
    this.viewport.tx += dx;
    this.viewport.ty += dy;
    this._persistViewport();
    this.requestRender();
  }

  // 以屏幕坐标 anchor 缩放 (factor > 1 放大)
  zoomAt(anchorX: number, anchorY: number, factor: number): void {
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
  setViewport(tx: number, ty: number, scale: number): void {
    this.viewport.tx = tx;
    this.viewport.ty = ty;
    this.viewport.scale = clamp(scale, this.minScale, this.maxScale);
    this._persistViewport();
    this.requestRender();
  }

  // ---- live stroke (画的过程中) ----
  beginStroke(pointerId: number, color: string, width: number, x: number, y: number, pressure: number): InkStroke {
    const s: InkStroke = {
      color,
      width,
      points: [x, y, pressure],
      bbox: [x, y, x, y],
    };
    this.liveStrokes.set(pointerId, s);
    this.requestRender();
    return s;
  }
  extendStroke(pointerId: number, x: number, y: number, pressure: number): void {
    const s = this.liveStrokes.get(pointerId);
    if (!s) return;
    // live stroke 的 points 一定是 number[]
    (s.points as number[]).push(x, y, pressure);
    if (x < s.bbox[0]) s.bbox[0] = x;
    if (y < s.bbox[1]) s.bbox[1] = y;
    if (x > s.bbox[2]) s.bbox[2] = x;
    if (y > s.bbox[3]) s.bbox[3] = y;
    this.requestRender();
  }
  endStroke(pointerId: number): InkStroke | null {
    const s = this.liveStrokes.get(pointerId);
    if (!s) return null;
    this.liveStrokes.delete(pointerId);
    // 转 Float32Array 节省内存
    const arr = new Float32Array(s.points);
    s.points = arr;
    this.store.add(s);
    this.requestRender();
    return s;
  }
  cancelStroke(pointerId: number): void {
    if (this.liveStrokes.has(pointerId)) {
      this.liveStrokes.delete(pointerId);
      this.requestRender();
    }
  }

  // ---- 擦除 (世界半径 r 内的笔画整条删) ----
  hitStrokesAt(wx: number, wy: number, r: number): Stroke[] {
    return this.store.hitTest(wx, wy, r);
  }

  removeStrokesByIds(ids: number[]): void {
    this.store.removeByIds(ids);
  }

  // ---- 选区 (套索) —— 几何深模块 ----
  //
  // 两条 subtype-无关的原语，套索交互全走这两条，input 层不碰"手写 vs 文字"的差异：
  //   1) strokesInPolygon(poly)     区域命中 → 选中集 (hitStrokesAt 的"面"版本)
  //   2) translateStrokes(ss,dx,dy) 平移一批 stroke —— 唯一知道"某类 stroke 世界坐标怎么挪"的地方
  //
  // 几何本体在 StrokeStore.inPolygon / translate；下面两个是 Board 侧的入口 + 副作用。

  // poly = 世界坐标 flat 数组 [x0,y0,x1,y1,...]。返回选中的 stroke 对象数组。
  strokesInPolygon(poly: number[]): Stroke[] {
    return this.store.inPolygon(poly);
  }

  // 唯一的"移动 stroke"choke point。dx/dy = 世界坐标增量。就地改 points/x/y + bbox。
  // 手写 stroke 的 points 是 Float32Array (已 commit)，就地加即可；文字改 x/y。
  translateStrokes(strokes: Stroke[], dx: number, dy: number): void {
    this.store.translate(strokes, dx, dy);            // store emit change → requestRender
    if (this.onStrokesMoved) this.onStrokesMoved();   // 文字 DOM 位置跟着挪
  }

  setSelection(strokes: Stroke[] | null): void {
    this.selection = strokes || [];
    if (this.onSelectionChange) this.onSelectionChange();
    this.requestRender();
  }
  clearSelection(): void {
    if (!this.selection.length && !this._lassoWorld) return;
    this.selection = [];
    this._lassoWorld = null;
    if (this.onSelectionChange) this.onSelectionChange();
    this.requestRender();
  }
  // 选区并集 bbox (世界坐标)；空选区返回 null。命中测试"拖点在选区内 → 移动"用。
  selectionBBox(): WorldBox | null {
    if (!this.selection.length) return null;
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const s of this.selection) {
      if (s.bbox[0] < x0) x0 = s.bbox[0];
      if (s.bbox[1] < y0) y0 = s.bbox[1];
      if (s.bbox[2] > x1) x1 = s.bbox[2];
      if (s.bbox[3] > y1) y1 = s.bbox[3];
    }
    return { x0, y0, x1, y1 };
  }
  // 套索拖动中的多边形 (世界坐标 flat)。null = 没在拖。
  setLasso(worldPoly: number[] | null): void {
    this._lassoWorld = worldPoly;
    this.requestRender();
  }

  // 整体 bbox (导出 "全部内容" 用)
  computeBoundingBox(): WorldBox | null {
    return this.store.boundingBox();
  }

  // ---- 渲染 ----
  resize(): void {
    const w = this.canvas.clientWidth || window.innerWidth;
    const h = this.canvas.clientHeight || window.innerHeight;
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const tw = Math.round(w * dpr);
    const th = Math.round(h * dpr);
    // 没变就不动 — ResizeObserver / visualViewport / window.resize 频繁触发，
    // 多余的 canvas.width = ... 会清空 backing buffer，触发不必要的 reflow
    if (tw === this.canvas.width && th === this.canvas.height && dpr === this.dpr) return;
    this.dpr = dpr;
    this.canvas.width = tw;
    this.canvas.height = th;
    // 第一次启动时 viewport 是 (0,0) → 把世界原点放到屏幕中心
    if (this.viewport.tx === 0 && this.viewport.ty === 0 && !this._initialized) {
      this.viewport.tx = w / 2;
      this.viewport.ty = h / 2;
    }
    this._initialized = true;
    this.requestRender();
  }

  requestRender(): void {
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = null;
      this.render();
    });
  }

  // 注册"渲染后"回调。每帧 render() 末尾按注册顺序依次调用。
  addRenderListener(fn: () => void): void { this._renderListeners.push(fn); }

  private render(): void {
    const ctx = this.ctx;
    const W = this.canvas.width, H = this.canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = this._bgColor;
    ctx.fillRect(0, 0, W, H);

    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);

    this._drawGrid();

    // 视口的 *世界* 边界 (做 bbox 剔除)
    const wView = this._worldViewport();

    this.store.forEach((s) => {
      if (s.type === "text") return;              // 文字块走 DOM 浮层
      if (!aabbIntersect(s.bbox, wView)) return;
      this._drawStroke(s);
    });
    for (const s of this.liveStrokes.values()) {
      this._drawStroke(s);
    }

    this._drawSelection();

    for (const fn of this._renderListeners) fn();
  }

  // 选中 stroke 的 bbox 高亮 + 正在拖的套索多边形。都在屏幕坐标画 (由 world bbox 换算)，
  // 手写和文字统一走 bbox → 文字块也一样描框。
  _drawSelection(): void {
    const ctx = this.ctx;
    const { tx, ty, scale } = this.viewport;

    // 单个并集 AABB 框 (不是每 stroke 一个)。这个框就是移动命中区——input 的 sel-move
    // 判定用的正是 selectionBBox()，所以画框 = 把"能抓哪儿拖"如实画出来 (命中区不变)。
    const bb = this.selectionBBox();
    if (bb) {
      const pad = 5;   // 屏幕 px：框比内容略大一圈，好看清
      const x = bb.x0 * scale + tx - pad;
      const y = bb.y0 * scale + ty - pad;
      const w = (bb.x1 - bb.x0) * scale + pad * 2;
      const h = (bb.y1 - bb.y0) * scale + pad * 2;
      ctx.save();
      ctx.fillStyle = this._selColor;
      ctx.globalAlpha = 0.06;             // 极淡填充：让它读作一块可抓的区域
      ctx.fillRect(x, y, w, h);
      ctx.globalAlpha = 1;
      ctx.strokeStyle = this._selColor;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([5, 4]);
      ctx.strokeRect(x, y, w, h);
      ctx.restore();
    }

    const poly = this._lassoWorld;
    if (poly && poly.length >= 4) {
      ctx.save();
      ctx.strokeStyle = this._selColor;
      ctx.fillStyle = this._selColor;
      ctx.globalAlpha = 0.10;
      ctx.beginPath();
      ctx.moveTo(poly[0] * scale + tx, poly[1] * scale + ty);
      for (let i = 2; i < poly.length; i += 2) {
        ctx.lineTo(poly[i] * scale + tx, poly[i+1] * scale + ty);
      }
      ctx.closePath();
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = 1.25;
      ctx.setLineDash([4, 4]);
      ctx.stroke();
      ctx.restore();
    }
  }

  _worldViewport(): number[] {
    const w = this.canvas.clientWidth || this.canvas.width / this.dpr;
    const h = this.canvas.clientHeight || this.canvas.height / this.dpr;
    const { tx, ty, scale } = this.viewport;
    return [
      (0 - tx) / scale, (0 - ty) / scale,
      (w - tx) / scale, (h - ty) / scale,
    ];
  }

  _drawStroke(s: InkStroke): void {
    drawStroke(this.ctx, s, this.viewport, this._inkColor);
  }

  _drawGrid(): void {
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

export function drawStroke(ctx: CanvasRenderingContext2D, s: InkStroke, viewport: Viewport, inkColor: string): void {
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

function clamp(x: number, lo: number, hi: number): number { return Math.max(lo, Math.min(hi, x)); }

function aabbIntersect(b: readonly number[], v: readonly number[]): boolean {
  // b = [x0,y0,x1,y1], v 同
  return !(b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3]);
}
