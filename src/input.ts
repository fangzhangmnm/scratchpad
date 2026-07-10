// Pointer events + 手势。
//
// 行为矩阵:
//   tool = pen / eraser:
//     pen (Apple Pencil / stylus)     → 画 / 擦
//     touch (手指)                    → 单指惰性 hold（不画不平移，防手掌误触）；
//                                        「单指绘画」开关开时单指作画。**单指永不平移画布**。
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
import { History } from "./history.js";
import type { ToolName, Viewport, Stroke, TextPlaceRect } from "./types.js";
import type { Board } from "./board.js";

type PointerRole =
  | "draw" | "erase" | "pan" | "hold" | "gesture"
  | "ignore" | "lasso" | "sel-move" | "text-create";

// A single tracked pointer. Many fields are role-specific → optional. Keep it broad.
interface PointerRec {
  pointerType: string;
  role: PointerRole | null;
  x: number;
  y: number;
  startX?: number;
  startY?: number;
  smX?: number;
  smY?: number;
  downTime?: number;
  lastSeen?: number;
  lastP?: number | null;
  smP?: number;
  lastEventTs?: number;
  lastAcceptedX?: number;
  lastAcceptedY?: number;
  minSampleDistSq?: number;
  lastX?: number;
  lastY?: number;
  totalDx?: number;
  totalDy?: number;
  moved?: boolean;
  _panEngaged?: boolean;
  _lastX?: number;
  _lastY?: number;
}

interface InputOptions {
  onChange?: () => void;
  getTool?: () => ToolName;
  getColor?: () => string;
  getWidth?: () => number;
  getPressureEnabled?: () => boolean;
  getSingleFingerDraw?: () => boolean;
  onTextPlace?: (rect: TextPlaceRect) => void;
  onTextDismiss?: () => void;
  status?: (text: string, persist?: boolean) => void;
}

const ERASER_RADIUS_SCREEN = 14; // 屏幕 px

// 屏幕双击 = 切换 笔/橡皮（手指双击；单指现在惰性 hold，双击只在见过 Pencil 的设备上才切工具）。
//   - pen 自己不触发：写等号 / i-dot / 短笔画都误判过 (上一版)。Pencil 用户走工具栏切换。
//   - 没见过 pen 的设备不触发 (penEverSeen=false)：走工具栏 / 键盘切换。
const TAP_MAX_DURATION = 220;    // ms — 单次按下持续多久还算 tap
const TAP_MAX_MOVE = 16;          // 屏幕 px — 单次 tap 期间允许的位移
const DOUBLETAP_WINDOW = 500;     // ms — 两次 tap 间隔
const DOUBLETAP_MAX_GAP = 80;     // 屏幕 px — 两次 tap 的位置容忍

// 多指 tap (Procreate 方言)：双指 = 撤销，三指 = 重做
const GESTURE_TAP_MAX_MS = 250;
const GESTURE_TAP_MAX_MOVE_SQ = 256;   // 16 px²

// ghost pointer 自愈：iOS 偶尔吞掉 pointerup，残留一个"鬼指针"会和下一个真触点
// 凑成"两指"→ 松手时误判成双指撤销。新触点落下前，清掉超过此时长没动过的旧 touch。
const GHOST_POINTER_TIMEOUT_MS = 1500;

// 掌触防误撤销：手掌搁屏 = ≥2 个 touch 触点，与真双指物理不可分。写字前后手掌一抖/闪灭
// 就凑成"双指 tap"→ 误 undo。策略：笔尖活动（落/移/抬）后这段时间内的多指 tap 一律
// 视作掌触 flicker，吞掉不撤销/重做。写字节奏里手掌抖动全落此窗口；真想撤销时笔尖离屏
// > 此时长再双指 tap 照常生效。只挡 tap，pinch/pan 缩放平移不受影响。
const PALM_PEN_GUARD_MS = 600;

// 触屏单指 pan 死区：手指移动超过此距离才真正开始平移。让"双指 tap 撤销"里先落的
// 那根手指在第二指到来前不把画面挪走 → 双指 tap 零位移、和 panning 不再打架。
const PAN_TOUCH_DEADZONE_SQ = 36;   // 6 px²

// 抗抖动：写笔画时的一阶指数平滑。α 越大越接近原始 (主要是写字，不能太糊)。
// α=0.65 大概是：每一新 raw sample 占 65%，历史平滑值占 35%。
// 起笔 / 短点子 (单 tap、i-dot) 几乎不受影响，长划才积累。
const STROKE_SMOOTH_ALPHA = 0.65;

// 点采样间距门限：相邻样本距离小于 (笔宽 × 因子) 屏幕 px 时跳过。
// 笔宽 2.2 → 阈值 0.55 px；笔宽 12 → 阈值 3 px。够 ribbon 渲染平滑，省内存。
const MIN_SAMPLE_DIST_FACTOR = 0.25;

