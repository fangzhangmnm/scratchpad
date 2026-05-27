# ScratchPad

> 无限大数学草稿纸。阅后即焚 — 没有 library，只有 clear。Apple Pencil / stylus / 鼠标都能用。

- **🔗 PWA**: https://fangzhangmnm.github.io/scratchpad/
- **📦 Source**: https://github.com/fangzhangmnm/scratchpad

致敬 iPad 上那个早已 abandonware 的 *Scratchpad*：打开就能推公式，关掉就忘，重开还在。

## MVP 状态

- ✅ 无限大画布（拖拽 / pinch 缩放，含负数坐标）
- ✅ 矢量笔画（Float32 点列 + 压感 → 变宽）
- ✅ Pointer Events 统一处理 pen / touch / mouse
- ✅ Apple Pencil 防误触（设备一旦见过 pen，touch 全部转 pan）
- ✅ Apple Pencil 屏幕双击 → 笔 ↔ 橡皮（barrel-tap 没法走 web，所以用 screen 双击代替）
- ✅ 变宽填充丝带渲染（quadratic 中点平滑，避免 per-segment stroke 的狗牙）
- ✅ 文字 + LaTeX 块（T 键 / `T` 工具按钮）：纯文字 + inline `$x^2$` 或 display `$$\sum$$`，回车提交，Shift+Enter 换行，Esc 取消。点已有块即编辑。KaTeX 本地 vendor，离线可用。橡皮 / 撤销 / 清空 / 导出都自动兼容
- ✅ 多档网格：无 / 点阵 / 方格 / 横线（按 G 循环）
- ✅ IndexedDB 持久化 — 重开即恢复
- ✅ 阅后即焚（一键清空，二级确认）
- ✅ Undo / Redo（含擦除）
- ✅ 导出 / 分享：复制 PNG 到剪贴板 / `navigator.share` 走系统分享面板（AirDrop / 微信文件传输助手等）/ 下载 PNG·当前视图 / 下载 PNG·全部 / 下载 PDF·全部
- ✅ 压感开关（默认**关** — 关时单条 Path2D 描边，浏览器原生抗锯齿，最干净；开时变宽丝带）
- ✅ 日 / 夜 / 跟随系统 三档主题
- ✅ PWA：所有依赖 vendored 本地，service worker 装包，飞机模式可用
- ✅ 新版本检测（同源 ETag 变 → 弹 toast，用户点了再 reload）

## 用法

| 操作 | 笔 | 鼠标 | 触屏 |
| - | - | - | - |
| 画 | Apple Pencil 落笔 | 左键拖 | 单指拖（前提：本设备没出现过 pen） |
| 擦 | 工具切到 eraser；或 Pencil 副按钮；或屏幕双击 | 工具切到 eraser，左键拖 | 工具切到 eraser，单指拖 |
| 平移 | 单指拖（pencil 模式下） | 中键 / 右键拖；或按 Space 拖 | 双指拖 |
| 缩放 | — | 触控板 pinch（Ctrl+滚轮）；或 +/- 键 | 双指 pinch |

### 键盘

- `P` 笔 `E` 橡皮 `H` 平移
- `Space`（按住）= 临时平移
- `G` 循环网格 `0` 回到原点
- `+/-` 缩放
- `Ctrl+Z` / `Ctrl+Shift+Z` 撤销 / 重做

## 本地跑

```bash
python -m http.server 8000
# http://localhost:8000/
```

`localhost` / `127.0.0.1` 上 SW 不会注册，F5 永远拉到最新代码。要测离线 / PWA 安装，用 LAN IP（`http://192.168.x.x:8000/`）或部署版本。

## 部署

GitHub Pages，纯静态，不需要 build：

1. 新仓库 `scratchpad`（public，GH Pages 免费层要求）。
2. push 上去。
3. Settings → Pages → Source: **Deploy from a branch**, Branch: `main` / `/ (root)`。
4. 改了客户端代码要让已装 PWA 的人感知到 → bump [`service-worker.js`](service-worker.js) 里的 `CACHE_VERSION`。

## 架构

```
index.html               全屏 canvas + 浮动顶栏 + 表单 (sheets)
manifest.webmanifest     PWA
service-worker.js        同源 cache-first，新版 ETag 变发 asset-updated
icon.svg                 浅米色 + 公式 + 铅笔
src/
  app.js                 orchestrator (boot + UI 绑定 + SW + theme)
  board.js               infinite canvas viewport + 渲染 + grid + hit-test
  input.js               pointer / wheel / keys + 手势 + 防误触 + undo stack
  db.js                  IndexedDB (strokes + meta)
  export.js              PNG / PDF (jspdf 动态 import)
  styles.css             warm parchment 主题（亮 / 暗）
  vendor/
    jspdf.umd.min.js     PDF 导出依赖（仅 PDF 时按需 import）
```

## 数据

IndexedDB `scratchpad` 库：

```
strokes (autoIncrement id)
  { id, color, width, points: Float32Array[x,y,p,x,y,p,...], bbox: [x0,y0,x1,y1] }
meta (key/value)
  viewport: { tx, ty, scale, gridMode }
```

主题选择存 localStorage `scratchpad.theme`（防 FOUC 内联 script 要早于样式表读）。

## 设计原则

- **阅后即焚**：没有 library / trash / 文件管理。一个 canvas，开了即上一次的位置，clear 就回到空白。
- **矢量优先**：缩放怎么放大都清晰，导出 PNG / PDF 不糊；IndexedDB 占用小。
- **离线纯本地**：vendor 全部进仓，没有运行时跨源依赖。装 PWA 之后飞机上也能写公式。
- **防误触**：第一次见到 Pencil 之后，本设备的 touch 永远只用于平移 / pinch，不再画线。
