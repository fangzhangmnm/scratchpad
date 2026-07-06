import { drawStroke } from "./board.js";
import { renderHtml as renderTextHtml, ensureKatex } from "./textbox.js";
import type { Board } from "./board.js";
import type { TextStroke } from "./types.js";

// 导出 PNG / PDF / 复制到剪贴板 / Web Share。
//
// 分辨率：iPad / 桌面都用，不需要超高分辨率
//   PNG 当前视图: 1.5x DPI
//   PNG 全部:    1.5x viewport scale, 封顶 4096px
//   PDF 全部:    2x viewport scale, 封顶 4096px
//
// jspdf 走动态 import，本地 vendor。第一次导出 PDF 才加载。

const PNG_DPI = 1.5;
const PNG_ALL_PADDING = 32;     // world units
const PNG_ALL_MAX_DIM = 4096;
const PDF_MAX_DIM = 4096;

// ---- 下载入口 ----

export async function exportPngCurrentView(board: Board, fileName = "scratchpad.png"): Promise<void> {
  const blob = await renderCurrentViewBlob(board);
  triggerDownload(blob, fileName);
}

export async function exportPngAll(board: Board, fileName = "scratchpad.png"): Promise<void> {
  const blob = await renderAllBlob(board);
  if (!blob) { alert("没东西可导出"); return; }
  triggerDownload(blob, fileName);
}

export async function exportPdfAll(board: Board, fileName = "scratchpad.pdf"): Promise<void> {
  const bb = board.computeBoundingBox();
  if (!bb) { alert("没东西可导出"); return; }
  const pad = PNG_ALL_PADDING;
  const worldW = (bb.x1 - bb.x0) + pad * 2;
  const worldH = (bb.y1 - bb.y0) + pad * 2;
  const widthMm = (worldW / 96) * 25.4;
  const heightMm = (worldH / 96) * 25.4;

  let pxPerUnit = 2;
  if (worldW * pxPerUnit > PDF_MAX_DIM) pxPerUnit = PDF_MAX_DIM / worldW;
  if (worldH * pxPerUnit > PDF_MAX_DIM) pxPerUnit = PDF_MAX_DIM / worldH;
  const w = Math.round(worldW * pxPerUnit);
  const h = Math.round(worldH * pxPerUnit);

  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const ctx = off.getContext("2d", { alpha: false })!;
  await renderOffscreen(board, ctx, {
    width: w, height: h,
    tx: (-bb.x0 + pad) * pxPerUnit,
    ty: (-bb.y0 + pad) * pxPerUnit,
    scale: pxPerUnit,
  });
  const dataUrl = off.toDataURL("image/png");

  const { jsPDF } = await loadJsPdf();
  const pdf = new jsPDF({
    orientation: widthMm > heightMm ? "landscape" : "portrait",
    unit: "mm",
    format: [widthMm, heightMm],
    compress: true,
  });
  pdf.addImage(dataUrl, "PNG", 0, 0, widthMm, heightMm);
  pdf.save(fileName);
}

// ---- 复制 PNG 到剪贴板 ----

export async function copyPngCurrentView(board: Board): Promise<void> {
  const blob = await renderCurrentViewBlob(board);
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob }),
  ]);
}

export async function copyPngAll(board: Board): Promise<void> {
  const blob = await renderAllBlob(board);
  if (!blob) throw new Error("空");
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob }),
  ]);
}

// ---- Web Share ----

export function isShareSupported(): boolean {
  try {
    const dummy = new File([new Blob()], "x.png", { type: "image/png" });
    return typeof navigator.share === "function" &&
           typeof navigator.canShare === "function" &&
           navigator.canShare({ files: [dummy] });
  } catch { return false; }
}

export async function sharePngAll(board: Board, fileName = "scratchpad.png"): Promise<void> {
  const blob = await renderAllBlob(board);
  if (!blob) throw new Error("空");
  const file = new File([blob], fileName, { type: "image/png" });
  await navigator.share({ files: [file], title: "ScratchPad" });
}

export async function sharePngCurrentView(board: Board, fileName = "scratchpad.png"): Promise<void> {
  const blob = await renderCurrentViewBlob(board);
  const file = new File([blob], fileName, { type: "image/png" });
  await navigator.share({ files: [file], title: "ScratchPad" });
}

// ---- 内部：blob 渲染 ----

async function renderCurrentViewBlob(board: Board): Promise<Blob> {
  const w = board.canvas.clientWidth;
  const h = board.canvas.clientHeight;
  const off = document.createElement("canvas");
  off.width = Math.round(w * PNG_DPI);
  off.height = Math.round(h * PNG_DPI);
  const ctx = off.getContext("2d", { alpha: false })!;
  await renderOffscreen(board, ctx, {
    width: off.width,
    height: off.height,
    tx: board.viewport.tx * PNG_DPI,
    ty: board.viewport.ty * PNG_DPI,
    scale: board.viewport.scale * PNG_DPI,
  });
  return toBlob(off, "image/png");
}

async function renderAllBlob(board: Board): Promise<Blob | null> {
  const bb = board.computeBoundingBox();
  if (!bb) return null;
  const pad = PNG_ALL_PADDING;
  const worldW = (bb.x1 - bb.x0) + pad * 2;
  const worldH = (bb.y1 - bb.y0) + pad * 2;
  let pxPerUnit = Math.max(1, board.viewport.scale) * 1.5;
  if (worldW * pxPerUnit > PNG_ALL_MAX_DIM) pxPerUnit = PNG_ALL_MAX_DIM / worldW;
  if (worldH * pxPerUnit > PNG_ALL_MAX_DIM) pxPerUnit = PNG_ALL_MAX_DIM / worldH;
  const w = Math.round(worldW * pxPerUnit);
  const h = Math.round(worldH * pxPerUnit);
  const off = document.createElement("canvas");
  off.width = w; off.height = h;
  const ctx = off.getContext("2d", { alpha: false })!;
  await renderOffscreen(board, ctx, {
    width: w, height: h,
    tx: (-bb.x0 + pad) * pxPerUnit,
    ty: (-bb.y0 + pad) * pxPerUnit,
    scale: pxPerUnit,
  });
  return toBlob(off, "image/png");
}