// 压感 LPF (stabilizer)。Pencil 自带 ~10Hz 握笔抖动 (手腕/食指生理频率) 灌进 size
// 会让笔每秒 10 次缩胀 → 视觉结节 / mid-bulb。一阶 IIR damp 之。
// rec.smP = -1 sentinel：第一颗 stamp 用 raw (保 tap 满压)，之后才 LPF。
const PRESSURE_SMOOTH_ALPHA = 0.4;

export class InputController {
  board: Board;
  canvas: HTMLCanvasElement;
  onChange: () => void;
  getTool: () => ToolName;
  getColor: () => string;
  getWidth: () => number;
  getPressureEnabled: () => boolean;
  getSingleFingerDraw: () => boolean;
  onTextPlace: (rect: TextPlaceRect) => void;
  onTextDismiss: () => void;
  status: (text: string, persist?: boolean) => void;
  pointers: Map<number, PointerRec>;
  penEverSeen: boolean;
  spaceDown: boolean;
  gestureStart: { dist: number; midX: number; midY: number; vp: Viewport } | null;
  _gestureTap: { startTime: number; firstDownTime: number; isTap: boolean; maxCount: number; startPositions: Record<number, { x: number; y: number }> } | null;
  eraseSession: { ids: Set<number>; strokes: Stroke[] } | null;
  history: History;
  _lastTap: { time: number; x: number; y: number; stroke: Stroke | null } | null;
  _lastPenActivity: number;
  _lassoPts: number[] | null = null;
  _textDraft: HTMLElement | null = null;

  constructor(board: Board, { onChange, getTool, getColor, getWidth, getPressureEnabled, getSingleFingerDraw, onTextPlace, onTextDismiss, status }: InputOptions = {}) {
    this.board = board;
    this.canvas = board.canvas;
    this.onChange = onChange || (() => {});
    this.getTool = getTool || (() => "pen");
    this.getColor = getColor || (() => "ink");
    this.getWidth = getWidth || (() => 2.2);
    this.getPressureEnabled = getPressureEnabled || (() => false);
    this.getSingleFingerDraw = getSingleFingerDraw || (() => false);
    this.onTextPlace = onTextPlace || (() => {});
    this.onTextDismiss = onTextDismiss || (() => {});
    this.status = status || (() => {});

    this.pointers = new Map();    // pointerId → {pointerType, role, x, y, pressure, startX, startY}
    this.penEverSeen = false;     // 见过 pen 的设备才启用"手指双击切笔/橡皮"(手指本就恒 pan)
    this.spaceDown = false;
    this.gestureStart = null;     // {dist, midX, midY, vp:{tx,ty,scale}}
    this._gestureTap = null;      // {startTime, isTap, maxCount, startPositions} — 多指 tap 判定
    this.eraseSession = null;     // {ids: Set, strokesById: Map<id,stroke>}

    this.history = new History();  // [{type:'add'|'erase', strokes: [stroke,...]}]
    this.history.onChange = () => this._emitHistChange();
    this._lastTap = null;         // {time, x, y, stroke?} — pen 或 touch 都记
    this._lastPenActivity = -Infinity;  // 最近一次笔尖落/移/抬的时刻 (ms)。掌触 tap 门用

    this._bind();
  }

  _bind(): void {
    const c = this.canvas;
    c.addEventListener("pointerdown", (e) => this._down(e));
    c.addEventListener("pointermove", (e) => this._move(e));
    c.addEventListener("pointerup", (e) => this._up(e));
    c.addEventListener("pointercancel", (e) => this._up(e, true));
    c.addEventListener("pointerleave", (e) => this._up(e, true));
    c.addEventListener("contextmenu", (e) => e.preventDefault());

    // iOS 长按弹框/放大镜杀手：单指 touchstart 必须 preventDefault (非 passive)。
    // contextmenu 在 iOS 上几乎从不 fire，单纯 user-select:none 也压不住 callout；
    // 唯一可靠的是拦住 touchstart 默认动作。画板已 touch-action:none 故不影响绘制
    // (指针事件独立于 touch 默认动作，单指照样画)。多指 (>=2) 不拦，留给系统/手势路由。
    c.addEventListener("touchstart", (e) => {
      if (e.touches.length === 1) e.preventDefault();
    }, { passive: false });

    c.addEventListener("wheel", (e) => this._wheel(e), { passive: false });

    window.addEventListener("keydown", (e) => this._keydown(e));
    window.addEventListener("keyup", (e) => this._keyup(e));
  }

