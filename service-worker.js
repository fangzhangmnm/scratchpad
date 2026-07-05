// SW（bundle 后重写）：整个站只剩 1 个 hash-named bundle，缓存失效**自动**通过文件名差异
// 解决。老花招（version.js 合成 CACHE_VERSION / import URL rewrite）全删。
//
// 设计：
//   - install：fetch index.html → 抠出当前 bundle 文件名 → precache 入口 + bundle + statics
//   - cache name = "scratchpad-<bundleHash>"。新 bundle = 新 cache name；activate 时清老的。
//   - fetch：cache-first(prod) / network-first(dev) + 后台 revalidate；ETag 变了通知 page。
//
// 抄自 sibling canonical（`../20260524 WebPaint/service-worker.js`），**与它逐字对齐**——
// 只差两处：① scratchpad- 名（vs webpaint-）② STATIC_PRECACHE 列表。改 canonical 时把新逻辑
// 照拷回来即可（diff 应仍只剩这两处 + 本头注）。ScratchPad 纯本地无云、无跨源请求、无
// passthrough 红线，故 fetch handler 与 WebPaint 逐字同（无 .glb/.gltf 那类 passthrough）。
//
// STATIC_PRECACHE = PWA 壳 + styles + version.js（水印）+ vendor 库（jspdf/html2canvas/katex）。
//   vendor 虽懒加载，仍预缓存：装 PWA 第一次就能离线导出 / 用文字（ScratchPad offline-first）。

const STATIC_PRECACHE = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./icon-192.png",
  "./icon-512.png",
  "./apple-touch-icon-180.png",
  "./src/styles.css",
  "./src/version.js",
  "./src/vendor/jspdf.umd.min.js",
  "./src/vendor/html2canvas/html2canvas.min.js",
  "./src/vendor/katex/katex.min.js",
  "./src/vendor/katex/katex.min.css",
  "./src/vendor/katex/fonts/KaTeX_AMS-Regular.woff2",
  "./src/vendor/katex/fonts/KaTeX_Caligraphic-Bold.woff2",
  "./src/vendor/katex/fonts/KaTeX_Caligraphic-Regular.woff2",
  "./src/vendor/katex/fonts/KaTeX_Fraktur-Bold.woff2",
  "./src/vendor/katex/fonts/KaTeX_Fraktur-Regular.woff2",
  "./src/vendor/katex/fonts/KaTeX_Main-Bold.woff2",
  "./src/vendor/katex/fonts/KaTeX_Main-BoldItalic.woff2",
  "./src/vendor/katex/fonts/KaTeX_Main-Italic.woff2",
  "./src/vendor/katex/fonts/KaTeX_Main-Regular.woff2",
  "./src/vendor/katex/fonts/KaTeX_Math-BoldItalic.woff2",
  "./src/vendor/katex/fonts/KaTeX_Math-Italic.woff2",
  "./src/vendor/katex/fonts/KaTeX_SansSerif-Bold.woff2",
  "./src/vendor/katex/fonts/KaTeX_SansSerif-Italic.woff2",
  "./src/vendor/katex/fonts/KaTeX_SansSerif-Regular.woff2",
  "./src/vendor/katex/fonts/KaTeX_Script-Regular.woff2",
  "./src/vendor/katex/fonts/KaTeX_Size1-Regular.woff2",
  "./src/vendor/katex/fonts/KaTeX_Size2-Regular.woff2",
  "./src/vendor/katex/fonts/KaTeX_Size3-Regular.woff2",
  "./src/vendor/katex/fonts/KaTeX_Size4-Regular.woff2",
  "./src/vendor/katex/fonts/KaTeX_Typewriter-Regular.woff2",
];

let CACHE_NAME = "scratchpad-boot";   // install 时会被替换为 scratchpad-<bundleHash>