async function renderOffscreen(
  board: Board,
  ctx: CanvasRenderingContext2D,
  opts: { width: number; height: number; tx: number; ty: number; scale: number },
): Promise<void> {
  const { width, height, tx, ty, scale } = opts;
  const colors = board.getThemeColors();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = colors.bg;
  ctx.fillRect(0, 0, width, height);
  const viewport = { tx, ty, scale };
  for (const s of board.store.all) {
    if (s.type === "text") continue;   // 先画手写笔画，文字 / LaTeX 块最后叠上
    drawStroke(ctx, s, viewport, colors.ink);
  }
  // 文字块走 html2canvas → 离屏临时 div → 像素 → drawImage 到导出 canvas
  const textStrokes = board.store.all.filter((s): s is TextStroke => s.type === "text");
  if (textStrokes.length) {
    const inkColor = colors.ink;
    await ensureKatex().catch(() => {});
    await ensureHtml2Canvas().catch(() => {});
    // 串行而非并行：html2canvas 内部用临时 iframe，并行会互相干扰
    for (const s of textStrokes) {
      await rasterizeTextStroke(s, ctx, tx, ty, scale, inkColor);
    }
  }
}

// 把一个 text stroke 渲染成 PNG 叠到导出 ctx 上。
// 用 html2canvas 走 DOM tree → 像素，不靠 SVG foreignObject 那套跨浏览器不稳的 hack。
// 流程：建一个跟 live .text-stroke 同样 CSS 的离屏 div → html2canvas → drawImage。
// WYSIWYG：div 用 1:1 自然字号渲染，scale 选项告诉 html2canvas 输出多少 DPI 像素。
async function rasterizeTextStroke(
  s: TextStroke,
  ctx: CanvasRenderingContext2D,
  exportTx: number,
  exportTy: number,
  exportScale: number,
  inkColor: string,
): Promise<void> {
  const html = (() => {
    try { return renderTextHtml(s.source); }
    catch { return s.source.replace(/[<>&]/g, ""); }
  })();
  const color = s.color === "ink" ? inkColor : s.color;
  const fontFamily = '-apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif';

  // 离屏临时元素，跟 live .text-stroke 同样的 CSS
  const wrap = document.createElement("div");
  wrap.style.cssText = "position:absolute;top:-99999px;left:0;pointer-events:none;";
  const target = document.createElement("div");
  target.style.font = `14px/1.5 ${fontFamily}`;
  target.style.color = color;
  if (s.width && s.width > 0) {
    target.style.width = s.width + "px";
    target.style.whiteSpace = "pre-wrap";
    target.style.wordBreak = "break-word";
  } else {
    target.style.whiteSpace = "pre";
  }
  try { target.innerHTML = html; }
  catch { target.textContent = s.source; }
  wrap.appendChild(target);
  document.body.appendChild(wrap);

  try {
    const bitmap = await window.html2canvas!(target, {
      backgroundColor: null,           // 透明
      scale: exportScale,              // 直接出导出分辨率
      logging: false,
      useCORS: true,
    });
    const px = s.x * exportScale + exportTx;
    const py = s.y * exportScale + exportTy;
    ctx.drawImage(bitmap, px, py);
  } catch (e) {
    console.warn("text stroke export failed", e);
  } finally {
    wrap.remove();
  }
}

// ---- html2canvas 懒加载 ----
let _html2canvasPromise: Promise<unknown> | null = null;
function ensureHtml2Canvas(): Promise<unknown> {
  if (_html2canvasPromise) return _html2canvasPromise;
  _html2canvasPromise = new Promise((resolve, reject) => {
    if (window.html2canvas) { resolve(window.html2canvas); return; }
    const s = document.createElement("script");
    s.src = "./src/vendor/html2canvas/html2canvas.min.js";
    s.onload = () => window.html2canvas ? resolve(window.html2canvas) : reject(new Error("html2canvas 没挂上 window"));
    s.onerror = () => reject(new Error("html2canvas 加载失败"));
    document.head.appendChild(s);
  });
  return _html2canvasPromise;
}

function toBlob(canvas: HTMLCanvasElement, type: string): Promise<Blob> {
  return new Promise((resolve) => canvas.toBlob((blob) => resolve(blob!), type));
}

function triggerDownload(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// 动态加载本地 vendor 的 jsPDF (UMD)
let _jspdfPromise: Promise<JsPdfNamespace> | null = null;
function loadJsPdf(): Promise<JsPdfNamespace> {
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = new Promise((resolve, reject) => {
    const ns = window.jspdf;
    if (ns?.jsPDF) { resolve(ns); return; }
    const s = document.createElement("script");
    s.src = "./src/vendor/jspdf.umd.min.js";
    s.onload = () => {
      const loaded = window.jspdf;
      if (loaded?.jsPDF) resolve(loaded);
      else reject(new Error("jsPDF 加载失败"));
    };
    s.onerror = () => reject(new Error("jsPDF 网络失败"));
    document.head.appendChild(s);
  });
  return _jspdfPromise;
}