  _down(e: PointerEvent): void {
    this._purgeStalePointers();
    if (e.pointerType === "pen") {
      this.penEverSeen = true;
      // 笔尖落下 = 权威信号：之前所有 touch 都是掌触，立即清（即使没收到 up）。抄 WebPaint
      // input.ts:_purgeAllTouches。比 stale purge 激进：不管多久，pen down 就清掉挂着的掌触点，
      // 免得它们抬起时凑成假双指 tap 误撤销。
      this._purgeAllTouches();
      this._lastPenActivity = performance.now();
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
        if (p.role === "draw") this.board.cancelStroke(pid);
        else if (p.role === "erase") this._commitErase();
        else if (p.role === "lasso") this._abandonLasso();
        else if (p.role === "sel-move") this._commitMove(p);
        // 在场的非掌触 touch 全升级成 gesture —— 包括先落的 hold/pan 指针。
        // 否则它们不算 gesture：tap 判定只看 gesture 指针，抬指顺序不对 (gesture 指
        // 先抬→remaining≠0) 双指 tap 就丢掉。这是"双指很难按出来"的根因。
        if (p.pointerType === "touch" && p.role !== "ignore") p.role = "gesture";
      }
      this.pointers.set(e.pointerId, {
        pointerType: e.pointerType, role: "gesture",
        x, y, startX: x, startY: y, downTime: performance.now(),
      });
      this._beginGesture();
      this._updateGestureTapSnapshot();
      e.preventDefault();
      return;
    }

    // 套索工具：单指/笔/鼠标左键拖 = 画选区多边形；拖点落在已有选区内 = 移动选区。
    // 两指仍走上面的 gesture 分支平移缩放 (故选区拖动只单指)。几何全委托 board。
    // 鼠标中/右键不进套索 → 落到下面 role 决策走平移 (跟其它工具一致)。
    if (tool === "select" && !(e.pointerType === "mouse" && e.button !== 0)) {
      const { x: wx, y: wy } = this.board.screenToWorld(x, y);
      const bb = this.board.selectionBBox();
      const insideSel = bb && wx >= bb.x0 && wx <= bb.x1 && wy >= bb.y0 && wy <= bb.y1;
      if (insideSel) {
        this.pointers.set(e.pointerId, {
          pointerType: e.pointerType, role: "sel-move",
          x, y, startX: x, startY: y, lastX: x, lastY: y,
          totalDx: 0, totalDy: 0, moved: false, downTime: performance.now(),
        });
      } else {
        this.board.clearSelection();          // 新套索：先弃旧选区
        this._lassoPts = [wx, wy];
        this.board.setLasso(this._lassoPts);
        this.pointers.set(e.pointerId, {
          pointerType: e.pointerType, role: "lasso",
          x, y, startX: x, startY: y, downTime: performance.now(),
        });
      }
      this.canvas.setPointerCapture?.(e.pointerId);
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
    let role: PointerRole | null = null;
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
      // 「单指绘画」纯开关：开 = 手指作画；关 = 单指惰性 hold（不画、**也不平移画布**）。
      // 防手掌误触：搁在屏上的手掌 = 一个单指 touch，与真手指物理上无法区分。只要单指能 pan，
      //   手掌就能在画画时把画布带跑。故单指永不 pan——平移一律两指（第二指到来即升级 gesture）。
      //   hand 工具 / 空格仍可单指 pan（上面已分流，那是显式平移意图）。
      // hold 仍参与双指/三指手势 + 屏幕双击切笔（见 _move / _up）。
      if (this.getSingleFingerDraw()) {
        role = tool === "eraser" ? "erase" : "draw";
      } else {
        role = "hold";
      }
    }

