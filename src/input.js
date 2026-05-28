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

// 屏幕双击 = 切换 笔/橡皮。
// **只有 pencil 模式下的手指** (penEverSeen=true，touch role=pan) 才触发。
//   - pen 自己不触发：写等号 / i-dot / 短笔画都误判过 (上一版)。Pencil 用户走工具栏切换。
//   - 触屏模式 (无 pen 见过) 的手指也不触发：finger 是绘图主输入，不能跟 dot 冲突。
const TAP_MAX_DURATION = 220;    // ms — 单次按下持续多久还算 tap
const TAP_MAX_MOVE = 16;          // 屏幕 px — 单次 tap 期间允许的位移
const DOUBLETAP_WINDOW = 500;     // ms — 两次 tap 间隔
const DOUBLETAP_MAX_GAP = 80;     // 屏幕 px — 两次 tap 的位置容忍

// 抗抖动：写笔画时的一阶指数平滑。α 越大越接近原始 (主要是写字，不能太糊)。
// α=0.65 大概是：每一新 raw sample 占 65%，历史平滑值占 35%。
// 起笔 / 短点子 (单 tap、i-dot) 几乎不受影响，长划才积累。
const STROKE_SMOOTH_ALPHA = 0.65;

// 压感 LPF (stabilizer)。Pencil 自带 ~10Hz 握笔抖动 (手腕/食指生理频率) 灌进 size
// 会让笔每秒 10 次缩胀 → 视觉结节 / mid-bulb。一阶 IIR damp 之。
// rec.smP = -1 sentinel：第一颗 stamp 用 raw (保 tap 满压)，之后才 LPF。
const PRESSURE_SMOOTH_ALPHA = 0.4;

