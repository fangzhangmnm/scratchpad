// SSoT for app version. Loaded by:
//   - service-worker.js  via importScripts("./src/version.js") → SW CACHE_VERSION
//   - index.html         via <script src="./src/version.js"> (classic, before app.js) → window.SCRATCHPAD_VERSION
// Bump here on every shipped change. Both sides pick it up automatically.
self.SCRATCHPAD_VERSION = "v18-2026-06-20";
