// 文字 + LaTeX 块。区别于手写笔画：
//   - 存的是 source 字符串 (text 混 $inline$ / $$display$$)
//   - 渲染走 DOM 浮层 (textOverlayInner)，不走 canvas
//   - viewport transform 通过 inner div 一次施加，子元素拿世界坐标
//   - 擦除 / 撤销 / 清空跟手写笔画共享同一套 bbox + id 机制
//
// 数据形态:
//   { type: "text", id, x, y, source, color, bbox: [x0,y0,x1,y1] }
// 老的手写笔画没有 type 字段 (兼容)。

import { addStroke, deleteStrokes, putStrokeWithId } from "./db.js";

// ---- KaTeX 懒加载 ----
let _katexPromise = null;
export function ensureKatex() {
  if (_katexPromise) return _katexPromise;
  _katexPromise = new Promise((resolve, reject) => {
    if (!document.getElementById("__katex_css")) {
      const link = document.createElement("link");
      link.id = "__katex_css";
      link.rel = "stylesheet";
      link.href = "./src/vendor/katex/katex.min.css";
      document.head.appendChild(link);
    }
    if (window.katex) { resolve(window.katex); return; }
    const s = document.createElement("script");
    s.src = "./src/vendor/katex/katex.min.js";
    s.onload = () => window.katex ? resolve(window.katex) : reject(new Error("KaTeX 没挂上 window"));
    s.onerror = () => reject(new Error("KaTeX 加载失败"));
    document.head.appendChild(s);
  });
  return _katexPromise;
}

// ---- source 解析 (text + $..$ + $$..$$) ----
// 简单状态机：先看 $$，再看 $。未闭合的 $ 当字面量。
export function parseSource(source) {
  const out = [];
  let i = 0, buf = "";
  while (i < source.length) {
    if (source[i] === "$" && source[i + 1] === "$") {
      const end = source.indexOf("$$", i + 2);
      if (end === -1) { buf += source.slice(i); break; }
      if (buf) { out.push({ mode: "text", text: buf }); buf = ""; }
      out.push({ mode: "math-display", text: source.slice(i + 2, end) });
      i = end + 2;
    } else if (source[i] === "$") {
      const end = source.indexOf("$", i + 1);
      if (end === -1) { buf += source.slice(i); break; }
      if (buf) { out.push({ mode: "text", text: buf }); buf = ""; }
      out.push({ mode: "math-inline", text: source.slice(i + 1, end) });
      i = end + 1;
    } else {
      buf += source[i];
      i++;
    }
  }
  if (buf) out.push({ mode: "text", text: buf });
  return out;
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[ch]);
}

export function renderHtml(source) {
  const parts = parseSource(source);
  return parts.map((p) => {
    if (p.mode === "text") return escapeHtml(p.text);
    const display = p.mode === "math-display";
    try {
      return window.katex.renderToString(p.text, { displayMode: display, throwOnError: false });
    } catch {
      return `<span class="text-stroke-err">${escapeHtml(p.text)}</span>`;
    }
  }).join("");
}

// ---- Manager ----
export class TextManager {
  constructor(board, opts = {}) {
    this.board = board;
    this.overlayInner = opts.overlayInner;
    this.editor = opts.editor;
    this.editorWrap = opts.editorWrap;
    this.getColor = opts.getColor || (() => "ink");
    this.getInkColor = opts.getInkColor || (() => "#1b1b1b");
    this.onAdd = opts.onAdd || (() => {});       // 推 undo
    this.onDelete = opts.onDelete || (() => {}); // 推 undo

    this.editing = null;       // { stroke?, sx, sy, isNew }
    this.elById = new Map();   // stroke.id → DOM 元素

    this.editor.addEventListener("keydown", (e) => this._onEditorKey(e));
    this.editor.addEventListener("blur", () => {
      // blur 也提交 (用户点别处)。但如果是因为 Esc 关掉 editor 触发的 blur，
      // editing 已经清掉了，下面早返回。
      if (this.editing) this._commit();
    });
  }

  // 把所有 type="text" 笔画渲染到浮层 (boot / theme change / clear 后调)
  renderAll() {
    this.overlayInner.innerHTML = "";
    this.elById.clear();
    for (const s of this.board.strokes) {
      if (s.type === "text") this._renderStroke(s);
    }
  }

