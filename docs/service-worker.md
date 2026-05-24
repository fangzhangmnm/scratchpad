# Service Worker — cache-first + update toast + version bump

Strategy used across the lobster-project series. Same SW shape works
whether the app needs cloud (JustReadPapers, Background Radio) or is
pure local (ScratchPad).

## Core decisions

1. **Cache-first** — page loads from cache, network in background.
   Drawing/reading apps shouldn't lag waiting for network.
2. **ETag / content-length diff** detects updates. On change, post
   `{type: "asset-updated"}` to clients.
3. **Never auto-reload.** The user might be mid-stroke / mid-paragraph.
   Page shows a "新版本" toast; user clicks → `postMessage("skip-waiting")`
   → `location.reload()`.
4. **Same-origin only.** Cross-origin requests pass through.
   (Sibling projects with CDN deps have a separate `CDN_DOMAINS`
   allow-list; ScratchPad doesn't need one because vendor is local.)
5. **Bump `CACHE_VERSION` for every shipped change** — the SW source
   byte changes, browser fires `updatefound`, iOS PWA picks it up.

## Skeleton

```js
const CACHE_VERSION = "v7-2026-05-20";        // bump on every ship
const CACHE_NAME = `scratchpad-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./", "./index.html", "./manifest.webmanifest",
  "./icon.svg", "./apple-touch-icon-180.png",
  "./icon-192.png", "./icon-512.png",
  "./src/styles.css",
  "./src/app.js", "./src/board.js", "./src/input.js",
  "./src/db.js", "./src/export.js",
  "./src/vendor/jspdf.umd.min.js",
];

self.addEventListener("install", (e) => e.waitUntil((async () => {
  const cache = await caches.open(CACHE_NAME);
  await cache.addAll(PRECACHE_URLS);
  await self.skipWaiting();
})()));

self.addEventListener("activate", (e) => e.waitUntil((async () => {
  const keys = await caches.keys();
  await Promise.all(
    keys.filter(k => k.startsWith("scratchpad-") && k !== CACHE_NAME)
        .map(k => caches.delete(k))
  );
  await self.clients.claim();
})()));

let updateAnnounced = false;
async function notifyUpdate(url) {
  if (updateAnnounced) return;
  updateAnnounced = true;
  const clients = await self.clients.matchAll({ includeUncontrolled: true });
  for (const c of clients) c.postMessage({ type: "asset-updated", url });
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // passthrough

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    const cached = await cache.match(req);
    const network = fetch(req).then((resp) => {
      if (resp && resp.ok) {
        if (cached) {
          const cE = cached.headers.get("etag");
          const fE = resp.headers.get("etag");
          const cL = cached.headers.get("content-length");
          const fL = resp.headers.get("content-length");
          const changed = (cE && fE && cE !== fE) ||
                          (!cE && cL && fL && cL !== fL);
          if (changed) notifyUpdate(req.url).catch(() => {});
        }
        cache.put(req, resp.clone()).catch(() => {});
      }
      return resp;
    }).catch(() => null);

    if (cached) { network.catch(() => {}); return cached; }
    const resp = await network;
    if (resp) return resp;
    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("offline & not cached", { status: 503 });
  })());
});

self.addEventListener("message", (e) => {
  if (e.data?.type === "skip-waiting") self.skipWaiting();
});
```

## Page-side wiring

```js
navigator.serviceWorker.addEventListener("message", (e) => {
  if (e.data?.type === "asset-updated") {
    showUpdateToast();
  }
});
updateToastReload.addEventListener("click", () => {
  navigator.serviceWorker?.controller?.postMessage({ type: "skip-waiting" });
  location.reload();
});
```

## ⚠ The half-cached state failure (real bug)

**Symptom:** After shipping a release with new HTML elements that new
JS depends on, iPad users report "JS 挂了" (app dead). No devtools
to debug.

**Why:** The fetch handler does cache-first + background revalidate
+ cache.put with the new response. So during the revalidate window,
the user can land on a page where:
- `index.html` was just updated in cache (new HTML with the new button)
- `src/app.js` was the OLD version (still cached, not yet revalidated)

OR (more commonly):

- The active SW is still the previous version
- It served OLD cached `index.html`
- New `app.js` arrived via background revalidate, was used on next reload
- New `app.js` queries `getElementById("newButton")`, gets `null`,
  call `null.setAttribute(...)`, throws → boot dies

iPad has no devtools so the failure is silent and total.

### Mitigation

1. **Defensive DOM access in JS.** Optional-chain every querySelector
   result that points at a possibly-new element:

   ```js
   els.pressureBtn?.addEventListener("click", …);
   if (els.pressureBtn) els.pressureBtn.setAttribute(…);
   ```

2. **Try/catch around `localStorage`** — Safari private mode throws.

3. **Inline error overlay.** From an inline `<script>` that runs
   BEFORE module load, register `window.onerror` +
   `onunhandledrejection`. Paint failures as a red bar across the top
   of the screen. See [ios-pwa-quirks.md](ios-pwa-quirks.md).

4. **Bump `CACHE_VERSION` aggressively.** Every change ships with a
   bump. Clients see "新版本" → reload → atomically pick up the
   matching set of files.

5. Resist shipping HTML changes without bumping. Even cosmetic HTML
   change that affects DOM structure needs a bump.

## What I'd do differently next time

- Consider serving a separate `version.json` and gating UI features on
  it — so the app can detect "I'm running JS from a newer version than
  the HTML I'm in" and self-disable / force-reload.
- Or: make the SW go network-first for `index.html` specifically
  (always fresh shell), cache-first for everything else. That breaks
  the "instantly opens offline" promise though.

For now, defensive coding + version bumps is what's there.
