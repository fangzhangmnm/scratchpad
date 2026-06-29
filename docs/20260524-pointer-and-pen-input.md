# Pointer + pen + touch input

Everything I learned wiring pencil / finger / mouse drawing onto a
single canvas. The Pencil double-tap saga is the longest section
because it took the most iteration.

## Use PointerEvent only

Forget `TouchEvent` / `MouseEvent`. `PointerEvent` unifies pen, touch,
and mouse with a consistent shape:

- `e.pointerType` → `"pen"` / `"touch"` / `"mouse"`
- `e.pressure` → `0..1` (real for Pencil, default `0.5` for mouse, may be `0` for touch / sensor warmup)
- `e.button` → `0` left / `1` middle / `2` right / etc.
- `e.getCoalescedEvents()` → all sub-frame samples since last frame

```js
canvas.addEventListener("pointerdown", _down);
canvas.addEventListener("pointermove", _move);
canvas.addEventListener("pointerup", _up);
canvas.addEventListener("pointercancel", e => _up(e, true));
canvas.addEventListener("pointerleave",  e => _up(e, true));
canvas.addEventListener("contextmenu",   e => e.preventDefault());
```

On the canvas CSS:

```css
.board {
  touch-action: none;     /* disable native pan / pinch interpretation */
  user-select: none;
}
```

On `pointerdown` call `canvas.setPointerCapture(e.pointerId)` so move
events keep flowing even if the finger / pen leaves the canvas bounds.

## Coalesced events for smooth pen

Pen sample rate (Apple Pencil ≈ 240 Hz) is way higher than `pointermove`
fire rate (~60 Hz tied to rAF). Use `getCoalescedEvents()` to capture
the in-between samples and avoid jagged strokes:

```js
const events = typeof e.getCoalescedEvents === "function"
  ? e.getCoalescedEvents() : null;
const list = (events && events.length) ? events : [e];
for (const ev of list) { /* one extendStroke per ev */ }
```

### ⚠ Cross-batch replay on Safari iOS (the big one)

`getCoalescedEvents()` on iPad Safari sometimes hands you the same samples
in the next `pointermove` callback too. Pattern:

```
_move call 1: getCoalescedEvents() → [t=4, t=8, t=13, t=17, t=21]
_move call 2: getCoalescedEvents() → [t=4, t=8, t=13, t=17, t=21, t=25, t=29]
                                      ↑─── repeats ───────↑   ↑ new ↑
```

Feed the whole list to your arc-length / segment algorithm → time goes
backwards at batch boundary → polyline folds back → distance accumulates
wrong → **periodic dense / sparse banding** in the stroke. Mouse doesn't
trigger this (mouse coalesced is usually a single event).

**Visually subtle in vector strokes**; with a brush engine that stamps by
arc-length it's plain to see (WebPaint hit this first). Fix is one line:
drop events whose `timeStamp` isn't strictly greater than the last
accepted one.

```js
// init on _down:
rec.lastEventTs = -Infinity;

// each event in the coalesced loop:
if (ev.timeStamp <= rec.lastEventTs) continue;
rec.lastEventTs = ev.timeStamp;
// ... rest of loop
```

Use `<=` not `<` — fully duplicate-timestamp events should also drop.
Cheap, safe, do it.

### Pencil `clientX/Y` are integer-quantized on Safari iOS

`PointerEvent.clientX/Y` from Apple Pencil on Safari iOS are **integers**.
Everywhere else (mouse, other platforms) they're doubles. At 1:1 zoom
moving close to horizontal/vertical, the polyline has visible stair-stepping
(±0.5 px noise).

Don't try to "fix" — sub-pixel reconstruction from neighboring sample
direction + timestamp is a project on its own. For handwriting, the
in-stroke LPF below masks it. Just be aware when doing curvature /
velocity analysis.

## Palm rejection — the `penEverSeen` flag

iPad's flow: when the user puts pen tip near the screen, the wrist
rests on the glass. The wrist generates a `touch` PointerEvent. If
you treat that as drawing, every pen stroke gets a palm streak.

