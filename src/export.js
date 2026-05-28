import { drawStroke } from "./board.js";
import { renderHtml as renderTextHtml } from "./textbox.js";

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

export async function exportPngCurrentView(board, fileName = "scratchpad.png") {
  const blob = await renderCurrentViewBlob(board);
  triggerDownload(blob, fileName);
}

export async function exportPngAll(board, fileName = "scratchpad.png") {
  const blob = await renderAllBlob(board);
  if (!blob) { alert("没东西可导出"); return; }
  triggerDownload(blob, fileName);
}

export async function exportPdfAll(board, fileName = "scratchpad.pdf") {
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
  const ctx = off.getContext("2d", { alpha: false });
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

export async function copyPngCurrentView(board) {
  const blob = await renderCurrentViewBlob(board);
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob }),
  ]);
}

export async function copyPngAll(board) {
  const blob = await renderAllBlob(board);
  if (!blob) throw new Error("空");
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob }),
  ]);
}

// ---- Web Share ----

export function isShareSupported() {
  try {
    const dummy = new File([new Blob()], "x.png", { type: "image/png" });
    return typeof navigator.share === "function" &&
           typeof navigator.canShare === "function" &&
           navigator.canShare({ files: [dummy] });
  } catch { return false; }
}

export async function sharePngAll(board, fileName = "scratchpad.png") {
  const blob = await renderAllBlob(board);
  if (!blob) throw new Error("空");
  const file = new File([blob], fileName, { type: "image/png" });
  await navigator.share({ files: [file], title: "ScratchPad" });
}

export async function sharePngCurrentView(board, fileName = "scratchpad.png") {
  const blob = await renderCurrentViewBlob(board);
  const file = new File([blob], fileName, { type: "image/png" });
  await navigator.share({ files: [file], title: "ScratchPad" });
}

// ---- 内部：blob 渲染 ----

async function renderCurrentViewBlob(board) {
  const w = board.canvas.clientWidth;
  const h = board.canvas.clientHeight;
  const off = document.createElement("canvas");
  off.width = Math.round(w * PNG_DPI);
  off.height = Math.round(h * PNG_DPI);
  const ctx = off.getContext("2d", { alpha: false });
  await renderOffscreen(board, ctx, {
    width: off.width,
    height: off.height,
    tx: board.viewport.tx * PNG_DPI,
    ty: board.viewport.ty * PNG_DPI,
    scale: board.viewport.scale * PNG_DPI,
  });
  return toBlob(off, "image/png");
}

async function renderAllBlob(board) {
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
  const ctx = off.getContext("2d", { alpha: false });
  await renderOffscreen(board, ctx, {
    width: w, height: h,
    tx: (-bb.x0 + pad) * pxPerUnit,
    ty: (-bb.y0 + pad) * pxPerUnit,
    scale: pxPerUnit,
  });
  return toBlob(off, "image/png");
}

async function renderOffscreen(board, ctx, opts) {
  const { width, height, tx, ty, scale } = opts;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = board._bgColor;
  ctx.fillRect(0, 0, width, height);
  const viewport = { tx, ty, scale };
  for (const s of board.strokes) {
    if (s.type === "text") continue;   // 先画手写笔画，文字 / LaTeX 块最后叠上
    drawStroke(ctx, s, viewport, board._inkColor);
  }
  // 文字块走 SVG foreignObject → image → canvas (并行加载)
  const textStrokes = board.strokes.filter((s) => s.type === "text");
  if (textStrokes.length) {
    const inkColor = board._inkColor;
    await Promise.all(textStrokes.map((s) =>
      rasterizeTextStroke(s, ctx, tx, ty, scale, inkColor)
    ));
  }
}

// 把一个 text stroke 渲染成 PNG 叠到 ctx 上。
// 走 SVG <foreignObject> 包 KaTeX 输出的 HTML → Image → drawImage。
// 字体走浏览器默认 fallback (KaTeX woff2 不会被 SVG image 通道加载)；
// 数学符号大体能认，要 1:1 复刻请直接截图分享。
async function rasterizeTextStroke(s, ctx, tx, ty, scale, inkColor) {
  const html = (() => {
    try { return renderTextHtml(s.source); }
    catch { return s.source.replace(/[<>&]/g, ""); }
  })();
  const color = s.color === "ink" ? inkColor : s.color;
  const fontFamily = '-apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", sans-serif';

  // 用 stroke.bbox 反推 1:1 大小 (offsetWidth/Height 当时存的就是 CSS px = world unit)
  const bw = Math.max(1, Math.ceil(s.bbox[2] - s.bbox[0]));
  const bh = Math.max(1, Math.ceil(s.bbox[3] - s.bbox[1]));
  const renderW = Math.max(1, Math.ceil(bw * scale));
  const renderH = Math.max(1, Math.ceil(bh * scale));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${renderW}" height="${renderH}">` +
    `<foreignObject width="${renderW}" height="${renderH}">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="` +
        `font:14px/1.5 ${fontFamily};color:${color};white-space:pre;` +
        `transform:scale(${scale});transform-origin:0 0;` +
      `">${html}</div>` +
    `</foreignObject></svg>`;

  const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    await new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const sx = s.x * scale + tx;
        const sy = s.y * scale + ty;
        ctx.drawImage(img, sx, sy);
        resolve();
      };
      img.onerror = () => reject(new Error("text stroke svg image load failed"));
      img.src = url;
    });
  } catch (e) {
    console.warn("text stroke export failed", e);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function toBlob(canvas, type) {
  return new Promise((resolve) => canvas.toBlob(resolve, type));
}

function triggerDownload(blob, fileName) {
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
let _jspdfPromise = null;
function loadJsPdf() {
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = new Promise((resolve, reject) => {
    if (window.jspdf?.jsPDF) { resolve(window.jspdf); return; }
    const s = document.createElement("script");
    s.src = "./src/vendor/jspdf.umd.min.js";
    s.onload = () => {
      if (window.jspdf?.jsPDF) resolve(window.jspdf);
      else reject(new Error("jsPDF 加载失败"));
    };
    s.onerror = () => reject(new Error("jsPDF 网络失败"));
    document.head.appendChild(s);
  });
  return _jspdfPromise;
}