  // 对账浮层 DOM 和 board.strokes：擦除 / undo / redo / clearAll 都通过这条路
  // 收尾 (input.js 不需要知道 text 块的存在)。每帧 render hook 后调，O(n) 但
  // n 通常很小。
  syncOverlay() {
    // 删：DOM 里有，但 strokes 里找不到的
    if (this.elById.size > 0) {
      const live = new Set();
      for (const s of this.board.strokes) {
        if (s.type === "text" && s.id != null) live.add(s.id);
      }
      for (const [id, el] of this.elById) {
        if (!live.has(id)) { el.remove(); this.elById.delete(id); }
      }
    }
    // 加：strokes 里有 text 块但 DOM 里没的 (eg undo 把刚擦掉的 text 恢复)
    for (const s of this.board.strokes) {
      if (s.type === "text" && s.id != null && !this.elById.has(s.id)) {
        this._renderStroke(s);
      }
    }
  }

  _renderStroke(s) {
    const el = document.createElement("div");
    el.className = "text-stroke";
    el.style.transform = `translate(${s.x}px, ${s.y}px)`;
    el.style.color = s.color === "ink" ? this.getInkColor() : s.color;
    // 用户在 editor 里 resize 过 → 固定 width；否则 pre 自然撑开
    if (s.width && s.width > 0) {
      el.style.width = s.width + "px";
    } else {
      el.style.whiteSpace = "pre";       // 单笔 override CSS 默认的 pre-wrap
    }
    el.dataset.strokeId = s.id ?? "";
    try {
      el.innerHTML = renderHtml(s.source);
    } catch (e) {
      el.innerHTML = `<span class="text-stroke-err">${escapeHtml(s.source)}</span>`;
    }
    this._bindStrokeHandlers(el, s);
    this.overlayInner.appendChild(el);
    this.elById.set(s.id, el);
    // bbox: offsetWidth/Height 不受 transform 影响，等于 1:1 scale 下的 CSS px
    s.bbox = [s.x, s.y, s.x + el.offsetWidth, s.y + el.offsetHeight];
  }

  // 拖 = 移动；点击 (无移动) = 编辑
  _bindStrokeHandlers(el, s) {
    const DRAG_THRESHOLD_SQ = 16;   // 4 px²；超过就当拖动
    let pid = null;
    let startX = 0, startY = 0;     // 屏幕坐标
    let originX = s.x, originY = s.y;
    let moved = false;

    el.addEventListener("pointerdown", (e) => {
      e.stopPropagation();
      pid = e.pointerId;
      startX = e.clientX; startY = e.clientY;
      originX = s.x; originY = s.y;
      moved = false;
      el.setPointerCapture?.(pid);
    });

    el.addEventListener("pointermove", (e) => {
      if (e.pointerId !== pid) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;
      if (!moved && dx * dx + dy * dy < DRAG_THRESHOLD_SQ) return;
      moved = true;
      el.classList.add("dragging");
      // 屏幕位移转世界位移：除以 viewport.scale
      const scale = this.board.viewport.scale;
      s.x = originX + dx / scale;
      s.y = originY + dy / scale;
      el.style.transform = `translate(${s.x}px, ${s.y}px)`;
      // bbox 跟着挪 (宽高不变)
      const w = s.bbox[2] - s.bbox[0];
      const h = s.bbox[3] - s.bbox[1];
      s.bbox = [s.x, s.y, s.x + w, s.y + h];
    });

    el.addEventListener("pointerup", (e) => {
      if (e.pointerId !== pid) return;
      el.releasePointerCapture?.(pid);
      pid = null;
      el.classList.remove("dragging");
      if (moved) {
        // 拖完了，持久化新位置
        putStrokeWithId(s).catch((err) => console.error("text move save failed", err));
      } else {
        // 没动 = 点击 → 编辑
        this.openEditor(s);
      }
    });

    el.addEventListener("pointercancel", () => {
      if (pid != null) {
        el.releasePointerCapture?.(pid);
        pid = null;
      }
      el.classList.remove("dragging");
      // 不撤回位移 (用户体验上拖到哪算哪)；如果有动了，存一下
      if (moved) putStrokeWithId(s).catch(() => {});
    });
  }

  removeStrokeFromOverlay(strokeId) {
    const el = this.elById.get(strokeId);
    if (el) el.remove();
    this.elById.delete(strokeId);
  }

  // 主题切换 / ink 变色：把所有 color === "ink" 的 text-stroke 重染色
  refreshThemeColors() {
    const ink = this.getInkColor();
    for (const [id, el] of this.elById) {
      const s = this.board.strokes.find((x) => x.id === id);
      if (s && s.color === "ink") el.style.color = ink;
    }
  }

  updateOverlayTransform() {
    const { tx, ty, scale } = this.board.viewport;
    this.overlayInner.style.transform = `translate(${tx}px, ${ty}px) scale(${scale})`;
  }

  // ---- 编辑流程 ----

