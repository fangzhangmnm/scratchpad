// Orchestrator: 启动序列 + UI 绑定。

import { Board, GRID_MODES } from "./board.js";
import { InputController } from "./input.js";
import { installPlatformGuards } from "./platform-guards.js";
import { loadAllStrokes, clearAll, setMeta, getMeta } from "./db.js";
import {
  exportPngCurrentView, exportPngAll, exportPdfAll,
  copyPngCurrentView, sharePngAll, isShareSupported,
} from "./export.js";
import { TextManager, ensureKatex } from "./textbox.js";
import type { ToolName, Stroke, TextPlaceRect } from "./types.js";

const THEMES = ["auto", "day", "night"];
const THEME_LABEL: Record<string, string> = { auto: "跟随系统", day: "日", night: "夜" };

const els = {
  board: document.getElementById("board") as HTMLCanvasElement,
  topBar: document.getElementById("topBar") as HTMLElement,
  hud: document.getElementById("hud") as HTMLElement,
  zoomLabel: document.getElementById("zoomLabel") as HTMLElement,
  statusLabel: document.getElementById("statusLabel") as HTMLElement,
  widthSlider: document.getElementById("widthSlider") as HTMLInputElement,
  clearBtn: document.getElementById("clearButton") as HTMLElement,
  pressureBtn: document.getElementById("pressureButton") as HTMLElement,
  menuBtn: document.getElementById("menuButton") as HTMLElement,
  appMenu: document.getElementById("appMenu") as HTMLElement,
  menuVersion: document.getElementById("menuVersion") as HTMLElement,
  menuGrid: document.getElementById("menuGrid") as HTMLElement,
  menuFit: document.getElementById("menuFit") as HTMLElement,
  menuExport: document.getElementById("menuExport") as HTMLElement,
  menuTheme: document.getElementById("menuTheme") as HTMLElement,
  menuSingleFinger: document.getElementById("menuSingleFinger") as HTMLElement,
  menuForceUpdate: document.getElementById("menuForceUpdate") as HTMLElement,
  toolBtns: [...document.querySelectorAll<HTMLElement>(".tool[data-tool]")],
  swatches: [...document.querySelectorAll<HTMLElement>(".swatch[data-color]")],
  exportSheet: document.getElementById("exportSheet") as HTMLElement,
  shareAllBtn: document.getElementById("shareAllBtn") as HTMLElement,
  exportBackdrop: document.getElementById("exportBackdrop") as HTMLElement,
  clearSheet: document.getElementById("clearSheet") as HTMLElement,
  clearBackdrop: document.getElementById("clearBackdrop") as HTMLElement,
  updateToast: document.getElementById("updateToast") as HTMLElement,
  updateReload: document.getElementById("updateToastReload") as HTMLElement,
  updateDismiss: document.getElementById("updateToastDismiss") as HTMLElement,
  textOverlayInner: document.getElementById("textOverlayInner") as HTMLElement,
  textEditorWrap: document.getElementById("textEditorWrap") as HTMLElement,
  textEditor: document.getElementById("textEditor") as HTMLTextAreaElement,
  selBar: document.getElementById("selBar") as HTMLElement,
  selCopy: document.getElementById("selCopy") as HTMLElement,
  selDelete: document.getElementById("selDelete") as HTMLElement,
  selDone: document.getElementById("selDone") as HTMLElement,
};

// 套索子命令排：仅「选择」工具且有选区时浮出 (顶栏下方 pill)。
function refreshSelBar(): void {
  const show = state.tool === "select" && board.selection.length > 0;
  els.selBar.classList.toggle("hidden", !show);
}

function safeLS(key: string, fallback: string | null = null): string | null {
  try { return localStorage.getItem(key); } catch { return fallback; }
}

const state: {
  tool: ToolName;
  color: string;
  width: number;
  pressureEnabled: boolean;
  singleFingerDraw: boolean;
} = {
  tool: "pen",
  color: "ink",
  width: 2.2,
  pressureEnabled: safeLS("scratchpad.pressure") === "1",
  singleFingerDraw: safeLS("scratchpad.singleFingerDraw") === "1",  // 默认关：单指惰性(防手掌误触)，平移走两指
};

const board = new Board(els.board);

const textManager = new TextManager(board, {
  overlayInner: els.textOverlayInner,
  editor: els.textEditor,
  editorWrap: els.textEditorWrap,
  getColor: () => state.color,
  getInkColor: () => readCssColor("--ink"),
  onAdd: (s: Stroke) => { input.history.record({ type: "add", strokes: [s] }); setStatus("文字 · 已添加"); },
  onDelete: (s: Stroke) => { input.history.record({ type: "erase", strokes: [s] }); setStatus("文字 · 已删除"); },
});

