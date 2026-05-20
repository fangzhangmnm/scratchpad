// Pointer events + 手势。
//
// 行为矩阵:
//   tool = pen / eraser:
//     pen (Apple Pencil / stylus)     → 画 / 擦
//     touch (手指)                    → 一旦本设备见过 pen，永远忽略 (防误触)；否则单指画
//     2 个 touch 同时按下             → 平移 + pinch 缩放，取消正在画的 stroke
//     mouse 左键                      → 画
//     mouse 中键 / 右键               → 平移
//     按住 space                      → 临时进入 hand (释放回原工具)
//   tool = hand:
//     任何 pointer 拖动               → 平移
//
//   wheel (mac 触控板双指):
//     ctrlKey (pinch)                 → 以光标为中心缩放
//     otherwise                       → 平移 (与浏览器滚动一致)
//
// 撤销: 每画完一笔 / 每擦一批 → 推入 undo stack。redo stack 在新动作时清空。

import { addStroke, deleteStrokes, putStrokeWithId } from "./db.js";

const ERASER_RADIUS_SCREEN = 14; // 屏幕 px

// 屏幕双击 = 切换 笔/橡皮。pen 或 finger 都能触发 (mouse 走键盘 E)。
// 容差按手指 contact 的不精确算 — 触屏指尖中心点可能漂 30-50px。
const TAP_MAX_DURATION = 220;    // ms — 单次按下持续多久还算 tap
const TAP_MAX_MOVE = 16;          // 屏幕 px — 单次 tap 期间允许的位移
const DOUBLETAP_WINDOW = 500;     // ms — 两次 tap 间隔
const DOUBLETAP_MAX_GAP = 80;     // 屏幕 px — 两次 tap 的位置容忍

// 抗抖动：写笔画时的一阶指数平滑。α 越大越接近原始 (主要是写字，不能太糊)。
// α=0.65 大概是：每一新 raw sample 占 65%，历史平滑值占 35%。
// 起笔 / 短点子 (单 tap、i-dot) 几乎不受影响，长划才积累。
const STROKE_SMOOTH_ALPHA = 0.65;

export class InputController {
  constructor(board, { onChange, getTool, getColor, getWidth, getPressureEnabled, status } = {}) {
    this.board = board;
    this.canvas = board.canvas;
    this.onChange = onChange || (() => {});
    this.getTool = getTool || (() => "pen");
    this.getColor = getColor || (() => "ink");
    this.getWidth = getWidth || (() => 2.2);
    this.getPressureEnabled = getPressureEnabled || (() => false);
    this.status = status || (() => {});

    this.pointers = new Map();    // pointerId → {pointerType, role, x, y, pressure, startX, startY}
    this.penEverSeen = false;     // 一旦见过 pen，touch 不再绘
    this.spaceDown = false;
    this.gestureStart = null;     // {dist, midX, midY, vp:{tx,ty,scale}}
    this.eraseSession = null;     // {ids: Set, strokesById: Map<id,stroke>}

    this.undoStack = [];          // [{type:'add'|'erase', strokes: [stroke,...]}]
    this.redoStack = [];
    this._lastTap = null;         // {time, x, y, stroke?} — pen 或 touch 都记

    this._bind();
  }

  _bind() {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._down(e));
    c.addEventListener("pointermove", (e) => this._move(e));
    c.addEventListener("pointerup", (e) => this._up(e));
    c.addEventListener("pointercancel", (e) => this._up(e, true));
    c.addEventListener("pointerleave", (e) => this._up(e, true));
    c.addEventListener("contextmenu", (e) => e.preventDefault());

    c.addEventListener("wheel", (e) => this._wheel(e), { passive: false });

