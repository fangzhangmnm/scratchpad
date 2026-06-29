# Export + share + clipboard

How to get a PNG / PDF out of a canvas and into the user's
clipboard / share sheet / file download. iOS-friendly (target was
iPad Safari + desktop).

## The bigger picture

For a "write-then-burn" app like ScratchPad, the user's main pain is
"how do I get this from iPad to PC?" They wanted to avoid building
sync (it contradicts the transient mental model). The answer is
make sharing one-tap and let the OS share sheet handle the routing.

Three output paths shipped:

1. **Download** — `<a download>` click. File goes to user's Downloads
   / Files / Photos depending on browser settings.
2. **Copy to clipboard** — `navigator.clipboard.write([ClipboardItem])`.
   PC: `Ctrl+V` paste straight into chat / doc.
3. **Share** — `navigator.share({files: [...]})`. Pops AirDrop,
   WeChat, Messages, Mail, any installed share extension.

(1) is the lowest common denominator. (2) is best for "I want it in
that document over there right now." (3) is best on iPad → reaches
any installed receiver.

## Offscreen render

Single helper that all three paths use:

```js
function renderOffscreen(board, ctx, opts) {
  const { width, height, tx, ty, scale } = opts;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = board._bgColor;
  ctx.fillRect(0, 0, width, height);
  const viewport = { tx, ty, scale };
  for (const s of board.strokes) {
    drawStroke(ctx, s, viewport, board._inkColor);
  }
}
```

`drawStroke` is the same function used for live render — single source
of truth. WYSIWYG-vs-export divergence is a maintenance smell.

Two coordinate setups:

**Current view** — match the live viewport scaled by an export DPI:

```js
const w = board.canvas.clientWidth;
const h = board.canvas.clientHeight;
off.width  = round(w * DPI);
off.height = round(h * DPI);
renderOffscreen(board, ctx, {
  width: off.width, height: off.height,
  tx:    board.viewport.tx    * DPI,
  ty:    board.viewport.ty    * DPI,
  scale: board.viewport.scale * DPI,
});
```

**All content** — compute bbox of all strokes, add padding, fit into
a max-dim cap:

```js
const bb = board.computeBoundingBox();
if (!bb) { /* empty — bail */ }
const pad = 32;                          // world units
const worldW = (bb.x1 - bb.x0) + pad*2;
const worldH = (bb.y1 - bb.y0) + pad*2;
let pxPerUnit = max(1, board.viewport.scale) * 1.5;
if (worldW * pxPerUnit > MAX_DIM) pxPerUnit = MAX_DIM / worldW;
if (worldH * pxPerUnit > MAX_DIM) pxPerUnit = MAX_DIM / worldH;
const w = round(worldW * pxPerUnit), h = round(worldH * pxPerUnit);
// off canvas sized to w, h
renderOffscreen(board, ctx, {
  width: w, height: h,
  tx: (-bb.x0 + pad) * pxPerUnit,
  ty: (-bb.y0 + pad) * pxPerUnit,
  scale: pxPerUnit,
});
```

## Resolution — don't over-engineer

First version was 2× DPI for current view, 3× scale for PDF, max
8192 px. User said the export resolution didn't need to be that
high.

Final:
- `PNG_DPI = 1.5`
- `MAX_DIM = 4096`
- PDF px-per-unit = 2

Reasoning: 4K is plenty sharp on a retina display when used at 1:1
zoom. Bigger files just slow share / clipboard ops and bloat WeChat
attachments. Keep small.

## Download

```js
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
```

The `<a download>` approach works everywhere including iPad Safari
(falls back to opening a download confirmation sheet).

## Clipboard

```js
export async function copyPngCurrentView(board) {
  const blob = await renderCurrentViewBlob(board);
  await navigator.clipboard.write([
    new ClipboardItem({ "image/png": blob }),
  ]);
}
```

Requirements:
- HTTPS (GH Pages is HTTPS).
- iOS 13.4+ for `navigator.clipboard.write` + `ClipboardItem`.
- Triggered from a user gesture (click handler).

Failure modes:
- User denies clipboard permission → throws. Catch and show a status
  message.
- `ClipboardItem` not supported (very old browsers) → catch
  `ReferenceError` and fall back to download.

## Share

```js
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
```

Important:
- Always `canShare({files: [...]})` check — `navigator.share` exists
  on desktop Chrome but doesn't accept files.
- Hide the share button when not supported. Don't show-and-fail.
- User dismissing the share sheet throws `AbortError`. Treat as
  cancel, not error:

```js
catch (err) {
  if (err && err.name === "AbortError") setStatus("已取消");
  else setStatus("导出失败");
}
```

### What lands where (iPad)

`navigator.share` on iPad opens the system share sheet. Targets the
user actually used:

- **AirDrop** → other Apple device (Mac mostly). 1 tap, image arrives
  on Mac desktop / image clipboard.
- **微信** → contact picker → "文件传输助手" → PC WeChat receives.
  About 3 taps.
- **Mail** → compose with attachment.
- **Notes** / Reminders / Files → save locally.

Beats the "export to Photos → switch app → attach" loop by 2 taps.

## PDF — vendor jspdf

`jspdf` is ~365 KB minified. Don't ship it in the initial bundle.
Vendor at `src/vendor/jspdf.umd.min.js`. Lazy-load with a script tag
on first PDF export:

```js
let _jspdfPromise = null;
function loadJsPdf() {
  if (_jspdfPromise) return _jspdfPromise;
  _jspdfPromise = new Promise((resolve, reject) => {
    if (window.jspdf?.jsPDF) { resolve(window.jspdf); return; }
    const s = document.createElement("script");
    s.src = "./src/vendor/jspdf.umd.min.js";
    s.onload  = () => window.jspdf?.jsPDF
      ? resolve(window.jspdf)
      : reject(new Error("jsPDF 加载失败"));
    s.onerror = () => reject(new Error("jsPDF 网络失败"));
    document.head.appendChild(s);
  });
  return _jspdfPromise;
}
```

Use:

```js
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
```

Convert px → mm via 96 DPI: `widthMm = worldPx / 96 * 25.4`.

(For real vector PDF — jsPDF can do line drawing directly. We just
embed PNG because it's simpler and matches what the user sees.)

## File naming

Timestamp suffix so multiple exports don't overwrite:

```js
function stampStr() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
// scratchpad-20260520-143055.png
```

## Export sheet layout

For a write-then-burn app the share-to-clipboard path is the most
common use, so put it first:

```
复制 PNG · 当前视图 （→ 剪贴板）
分享 PNG · 全部内容   ← hidden when isShareSupported() === false
下载 PNG · 当前视图
下载 PNG · 全部内容
下载 PDF · 全部内容
取消
```

Don't offer all five with equal prominence. The user knows what they
want from context (chat? archive? print?), surface the common one.

## Anti-pattern: separate export pipeline

If you have a separate render path for export (e.g. "high-quality"
SVG export that re-derives the geometry differently from the live
canvas render), they will diverge over time. Strokes will look
different in the file than on screen. Don't do it. Share the function.
