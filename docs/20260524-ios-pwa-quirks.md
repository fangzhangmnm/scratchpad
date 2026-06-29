# iOS / iPad PWA quirks

Stuff that bit specifically because iPad Safari is the target. Mostly
the WebKit / iOS-PWA side.

## apple-touch-icon MUST be PNG

iOS Safari does not render SVG for the home-screen icon. Even though
the SVG spec is part of WebKit, the icon path goes through legacy
code that wants PNG.

First version had:

```html
<link rel="apple-touch-icon" href="./icon.svg" />
```

Result on iPad: install to home screen, get the default white icon
with a snapshot of the page rendered into it. User reported "ipad端
icon没上去（需要转图片格式）".

Fix: generate PNG via ImageMagick from the same SVG source, declare
both:

```html
<link rel="icon" href="./icon.svg" type="image/svg+xml" />
<link rel="icon" href="./icon-192.png" type="image/png" sizes="192x192" />
<link rel="apple-touch-icon" sizes="180x180" href="./apple-touch-icon-180.png" />
```

```bash
convert -background none      -resize 180x180 icon.svg apple-touch-icon-180.png
convert -background "#f6f4ef" -resize 192x192 icon.svg icon-192.png
convert -background "#f6f4ef" -resize 512x512 icon.svg icon-512.png
```

Apple Touch icon background is transparent (iOS adds its own
rounded-corner mask). Manifest icons can have a flat background.

Also list PNGs in `manifest.webmanifest` for Android / Chrome:

```json
{
  "icons": [
    { "src": "./icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
    { "src": "./icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
    { "src": "./icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
    { "src": "./icon.svg",     "sizes": "any",     "type": "image/svg+xml", "purpose": "any" }
  ]
}
```

Precache all icons in the SW.

## PWA meta tags

The full incantation for "open from home screen as standalone app":

```html
<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover, user-scalable=no" />
<meta name="theme-color" content="#F6F4EF" />
<meta name="theme-color" content="#121110" media="(prefers-color-scheme: dark)" />
<meta name="color-scheme" content="light dark" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
<meta name="apple-mobile-web-app-title" content="ScratchPad" />
```

- `viewport-fit=cover` lets content extend into the notch area.
- `user-scalable=no` is ignored by Apple for accessibility but is
  still honored as a *hint* for native pinch-zoom (we override with
  our own pinch handler anyway).
- `apple-mobile-web-app-status-bar-style=black-translucent` lets the
  page background show under the status bar — combined with safe-area
  insets, the UI extends to the screen edge.

## Safe-area insets

For floating toolbars / overlays at edges:

```css
.top-bar {
  top: max(env(safe-area-inset-top, 0px), 8px);
}
.hud {
  right: max(env(safe-area-inset-right, 0px), 12px);
  bottom: max(env(safe-area-inset-bottom, 0px), 12px);
}
```

`max()` so it's at least 8/12 px even on a flat-edged device.

## No devtools on iPad — inline error overlay

iPad Safari only exposes a DevTools-like inspector via a cabled Mac
(Web Inspector). For users in the wild, JS errors are silent.

To survive without that, install a JS error → red bar on screen,
from an inline `<script>` that runs **before** the module imports:

```html
<script>
  (function () {
    function show(text) {
      var bar = document.getElementById("__errBar");
      if (!bar) {
        bar = document.createElement("div");
        bar.id = "__errBar";
        bar.style.cssText = "position:fixed;left:0;right:0;top:0;" +
          "z-index:9999;padding:8px 12px;background:#c0392b;color:#fff;" +
          "font:13px/1.4 system-ui;white-space:pre-wrap;word-break:break-word;" +
          "max-height:50vh;overflow:auto";
        bar.addEventListener("click", function () { bar.remove(); });
        (document.body || document.documentElement).appendChild(bar);
      }
      bar.textContent = "⚠ " + text + "  (点击关闭)";
    }
    window.addEventListener("error", function (e) {
      var m = (e && e.message) ||
              (e && e.error && (e.error.message || String(e.error))) ||
              "脚本错误";
      var src = e && e.filename
        ? " (" + e.filename.split("/").pop() + ":" + e.lineno + ")"
        : "";
      show(m + src);
    });
    window.addEventListener("unhandledrejection", function (e) {
      var r = e && e.reason;
      show((r && r.message) || String(r || "promise rejection"));
    });
  })();
</script>
<script type="module" src="./src/app.js"></script>
```

Must be inline + before the module. If the module load itself throws
(syntax error), an external script's error handler hasn't registered
yet.

User can take a screenshot of the red bar and send it — beats
"the app is broken" with no detail.

## localStorage can throw

In Safari private browsing, `localStorage.getItem(…)` throws
`SecurityError`. Wrap every access:

```js
function safeLS(key, fallback) {
  try { return localStorage.getItem(key); } catch { return fallback; }
}
try { localStorage.setItem(key, value); } catch {}
```

A bare `localStorage.getItem(…)` at module top-level will kill the
boot in private mode.

## FOUC theme guard

To set `[data-theme]` on `<html>` before the stylesheet applies and
the page paints, inline this in `<head>` *before* the stylesheet link:

```html
<script>
  (function () {
    try {
      var saved = localStorage.getItem("scratchpad.theme");
      if (saved === "day" || saved === "night" || saved === "auto") {
        document.documentElement.setAttribute("data-theme", saved);
      }
    } catch (_) {}
  })();
</script>
```

Without this, a `night`-saved user sees a flash of light theme on
load. Pair with `:root[data-theme="night"] { … }` and `@media
(prefers-color-scheme: dark) { :root[data-theme="auto"] { … } }`.

## Web Share / Clipboard

See [20260524-export-share-clipboard.md](20260524-export-share-clipboard.md) for the
full setup. Quick notes:

- `navigator.share({files: [pngFile]})` — iOS 15+. Always feature-
  detect with `navigator.canShare({files: [dummy]})`.
- `navigator.clipboard.write([new ClipboardItem({"image/png": blob})])`
  — iOS 13.4+. Requires HTTPS (GH Pages is HTTPS).

## Pencil-related limits

- `e.pressure` for Apple Pencil PointerEvents works fine, range
  `0..1`.
- `e.tiltX / tiltY` and `e.altitudeAngle / azimuthAngle` are
  available for Pencil — useful if you want tilt-based shading. Did
  not use in ScratchPad.
- **Pencil 2 / Pro barrel-tap is NOT exposed to web JS.** No event
  fires for the double-tap-on-the-pencil-shell gesture. Don't try
  to detect. See [20260524-pointer-and-pen-input.md](20260524-pointer-and-pen-input.md).
- Apple Pencil hover (iPad Pro M2+) generates `pointerenter` /
  `pointermove` with `pointerType === "pen"` and no `pointerdown`.
  Could be used for tool preview / cursor. Did not use.

## PWA install hint

iOS Safari does NOT show an install prompt automatically (unlike
Chrome). Users have to manually tap the share button → "Add to Home
Screen." There's no JS API to programmatically trigger that flow.

Best you can do: add a one-time hint banner the first time the app
loads in mobile Safari (not already standalone) — but in ScratchPad
we did not, to keep the boot UI minimal.

## 防长按弹奇怪对话框硬化 (v17 / 2026-06-20)

> as-of v17-2026-06-20。抄 WebPaint (v216 callout / v232 selectstart) 的硬化，
> 补 ScratchPad 早前只有 `contextmenu` preventDefault + `user-select:none` 的缺口。

iOS 上画板长按会弹"拷贝/查询/分享/存图"callout，甚至放大镜，打断绘制 / 偷走手势。
`contextmenu` 在 iOS 几乎从不 fire，光靠 CSS `user-select:none` 也压不住。落地的层：

1. **CSS** (`styles.css`): `html,body` + `.board` 都加 `-webkit-touch-callout:none`；
   body 加 `touch-action:manipulation`(去双击缩放/300ms 延迟)，`.board` 维持
   `touch-action:none`。`.text-editor/textarea/input` 翻回 `user-select:text` +
   `callout:default`，否则编辑框选不中、不能长按粘贴。
2. **canvas 单指 touchstart preventDefault (非 passive)** (`input.js _bind`):
   唯一可靠的 callout/放大镜杀手。`touches.length===1` 才拦，多指留给手势路由。
   指针事件独立于 touch 默认动作，所以单指绘制不受影响。
3. **全局护栏** (`platform-guards.js`, capture+非passive): `gesturestart/change/end`
   (iOS 私有双指缩放)、`touchstart>=3 指`(挡 iPad 分屏/Slide Over/系统三指 —— 注意
   三指 redo 走指针事件不受影响)、`dblclick`(系统选词，文本框放行)、`selectstart`
   (画板长按不起选区，文本框放行)。
4. **ghost pointer 自愈** (`input.js`): iOS 偶尔吞 pointerup，残留鬼指针会和下一个
   真触点凑成假双指 → 误触发撤销。`_purgeStalePointers()` 在每次 `_down` 清掉 >1500ms
   没心跳的旧 touch；`cancelAllPointers()` 在 blur / visibilitychange(hidden) 全清。

注：双指撤销 / 三指重做手势本身在此之前就已实现 (input.js，"抄 WebPaint")；
本次只补让它在 iPad 上不被系统手势/callout 干扰的硬化。
