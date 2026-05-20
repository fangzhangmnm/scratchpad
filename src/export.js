import { drawStroke } from "./board.js";

// 导出 PNG / PDF。
//
// PNG (当前视图 / 全部内容): 离屏 canvas 重渲，再 toBlob → 下载。
// PDF: 同样离屏 canvas → PNG → 用 jspdf 包成单页 PDF (页面尺寸 = 内容尺寸 / 96 dpi 推算英寸)。
//
// jspdf 走动态 import，本地 vendor。第一次导出 PDF 才加载。

const PNG_DPI = 2;          // 当前视图导出 2x，照顾 retina
const PNG_ALL_PADDING = 32; // world units
const PNG_ALL_MAX_DIM = 8192;

export async function exportPngCurrentView(board, fileName = "scratchpad.png") {
  const w = board.canvas.clientWidth;
  const h = board.canvas.clientHeight;
  await renderToPng(board, {
    width: w, height: h, scaleMul: PNG_DPI,
    tx: board.viewport.tx, ty: board.viewport.ty, scale: board.viewport.scale,
  }, fileName);
}

export async function exportPngAll(board, fileName = "scratchpad.png") {
  const bb = board.computeBoundingBox();
  if (!bb) {
    alert("没东西可导出");
    return;
  }
  const pad = PNG_ALL_PADDING;
  const worldW = (bb.x1 - bb.x0) + pad * 2;
  const worldH = (bb.y1 - bb.y0) + pad * 2;
  // 用当前 viewport.scale 作为基准 px-per-unit, 再 *2 抗锯齿，但封顶 8192
  let pxPerUnit = Math.max(1, board.viewport.scale) * 2;
  if (worldW * pxPerUnit > PNG_ALL_MAX_DIM) pxPerUnit = PNG_ALL_MAX_DIM / worldW;
  if (worldH * pxPerUnit > PNG_ALL_MAX_DIM) pxPerUnit = PNG_ALL_MAX_DIM / worldH;
  const w = Math.round(worldW * pxPerUnit);
  const h = Math.round(worldH * pxPerUnit);
  await renderToPng(board, {
    width: w, height: h, scaleMul: 1,
    tx: (-bb.x0 + pad) * pxPerUnit,
    ty: (-bb.y0 + pad) * pxPerUnit,
    scale: pxPerUnit,
    drawGrid: false,
  }, fileName);
}

export async function exportPdfAll(board, fileName = "scratchpad.pdf") {
  const bb = board.computeBoundingBox();
  if (!bb) {
    alert("没东西可导出");
    return;
  }
  const pad = PNG_ALL_PADDING;
  const worldW = (bb.x1 - bb.x0) + pad * 2;
  const worldH = (bb.y1 - bb.y0) + pad * 2;
  // PDF: world unit ≈ CSS px。我们用 96 dpi 推 inch → mm。
  const widthMm = (worldW / 96) * 25.4;
  const heightMm = (worldH / 96) * 25.4;

  // 离屏渲染高分辨率 PNG (3x)
  let pxPerUnit = 3;
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
    drawGrid: false,
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

async function renderToPng(board, opts, fileName) {
  const { width, height, scaleMul } = opts;
  const off = document.createElement("canvas");
  off.width = Math.round(width * scaleMul);
  off.height = Math.round(height * scaleMul);
  const ctx = off.getContext("2d", { alpha: false });
  await renderOffscreen(board, ctx, {
    width: off.width,
    height: off.height,
    tx: opts.tx * scaleMul,
    ty: opts.ty * scaleMul,
    scale: opts.scale * scaleMul,
    drawGrid: opts.drawGrid !== false,
  });
  await new Promise((resolve) => {
    off.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      resolve();
    }, "image/png");
  });
}

async function renderOffscreen(board, ctx, opts) {
  const { width, height, tx, ty, scale } = opts;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = board._bgColor;
  ctx.fillRect(0, 0, width, height);
  const viewport = { tx, ty, scale };
  for (const s of board.strokes) {
    drawStroke(ctx, s, viewport, board._inkColor);
  }
}

// 动态加载本地 vendor 的 jsPDF (UMD, 注册到 window.jspdf)
let _jspdfPromise = null;
function loadJsPdf() {
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = new Promise((resolve, reject) => {
    if (window.jspdf?.jsPDF) {
      resolve(window.jspdf);
      return;
    }
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