export class InputController {
  constructor(board, { onChange, getTool, getColor, getWidth, getPressureEnabled, onTextPlace, onTextDismiss, status } = {}) {
    this.board = board;
    this.canvas = board.canvas;
    this.onChange = onChange || (() => {});
    this.getTool = getTool || (() => "pen");
    this.getColor = getColor || (() => "ink");
    this.getWidth = getWidth || (() => 2.2);
    this.getPressureEnabled = getPressureEnabled || (() => false);
    this.onTextPlace = onTextPlace || (() => {});
    this.onTextDismiss = onTextDismiss || (() => {});
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
    if (e.pointerType === "pen") {
      this.penEverSeen = true;
      // pen 落下立即作废任何挂起的 touch tap：
      // 防止 "手指 tap → pen 短笔 → 手指 tap" 三段误判成 finger 双击
      this._lastTap = null;
    }
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

    // 文字工具：拖矩形定 textbox 边界，松手才弹 editor。点击 (< 阈值) = 无操作。
    // 击中已有文字块由浮层 div 自己的 pointerdown 拦截 (stopPropagation)，
    // 走到这里的都是真空白。
    if (tool === "text") {
      this.pointers.set(e.pointerId, {
        pointerType: e.pointerType,
        role: "text-create",
        x, y, startX: x, startY: y,
        downTime: performance.now(),
      });
      this.canvas.setPointerCapture?.(e.pointerId);
      this._textDraft = document.getElementById("textDraftRect");
      this._updateTextDraft(x, y, x, y, true);
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
      // 笔画状态：压感 LPF + 抬笔 fallback + coalesced 单调过滤
      lastP: null,                     // 上一颗有效 raw 压感
      smP: -1,                         // LPF state，-1 = 还没收到首颗
      lastEventTs: -Infinity,          // Safari iOS coalesced 边界回放过滤
    };
    this.pointers.set(e.pointerId, rec);

    if (role === "draw") {
      const { x: wx, y: wy } = this.board.screenToWorld(x, y);
      const pressure = effectivePressureFor(rec, e, this.getPressureEnabled());
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

    if (rec.role === "text-create") {
      this._updateTextDraft(rec.startX, rec.startY, rec.x, rec.y, false);
      e.preventDefault();
      return;
    }

    if (rec.role === "draw") {
      // 用 coalesced events 拿到所有亚帧采样 + 轻量指数平滑
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      const list = (events && events.length) ? events : [e];
      const enabled = this.getPressureEnabled();
      for (const ev of list) {
        // **Safari iOS getCoalescedEvents() 跨批次回放过滤**：每次 pointermove
        // 的 coalesced 列表可能把上一批末尾几个样本回放进来 (eg 上批 t=21 末尾，
        // 下批 t=4..25 又来一遍)。直接用 → 时间回退 → polyline 折返 → arc-length
        // 算法被注水 → 视觉上周期性疏密波。鼠标无此问题 (鼠标 coalesced 通常 ≤1)。
        // 一行 if 挡住。详见 docs/pointer-and-pen-input.md。
        if (ev.timeStamp <= rec.lastEventTs) continue;
        rec.lastEventTs = ev.timeStamp;
        rec.smX += STROKE_SMOOTH_ALPHA * (ev.clientX - rec.smX);
        rec.smY += STROKE_SMOOTH_ALPHA * (ev.clientY - rec.smY);
        const { x: wx, y: wy } = this.board.screenToWorld(rec.smX, rec.smY);
        const pressure = effectivePressureFor(rec, ev, enabled);
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

    if (rec.role === "text-create") {
      // 收尾：drag 够大 → 把屏幕矩形交给 onTextPlace；
      //       小到几乎是点击 → 默默放弃，同时如果挂着一个空 editor 也一起关掉
      if (this._textDraft) this._textDraft.classList.add("hidden");
      const x0 = Math.min(rec.startX, rec.x);
      const y0 = Math.min(rec.startY, rec.y);
      const x1 = Math.max(rec.startX, rec.x);
      const y1 = Math.max(rec.startY, rec.y);
      const sw = x1 - x0, sh = y1 - y0;
      const MIN_DRAG = 24;
      if (sw >= MIN_DRAG || sh >= MIN_DRAG) {
        this.onTextPlace({ sx: x0, sy: y0, sw: Math.max(sw, 60), sh: Math.max(sh, 24) });
      } else {
        this.onTextDismiss();
      }
      return;
    }

    // 屏幕双击 → 切换工具。**只**在 pencil 模式下的手指生效 (palm-rejection 把
    // touch 转 pan 的状态)。pen 自己不参与，触屏主输入模式下的 finger 也不参与。
    let isTap = false;
    const tapEligible = !cancelled && rec.downTime &&
      e.pointerType === "touch" && this.penEverSeen &&
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

  // ---- text-create 矩形预览 ----
  _updateTextDraft(x0, y0, x1, y1, show) {
    if (!this._textDraft) this._textDraft = document.getElementById("textDraftRect");
    const el = this._textDraft;
    if (!el) return;
    const l = Math.min(x0, x1);
    const t = Math.min(y0, y1);
    el.style.left = l + "px";
    el.style.top = t + "px";
    el.style.width = Math.abs(x1 - x0) + "px";
    el.style.height = Math.abs(y1 - y0) + "px";
    if (show) el.classList.remove("hidden");
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
    else if (e.key === "t" || e.key === "T") this._emitTool("text");
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

// 压感取值：
//   - 压感关 → 一律 1.0 (满压感，渲染层会走 uniform 单 path 描边)
//   - mouse → 0.5 (无传感器)
//   - pen / touch：ev.pressure 抬笔瞬间会突然掉 0 (传感器 race)，沿用 rec.lastP
//     避免笔尾突然变粗 / 变细。起手 warmup 也常是 0 但还没 lastP → 退到 0.2
//     (不退 0.5 是怕起手鼓 bulb；WebPaint 同款经验值)。
//   - 算完 raw 后过一道 LPF (rec.smP，α=PRESSURE_SMOOTH_ALPHA)：damp Pencil 自带
//     的 ~10Hz 握笔抖动 + 削传感器尖刺。sentinel rec.smP < 0 = 首颗用 raw
//     (这样 tap / 短点子直接是 raw 满压，不被 LPF 拖)
function effectivePressureFor(rec, e, enabled) {
  if (!enabled) return 1;
  let raw;
  if (e.pointerType === "mouse") {
    raw = 0.5;
  } else {
    const r = typeof e.pressure === "number" ? e.pressure : null;
    if (r == null || r === 0) {
      raw = rec.lastP != null ? rec.lastP : 0.2;
    } else {
      raw = Math.max(0.05, Math.min(1, r));
      rec.lastP = raw;
    }
  }
  if (rec.smP < 0) rec.smP = raw;
  else rec.smP += PRESSURE_SMOOTH_ALPHA * (raw - rec.smP);
  return rec.smP;
}