// 主题
function readCssColor(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function applyThemeColorsToBoard(): void {
  board.setThemeColors({
    ink: readCssColor("--ink"),
    bg: readCssColor("--bg"),
    line: readCssColor("--line"),
  });
  textManager.refreshThemeColors();
}

let theme: string = localStorage.getItem("scratchpad.theme") || "auto";
if (!THEMES.includes(theme)) theme = "auto";
function applyTheme(t: string): void {
  theme = t;
  document.documentElement.setAttribute("data-theme", t);
  localStorage.setItem("scratchpad.theme", t);
  els.menuTheme.textContent = `主题：${THEME_LABEL[t]}`;
  // 等下一帧让 CSS 变量先生效
  requestAnimationFrame(applyThemeColorsToBoard);
}
applyTheme(theme);
window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme === "auto") requestAnimationFrame(applyThemeColorsToBoard);
});

// 工具按钮
function setTool(t: ToolName): void {
  state.tool = t;
  for (const b of els.toolBtns) b.setAttribute("aria-pressed", b.dataset.tool === t ? "true" : "false");
  document.body.dataset.tool = t;
  // 切离套索 → 弃选区 (高亮/子命令排不残留到别的工具)
  if (t !== "select") board.clearSelection();
  // 切到文字 → 后台懒加载 KaTeX (空载也安全)
  if (t === "text") ensureKatex().catch((err) => { console.error(err); setStatus("KaTeX 加载失败"); });
  refreshSelBar();
}
for (const b of els.toolBtns) {
  b.addEventListener("click", () => setTool(b.dataset.tool as ToolName));
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
function setColor(c: string): void {
  state.color = c;
  for (const s of els.swatches) s.setAttribute("aria-pressed", s.dataset.color === c ? "true" : "false");
}
for (const s of els.swatches) {
  s.addEventListener("click", () => setColor(s.dataset.color as string));
}

// 笔粗
els.widthSlider.addEventListener("input", () => {
  state.width = parseFloat(els.widthSlider.value);
});
state.width = parseFloat(els.widthSlider.value);

// 压感开关 — 默认关。只影响 *新* 笔画的写入 (off 时 pressure=1)，老笔画不变。
function applyPressure(on: boolean): void {
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
// undo/redo 按钮已移除：撤销/重做走键盘 (Ctrl+Z / Ctrl+Shift+Z) + 双指/三指 tap。

// Grid（菜单项，循环切换；菜单保持打开方便连点）
function refreshGridLabel(): void {
  const map: Record<string, string> = { none: "无", dots: "点", squares: "方", lines: "横" };
  els.menuGrid.textContent = `网格：${map[board.gridMode]}`;
}
els.menuGrid.addEventListener("click", () => {
  board.cycleGridMode();
  refreshGridLabel();
  setStatus(`网格 · ${board.gridMode}`);
});
window.addEventListener("sp:gridcycle", () => els.menuGrid.click());

// Fit / reset
els.menuFit.addEventListener("click", () => {
  closeMenu();
  board.resetViewport();
  updateZoomLabel();
  setStatus("回到原点");
});

// Export sheet
function openSheet(sheet: HTMLElement, backdrop: HTMLElement): void {
  backdrop.classList.remove("hidden");
  sheet.classList.remove("hidden");
}
function closeSheet(sheet: HTMLElement, backdrop: HTMLElement): void {
  backdrop.classList.add("hidden");
  sheet.classList.add("hidden");
}
els.menuExport.addEventListener("click", () => {
  closeMenu();
  if (els.shareAllBtn) els.shareAllBtn.hidden = !isShareSupported();
  openSheet(els.exportSheet, els.exportBackdrop);
});
els.exportBackdrop.addEventListener("click", () => closeSheet(els.exportSheet, els.exportBackdrop));
els.exportSheet.addEventListener("click", async (e) => {
  const action = (e.target as HTMLElement).closest<HTMLElement>("[data-export]")?.dataset.export;
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
    const e2 = err as { name?: string; message?: string } | null;
    if (e2 && e2.name === "AbortError") {
      setStatus("已取消");
    } else {
      console.error("export failed", err);
      setStatus(e2?.message?.includes("空") ? "没东西可导出" : "导出失败");
    }
  }
});

// Clear confirm
els.clearBtn.addEventListener("click", () => openSheet(els.clearSheet, els.clearBackdrop));
els.clearBackdrop.addEventListener("click", () => closeSheet(els.clearSheet, els.clearBackdrop));
els.clearSheet.addEventListener("click", async (e) => {
  const a = (e.target as HTMLElement).closest<HTMLElement>("[data-clear]")?.dataset.clear;
  if (!a) return;
  closeSheet(els.clearSheet, els.clearBackdrop);
  if (a !== "confirm") return;
  await clearAll();
  board.setStrokes([]);
  textManager.renderAll();          // 文字浮层也清空
  input.clearHistory();
  setStatus("已烧掉");
});

// ☰ 菜单：开关 / 锚定 / 外部点击 / Esc
function positionMenu(): void {
  const r = els.menuBtn.getBoundingClientRect();
  els.appMenu.style.top = (r.bottom + 6) + "px";
  // 右对齐到按钮右缘，clamp 进视口
  els.appMenu.style.right = Math.max(8, window.innerWidth - r.right) + "px";
}
function openMenu(): void {
  positionMenu();
  els.appMenu.classList.remove("hidden");
  els.menuBtn.setAttribute("aria-expanded", "true");
}
function closeMenu(): void {
  els.appMenu.classList.add("hidden");
  els.menuBtn.setAttribute("aria-expanded", "false");
}
els.menuBtn.addEventListener("click", (e) => {
  e.stopPropagation();
  if (els.appMenu.classList.contains("hidden")) openMenu(); else closeMenu();
});
document.addEventListener("pointerdown", (e) => {
  if (els.appMenu.classList.contains("hidden")) return;
  if (els.appMenu.contains(e.target as Node) || els.menuBtn.contains(e.target as Node)) return;
  closeMenu();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !els.appMenu.classList.contains("hidden")) closeMenu();
});

