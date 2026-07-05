// 共享领域类型。所有模块从这里取 stroke / viewport / bbox 的形状，保证跨文件一致。
// （运行时无内容——纯类型，esbuild strip 后不产码。）

// bbox = [x0, y0, x1, y1]（世界坐标）。
export type BBox = [number, number, number, number];

// 屏幕/世界的点。
export interface Point {
  x: number;
  y: number;
}

// viewport：screen = world * scale + t。
export interface Viewport {
  tx: number;
  ty: number;
  scale: number;
}

// 手写笔画的点串：flat [x, y, pressure, x, y, pressure, ...]（世界坐标）。
// 画的过程中是可 push 的 number[]；endStroke 后转成 Float32Array 省内存。
export type PointArray = Float32Array | number[];

export type GridMode = "none" | "dots" | "squares" | "lines";

export type ToolName = "pen" | "eraser" | "hand" | "text" | "select";

export interface ThemeColors {
  ink: string;
  bg: string;
  line: string;
}

// selectionBBox / computeBoundingBox 的返回形状（世界坐标包围盒）。
export interface WorldBox {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

// ---- Stroke（多态）----
// 手写笔画：无 type 字段（老数据兼容）。文字块：type === "text"。
// 两者共享 id / color / width / bbox，靠 type 判别。

export interface InkStroke {
  id?: number;
  type?: undefined;
  color: string;         // 具体色值，或 "ink" sentinel（渲染时解析成当前主题墨色）
  width: number;
  points: PointArray;    // live 时是 number[]，commit 后是 Float32Array
  bbox: BBox;
}

export interface TextStroke {
  id?: number;
  type: "text";
  x: number;             // 世界坐标左上角
  y: number;
  source: string;        // text 混 $inline$ / $$display$$
  color: string;
  width: number;         // 世界 px 定宽；0 = 自然 pre 撑开
  bbox: BBox;
}

export type Stroke = InkStroke | TextStroke;

// ---- 撤销栈条目 ----
// input.ts 拥有栈；app.ts / textbox 回调也构造 "add" / "erase" 条目推进去。
export type UndoEntry =
  | { type: "add"; strokes: Stroke[] }
  | { type: "erase"; strokes: Stroke[] }
  | { type: "move"; strokes: Stroke[]; dx: number; dy: number };

// ---- 文字工具落点矩形（屏幕坐标）----
// input._up 交给 onTextPlace → TextManager.openEditor 新建 textbox。
export interface TextPlaceRect {
  sx: number;
  sy: number;
  sw: number;
  sh: number;
}
