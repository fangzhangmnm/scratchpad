// Orchestrator: 启动序列 + UI 绑定。

import { Board, GRID_MODES } from "./board.js";
import { InputController } from "./input.js";
import { loadAllStrokes, clearAll, setMeta, getMeta } from "./db.js";
import {
  exportPngCurrentView, exportPngAll, exportPdfAll,
  copyPngCurrentView, sharePngAll, isShareSupported,
} from "./export.js";
import { TextManager, ensureKatex } from "./textbox.js";

const THEMES = ["auto", "day", "night"];
const THEME_LABEL = { auto: "跟随系统", day: "日", night: "夜" };

const els = {
  board: document.getElementById("board"),
  topBar: document.getElementById("topBar"),
  hud: document.getElementById("hud"),
  zoomLabel: document.getElementById("zoomLabel"),
  statusLabel: document.getElementById("statusLabel"),
  widthSlider: document.getElementById("widthSlider"),
  undoBtn: document.getElementById("undoButton"),
  redoBtn: document.getElementById("redoButton"),
  gridBtn: document.getElementById("gridButton"),
  fitBtn: document.getElementById("fitButton"),
  exportBtn: document.getElementById("exportButton"),
  clearBtn: document.getElementById("clearButton"),
  themeBtn: document.getElementById("themeButton"),
  pressureBtn: document.getElementById("pressureButton"),
  toolBtns: [...document.querySelectorAll(".tool[data-tool]")],
  swatches: [...document.querySelectorAll(".swatch[data-color]")],
  exportSheet: document.getElementById("exportSheet"),
  shareAllBtn: document.getElementById("shareAllBtn"),
  exportBackdrop: document.getElementById("exportBackdrop"),
  clearSheet: document.getElementById("clearSheet"),
  clearBackdrop: document.getElementById("clearBackdrop"),
  updateToast: document.getElementById("updateToast"),
  updateReload: document.getElementById("updateToastReload"),
  updateDismiss: document.getElementById("updateToastDismiss"),
  textOverlayInner: document.getElementById("textOverlayInner"),
  textEditorWrap: document.getElementById("textEditorWrap"),
  textEditor: document.getElementById("textEditor"),
};

function safeLS(key, fallback) {
  try { return localStorage.getItem(key); } catch { return fallback; }
}

const state = {
  tool: "pen",
  color: "ink",
  width: 2.2,
  pressureEnabled: safeLS("scratchpad.pressure") === "1",
};

const board = new Board(els.board);

const textManager = new TextManager(board, {
  overlayInner: els.textOverlayInner,
  editor: els.textEditor,
  editorWrap: els.textEditorWrap,
  getColor: () => state.color,
  getInkColor: () => readCssColor("--ink"),
  onAdd: (s) => { input._pushUndo({ type: "add", strokes: [s] }); setStatus("文字 · 已添加"); },
  onDelete: (s) => { input._pushUndo({ type: "erase", strokes: [s] }); setStatus("文字 · 已删除"); },
});

// 主题
function readCssColor(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function applyThemeColorsToBoard() {
  board.setThemeColors({
    ink: readCssColor("--ink"),
    bg: readCssColor("--bg"),
    line: readCssColor("--line"),
  });
  textManager.refreshThemeColors();
}

let theme = localStorage.getItem("scratchpad.theme") || "auto";
if (!THEMES.includes(theme)) theme = "auto";
function applyTheme(t) {
  theme = t;
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("scratchpad.theme", t);
  els.themeBtn.title = `主题：${THEME_LABEL[t]}`;
  // 等下一帧让 CSS 变量先生效
  requestAnimationFrame(applyThemeColorsToBoard);
}
applyTheme(theme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme === "auto") requestAnimationFrame(applyThemeColorsToBoard);
});

