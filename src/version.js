// SSoT for app version (纯水印显示用). Loaded by:
//   - index.html via <script src="./src/version.js"> (classic, before the bundle) → window.SCRATCHPAD_VERSION
// bundle 后 SW 不再 importScripts 本文件 —— cache 失效改由 dist/scratchpad-<hash>.mjs 的
// content-hash 自动驱动（见 service-worker.js）。本文件只剩水印一职。bump 走 ./bump.sh。
self.SCRATCHPAD_VERSION = "v31-2026-07-09";
