# Lessons from ScratchPad

This folder is a knowledge dump from building ScratchPad (a write-then-burn
infinite-canvas PWA for Apple Pencil / stylus / mouse on iPad + desktop).

These are not generic tutorials — every doc records something I actually
hit while shipping the first version. Future similar projects (offline
PWA + pointer input + canvas drawing) can use these as priors.

## Topics

| File | What it covers |
| - | - |
| [20260524-pwa-shell-pattern.md](20260524-pwa-shell-pattern.md) | Zero-build PWA layout, GH Pages deploy, vendored deps |
| [20260529-pwa-update-detection.md](20260529-pwa-update-detection.md) | 4 SW update paths + manual check + version watermark + version.js SSoT (WebPaint port) |
| [20260524-service-worker.md](20260524-service-worker.md) | Cache-first + ETag toast + version bump discipline, the half-cached state failure mode |
| [20260529-canvas-resize.md](20260529-canvas-resize.md) | visualViewport + ResizeObserver + window.resize trio; dimension-change early-exit (cause of stroke / pointer drift) |
| [20260524-pointer-and-pen-input.md](20260524-pointer-and-pen-input.md) | PointerEvents, palm rejection, pinch gesture, double-tap detection (saga), light jitter smoothing, Pencil barrel-tap limit |
| [20260524-stroke-rendering.md](20260524-stroke-rendering.md) | Path2D vs variable-width ribbon, when to use which, pressure as data-layer not render-layer |
| [20260524-infinite-canvas.md](20260524-infinite-canvas.md) | Viewport transform math, DPR/HiDPI, grid rendering, bbox-cull |
| [20260524-ios-pwa-quirks.md](20260524-ios-pwa-quirks.md) | apple-touch-icon must be PNG, devtools-less debugging via inline error overlay, Share / Clipboard API |
| [20260524-export-share-clipboard.md](20260524-export-share-clipboard.md) | PNG / PDF download, `navigator.share`, `navigator.clipboard.write`, jspdf lazy-load |

## Conventions

When code patterns appear, they're trimmed to the load-bearing parts —
not full impls. Read alongside the actual `src/` if you need more.

When a quote says "user said …", it's verbatim from the conversation that
drove that decision. Useful for understanding the *why*, not just the *what*.
