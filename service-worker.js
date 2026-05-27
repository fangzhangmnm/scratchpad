// SW: cache-first + 后台 revalidate + 改了通知页面（toast）。
// 改文件前 bump CACHE_VERSION。
//
// ScratchPad 是纯本地，没有任何运行时跨源请求 — vendor 也在仓库里。
// 所以 SW 只关心同源即可。
//
// v8 起：响应 .js 时改写 import URL 加 ?v=VERSION，绕开 iPad Safari WKWebView
// 的 V8 bytecode cache (按 URL 索引，URL 没变就用旧 bytecode，即使 SW 返回了
// 新内容也忽略)。详见 docs/pointer-and-pen-input.md / WebPaint 同款问题。

const CACHE_VERSION = "v9-2026-05-27";
const CACHE_NAME = `scratchpad-${CACHE_VERSION}`;

const PRECACHE_URLS = [
  "./",
  "./index.html",
  "./manifest.webmanifest",
  "./icon.svg",
  "./apple-touch-icon-180.png",
  "./icon-192.png",
  "./icon-512.png",
  "./src/styles.css",
  "./src/app.js",
  "./src/board.js",
  "./src/input.js",
  "./src/db.js",
  "./src/export.js",
  "./src/textbox.js",
  "./src/vendor/jspdf.umd.min.js",
  // KaTeX vendor (懒加载，但 SW 预缓存：装 PWA 第一次就能离线用文字)
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

// .js module 走 import-URL 改写。vendor/ 是 UMD 不用改 (没有 ES import)。
function isJSModule(url) {
  return url.pathname.endsWith(".js")
    && url.pathname.includes("/src/")
    && !url.pathname.includes("/vendor/");
}

// 把源码里 `from "./xxx.js"` 和 `import("./xxx.js")` 改成 `?v=VERSION`。
// 版本变 = URL 变 = bytecode 缓存键变 = 强制重编译。
function rewriteImports(text) {
  const v = `?v=${CACHE_VERSION}`;
  return text
    .replace(/(\bfrom\s+)(["'])(\.[^"'?]+\.js)(["'])/g, `$1$2$3${v}$4`)
    .replace(/(\bimport\s*\(\s*)(["'])(\.[^"'?]+\.js)(["'])/g, `$1$2$3${v}$4`);
}

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(PRECACHE_URLS);
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
  // 跨源 (新版本检测之类) → passthrough
  if (url.origin !== self.location.origin) return;

  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // ignoreSearch：cache 按裸 URL 存；带 ?v=N 的请求也能命中
    const cached = await cache.match(req, { ignoreSearch: true });
    // 拿网络 / 写 cache 都按裸 URL
    const bareReq = new Request(url.origin + url.pathname);

    const network = fetch(bareReq).then((resp) => {
      if (resp && resp.ok) {
        if (cached) {
          const cE = cached.headers.get("etag");
          const fE = resp.headers.get("etag");
          const cL = cached.headers.get("content-length");
          const fL = resp.headers.get("content-length");
          const changed = (cE && fE && cE !== fE) || (!cE && cL && fL && cL !== fL);
          if (changed) notifyUpdate(req.url).catch(() => {});
        }
        cache.put(bareReq, resp.clone()).catch(() => {});
      }
      return resp;
    }).catch(() => null);

    async function maybeRewrite(resp) {
      if (!resp || !isJSModule(url)) return resp;
      const text = await resp.text();
      const rewritten = rewriteImports(text);
      return new Response(rewritten, {
        status: resp.status,
        headers: { "Content-Type": "application/javascript" },
      });
    }

    if (cached) {
      network.catch(() => {});
      return await maybeRewrite(cached.clone());
    }
    const resp = await network;
    if (resp) return await maybeRewrite(resp.clone());
    if (req.mode === "navigate") {
      const fallback = await cache.match("./index.html");
      if (fallback) return fallback;
    }
    return new Response("offline & not cached", { status: 503 });
  })());
});

self.addEventListener("message", (event) => {
  if (event.data?.type === "skip-waiting") self.skipWaiting();
});
