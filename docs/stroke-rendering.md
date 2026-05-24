# Stroke rendering

How to draw a smooth, pressure-aware stroke on `<canvas>`. The
"jaggies" investigation took a few rounds; the final design has two
render paths chosen automatically per stroke.

## Stroke storage

Vector format, world coordinates:

```js
{
  id: 42,
  color: "ink",                       // "ink" is a sentinel that re-resolves to theme color
  width: 2.2,                         // CSS px at viewport.scale = 1
  points: Float32Array(N * 3),        // [x, y, p, x, y, p, ...]
  bbox: [x0, y0, x1, y1],             // precomputed for cull
}
```

- `Float32Array` over plain array: `.length / 3` quick math, half the
  memory, IDB structured-clone preserves the typed array.
- `bbox` updated incrementally during stroke build, frozen on
  `endStroke`. Saves O(N) per render at draw time.
- `"ink"` color sentinel: resolves at draw time to current theme's ink
  color so theme toggle re-renders correctly without touching data.

## The two render paths

ScratchPad ended up with auto-detect. Scan once: if every `p[i*3+2]
=== 1` the stroke is uniform-width; otherwise variable.

### Uniform path — single Path2D + quadratic midpoints

When all pressure values are `1`, render as a single SVG-like stroked
path. Native browser stroke antialiasing is unbeatable for clean
lines.

```js
ctx.lineWidth = Math.max(0.5, s.width * scale);
ctx.lineCap = "round";
ctx.lineJoin = "round";
ctx.beginPath();
ctx.moveTo(sx[0], sy[0]);
for (let i = 1; i < N - 1; i++) {
  const mx = (sx[i] + sx[i+1]) * 0.5;
  const my = (sy[i] + sy[i+1]) * 0.5;
  ctx.quadraticCurveTo(sx[i], sy[i], mx, my);
}
ctx.lineTo(sx[N-1], sy[N-1]);
ctx.stroke();
```

Why quadratic-through-midpoints: each `pointermove` sample becomes a
control point. The curve only passes through midpoints, not through
the controls. So a single noisy sample doesn't put a kink in the
path — it just bends the curve toward it slightly.

### Variable path — filled ribbon

For variable pressure, build a polygon by offsetting the centerline
to both sides perpendicular to the local tangent, then walk both
sides with quadratic-through-midpoints, and seal with full-circle
end-caps.

```js
// per-sample half-width
hw[i] = max(0.25, s.width * (0.3 + 0.7 * pow(pressure, 0.6)) * scale * 0.5);

// per-sample normal direction (perpendicular to local tangent)
// for i in 0..N-1:
const dx = sx[i+1] - sx[i-1];   // central difference; endpoints use one-sided
const dy = sy[i+1] - sy[i-1];
const len = hypot(dx, dy) || 1;
const nx = -dy / len, ny = dx / len;
lx[i] = sx[i] + nx * hw[i];   ly[i] = sy[i] + ny * hw[i];
rx[i] = sx[i] - nx * hw[i];   ry[i] = sy[i] - ny * hw[i];

// fill ribbon
ctx.beginPath();
ctx.moveTo(lx[0], ly[0]);
for (let i = 1; i < N - 1; i++) {
  const mx = (lx[i] + lx[i+1]) * 0.5;
  const my = (ly[i] + ly[i+1]) * 0.5;
  ctx.quadraticCurveTo(lx[i], ly[i], mx, my);
}
ctx.lineTo(lx[N-1], ly[N-1]);
ctx.lineTo(rx[N-1], ry[N-1]);
for (let i = N - 2; i > 0; i--) {
  const mx = (rx[i] + rx[i-1]) * 0.5;
  const my = (ry[i] + ry[i-1]) * 0.5;
  ctx.quadraticCurveTo(rx[i], ry[i], mx, my);
}
ctx.lineTo(rx[0], ry[0]);
ctx.closePath();
ctx.fill();

// circle caps cover the straight crossings at the endpoints
ctx.beginPath(); ctx.arc(sx[0],   sy[0],   hw[0],   0, 2*PI); ctx.fill();
ctx.beginPath(); ctx.arc(sx[N-1], sy[N-1], hw[N-1], 0, 2*PI); ctx.fill();
```

Pressure → half-width curve `0.3 + 0.7 * p^0.6` was tuned by feel:
- Linear `0.5 + p` had too narrow a dynamic range (~2.7×).
- `p^0.5` was over-sensitive to feathery taps.
- `0.3 + 0.7 * p^0.6` gives ~3.3× dynamic range, low-pressure stays
  visible, full-pressure is clearly thick.

## Why two paths, not one

The ribbon path can be visible-aliased at high zoom even with native
canvas AA, because the polygon edges are discrete piecewise-linear
between offset samples. With uniform width, the single stroked path
has cleaner AA via the GPU's line rasterizer.

For a writing app most strokes default to "pressure off" (so all
pressure = 1) and benefit from the uniform path. Pressure-on strokes
still get the proper variable-width feel via the ribbon.

## ⚠ Pressure as DATA, not RENDER

First version put the pressure toggle on the render side: always
store actual sensor pressure, decide whether to render with
variation. User correction:

> 压感关掉的时候写的应该就是满压感，而不是只是渲染

Right semantics: pressure-off means "I drew at full pressure." Bake
`1.0` into the stored data. Then:

1. Old strokes keep their captured pressure forever. Toggle doesn't
   retroactively flatten them.
2. New strokes captured with pressure-off are factually uniform-
   pressure data.
3. Renderer doesn't need a flag — auto-detect from the data.

Implementation: pass a `getPressureEnabled` getter into the input
layer; gate it inside `effectivePressure(e, enabled)` (returns 1.0
unconditionally when off). Renderer is dumb.

## Shared render path between live + export

The live `Board.render()` and the offscreen `renderOffscreen()` for
PNG/PDF export both call the **same** `drawStroke(ctx, s, viewport,
inkColor)`. Don't duplicate the drawing code.

```js
// board.js
export function drawStroke(ctx, s, viewport, inkColor) { /* … */ }

// export.js
import { drawStroke } from "./board.js";
function renderOffscreen(board, ctx, opts) {
  const viewport = { tx: opts.tx, ty: opts.ty, scale: opts.scale };
  for (const s of board.strokes) {
    drawStroke(ctx, s, viewport, board._inkColor);
  }
}
```

A diverging export pipeline produces visible "WYSIWYG"-vs-export
mismatches. Don't go there.

## Performance notes

- AABB cull at render time: skip strokes whose `bbox` doesn't
  intersect the world-space viewport rect. Cheap (`!(b[2]<v[0] ||
  b[0]>v[2] || …)`), saves a lot on dense scenes.
- `requestAnimationFrame` debounce: `requestRender()` sets a flag, rAF
  runs once. Don't redraw on every `pointermove`.
- Float64Array intermediate arrays for the ribbon (`sx, sy, hw, lx,
  ly, rx, ry`) — allocated per stroke. Could pool if profiling shows
  GC pressure; didn't need to.

## What I'd revisit if doing it again

- Cache the live stroke's rendered path while drawing — currently
  every `pointermove` re-renders every committed stroke from scratch
  (with bbox cull). For thousands of strokes that's still fast on
  iPad but could be smarter with an "already rendered to a bitmap"
  cache.
- Variable-width ribbon could be implemented as multiple stroked
  paths with interpolated width instead of a filled polygon — might
  AA better at small zoom. Didn't profile.