    const baseW = this.getWidth();
    const rec: PointerRec = {
      pointerType: e.pointerType, role,
      x, y, startX: x, startY: y,
      smX: x, smY: y,                  // 平滑后的屏幕坐标 (draw 用)
      downTime: performance.now(),
      // 笔画状态：压感 LPF + 抬笔 fallback + coalesced 单调过滤
      lastP: null,                     // 上一颗有效 raw 压感
      smP: -1,                         // LPF state，-1 = 还没收到首颗
      lastEventTs: -Infinity,          // Safari iOS coalesced 边界回放过滤
      // 采样间距门限 (笔宽 × 因子 的平方)
      lastAcceptedX: x,
      lastAcceptedY: y,
      minSampleDistSq: (baseW * MIN_SAMPLE_DIST_FACTOR) ** 2,
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

  _move(e: PointerEvent): void {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    rec.x = e.clientX;
    rec.y = e.clientY;
    rec.lastSeen = performance.now();   // ghost 自愈用：心跳，证明这指针还活着
    if (rec.pointerType === "pen") this._lastPenActivity = rec.lastSeen;  // 掌触 tap 门

    if (this.gestureStart) {
      this._updateGesture();
      // 多指 tap 判定 — 任一手指移动超阈值就废掉
      if (this._gestureTap && this._gestureTap.isTap) {
        for (const [pid, p] of this.pointers) {
          if (p.role !== "gesture") continue;
          const start = this._gestureTap.startPositions[pid];
          if (!start) continue;
          const dx = p.x - start.x;
          const dy = p.y - start.y;
          if (dx * dx + dy * dy > GESTURE_TAP_MAX_MOVE_SQ) {
            this._gestureTap.isTap = false;
            break;
          }
        }
      }
      e.preventDefault();
      return;
    }

    if (rec.role === "text-create") {
      this._updateTextDraft(rec.startX!, rec.startY!, rec.x, rec.y, false);
      e.preventDefault();
      return;
    }

    if (rec.role === "lasso") {
      // 追加套索顶点 (世界坐标)。距离门限省点，够平滑即可。
      if (this._lassoPts) {
        const { x: wx, y: wy } = this.board.screenToWorld(e.clientX, e.clientY);
        const n = this._lassoPts.length;
        const ldx = wx - this._lassoPts[n-2], ldy = wy - this._lassoPts[n-1];
        const minW = 2 / this.board.viewport.scale;   // ~2 屏幕 px
        if (ldx*ldx + ldy*ldy >= minW*minW) {
          this._lassoPts.push(wx, wy);
          this.board.setLasso(this._lassoPts);
        }
      }
      e.preventDefault();
      return;
    }

    if (rec.role === "sel-move") {
      const dxS = e.clientX - rec.lastX!, dyS = e.clientY - rec.lastY!;
      rec.lastX = e.clientX; rec.lastY = e.clientY;
      const scale = this.board.viewport.scale;
      const dx = dxS / scale, dy = dyS / scale;
      this.board.translateStrokes(this.board.selection, dx, dy);
      rec.totalDx! += dx; rec.totalDy! += dy;
      if (Math.hypot(e.clientX - rec.startX!, e.clientY - rec.startY!) > 3) rec.moved = true;
      e.preventDefault();
      return;
    }

    if (rec.role === "draw") {
      // 用 coalesced events 拿到所有亚帧采样 + 轻量指数平滑 + 距离门限
      const events = typeof e.getCoalescedEvents === "function" ? e.getCoalescedEvents() : null;
      const list: PointerEvent[] = (events && events.length) ? events : [e];
      const enabled = this.getPressureEnabled();
      for (const ev of list) {
        // **Safari iOS getCoalescedEvents() 跨批次回放过滤** — 详见 docs。
        if (ev.timeStamp <= rec.lastEventTs!) continue;
        rec.lastEventTs = ev.timeStamp;
        rec.smX! += STROKE_SMOOTH_ALPHA * (ev.clientX - rec.smX!);
        rec.smY! += STROKE_SMOOTH_ALPHA * (ev.clientY - rec.smY!);
        // 距离门限：相邻样本太近就跳过 (省内存 + 减计算)。粗笔阈值大，细笔阈值小。
        const ddx = rec.smX! - rec.lastAcceptedX!;
        const ddy = rec.smY! - rec.lastAcceptedY!;
        if (ddx * ddx + ddy * ddy < rec.minSampleDistSq!) continue;
        rec.lastAcceptedX = rec.smX!;
        rec.lastAcceptedY = rec.smY!;
        const { x: wx, y: wy } = this.board.screenToWorld(rec.smX!, rec.smY!);
        const pressure = effectivePressureFor(rec, ev, enabled);
        this.board.extendStroke(e.pointerId, wx, wy, pressure);
      }
    } else if (rec.role === "erase") {
      this._doErase(e.clientX, e.clientY);
    } else if (rec.role === "pan") {
      // 触屏 pan 死区：第二指到来前，先落的手指动得够小就先不平移 (防双指 tap 抖动)。
      // 注意死区只挡触屏；鼠标/笔即时平移。死区内仍更新 _lastX/Y 基准，避免 engage 时跳跃。
      if (rec.pointerType === "touch" && !rec._panEngaged) {
        const ddx = e.clientX - rec.startX!;
        const ddy = e.clientY - rec.startY!;
        if (ddx * ddx + ddy * ddy < PAN_TOUCH_DEADZONE_SQ) {
          rec._lastX = e.clientX;
          rec._lastY = e.clientY;
          e.preventDefault();
          return;
        }
        rec._panEngaged = true;
      }
      // 用 movementX/Y 更稳 (pointer capture 时仍然有效)
      const dx = e.movementX || (e.clientX - (rec._lastX ?? e.clientX));
      const dy = e.movementY || (e.clientY - (rec._lastY ?? e.clientY));
      rec._lastX = e.clientX;
      rec._lastY = e.clientY;
      this.board.pan(dx, dy);
    } else if (rec.role === "hold") {
      // 单指惰性：不画不平移（防手掌误触）。只等第二指到来升级成 gesture，或松手判双击切笔。
    }
    e.preventDefault();
  }

  _up(e: PointerEvent, cancelled = false): void {
    const rec = this.pointers.get(e.pointerId);
    if (!rec) return;
    this.pointers.delete(e.pointerId);
    rec.x = e.clientX;
    rec.y = e.clientY;
    if (rec.pointerType === "pen") this._lastPenActivity = performance.now();  // 掌触 tap 门：从抬笔起算

    if (rec.role === "gesture") {
      const remaining = this._gestureTouches().length;
      if (remaining < 2) {
        this._endGesture();
        // 所有 gesture touch 都松手 → 判定多指 tap
        if (remaining === 0 && this._gestureTap) {
          const tap = this._gestureTap;
          this._gestureTap = null;
          const now = performance.now();
          // 从最早触点落下算 tap 时长（不是从第二指到来算）：掌根久搁 = 慢 tap = 超限剔除。
          const elapsed = now - tap.firstDownTime;
          // 笔尖时近性门：写字节奏里手掌抖出的"快闪双指"（时长没超但落在写字缝里）也吞掉。
          const palmGuard = (now - this._lastPenActivity) < PALM_PEN_GUARD_MS;
          if (tap.isTap && elapsed < GESTURE_TAP_MAX_MS && !palmGuard) {
            if (tap.maxCount === 2) {
              this.undo();
              this.status("双指 · 撤销");
            } else if (tap.maxCount >= 3) {
              this.redo();
              this.status("三指 · 重做");
            }
          }
        }
      } else {
        this._beginGesture();   // 重设基准
      }
      return;
    }

    if (rec.role === "text-create") {
      // 收尾：drag 够大 → 把屏幕矩形交给 onTextPlace；
      //       小到几乎是点击 → 默默放弃，同时如果挂着一个空 editor 也一起关掉
      if (this._textDraft) this._textDraft.classList.add("hidden");
      const x0 = Math.min(rec.startX!, rec.x);
      const y0 = Math.min(rec.startY!, rec.y);
      const x1 = Math.max(rec.startX!, rec.x);
      const y1 = Math.max(rec.startY!, rec.y);
      const sw = x1 - x0, sh = y1 - y0;
      const MIN_DRAG = 24;
      if (sw >= MIN_DRAG || sh >= MIN_DRAG) {
        this.onTextPlace({ sx: x0, sy: y0, sw: Math.max(sw, 60), sh: Math.max(sh, 24) });
      } else {
        this.onTextDismiss();
      }
      return;
    }

    if (rec.role === "lasso") {
      if (cancelled) this._abandonLasso();
      else this._finishLasso();
      return;
    }
    if (rec.role === "sel-move") {
      if (!cancelled) this._commitMove(rec);
      return;
    }

    // 屏幕双击 → 切换工具。**只**在见过 pen 的设备上的手指生效（单指此时是惰性 hold）。
    // pen 自己不参与，没见过 pen 的纯触屏设备也不参与。
    let isTap = false;
    const tapEligible = !cancelled && rec.downTime &&
      e.pointerType === "touch" && this.penEverSeen &&
      (rec.role as PointerRole | null) !== "gesture" && rec.role !== "ignore";
    if (tapEligible) {
      const now = performance.now();
      const dur = now - rec.downTime!;
      const dist = Math.hypot(rec.x - rec.startX!, rec.y - rec.startY!);
      isTap = dur < TAP_MAX_DURATION && dist < TAP_MAX_MOVE;
      if (isTap) {
        const lt = this._lastTap;
        const isDouble = lt && (now - lt.time) < DOUBLETAP_WINDOW &&
          Math.hypot(rec.startX! - lt.x, rec.startY! - lt.y) < DOUBLETAP_MAX_GAP;
        if (isDouble) {
          // 取消当前 stroke (还没 endStroke 的情况)
          if (rec.role === "draw") this.board.cancelStroke(e.pointerId);
          else if (rec.role === "erase") this.eraseSession = null;
          // hold / pan 角色无 stroke 可撤
          // 撤销上一笔 tap (如果是 draw 留下来的点)
          if (lt.stroke) {
            this.board.store.removeByRef(lt.stroke);
            this.board.requestRender();
            if (lt.stroke.id != null) deleteStrokes([lt.stroke.id]).catch(() => {});
            const ui = this.history.undoStack.findIndex((ent) => ent.type === "add" && ent.strokes.includes(lt.stroke!));
            if (ui >= 0) { this.history.undoStack.splice(ui, 1); this.history.emit(); }
          }
          this._lastTap = null;
          window.dispatchEvent(new CustomEvent("sp:doubletap"));
          this.onChange();
          return;
        }
        this._lastTap = { time: now, x: rec.startX!, y: rec.startY!, stroke: null };
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
            this.history.record({ type: "add", strokes: [s] });
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
  _updateTextDraft(x0: number, y0: number, x1: number, y1: number, show: boolean): void {
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

  // ---- gesture (2 finger pan + pinch + multi-finger tap) ----
  _gestureTouches(): PointerRec[] {
    return [...this.pointers.values()].filter(
      (p) => p.pointerType === "touch" && p.role !== "ignore",
    );
  }
  // 进 / 升级 gesture 时刷一遍 tap 快照
  _updateGestureTapSnapshot(): void {
    const touches = this._gestureTouches();
    if (!this._gestureTap) {
      this._gestureTap = {
        startTime: performance.now(),
        firstDownTime: Infinity,   // 参与本次手势的最早触点落下时刻，tap 时长从这里算
        isTap: true,
        maxCount: 0,
        startPositions: {},
      };
    }
    for (const [pid, p] of this.pointers) {
      if (p.role === "gesture" && !(pid in this._gestureTap.startPositions)) {
        this._gestureTap.startPositions[pid] = { x: p.x, y: p.y };
        // 掌根久搁再抬：它的 downTime 很早 → firstDownTime 很早 → 抬手时 elapsed 超限，不算 tap。
        // （从第二指到来算的旧口径抓不到这种"慢 tap"：掌 blob 早就压着，第二个 blob 才刚冒。）
        if (p.downTime != null && p.downTime < this._gestureTap.firstDownTime) {
          this._gestureTap.firstDownTime = p.downTime;
        }
      }
    }
    if (touches.length > this._gestureTap.maxCount) {
      this._gestureTap.maxCount = touches.length;
    }
  }
  _beginGesture(): void {
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
  _updateGesture(): void {
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
  _endGesture(): void {
    this.gestureStart = null;
    delete document.body.dataset.panning;
  }

  // ---- ghost pointer 自愈 ----
  // 清掉久未更新的"鬼"触点 (iOS 吞了它的 pointerup)。在每次 _down 开头跑一遍，
  // 避免鬼指针和真触点凑成假双指 → 误触发撤销/缩放。
  _purgeStalePointers(): void {
    const now = performance.now();
    let removed = false;
    for (const [pid, p] of this.pointers) {
      if (p.pointerType !== "touch") continue;
      const seen = p.lastSeen ?? p.downTime ?? now;
      if (now - seen > GHOST_POINTER_TIMEOUT_MS) {
        if (p.role === "draw") this.board.cancelStroke(pid);
        this.pointers.delete(pid);
        removed = true;
      }
    }
    // 清完若已不够两指，收掉 gesture / tap 残留状态
    if (removed && this.gestureStart && this._gestureTouches().length < 2) {
      this._endGesture();
      this._gestureTap = null;
    }
  }

  // 笔尖落下时把所有 touch 当掌触清掉（含没收到 up 的 ghost）。清得比 stale purge 狠：
  // 不看时间，pen down 即清。清完收掉任何 gesture / tap 残留，免得掌触抬起时假双指误撤销。
  _purgeAllTouches(): void {
    for (const [pid, p] of this.pointers) {
      if (p.pointerType !== "touch") continue;
      if (p.role === "draw") this.board.cancelStroke(pid);
      else if (p.role === "erase") this._commitErase();
      this.pointers.delete(pid);
    }
    if (this.gestureStart && this._gestureTouches().length < 2) this._endGesture();
    this._gestureTap = null;
  }

  // 失焦 / 切后台 / 系统打断时，丢弃所有在途指针，回到干净基线。
  // 防止"切走再切回"时残留的半截手势被当成真输入。
  cancelAllPointers(): void {
    for (const [pid, p] of this.pointers) {
      if (p.role === "draw") this.board.cancelStroke(pid);
    }
    this.eraseSession = null;
    this._abandonLasso();          // 在途套索丢弃 (已 commit 的选区保留)
    this.pointers.clear();
    this._endGesture();
    this._gestureTap = null;
    delete document.body.dataset.panning;
  }

  // ---- erase ----
  _beginErase(): void {
    this.eraseSession = { ids: new Set(), strokes: [] };
  }
  _doErase(sx: number, sy: number): void {
    if (!this.eraseSession) return;
    const { x: wx, y: wy } = this.board.screenToWorld(sx, sy);
    const r = ERASER_RADIUS_SCREEN / this.board.viewport.scale;
    const hits = this.board.hitStrokesAt(wx, wy, r);
    if (!hits.length) return;
    const newIds: number[] = [];
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
  _commitErase(): void {
    if (!this.eraseSession) return;
    const sess = this.eraseSession;
    this.eraseSession = null;
    if (!sess.strokes.length) return;
    deleteStrokes([...sess.ids]).then(() => {
      this.history.record({ type: "erase", strokes: sess.strokes });
      this.onChange();
    }).catch((err) => {
      console.error("deleteStrokes failed", err);
      this.status("擦除保存失败");
    });
  }

  // ---- 套索选区 ----
  // 松手：套索多边形 → 选中集。太小 (几乎是点击) → 只清选区。
  _finishLasso(): void {
    const pts = this._lassoPts;
    this._lassoPts = null;
    this.board.setLasso(null);
    if (!pts || pts.length < 6) { this.board.clearSelection(); return; }
    const hits = this.board.strokesInPolygon(pts);
    this.board.setSelection(hits);
    this.status(hits.length ? `已选 ${hits.length} 项` : "空选区");
  }
  _abandonLasso(): void {
    this._lassoPts = null;
    this.board.setLasso(null);
  }
  // 移动选区收尾：持久化每个 moved stroke + 推 move 撤销。没真移动就不记。
  _commitMove(rec: PointerRec): void {
    if (!rec) return;
    const dx = rec.totalDx!, dy = rec.totalDy!;
    rec.totalDx = 0; rec.totalDy = 0;
    if (!dx && !dy) return;
    const strokes = this.board.selection.slice();
    if (!strokes.length) return;
    if (!rec.moved) {
      // 点击/抖动级位移 (<阈值)：撤回内存里那点漂移，别落库别记 undo (免内存↔DB 不一致)。
      this.board.translateStrokes(strokes, -dx, -dy);
      return;
    }
    for (const s of strokes) putStrokeWithId(s).catch((err) => console.error("move save failed", err));
    this.history.record({ type: "move", strokes, dx, dy });
    this.onChange();
  }
  // 删除选区 (键盘 Delete / chip)。复用 erase 撤销类型：undo 会原样插回、文字浮层自动对账。
  deleteSelection(): void {
    const strokes = this.board.selection.slice();
    if (!strokes.length) return;
    const ids = strokes.map((s) => s.id).filter((x): x is number => x != null);
    this.board.clearSelection();
    this.board.removeStrokesByIds(ids);
    deleteStrokes(ids).then(() => {
      this.history.record({ type: "erase", strokes });
      this.onChange();
      this.status(`已删除 ${strokes.length} 项`);
    }).catch((err) => {
      console.error("deleteSelection failed", err);
      this.status("删除失败");
    });
  }

  // 复制选区 (子命令排「复制」)。克隆选中 stroke (剥 id) → 偏移一点 → 落库分配新 id → 选中副本。
  // 偏移让副本一眼看出是复制、且能立刻拖走。复用 add 撤销类型：undo 删副本、redo 重插。
  duplicateSelection(): void {
    const src = this.board.selection.slice();
    if (!src.length) return;
    const off = 24 / this.board.viewport.scale;   // 固定 ~24 屏幕 px 偏移 (与缩放无关)
    const clones = src.map((s) => cloneStrokeOffset(s, off, off));
    // 先进 store：手写副本立即上屏；文字副本要等 id 落定后再刷一帧，syncOverlay 才补 DOM 浮层。
    for (const c of clones) this.board.store.add(c);
    this.board.setSelection(clones);
    Promise.all(clones.map((c) => addStroke(c))).then(() => {
      this.board.requestRender();                 // 文字副本此刻才有 id → 下一帧 syncOverlay 补浮层
      this.history.record({ type: "add", strokes: clones });
      this.onChange();
      this.status(`已复制 ${clones.length} 项`);
    }).catch((err) => {
      console.error("duplicateSelection failed", err);
      this.status("复制失败");
    });
  }

  // ---- wheel ----
  // wheel 的 deltaY 跨设备语义不统一：
  //   trackpad pinch (macOS / 触控板)   → ctrlKey=true, deltaMode=0, |deltaY| 通常 1-20，每秒几十个 event
  //   mouse wheel + ctrl              → ctrlKey=true, deltaMode 视浏览器 (Edge/Chrome=0 但 |dy|=100；FF=1)，每秒 1-3 个 tick
  // 用 deltaMode + |deltaY| 量级判定，不同分支用不同 k。
  // 阈值 80 是经验值 (鼠标 tick 至少 100，触控板单个 event 通常 < 20)。
  _wheel(e: WheelEvent): void {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const smooth = e.deltaMode === 0 && Math.abs(e.deltaY) < 80;
      const k = smooth ? 0.003 : 0.001;
      const factor = Math.exp(-e.deltaY * k);
      this.board.zoomAt(e.clientX, e.clientY, factor);
    } else {
      let dx = -e.deltaX, dy = -e.deltaY;
      if (e.shiftKey && dx === 0) { dx = dy; dy = 0; }
      this.board.pan(dx, dy);
    }
  }

  // ---- keys ----
  _keydown(e: KeyboardEvent): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
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
    if ((e.key === "Delete" || e.key === "Backspace") && this.board.selection.length) {
      this.deleteSelection();
      e.preventDefault();
      return;
    }
    if (e.key === "Escape" && this.board.selection.length) {
      this.board.clearSelection();
      e.preventDefault();
      return;
    }
    if (e.key === "p" || e.key === "P") this._emitTool("pen");
    else if (e.key === "e" || e.key === "E") this._emitTool("eraser");
    else if (e.key === "h" || e.key === "H") this._emitTool("hand");
    else if (e.key === "t" || e.key === "T") this._emitTool("text");
    else if (e.key === "s" || e.key === "S") this._emitTool("select");
    else if (e.key === "g" || e.key === "G") this._emitGridCycle();
    else if (e.key === "0") this.board.resetViewport();
    else if (e.key === "=" || e.key === "+") this.board.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1.2);
    else if (e.key === "-" || e.key === "_") this.board.zoomAt(window.innerWidth / 2, window.innerHeight / 2, 1 / 1.2);
  }
  _keyup(e: KeyboardEvent): void {
    if (e.code === "Space") {
      this.spaceDown = false;
      delete document.body.dataset.spacePan;
    }
  }
  _emitTool(tool: ToolName): void { window.dispatchEvent(new CustomEvent("sp:settool", { detail: tool })); }
  _emitGridCycle(): void { window.dispatchEvent(new CustomEvent("sp:gridcycle")); }

  // ---- undo/redo ----
  canUndo(): boolean { return this.history.canUndo(); }
  canRedo(): boolean { return this.history.canRedo(); }

  async undo(): Promise<void> {
    const e = this.history.takeUndo();
    if (!e) return;
    if (e.type === "add") {
      const ids = e.strokes.map((s) => s.id).filter((x): x is number => x != null);
      await deleteStrokes(ids).catch(() => {});
      this.board.removeStrokesByIds(ids);
    } else if (e.type === "erase") {
      // 重新插入（用原 id）
      for (const s of e.strokes) {
        await putStrokeWithId(s).catch(() => {});
        this.board.store.add(s);
      }
      this.board.requestRender();
    } else if (e.type === "move") {
      this.board.translateStrokes(e.strokes, -e.dx, -e.dy);
      for (const s of e.strokes) putStrokeWithId(s).catch(() => {});
    }
    this.history.restoreRedo(e);
    this.onChange();
  }
  async redo(): Promise<void> {
    const e = this.history.takeRedo();
    if (!e) return;
    if (e.type === "add") {
      for (const s of e.strokes) {
        await putStrokeWithId(s).catch(() => {});
        this.board.store.add(s);
      }
      this.board.requestRender();
    } else if (e.type === "erase") {
      const ids = e.strokes.map((s) => s.id).filter((x): x is number => x != null);
      await deleteStrokes(ids).catch(() => {});
      this.board.removeStrokesByIds(ids);
    } else if (e.type === "move") {
      this.board.translateStrokes(e.strokes, e.dx, e.dy);
      for (const s of e.strokes) putStrokeWithId(s).catch(() => {});
    }
    this.history.restoreUndo(e);
    this.onChange();
  }

  clearHistory(): void {
    this.history.clear();
  }

  _emitHistChange(): void {
    window.dispatchEvent(new CustomEvent("sp:histchange", {
      detail: { canUndo: this.history.canUndo(), canRedo: this.history.canRedo() },
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
function effectivePressureFor(rec: PointerRec, e: PointerEvent, enabled: boolean): number {
  if (!enabled) return 1;
  let raw: number;
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
  if (rec.smP == null || rec.smP < 0) rec.smP = raw;
  else rec.smP += PRESSURE_SMOOTH_ALPHA * (raw - rec.smP);
  return rec.smP;
}

// 深克隆一条 stroke 并整体偏移 (dx,dy 世界坐标)。返回不带 id 的新对象 (IDB 自增分配)。
// 手写：拷 points (Float32Array，stride 3 = x,y,pressure)，只挪 x/y；文字：拷字段 + 挪 x/y。
function cloneStrokeOffset(s: Stroke, dx: number, dy: number): Stroke {
  const bb: [number, number, number, number] =
    [s.bbox[0] + dx, s.bbox[1] + dy, s.bbox[2] + dx, s.bbox[3] + dy];
  if (s.type === "text") {
    return { type: "text", x: s.x + dx, y: s.y + dy, source: s.source, color: s.color, width: s.width, bbox: bb };
  }
  const src = s.points;
  const pts = new Float32Array(src.length);
  for (let i = 0; i < src.length; i += 3) {
    pts[i] = src[i] + dx;
    pts[i + 1] = src[i + 1] + dy;
    pts[i + 2] = src[i + 2];
  }
  return { color: s.color, width: s.width, points: pts, bbox: bb };
}
