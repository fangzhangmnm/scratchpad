# Canvas 尺寸 — 三件套监听器 + 早退

iPad PWA / Safari 在地址栏 / 状态栏推送、键盘弹出、URL bar 收缩、PWA 容器
reflow 时会改 viewport，但**不一定**触发 `window.resize`。如果不响应，canvas 内部
pixel buffer 还是旧尺寸被 CSS 拉伸到新 viewport → 渲染像素和 `clientX/Y` **错位**
→ 笔迹和落点 drift。

WebPaint v54 撞过同样的坑
(`/mnt/d/JupyterLocal/20260524 WebPaint/WebPaint/src/board.js` 注释)，ScratchPad
v16 抄过来。

## 三件套监听器

```js
this.resize();
window.addEventListener("resize", () => this.resize());

// iOS / iPad PWA: visualViewport (地址栏 / 键盘) 不一定触发 window.resize
if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", () => this.resize());
  window.visualViewport.addEventListener("scroll", () => this.resize());
}

// 兜底: 直接观察 canvas 自身 CSS 尺寸 (Safari URL bar / PWA reflow / 折叠屏)
if (typeof ResizeObserver !== "undefined") {
  const ro = new ResizeObserver(() => this.resize());
  ro.observe(this.canvas);
}
```

哪条最关键：

- **桌面**：`window.resize` 就够了，但 PWA 容器 reflow 偶发只触发 ResizeObserver
- **iPad Safari (浏览器)**：URL bar 收缩/展开 → 只 visualViewport 触发
- **iPad PWA (Home Screen)**：键盘弹出收回 → 只 visualViewport 触发；rotation → 三个都触发
- **Quest 浏览器**：reflow 频繁，三个都挂上才稳

少一个就有一类设备 drift。三件套一起挂。

## 早退避免无效重 setup

```js
resize() {
  const w = this.canvas.clientWidth || window.innerWidth;
  const h = this.canvas.clientHeight || window.innerHeight;
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const tw = Math.round(w * dpr);
  const th = Math.round(h * dpr);
  // 没变就不动 — ResizeObserver / visualViewport / window.resize 频繁触发，
  // 多余的 canvas.width = ... 会清空 backing buffer 并触发不必要的 reflow
  if (tw === this.canvas.width && th === this.canvas.height && dpr === this.dpr) return;
  this.dpr = dpr;
  this.canvas.width = tw;
  this.canvas.height = th;
  this.requestRender();
}
```

为什么早退重要：

1. **canvas.width / canvas.height 是有副作用的赋值** — 即使写入相同值也清空 backing
   buffer 并重置 ctx 状态。频繁触发会丢正在画的 strokes / 立即重画一帧。
2. **ResizeObserver 在 scroll 期间频繁 fire** — 不早退会每个 scroll event 都重置
   canvas，肉眼可见的卡顿。
3. **visualViewport scroll** 时 dimensions 通常不变，只是 viewport offset 变 — 此时
   resize() 早退，不动 canvas。

## 坐标系一致性 — drift 的根本

`clientX/Y` 是相对于 viewport 左上角的 CSS px。canvas 内部 pixel buffer 是
`clientWidth * dpr × clientHeight * dpr` 物理 px。`ctx.setTransform(dpr, 0, 0, dpr, 0, 0)`
之后 draw 用 CSS px 单位，GPU 渲染到物理 px。**只要 backing buffer 跟 CSS 尺寸 ×
dpr 一致**，screenToWorld 用 `e.clientX` 跟实际渲染对得上。

resize 没响应 → backing buffer 尺寸过期 → CSS 拉伸 → 显示的内容在物理 px 里**位置
错了**，但 clientX/Y 还按当前 viewport 算 → 点击 (x, y) 跟显示的 (x, y) 不重合 →
drift。

## 触发场景

实测会触发 drift 的场景 (没挂三件套时)：

- iPad Safari：手指上滑使地址栏收起 / 下滑展开
- iPad PWA：唤起键盘 (例如 textarea focus) 收起键盘
- iPad 旋转屏幕
- 桌面 Edge / Chrome：F11 切换全屏 / 拖窗口跨显示器 (DPR 变)
- 移动浏览器：双击放大网页时 (visualViewport.scale 变)

挂了三件套之后**所有以上都不再 drift**。

## 兼容性

- `visualViewport`: Safari 13+, Chrome 61+, Firefox 91+. iOS PWA 全覆盖。检 truthy 即可。
- `ResizeObserver`: Safari 13.1+, Chrome 64+, Firefox 69+. 检 typeof 即可。

ScratchPad / WebPaint / 兄弟项目的目标平台 (iPad Safari + 现代桌面浏览器) 全部支持。
