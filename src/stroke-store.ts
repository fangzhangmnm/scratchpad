// StrokeStore = 笔画文档的唯一属主。strokes 数组 + 全部几何查询 / 变更都在这里，
// Board 不再暴露裸 strokes 数组（input / textbox / export 只经方法访问）。
//
// 笔画存 *世界坐标*。bbox = [x0,y0,x1,y1]（世界坐标）。

import type { Stroke, InkStroke, WorldBox } from "./types.js";

export class StrokeStore {
  // 唯一属主：已 commit 的笔画。private —— 外部只能经方法访问（这是本次重构的核心）。
  private strokes: Stroke[] = [];
  // 变更钩子：任何增删改后触发（Board 挂它 → requestRender）。
  onChange: (() => void) | null = null;

  private _emit(): void { if (this.onChange) this.onChange(); }

  // = 旧 Board.setStrokes：map ensureBbox 后整体替换。
  replace(strokes: Stroke[]): void { this.strokes = strokes.map((s) => ensureBbox(s)); this._emit(); }

  // 追加一条（新 commit 的手写/文字，或 undo/redo 重插）。bbox 已在调用前就绪。
  add(s: Stroke): void { this.strokes.push(s); this._emit(); }

  // = 旧 Board.removeStrokesByIds。
  removeByIds(ids: number[]): void {
    if (!ids.length) return;
    const set = new Set(ids);
    this.strokes = this.strokes.filter((s) => !set.has(s.id!));
    this._emit();
  }

  // 按对象引用删一条（双击撤点 / 文字删除用；旧代码是 strokes.filter(x=>x!==ref)）。
  removeByRef(ref: Stroke): void { this.strokes = this.strokes.filter((s) => s !== ref); this._emit(); }

  // = 旧 Board.translateStrokes 的“数据”部分（就地改 points/x/y + bbox）。
  // 注意：不在这里回调 onStrokesMoved（那是 app 层文字 DOM 的事，留在 Board.translateStrokes）。
  translate(strokes: Stroke[], dx: number, dy: number): void {
    if (!dx && !dy) return;
    for (const s of strokes) {
      if (s.type === "text") { s.x += dx; s.y += dy; }
      else { const p = s.points; for (let i = 0; i < p.length; i += 3) { p[i] += dx; p[i + 1] += dy; } }
      s.bbox = [s.bbox[0] + dx, s.bbox[1] + dy, s.bbox[2] + dx, s.bbox[3] + dy];
    }
    this._emit();
  }

  // ---- 擦除 (世界半径 r 内的笔画整条删) ----
  hitTest(wx: number, wy: number, r: number): Stroke[] {
    const r2 = r * r;
    const hits: Stroke[] = [];
    for (const s of this.strokes) {
      // bbox 快筛 (text 块只用 bbox 命中，不做更精细测试)
      if (wx < s.bbox[0] - r || wx > s.bbox[2] + r ||
          wy < s.bbox[1] - r || wy > s.bbox[3] + r) continue;
      if (s.type === "text") {
        hits.push(s);
        continue;
      }
      // 手写笔画：逐段精测
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

  // ---- 选区 (套索) —— 几何深模块 ----
  //
  // poly = 世界坐标 flat 数组 [x0,y0,x1,y1,...]。返回选中的 stroke 对象数组。
  // 命中语义：手写 = 任一采样点落在多边形内 (你套住了它的一部分)；
  //          文字 = bbox 中心落在多边形内。都先用 bbox 快筛。
  inPolygon(poly: number[]): Stroke[] {
    if (!poly || poly.length < 6) return [];   // 至少 3 点才成面
    let px0 = Infinity, py0 = Infinity, px1 = -Infinity, py1 = -Infinity;
    for (let i = 0; i < poly.length; i += 2) {
      if (poly[i]   < px0) px0 = poly[i];
      if (poly[i]   > px1) px1 = poly[i];
      if (poly[i+1] < py0) py0 = poly[i+1];
      if (poly[i+1] > py1) py1 = poly[i+1];
    }
    const hits: Stroke[] = [];
    for (const s of this.strokes) {
      // bbox 快筛：完全在套索 bbox 外的直接跳过
      if (s.bbox[2] < px0 || s.bbox[0] > px1 || s.bbox[3] < py0 || s.bbox[1] > py1) continue;
      if (s.type === "text") {
        const cx = (s.bbox[0] + s.bbox[2]) / 2;
        const cy = (s.bbox[1] + s.bbox[3]) / 2;
        if (pointInPolygon(cx, cy, poly)) hits.push(s);
        continue;
      }
      const p = s.points;
      const N = p.length / 3;
      for (let i = 0; i < N; i++) {
        if (pointInPolygon(p[i*3], p[i*3+1], poly)) { hits.push(s); break; }
      }
    }
    return hits;
  }

  // 整体 bbox (导出 "全部内容" 用)
  boundingBox(): WorldBox | null {
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

  findById(id: number): Stroke | undefined { return this.strokes.find((s) => s.id === id); }
  forEach(cb: (s: Stroke) => void): void { for (const s of this.strokes) cb(s); }
  get all(): readonly Stroke[] { return this.strokes; }
  get size(): number { return this.strokes.length; }
}

// ---- 工具函数 ----

function segDistSq(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
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

// 射线法：点 (px,py) 是否在多边形 poly (flat [x,y,...]) 内。
function pointInPolygon(px: number, py: number, poly: readonly number[]): boolean {
  let inside = false;
  const n = poly.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = poly[i*2], yi = poly[i*2+1];
    const xj = poly[j*2], yj = poly[j*2+1];
    if (((yi > py) !== (yj > py)) &&
        (px < (xj - xi) * (py - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

function ensureBbox(s: Stroke): Stroke {
  if (s.bbox && s.bbox.length === 4) return s;
  const p = (s as InkStroke).points;
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
