# Infinite canvas

How to make a `<canvas>` feel infinite — pan to any coordinate
(including negative), pinch / wheel to zoom, drawn content stored in
world coords decoupled from the screen.

## The viewport model

```js
viewport = { tx: number, ty: number, scale: number };
// screen = world * scale + t
// world  = (screen - t) / scale
```

`tx, ty` are the screen-space position of the world origin
`(0, 0)`. `scale` is screen-px per world-unit.

Conversions:

```js
screenToWorld(sx, sy) {
  return { x: (sx - tx) / scale, y: (sy - ty) / scale };
}
worldToScreen(wx, wy) {
  return { x: wx * scale + tx, y: wy * scale + ty };
}
```

**Store strokes in world coordinates.** This is the whole point —
zoom-in / pan don't touch the data.

## Pan

```js
pan(dx, dy) {            // both in screen px
  viewport.tx += dx;
  viewport.ty += dy;
}
```

Hook to mouse drag (`movementX/Y`) or single-finger touch drag in
hand mode.

## Zoom-at-anchor

For both wheel and pinch, the anchor (cursor / pinch midpoint) should
stay visually still while the world scales around it. Classic formula:

```js
zoomAt(anchorX, anchorY, factor) {
  const oldScale = viewport.scale;
  const newScale = clamp(oldScale * factor, MIN, MAX);
  if (newScale === oldScale) return;
  const k = newScale / oldScale;
  viewport.tx = anchorX - (anchorX - viewport.tx) * k;
  viewport.ty = anchorY - (anchorY - viewport.ty) * k;
  viewport.scale = newScale;
}
```

Derived from: if `(anchorX, anchorY)` maps to world point `P` before
zoom, we want it to still map to `P` after zoom, with new `scale * k`.

Min / max scale: `0.1` and `8` worked well for math handwriting.

## Pinch gesture

Two-finger touch, snapshot `{ midpoint, distance, viewport }` on the
second `pointerdown`. On move:

```js
const k = currentDistance / startDistance;
const newScale = clamp(startScale * k, MIN, MAX);
const actualK = newScale / startScale;        // may differ if clamped
viewport.tx = midX - (startMidX - startTx) * actualK;
viewport.ty = midY - (startMidY - startTy) * actualK;
viewport.scale = newScale;
```

Note: also apply the *current* midpoint as the anchor each frame, so
the user can pan + zoom in one gesture (move both fingers in the same
direction while spreading).

## Wheel

Match Figma / Excalidraw conventions:

- `wheel` with `ctrlKey` or `metaKey` → pinch zoom at cursor.
  Touchpad pinch sends `ctrlKey` on macOS / iOS — this is how Apple
  surfaces pinch as a wheel event.
- otherwise → pan (`viewport.tx -= deltaX, ty -= deltaY`).
- `shiftKey` + wheel can swap horizontal/vertical pan.

```js
if (e.ctrlKey || e.metaKey) {
  const factor = Math.exp(-e.deltaY * 0.01);   // exponential, smooth
  zoomAt(e.clientX, e.clientY, factor);
} else {
  pan(-e.deltaX, -e.deltaY);
}
```

`event.preventDefault()` to stop page scroll.

## HiDPI / DPR

```js
const dpr = Math.max(1, window.devicePixelRatio || 1);
canvas.width  = clientWidth  * dpr;
canvas.height = clientHeight * dpr;
ctx.setTransform(dpr, 0, 0, dpr, 0, 0);  // draw in CSS px from here
```

Now `ctx.moveTo(x, y)` accepts CSS pixels; the GPU renders at
physical pixels. Strokes are crisp on retina.

Re-resize on `window.resize`. If you also want to track DPR changes
(zoom in browser), listen for `matchMedia(\`(resolution: \${dpr}dppx)\`)`
or just refit on resize.

## Initial position

`(0, 0)` in world coords → center of screen on first load:

```js
viewport.tx = canvas.clientWidth  / 2;
viewport.ty = canvas.clientHeight / 2;
viewport.scale = 1;
```

Persist `viewport` to IndexedDB meta store. Debounce write (300 ms)
so panning doesn't hammer disk.

## Grid rendering

Dynamic step: at any zoom, the grid step should appear ~16–64 screen
px. Pick a base world step (e.g. 32), then double / halve until the
on-screen step is in range:

```js
let step = 32;
let stepScreen = step * scale;
while (stepScreen < 16) { step *= 2; stepScreen *= 2; }
while (stepScreen > 64) { step /= 2; stepScreen /= 2; }
```

Then `startX = floor(-tx / stepScreen) * stepScreen + tx` (and same
for Y) is the leftmost grid line's screen X. Walk by `stepScreen`
across the viewport.

Modes I shipped:
- `dots`: small circle at each intersection
- `squares`: vertical + horizontal lines (math paper)
- `lines`: horizontal only (notebook paper)
- `none`

Snap each line's X to `Math.round(x) + 0.5` to keep them crisp 1-px
wide.

A faint cross at world origin (only when `0.4 < scale < 4`) helps
orient.

## Bbox culling

```js
function aabbIntersect(b, v) {
  return !(b[2] < v[0] || b[0] > v[2] || b[3] < v[1] || b[1] > v[3]);
}

const wView = [
  -tx / scale,           -ty / scale,
  (W - tx) / scale,      (H - ty) / scale,
];
for (const s of strokes) {
  if (!aabbIntersect(s.bbox, wView)) continue;
  drawStroke(ctx, s, viewport, inkColor);
}
```

Skip the segment loop entirely for off-screen strokes. Negligible
overhead, huge win at zoomed-out / dense scenes.

## Reset

`0` key or button: snap back to world origin centered, scale = 1.

```js
resetViewport() {
  viewport.tx = canvas.clientWidth / 2;
  viewport.ty = canvas.clientHeight / 2;
  viewport.scale = 1;
}
```

## Caveats

- `requestAnimationFrame` coalesce — multiple `pan` / `zoomAt` in one
  frame should result in one render. `requestRender()` sets a dirty
  flag that rAF consumes.
- Numerical drift when panning very far. With `Float32Array` for
  strokes you have ~7 decimal digits of precision in world coords —
  enough for any realistic ScratchPad zoom range, but if you go
  100km from origin at 0.01mm precision you'll lose it.
- iPad Safari clamps canvas backing store size around 16M pixels.
  At `dpr=2` and a 12.9" iPad (≈ 5MP logical), you're at ~20MP
  backing — should be OK but check on hardware.