    window.addEventListener("keydown", (e) => this._keydown(e));
    window.addEventListener("keyup", (e) => this._keyup(e));
  }

  _shouldDraw(e) {
    // pencil 时禁触
    if (e.pointerType === "touch" && this.penEverSeen) return false;
    return true;
  }

  _down(e) {
    if (e.pointerType === "pen") this.penEverSeen = true;
    this.canvas.setPointerCapture?.(e.pointerId);

    const tool = this.getTool();
    const x = e.clientX, y = e.clientY;

    // pen 正在画 → 进来的 touch 当掌触忽略 (但仍登记 pointers，便于 up 时清理)
    const penDrawing = [...this.pointers.values()].some(
      (p) => p.pointerType === "pen" && (p.role === "draw" || p.role === "erase"),
    );
    if (e.pointerType === "touch" && penDrawing) {
      this.pointers.set(e.pointerId, { pointerType: e.pointerType, role: "ignore", x, y });
      e.preventDefault();
      return;
    }

    // 第二个 touch 进来 → 进 gesture (pinch / pan)
    const activeTouches = [...this.pointers.values()].filter(
      (p) => p.pointerType === "touch" && p.role !== "ignore",
    );
    if (e.pointerType === "touch" && activeTouches.length >= 1) {
      for (const [pid, p] of this.pointers) {
        if (p.role === "draw") {
          this.board.cancelStroke(pid);
          p.role = "gesture";
        } else if (p.role === "erase") {
          this._commitErase();
          p.role = "gesture";
        }
      }
      this.pointers.set(e.pointerId, { pointerType: e.pointerType, role: "gesture", x, y });
      this._beginGesture();
      e.preventDefault();
      return;
    }

    // 决定角色
    let role = null;
    if (tool === "hand" || this.spaceDown) {
      role = "pan";
    } else if (e.pointerType === "mouse") {
      if (e.button === 0) role = tool === "eraser" ? "erase" : "draw";
      else role = "pan"; // 中键 / 右键
    } else if (e.pointerType === "pen") {
      // 二级按钮 (Apple Pencil 双击 / Wacom 侧键) → erase
      if (e.button === 2 || e.buttons & 2) role = "erase";
      else role = tool === "eraser" ? "erase" : "draw";
    } else if (e.pointerType === "touch") {
      if (!this._shouldDraw(e)) {
        // pencil 模式下手指 → pan
        role = "pan";
      } else {
        role = tool === "eraser" ? "erase" : "draw";
      }
    }

    const rec = {
      pointerType: e.pointerType, role,
      x, y, startX: x, startY: y,
      smX: x, smY: y,                  // 平滑后的屏幕坐标 (draw 用)
      downTime: performance.now(),
    };
    this.pointers.set(e.pointerId, rec);

    if (role === "draw") {
      const { x: wx, y: wy } = this.board.screenToWorld(x, y);
      const pressure = effectivePressure(e, this.getPressureEnabled());
      this.board.beginStroke(e.pointerId, this.getColor(), this.getWidth(), wx, wy, pressure);
    } else if (role === "erase") {
      this._beginErase();
      this._doErase(x, y);
    } else if (role === "pan") {
      document.body.dataset.panning = "1";
    }
    e.preventDefault();
  }

  _move(e) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    rec.x = e.clientX;
    rec.y = e.clientY;

    if (this.gestureStart) {
      this._updateGesture();
      e.preventDefault();
      return;
    }

    if (rec.role === "draw") {
      // 用 coalesced events 拿到所有亚帧采样 + 轻量指数平滑
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      const list = (events && events.length) ? events : [e];
      const enabled = this.getPressureEnabled();
      for (const ev of list) {
        rec.smX += STROKE_SMOOTH_ALPHA * (ev.clientX - rec.smX);
        rec.smY += STROKE_SMOOTH_ALPHA * (ev.clientY - rec.smY);
        const { x: wx, y: wy } = this.board.screenToWorld(rec.smX, rec.smY);
        const pressure = effectivePressure(ev, enabled);
        this.board.extendStroke(e.pointerId, wx, wy, pressure);
      }
    } else if (rec.role === "erase") {
      this._doErase(e.clientX, e.clientY);
    } else if (rec.role === "pan") {
      // 用 movementX/Y 更稳 (pointer capture 时仍然有效)
      const dx = e.movementX || (e.clientX - (rec._lastX ?? e.clientX));
      const dy = e.movementY || (e.clientY - (rec._lastY ?? e.clientY));
      rec._lastX = e.clientX;
      rec._lastY = e.clientY;
      this.board.pan(dx, dy);
    }
    e.preventDefault();
  }

  _up(e, cancelled = false) {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    this.pointers.delete(e.pointerId);
    rec.x = e.clientX;
    rec.y = e.clientY;

    if (rec.role === "gesture") {
      if (this.pointers.size < 2) this._endGesture();
      else this._beginGesture();
      return;
    }

    // 屏幕双击 → 切换工具。pen / touch 都收，mouse 走键盘。
    // gesture / ignore (掌触) 不参与 — 多指 / 掌跟随不该被误判成 tap。
    let isTap = false;
    const tapEligible = !cancelled && rec.downTime &&
      (e.pointerType === "pen" || e.pointerType === "touch") &&
      rec.role !== "gesture" && rec.role !== "ignore";
    if (tapEligible) {
      const now = performance.now();
      const dur = now - rec.downTime;
      const dist = Math.hypot(rec.x - rec.startX, rec.y - rec.startY);
      isTap = dur < TAP_MAX_DURATION && dist < TAP_MAX_MOVE;
      if (isTap) {
        const lt = this._lastTap;
        const isDouble = lt && (now - lt.time) < DOUBLETAP_WINDOW &&
          Math.hypot(rec.startX - lt.x, rec.startY - lt.y) < DOUBLETAP_MAX_GAP;
        if (isDouble) {
          // 取消当前 stroke (还没 endStroke 的情况)
          if (rec.role === "draw") this.board.cancelStroke(e.pointerId);
          else if (rec.role === "erase") this.eraseSession = null;
          // pan 角色无 stroke 可撤
          // 撤销上一笔 tap (如果是 draw 留下来的点)
          if (lt.stroke) {
            this.board.strokes = this.board.strokes.filter((x) => x !== lt.stroke);
            this.board.requestRender();
            if (lt.stroke.id != null) deleteStrokes([lt.stroke.id]).catch(() => {});
            const ui = this.undoStack.findIndex((ent) => ent.type === "add" && ent.strokes.includes(lt.stroke));
            if (ui >= 0) { this.undoStack.splice(ui, 1); this._emitHistChange(); }
          }
          this._lastTap = null;
          window.dispatchEvent(new CustomEvent("sp:doubletap"));
          this.onChange();
          return;
        }
        this._lastTap = { time: now, x: rec.startX, y: rec.startY, stroke: null };
      } else {
        this._lastTap = null;
      }
    }

    if (rec.role === "draw") {
      if (cancelled) {
        this.board.cancelStroke(e.pointerId);
      } else {
        const s = this.board.endStroke(e.pointerId);
        if (s) {
          if (isTap && this._lastTap) this._lastTap.stroke = s;
          addStroke(s).then(() => {
            this._pushUndo({ type: "add", strokes: [s] });
            this.onChange();
          }).catch((err) => {
            console.error("addStroke failed", err);
            this.status("保存失败");
          });
        }
      }
    } else if (rec.role === "erase") {
      this._commitErase();
    } else if (rec.role === "pan") {
      if (![...this.pointers.values()].some((p) => p.role === "pan")) {
        delete document.body.dataset.panning;
      }
    }
  }

  // ---- gesture (2 finger pan + pinch) ----
  _gestureTouches() {
    return [...this.pointers.values()].filter(
      (p) => p.pointerType === "touch" && p.role !== "ignore",
    );
  }
  _beginGesture() {
    const touches = this._gestureTouches();
    if (touches.length < 2) return;
    const [a, b] = touches;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    this.gestureStart = {
      dist,
      midX, midY,
      vp: { ...this.board.viewport },
    };
    document.body.dataset.panning = "1";
  }
  _updateGesture() {
    const touches = this._gestureTouches();
    if (touches.length < 2 || !this.gestureStart) return;
    const [a, b] = touches;
    const dx = b.x - a.x, dy = b.y - a.y;
    const dist = Math.hypot(dx, dy) || 1;
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const g = this.gestureStart;
    const k = dist / g.dist;
    // 新 viewport: 先 pan (mid 漂移), 再围绕 mid 缩放
    let newScale = g.vp.scale * k;
    newScale = Math.max(this.board.minScale, Math.min(this.board.maxScale, newScale));
    const actualK = newScale / g.vp.scale;
    const newTx = midX - (g.midX - g.vp.tx) * actualK;
    const newTy = midY - (g.midY - g.vp.ty) * actualK;
    this.board.setViewport(newTx, newTy, newScale);
  }
  _endGesture() {
    this.gestureStart = null;
    delete document.body.dataset.panning;
  }

  // ---- erase ----
  _beginErase() {
    this.eraseSession = { ids: new Set(), strokes: [] };
  }
  _doErase(sx, sy) {
    if (!this.eraseSession) return;
    const { x: wx, y: wy } = this.board.screenToWorld(sx, sy);
    const r = ERASER_RADIUS_SCREEN / this.board.viewport.scale;
    const hits = this.board.hitStrokesAt(wx, wy, r);
    if (!hits.length) return;
    const newIds = [];
    for (const s of hits) {
      if (s.id == null) continue; // 还未入库 (理论上不会，因为是 strokes 数组里的)
      if (this.eraseSession.ids.has(s.id)) continue;
      this.eraseSession.ids.add(s.id);
      this.eraseSession.strokes.push(s);
      newIds.push(s.id);
    }
    if (newIds.length) {
      this.board.removeStrokesByIds(newIds);
    }
  }
  _commitErase() {
    if (!this.eraseSession) return;
    const sess = this.eraseSession;
    this.eraseSession = null;
    if (!sess.strokes.length) return;
    deleteStrokes([...sess.ids]).then(() => {
      this._pushUndo({ type: "erase", strokes: sess.strokes });
      this.onChange();
    }).catch((err) => {
      console.error("deleteStrokes failed", err);
      this.status("擦除保存失败");
    });
  }

  // ---- wheel ----
  _wheel(e) {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      // pinch
      const factor = Math.exp(-e.deltaY * 0.01);
      this.board.zoomAt(e.clientX, e.clientY, factor);
    } else {
      // 平移
      let dx = -e.deltaX, dy = -e.deltaY;
      if (e.shiftKey && dx === 0) { dx = dy; dy = 0; }
      this.board.pan(dx, dy);
    }
  }

  // ---- keys ----
  _keydown(e) {
    if (e.target && (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA")) return;
    if (e.code === "Space" && !this.spaceDown) {
      this.spaceDown = true;
      document.body.dataset.spacePan = "1";
      e.preventDefault();
      return;
    }
    const z = (e.ctrlKey || e.metaKey);
    if (z && e.code === "KeyZ") {
      if (e.shiftKey) this.redo(); else this.undo();
      e.preventDefault();
      return;
    }
    if (z && e.code === "KeyY") {
      this.redo();
      e.preventDefault();
      return;
    }
    if (e.key === "p" || e.key === "P") this._emitTool("pen");
    else if (e.key === "e" || e.key === "E") this._emitTool("eraser");
    else if (e.key === "h" || e.key === "H") this._emitTool("hand");
    else if (e.key === "g" || e.key === "G") this._emitGridCycle();
    else if (e.key === "0") this.board.resetViewport();
    else if (e.key === "=" || e.key === "+") this.board.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.2);
    else if (e.key === "-" || e.key === "_") this.board.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.2);
  }
  _keyup(e) {
    if (e.code === "Space") {
      this.spaceDown = false;
      delete document.body.dataset.spacePan;
    }
  }
  _emitTool(tool) { window.dispatchEvent(new CustomEvent("sp:settool", { detail: tool })); }
  _emitGridCycle() { window.dispatchEvent(new CustomEvent("sp:gridcycle")); }

  // ---- undo/redo ----
  _pushUndo(entry) {
    this.undoStack.push(entry);
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack.length = 0;
    this._emitHistChange();
  }
  canUndo() { return this.undoStack.length > 0; }
  canRedo() { return this.redoStack.length > 0; }

  async undo() {
    const e = this.undoStack.pop();
    if (!e) return;
    if (e.type === "add") {
      const ids = e.strokes.map((s) => s.id).filter((x) => x != null);
      await deleteStrokes(ids).catch(() => {});
      this.board.removeStrokesByIds(ids);
    } else if (e.type === "erase") {
      // 重新插入（用原 id）
      for (const s of e.strokes) {
        await putStrokeWithId(s).catch(() => {});
        this.board.strokes.push(s);
      }
      this.board.requestRender();
    }
    this.redoStack.push(e);
    this._emitHistChange();
    this.onChange();
  }
  async redo() {
    const e = this.redoStack.pop();
    if (!e) return;
    if (e.type === "add") {
      for (const s of e.strokes) {
        await putStrokeWithId(s).catch(() => {});
        this.board.strokes.push(s);
      }
      this.board.requestRender();
    } else if (e.type === "erase") {
      const ids = e.strokes.map((s) => s.id).filter((x) => x != null);
      await deleteStrokes(ids).catch(() => {});
      this.board.removeStrokesByIds(ids);
    }
    this.undoStack.push(e);
    this._emitHistChange();
    this.onChange();
  }

  clearHistory() {
    this.undoStack.length = 0;
    this.redoStack.length = 0;
    this._emitHistChange();
  }

  _emitHistChange() {
    window.dispatchEvent(new CustomEvent("sp:histchange", {
      detail: { canUndo: this.canUndo(), canRedo: this.canRedo() },
    }));
  }
}

function effectivePressure(e, enabled) {
  // 压感关 → 一律 1.0 (满压感)，渲染层会自动走 uniform 单 path 描边
  if (!enabled) return 1;
  if (e.pointerType === "mouse") return 0.5; // 鼠标没有传感器
  const p = typeof e.pressure === "number" ? e.pressure : 0.5;
  if (p === 0) return 0.5;                   // 起 / 收笔瞬间传感器返 0
  return Math.max(0.05, Math.min(1, p));
}