// 工具按钮
function setTool(t) {
  state.tool = t;
  for (const b of els.toolBtns) b.setAttribute("aria-pressed", b.dataset.tool === t ? "true" : "false");
  document.body.dataset.tool = t;
  // 切到文字 → 后台懒加载 KaTeX (空载也安全)
  if (t === "text") ensureKatex().catch((err) => { console.error(err); setStatus("KaTeX 加载失败"); });
}
for (const b of els.toolBtns) {
  b.addEventListener("click", () => setTool(b.dataset.tool));
}
window.addEventListener("sp:settool", (e) => setTool(e.detail));
// Apple Pencil 屏幕双击 → 笔↔橡皮
window.addEventListener("sp:doubletap", () => {
  const next = state.tool === "eraser" ? "pen" : "eraser";
  setTool(next);
  setStatus(`双击 · ${next === "eraser" ? "橡皮" : "笔"}`);
});
setTool(state.tool);

// 颜色 swatch
function setColor(c) {
  state.color = c;
  for (const s of els.swatches) s.setAttribute("aria-pressed", s.dataset.color === c ? "true" : "false");
}
for (const s of els.swatches) {
  s.addEventListener("click", () => setColor(s.dataset.color));
}

// 笔粗
els.widthSlider.addEventListener("input", () => {
  state.width = parseFloat(els.widthSlider.value);
});
state.width = parseFloat(els.widthSlider.value);

// 压感开关 — 默认关。只影响 *新* 笔画的写入 (off 时 pressure=1)，老笔画不变。
function applyPressure(on) {
  state.pressureEnabled = !!on;
  if (els.pressureBtn) {
    els.pressureBtn.setAttribute("aria-pressed", state.pressureEnabled ? "true" : "false");
    els.pressureBtn.title = `压感（${state.pressureEnabled ? "开" : "关"}）`;
  }
  try { localStorage.setItem("scratchpad.pressure", state.pressureEnabled ? "1" : "0"); } catch {}
}
els.pressureBtn?.addEventListener("click", () => {
  applyPressure(!state.pressureEnabled);
  setStatus(`压感 · ${state.pressureEnabled ? "开" : "关"}`);
});
applyPressure(state.pressureEnabled);

// Undo/Redo
els.undoBtn.addEventListener("click", () => input.undo());
els.redoBtn.addEventListener("click", () => input.redo());
window.addEventListener("sp:histchange", (e) => {
  els.undoBtn.disabled = !e.detail.canUndo;
  els.redoBtn.disabled = !e.detail.canRedo;
});

// Grid
function refreshGridLabel() {
  const map = { none: "无", dots: "点", squares: "方", lines: "横" };
  els.gridBtn.title = `网格：${map[board.gridMode]} (G)`;
}
els.gridBtn.addEventListener("click", () => {
  board.cycleGridMode();
  refreshGridLabel();
  setStatus(`网格 · ${board.gridMode}`);
});
window.addEventListener("sp:gridcycle", () => els.gridBtn.click());

// Fit / reset
els.fitBtn.addEventListener("click", () => {
  board.resetViewport();
  updateZoomLabel();
  setStatus("回到原点");
});

// Export sheet
function openSheet(sheet, backdrop) {
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
}
function closeSheet(sheet, backdrop) {
  backdrop.classList.add("hidden");
  sheet.classList.add("hidden");
}
els.exportBtn.addEventListener("click", () => {
  if (els.shareAllBtn) els.shareAllBtn.hidden = !isShareSupported();
  openSheet(els.exportSheet, els.exportBackdrop);
});
els.exportBackdrop.addEventListener("click", () => closeSheet(els.exportSheet, els.exportBackdrop));
els.exportSheet.addEventListener("click", async (e) => {
  const action = e.target.closest("[data-export]")?.dataset.export;
  if (!action) return;
  closeSheet(els.exportSheet, els.exportBackdrop);
  if (action === "cancel") return;
  setStatus("导出中…");
  try {
    const stamp = stampStr();
    if (action === "copy-view") {
      await copyPngCurrentView(board);
      setStatus("已复制到剪贴板");
    } else if (action === "share-all") {
      await sharePngAll(board, `scratchpad-${stamp}.png`);
      setStatus("已分享");
    } else if (action === "png-view") {
      await exportPngCurrentView(board, `scratchpad-${stamp}.png`);
      setStatus("导出完成");
    } else if (action === "png-all") {
      await exportPngAll(board, `scratchpad-${stamp}.png`);
      setStatus("导出完成");
    } else if (action === "pdf-all") {
      await exportPdfAll(board, `scratchpad-${stamp}.pdf`);
      setStatus("导出完成");
    }
  } catch (err) {
    // 用户取消分享 / 复制失败 / 没东西可导出
    if (err && err.name === "AbortError") {
      setStatus("已取消");
    } else {
      console.error("export failed", err);
      setStatus(err?.message?.includes("空") ? "没东西可导出" : "导出失败");
    }
  }
});