// 主题：菜单里循环切换 (auto→day→night)，菜单保持打开方便连点
els.menuTheme.addEventListener("click", () => {
  const i = THEMES.indexOf(theme);
  const next = THEMES[(i + 1) % THEMES.length];
  applyTheme(next);
  setStatus(`主题 · ${THEME_LABEL[next]}`);
});

// 单指绘画开关（默认关）：开 = 手指作画；关 = 单指惰性(防手掌误触)，平移走两指。菜单保持打开方便切。
function applySingleFingerDraw(on: boolean): void {
  state.singleFingerDraw = !!on;
  els.menuSingleFinger.textContent = `单指绘画：${state.singleFingerDraw ? "开" : "关"}`;
  try { localStorage.setItem("scratchpad.singleFingerDraw", state.singleFingerDraw ? "1" : "0"); } catch {}
}
els.menuSingleFinger.addEventListener("click", () => {
  applySingleFingerDraw(!state.singleFingerDraw);
  setStatus(`单指绘画 · ${state.singleFingerDraw ? "开" : "关"}`);
});
applySingleFingerDraw(state.singleFingerDraw);

// 强制更新：注销所有 SW + 清空 Cache Storage 后硬重载 (抄 WebPaint menuForcePwaReset)。
// 只清缓存/SW，不动 IndexedDB → 你的画不会丢。藏在菜单里，误触风险低，故不加二次确认。
els.menuForceUpdate.addEventListener("click", async () => {
  closeMenu();
  setStatus("清缓存重启中…", true);
  try {
    if (navigator.serviceWorker) {
      const regs = await navigator.serviceWorker.getRegistrations();
      for (const r of regs) await r.unregister().catch(() => {});
    }
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      for (const k of keys) await caches.delete(k).catch(() => {});
    }
    setTimeout(() => location.reload(), 200);
  } catch (e) {
    const err = e as { message?: string } | null;
    setStatus("清缓存失败：" + (err?.message || err), true);
  }
});

// HUD
function updateZoomLabel(): void {
  els.zoomLabel.textContent = Math.round(board.viewport.scale * 100) + "%";
}
let statusTimer: ReturnType<typeof setTimeout> | null = null;
function setStatus(text: string, persist = false): void {
  els.statusLabel.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  if (!persist) {
    statusTimer = setTimeout(() => { els.statusLabel.textContent = "就绪"; }, 1800);
  }
}

// hook board render → 同步文字浮层 viewport transform / DOM 对账 + 更新 HUD
board.addRenderListener(() => {
  textManager.updateOverlayTransform();
  textManager.syncOverlay();
  updateZoomLabel();
});

// Input controller
const input = new InputController(board, {
  getTool: () => state.tool,
  getColor: () => state.color,
  getWidth: () => state.width,
  getPressureEnabled: () => state.pressureEnabled,
  getSingleFingerDraw: () => state.singleFingerDraw,
  onTextPlace: (rect: TextPlaceRect) => textManager.openEditor(rect),
  onTextDismiss: () => textManager.dismissIfEmpty(),
  onChange: () => {},
  status: setStatus,
});

// ---- 套索选区：board (几何/渲染) ↔ app (文字浮层 / 子命令排) 的挂接 ----
// board 不认识 textManager / DOM / selBar；靠这两个回调回调 app 层。
// 移动 commit 走松手 _commitMove 落库；子命令排提供 复制 / 删除 / 完成 (iPad 无键盘的删除入口)。
board.onStrokesMoved = () => textManager.refreshPositions();   // 移动后文字 DOM 跟上
board.onSelectionChange = () => refreshSelBar();               // 选区增删 → 子命令排显隐