  // arg: 已有 stroke 对象 → 编辑；{ sx, sy } 屏幕坐标 → 新建
  async openEditor(arg) {
    if (this.editing) await this._commit();   // 之前的先收完整
    await ensureKatex();                       // 渲染要 KaTeX

    const scale = this.board.viewport.scale;
    let stroke = null, sx, sy, sw = 0, sh = 0;
    if (arg && arg.type === "text") {
      stroke = arg;
      const sp = this.board.worldToScreen(stroke.x, stroke.y);
      sx = sp.x; sy = sp.y;
      // 把世界宽度转回屏幕宽度，editor 才能"长得"跟最终渲染一样宽
      if (stroke.width && stroke.width > 0) sw = stroke.width * scale;
      const el = this.elById.get(stroke.id);
      if (el) el.style.visibility = "hidden";
    } else {
      sx = arg.sx; sy = arg.sy;
      sw = arg.sw || 0;
      sh = arg.sh || 0;
    }

    this.editing = { stroke, sx, sy, isNew: !stroke };
    this.editor.value = stroke ? stroke.source : "";
    this.editor.style.width = sw > 0 ? sw + "px" : "";
    this.editor.style.height = sh > 0 ? sh + "px" : "";
    this.editorWrap.style.left = `${sx}px`;
    this.editorWrap.style.top = `${sy}px`;
    this.editorWrap.classList.remove("hidden");
    setTimeout(() => {
      this.editor.focus();
      this.editor.setSelectionRange(this.editor.value.length, this.editor.value.length);
    }, 0);
  }

  _closeEditor() {
    if (!this.editing) return;
    const session = this.editing;
    this.editing = null;                   // claim 立即清，避免 blur/再点 重入
    if (session.stroke) {
      const el = this.elById.get(session.stroke.id);
      if (el) el.style.visibility = "";
    }
    this.editorWrap.classList.add("hidden");
  }

  _onEditorKey(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      this._closeEditor();
      return;
    }
    if (e.key === "Enter" && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      this._commit();
      return;
    }
    // Shift+Enter / Ctrl+Enter / Alt+Enter → 换行 (textarea 默认行为)
  }

  async _commit() {
    if (!this.editing) return;
    const session = this.editing;
    this.editing = null;                          // claim 立即清 (blur 再触发时早返回)
    const newSource = this.editor.value;          // 不 trim，前后空白让用户排版
    const trimmed = newSource.trim();

    // editor 是屏幕 px；存 stroke.width 是世界 px (跟 x/y/bbox 同坐标系)。
    // 用户拖小于 min-width + 容差 → 视为没有定宽 (回退到自然 pre 渲染)
    const scale = this.board.viewport.scale || 1;
    const editorW = this.editor.offsetWidth;
    const defaultMinW = parseFloat(getComputedStyle(this.editor).minWidth) || 80;
    const newWidth = editorW > defaultMinW + 4 ? editorW / scale : 0;   // 4 px 浮点容差

    // 隐藏编辑器 + 还原 edit target 的 visibility (≈ _closeEditor 的副作用)
    this.editorWrap.classList.add("hidden");
    if (session.stroke) {
      const el = this.elById.get(session.stroke.id);
      if (el) el.style.visibility = "";
    }

    if (session.isNew) {
      if (!trimmed) return;
      const { x: wx, y: wy } = this.board.screenToWorld(session.sx, session.sy);
      const stroke = {
        type: "text",
        x: wx, y: wy,
        source: newSource,
        color: this.getColor(),
        width: newWidth,
        bbox: [wx, wy, wx, wy],
      };
      try {
        await addStroke(stroke);     // 写入 IDB，回填 id
        this.board.strokes.push(stroke);
        this._renderStroke(stroke);
        this.onAdd(stroke);
      } catch (err) {
        console.error("text add failed", err);
      }
      return;
    }

    const existing = session.stroke;
    if (!trimmed) {
      try {
        await deleteStrokes([existing.id]);
        this.board.strokes = this.board.strokes.filter((x) => x !== existing);
        this.removeStrokeFromOverlay(existing.id);
        this.onDelete(existing);
      } catch (err) {
        console.error("text delete failed", err);
      }
      return;
    }
    if (newSource === existing.source && newWidth === (existing.width || 0)) return;
    const oldSource = existing.source;
    const oldWidth = existing.width;
    existing.source = newSource;
    existing.width = newWidth;
    try {
      await putStrokeWithId(existing);
      this.removeStrokeFromOverlay(existing.id);
      this._renderStroke(existing);
    } catch (err) {
      console.error("text update failed", err);
      existing.source = oldSource;
      existing.width = oldWidth;
    }
  }
}