Solution that worked: track `penEverSeen` globally per session.
Once ANY `pointerType === "pen"` event fires, treat all subsequent
`touch` events as **not for drawing**.

```js
if (e.pointerType === "pen") this.penEverSeen = true;

// later in _down:
if (e.pointerType === "touch" && this.penEverSeen) {
  // route to pan / gesture / ignore, never draw
}
```

This is sticky per session. If the user has a pen and then puts it
down to use finger, finger still goes to pan mode. That's fine — they
explicitly chose to ignore the pen by not using it. Reload to reset.

Don't try to be cleverer than that ("expire after 5s of no pen") —
the wrist rest can outlast the pen tip's last sample by seconds.

## Pinch + two-finger pan

Track all active pointers in a `Map<pointerId, rec>`. On `_down`:

- If we already have ≥1 active touch with a draw/erase role and
  another touch comes down → cancel the in-flight stroke, mark both
  as `role: "gesture"`, snapshot `{midpoint, distance, viewport}`.
- If a pen is currently drawing and a touch arrives → mark touch as
  `role: "ignore"` (it's palm). **Don't** flip the pen into gesture.

On `_move` of a gesture pointer:

```js
const k = currentDist / startDist;
const newScale = startScale * k;
const actualK = newScale / startScale;
viewport.tx = midX - (startMidX - startTx) * actualK;
viewport.ty = midY - (startMidY - startTy) * actualK;
viewport.scale = newScale;
```

## Mouse + keyboard

Mouse:
- `e.button === 0` (left) → draw
- `e.button === 1 / 2` (middle / right) → pan
- Wheel: ctrlKey (touchpad pinch) → zoom-at-cursor;
  otherwise → pan (matches Figma / Excalidraw)

Keyboard:
- `Space` (held) → temporary hand / pan, restore on release
- Letter keys for tool switching (`P` pen, `E` eraser, `H` hand)
- `0` reset viewport, `+/-` zoom
- `Ctrl+Z` / `Ctrl+Shift+Z` undo/redo

## Light jitter smoothing (writing-friendly)

Even with Apple Pencil, raw samples have sub-pixel wobble that, after
polygon-offset ribbon rendering, becomes visible edge aliasing.

One-pole IIR per pointer, α = 0.65:

```js
// init on _down:
rec.smX = rec.startX;
rec.smY = rec.startY;

// each coalesced move sample:
rec.smX += ALPHA * (ev.clientX - rec.smX);
rec.smY += ALPHA * (ev.clientY - rec.smY);
// use rec.smX / rec.smY for extendStroke
```

Constants matter:
- α too low (heavy smoothing): the pen tip "drags" — writing feels
  laggy, small digits ("i" dot, decimal point) get pulled toward
  the previous sample.
- α too high (light): wobble survives.
- α = 0.65 was the sweet spot for handwriting math.

Don't drop samples (don't add distance filter). Keep every coalesced
event, just smooth its position.

**Smoothing is for stored coords only.** Keep `rec.x / rec.y` = raw
for tap detection (see below) so thresholds aren't moved by the filter.

## Apple Pencil double-tap (barrel-tap)

**Not available to web JS.** Pencil 2 / Pro barrel-tap is an OS-level
gesture handled by `UIPencilInteraction` in native iOS apps. Safari
does not expose it. Don't try to detect it. Don't put a UI suggesting
it works.

**Compromise: screen double-tap.** Two quick taps anywhere on the
canvas → toggle pen/eraser. Took 3 iterations to land:

### V1 (failed): pen + touch, tight tolerances

```
TAP_MAX_MOVE = 8 px
DOUBLETAP_WINDOW = 400 ms
DOUBLETAP_MAX_GAP = 36 px
Both pen and touch trigger.
```

User: "ipad端狗牙严重，而且没有压感" + Pencil writing produces tap-
shaped events naturally. Detection fires on writing "=" and on every
"i" dot.

### V2 (failed): looser tolerances + finger added

```
TAP_MAX_MOVE = 16 px
DOUBLETAP_WINDOW = 500 ms
DOUBLETAP_MAX_GAP = 80 px
```