// 同一个 SW 文件部署到 /(prod) 和 /dev/ 两处；按**自己的作用域**选策略：
//   - prod(scope=/)      → cache-first：秒开 + 离线稳，更新靠 asset-updated toast。
//   - dev(scope 含 /dev/) → network-first：在线永远先抓网（「改完即见」/强制更新不变），离线才回退缓存
//     （崩溃后能离线重开——修「/dev/ 按设计无 SW → 闪退离线打不开」的坑）。
const SCOPE_IS_DEV = self.location.pathname.includes("/dev/");

async function getCurrentBundleUrl() {
  const res = await fetch("./index.html", { cache: "no-store" });
  if (!res.ok) throw new Error("install: index.html fetch failed " + res.status);
  const html = await res.text();
  // <script type="module" src="./dist/scratchpad-<hash>.mjs"></script>
  const m = html.match(/src="(\.\/dist\/scratchpad-[a-z0-9-]+\.mjs)"/i);
  if (!m) throw new Error("install: 找不到 ./dist/scratchpad-*.mjs 入口 in index.html");
  return { html, bundleUrl: m[1] };
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const { bundleUrl } = await getCurrentBundleUrl();
    const bundleHash = bundleUrl.match(/scratchpad-([a-z0-9-]+)\.mjs/i)?.[1] || "boot";
    CACHE_NAME = `scratchpad-${bundleHash}`;
    const cache = await caches.open(CACHE_NAME);
    const urls = [...STATIC_PRECACHE, bundleUrl, bundleUrl + ".map"];
    await Promise.all(urls.map((u) =>
      fetch(u, { cache: "no-store" })
        .then((r) => r.ok ? cache.put(u, r) : null)
        .catch((err) => console.warn("[SW] precache miss", u, err.message))
    ));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(
      keys.filter((k) => k.startsWith("scratchpad-") && k !== CACHE_NAME)
          .map((k) => caches.delete(k))
    );
    await self.clients.claim();
  })());
});

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
  if (url.origin !== self.location.origin) return;
  // prod 根 SW(scope=/)不碰 /dev/——留给 /dev/ 作用域的 dev SW 自己处理。
  if (!SCOPE_IS_DEV && url.pathname.includes("/dev/")) return;
  event.respondWith(SCOPE_IS_DEV ? networkFirst(req) : cacheFirst(req));
});

// prod：cache-first + 后台 revalidate（ETag/长度变 → 通知 page 弹更新 toast）。
async function cacheFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  const cached = await cache.match(req, { ignoreSearch: true });
  const networkPromise = fetch(req).then((resp) => {
    if (resp && resp.ok) {
      if (cached) {
        const cE = cached.headers.get("etag"), fE = resp.headers.get("etag");
        const cL = cached.headers.get("content-length"), fL = resp.headers.get("content-length");
        const changed = (cE && fE && cE !== fE) || (!cE && cL && fL && cL !== fL);
        if (changed) notifyUpdate(req.url).catch(() => {});
      }
      cache.put(req, resp.clone()).catch(() => {});   // hash-named bundle 内容不变；其它文件更新则刷一次
    }
    return resp;
  }).catch(() => null);
  if (cached) { networkPromise.catch(() => {}); return cached; }
  const resp = await networkPromise;
  if (resp) return resp;
  return navFallback(req, cache);
}

// dev：network-first——在线永远拿最新（「改完即见」/强制更新不变），离线才回退缓存（崩溃后能离线重开）。
async function networkFirst(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const resp = await fetch(req);
    if (resp && resp.ok) cache.put(req, resp.clone()).catch(() => {});   // 顺手刷缓存，供下次离线回退
    return resp;
  } catch {
    const cached = await cache.match(req, { ignoreSearch: true });
    if (cached) return cached;
    return navFallback(req, cache);
  }
}

// 导航请求离线且未命中 → 回退缓存的 index.html（PWA 壳）；否则 503。
async function navFallback(req, cache) {
  if (req.mode === "navigate") {
    const fallback = await cache.match("./index.html");
    if (fallback) return fallback;
  }
  return new Response("offline & not cached", { status: 503 });
}

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});