// Clear confirm
els.clearBtn.addEventListener("click", () => openSheet(els.clearSheet, els.clearBackdrop));
els.clearBackdrop.addEventListener("click", () => closeSheet(els.clearSheet, els.clearBackdrop));
els.clearSheet.addEventListener("click", async (e) => {
  const a = e.target.closest("[data-clear]")?.dataset.clear;
  if (!a) return;
  closeSheet(els.clearSheet, els.clearBackdrop);
  if (a !== "confirm") return;
  await clearAll();
  board.setStrokes([]);
  textManager.renderAll();          // 文字浮层也清空
  input.clearHistory();
  setStatus("已烧掉");
});

// Theme cycle
els.themeBtn.addEventListener("click", () => {
  const i = THEMES.indexOf(theme);
  const next = THEMES[(i + 1) % THEMES.length];
  applyTheme(next);
  setStatus(`主题 · ${THEME_LABEL[next]}`);
});

// HUD
function updateZoomLabel() {
  els.zoomLabel.textContent = Math.round(board.viewport.scale * 100) + "%";
}
let statusTimer = null;
function setStatus(text, persist = false) {
  els.statusLabel.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  if (!persist) {
    statusTimer = setTimeout(() => { els.statusLabel.textContent = "就绪"; }, 1800);
  }
}

// hook board render → 同步文字浮层 viewport transform / DOM 对账 + 更新 HUD
const origRender = board.render.bind(board);
board.render = function () {
  origRender();
  textManager.updateOverlayTransform();
  textManager.syncOverlay();
  updateZoomLabel();
};

// Input controller
const input = new InputController(board, {
  getTool: () => state.tool,
  getColor: () => state.color,
  getWidth: () => state.width,
  getPressureEnabled: () => state.pressureEnabled,
  onTextPlace: (rect) => textManager.openEditor(rect),
  onTextDismiss: () => textManager.dismissIfEmpty(),
  onChange: () => {},
  status: setStatus,
});

// 启动
(async function boot() {
  setStatus("加载中…", true);
  try {
    const strokes = await loadAllStrokes();
    // 有 text 笔画就先把 KaTeX 拉起来，渲染浮层
    if (strokes.some((s) => s.type === "text")) {
      await ensureKatex();
    }
    board.setStrokes(strokes);
    await board.restoreViewport();
    textManager.renderAll();
    textManager.updateOverlayTransform();
    refreshGridLabel();
    updateZoomLabel();
    setStatus(strokes.length ? `已加载 ${strokes.length} 笔` : "新草稿");
  } catch (err) {
    console.error("boot failed", err);
    setStatus("加载失败");
  }
  // 触发一次 histchange 初值
  window.dispatchEvent(new CustomEvent("sp:histchange", { detail: { canUndo: false, canRedo: false } }));
})();

// Service worker
if ("serviceWorker" in navigator) {
  const host = location.hostname;
  const isLocal = host === "localhost" || host === "127.0.0.1" || host === "";
  if (!isLocal) {
    navigator.serviceWorker.register("./service-worker.js").catch((err) => {
      console.warn("SW register failed", err);
    });
    navigator.serviceWorker.addEventListener("message", (e) => {
      if (e.data?.type === "asset-updated") {
        els.updateToast.classList.remove("hidden");
      }
    });
  }
}
els.updateReload.addEventListener("click", () => {
  navigator.serviceWorker?.controller?.postMessage({ type: "skip-waiting" });
  location.reload();
});
els.updateDismiss.addEventListener("click", () => {
  els.updateToast.classList.add("hidden");
});

// 时间戳 (文件名用)
function stampStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