Still false-positive from Pencil because the tolerances were
addressing finger imprecision not stroke rhythm.

### V3 (final): finger-only, in palm-rejection mode

```js
const tapEligible = !cancelled && rec.downTime &&
  e.pointerType === "touch" && this.penEverSeen &&
  rec.role !== "gesture" && rec.role !== "ignore";
```

- Pen never triggers — Pencil rhythm naturally creates tap-shaped
  events all the time, can't distinguish intent from data alone.
- Touch on a no-pen-ever device doesn't trigger either — finger is
  the drawing tool, tap = dot, can't share the gesture.
- Touch on a pen-using device DOES trigger — there, finger is for
  pan, so a two-tap cadence is unambiguously UI intent.

Pencil users switch tool via toolbar / keyboard `E`. The cross-input
asymmetry is OK because the populations of "pen user" and "finger
user" don't overlap much.

Also: on pen `pointerdown`, clear `_lastTap = null`. Prevents the
"finger-tap → pen-stroke → finger-tap" race within the 500 ms
window.

## Erase semantics

Eraser tested with: object-level. Whole-stroke deletion if hit-test
within radius intersects any segment.

```js
function segDistSq(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx*dx + dy*dy;
  if (len2 === 0) { /* point distance */ }
  let t = ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  return (px - cx) ** 2 + (py - cy) ** 2;
}
```

For each stroke: bbox cull first (cheap), then segment scan only on
the survivors. Eraser radius = constant in screen px, divide by
viewport scale to get world radius.

## Undo / redo with erase

Two entry types:

```
{ type: "add",   strokes: [s] }
{ type: "erase", strokes: [s1, s2, ...] }
```

Undo:
- `"add"`: delete from db + remove from board
- `"erase"`: re-insert with original id (`putStrokeWithId`)

Cap stack at ~100 entries. Clear both stacks on `clearAll`.

## Pressure semantics — data layer, not render layer

See [20260524-stroke-rendering.md](20260524-stroke-rendering.md) for the full saga.
Short version: when the "pressure" toggle is OFF, write `1.0` into
the pressure column of every point. Don't gate rendering on a flag.

The full pressure pipeline has three traps:

```js
// rec init on _down (draw role):
rec.lastP = null;     // last valid raw pressure (fallback for sensor-zero blips)
rec.smP = -1;         // LPF state; -1 = not seeded yet

function effectivePressureFor(rec, e, enabled) {
  if (!enabled) return 1;
  let raw;
  if (e.pointerType === "mouse") {
    raw = 0.5;
  } else {
    const r = typeof e.pressure === "number" ? e.pressure : null;
    if (r == null || r === 0) {
      // (Trap 1) Pen up / sensor warmup pulses pressure = 0 even while
      // the tip is still on glass. If you treat that as "max thin"
      // (or "max thick" with inverted maps), the stroke END flicks
      // visibly. Fall back to the last valid sample.
      // (Trap 2) Initial sample before lastP exists → 0.2, not 0.5.
      // 0.5 makes every start bulb a bit; 0.2 starts narrow & honest.
      raw = rec.lastP != null ? rec.lastP : 0.2;
    } else {
      raw = Math.max(0.05, Math.min(1, r));
      rec.lastP = raw;
    }
  }
  // (Trap 3) Apple Pencil signals have ~10 Hz hand-tremor in the
  // pressure channel. Mapped into width with p^0.6 it visibly pulses
  // along the stroke ("mid-bulb"). One-pole LPF at α≈0.4 damps it.
  // sentinel < 0 → first sample bypasses LPF so taps / i-dots stay raw.
  if (rec.smP < 0) rec.smP = raw;
  else rec.smP += PRESSURE_SMOOTH_ALPHA * (raw - rec.smP);
  return rec.smP;
}
```

`PRESSURE_SMOOTH_ALPHA = 0.4` was WebPaint's tuned value. Anything
much lower starts to feel laggy on quick pressure changes. Higher
lets the 10 Hz pulses through.