els.selCopy.addEventListener("click", () => input.duplicateSelection());
els.selDelete.addEventListener("click", () => input.deleteSelection());
els.selDone.addEventListener("click", () => board.clearSelection());

// 全局移动端护栏：防系统抢手势 + 防长按弹奇怪对话框 + 切后台清在途指针
installPlatformGuards({ onLostPointers: () => input.cancelAllPointers() });

// 启动
(async function boot(): Promise<void> {
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

// ---- Service worker: 四条 update 检测路径 + 手动 check + 版本水印 ----
// 参考 docs/20260529-pwa-update-detection.md (WebPaint 范式)。
//   路径 1: registration.waiting (开机检查)
//   路径 2: updatefound + statechange === "installed"
//   路径 3: SW 主动 postMessage({ type: "asset-updated" })
//   路径 4: visibilitychange / focus / 10min interval → registration.update()
const LOCAL_DEV_HOSTS = new Set(["localhost", "127.0.0.1", "::1", ""]);
let updateDismissed = false;
let _swRegistration: ServiceWorkerRegistration | null = null;

function showUpdate(): void {
  if (updateDismissed) return;
  els.updateToast?.classList.remove("hidden");
}

// 版本水印：早早写上 (即使 SW 没注册也读 window.SCRATCHPAD_VERSION)
if (els.menuVersion) els.menuVersion.textContent = window.SCRATCHPAD_VERSION || "v?";

const versionLabel = document.getElementById("versionLabel");
if (versionLabel) {
  versionLabel.textContent = window.SCRATCHPAD_VERSION || "v?";
  // 点击 = 手动检测更新
  versionLabel.addEventListener("click", async () => {
    setStatus("检测更新中…", true);
    try {
      // 优先用模块级 _swRegistration (iPad save-to-home-screen 模式下
      // navigator.serviceWorker.getRegistration() 偶尔返 undefined)
      const reg = _swRegistration || await navigator.serviceWorker?.getRegistration();
      if (!reg) { setStatus("Service Worker 未注册"); return; }
      await reg.update();
      setTimeout(() => {
        if (reg.waiting) setStatus("有新版本，点 toast 刷新");
        else setStatus(`已是最新（${window.SCRATCHPAD_VERSION || "v?"}）`);
      }, 1500);
    } catch (e) {
      const err = e as { message?: string } | null;
      setStatus("检测失败：" + (err?.message || err));
    }
  });
}

// 模块顶层 register — 不放 window.load 里 (dynamic import 导致 load 已 fire 完，
// listener 永不触发；详见 docs/20260529-pwa-update-detection.md §0)
if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  // 路径 3: SW 报告 asset 变了
  navigator.serviceWorker.addEventListener("message", (e) => {
    if (e.data?.type === "asset-updated") showUpdate();
  });

  navigator.serviceWorker.register("./service-worker.js").then((registration) => {
    _swRegistration = registration;

    // 路径 1: 开机检查有没有 waiting 的新 SW
    if (registration.waiting && navigator.serviceWorker.controller) {
      showUpdate();
    }

    // 路径 2: 本 session 内装到了新 SW
    registration.addEventListener("updatefound", () => {
      const newWorker = registration.installing;
      if (!newWorker) return;
      newWorker.addEventListener("statechange", () => {
        if (newWorker.state === "installed" && navigator.serviceWorker.controller) {
          showUpdate();
        }
      });
    });

    // 路径 4: 主动 poke 浏览器去 check (反 iOS PWA 不主动)
    const pokeUpdate = () => { registration.update().catch(() => {}); };
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") pokeUpdate();
    });
    window.addEventListener("focus", pokeUpdate);
    setInterval(pokeUpdate, 10 * 60 * 1000);
  }).catch((err) => {
    console.warn("SW register failed", err);
  });
}

// "刷新" 按钮: 推 reg.waiting (不是 controller — 后者是旧 SW，自己已 active，
// skipWaiting 无意义)。听 controllerchange 后再 reload，让新 SW 接管后从新 cache 服务。
// 兜底 5s timeout 防 iOS 偶发不 fire controllerchange。
els.updateReload.addEventListener("click", async () => {
  const reg = _swRegistration || await navigator.serviceWorker?.getRegistration();
  if (!reg || !reg.waiting) { location.reload(); return; }
  let reloaded = false;
  const doReload = () => { if (reloaded) return; reloaded = true; location.reload(); };
  navigator.serviceWorker.addEventListener("controllerchange", doReload, { once: true });
  reg.waiting.postMessage({ type: "skip-waiting" });
  setTimeout(doReload, 5000);
});
els.updateDismiss.addEventListener("click", () => {
  updateDismissed = true;
  els.updateToast.classList.add("hidden");
});

// 时间戳 (文件名用)
function stampStr(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
