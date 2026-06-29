# PWA 更新检测 — 四条路径 + 手动 + 版本水印

复用自 WebPaint v58-60 的同款经验
(`/mnt/d/JupyterLocal/20260524 WebPaint/WebPaint/docs/20260529-pwa-update-detection.md`)
在 ScratchPad v16 整套落地。**直接拷过去能用的范式**。

## TL;DR — 缺一个都会有用户抱怨

1. SW 在模块顶层 register，**不要塞 window.load 里**
2. 四条 update 检测路径全挂 (waiting / updatefound / postMessage / poll)
3. 加一个"检测更新"按钮 (HUD 上的版本号水印就是这个按钮 — 一物两用)
4. 屏幕常驻显示版本号 (HUD 角落)

ScratchPad v15 之前只挂了路径 3，结果好几次 push 上去用户 PWA 看不到新版。v16 补齐。

## SW 注册位置 (路径 0)

```js
// ❌ 错
window.addEventListener("load", async () => {
  await navigator.serviceWorker.register(...);
});

// ✅ 对
// 模块顶层直接 register
if ("serviceWorker" in navigator && !LOCAL_DEV_HOSTS.has(location.hostname)) {
  navigator.serviceWorker.register("./service-worker.js").then((reg) => {
    _swRegistration = reg;
    ...
  });
}
```

为什么：用 `<script type="module">` + dynamic `import()` 加载入口模块时，模块加载
是异步的 (网络 + 编译 + 依赖图)。等到 app.js 跑起来时 `load` event 经常已 fire
过 → `addEventListener("load", ...)` 永远不触发 → SW 根本没注册。iPad PWA 飞行模
式找不到服务器；菜单"检测更新"说"SW 未注册"。

## 四条路径

```
                 +-----------------------+
   bump version → ETag/byte 变 ────────→│ 浏览器 fetch 新 SW    │
                 +-----------┬-----------+
                             |
              registration.update() (路径 4)
                             |
              install → precache → skipWaiting
                             |
              state: installed (路径 2) ──→ showUpdate()
                             |
              activate → clients.claim
                             |
              asset-updated postMessage (路径 3) ──→ showUpdate()

  开机时:   registration.waiting (路径 1) ──→ showUpdate()
```

### 路径 1：`registration.waiting`
开机检查。上次 session 把新 SW 装到 waiting 状态但没 activate，再开 app 时把它捞出来。

### 路径 2：`updatefound + statechange === "installed"`
本次 session 浏览器 check 到新 SW 且装完的瞬间。前提：`navigator.serviceWorker.controller` 存在 (首装时 controller 是 null，不该弹 toast)。

### 路径 3：SW `postMessage({ type: "asset-updated" })`
SW 的 fetch handler 做 cache-first + background revalidate，发现网络版 ETag/content-length 跟 cached 不同就广播。**比版本号检测更敏感** — 忘 bump version 但某个 asset 字节级变了也能抓到。

### 路径 4：`visibilitychange` / `focus` / 10min interval → `registration.update()`
**关键** — iPad PWA standalone 不主动 check SW。没这条，前三条都得等浏览器想起来。

## "刷新"按钮的常见 bug

```js
// ❌ 错
navigator.serviceWorker?.controller?.postMessage({ type: "skip-waiting" });
location.reload();
```

为什么炸：`controller` 是当前 active 的 SW = 旧版本。它自己已 active，
`self.skipWaiting()` 无意义。新 SW 永远卡在 waiting；reload 用旧 controller 服务，
拿旧 index.html → 老代码再跑 → toast 又弹。永动机。

```js
// ✅ 对
const reg = _swRegistration || await navigator.serviceWorker?.getRegistration();
if (!reg || !reg.waiting) { location.reload(); return; }
let reloaded = false;
const doReload = () => { if (reloaded) return; reloaded = true; location.reload(); };
navigator.serviceWorker.addEventListener("controllerchange", doReload, { once: true });
reg.waiting.postMessage({ type: "skip-waiting" });
setTimeout(doReload, 5000);   // 兜底防 iOS 偶发不 fire controllerchange
```

关键：
- postMessage 推 `reg.waiting`，不是 `controller`
- 听 `controllerchange` 等新 SW 接管再 reload
- 5s 兜底 timeout

## 版本号 SSoT

`src/version.js` 是单一来源：

```js
// src/version.js — classic script
self.SCRATCHPAD_VERSION = "v16-2026-05-28";
```

- `index.html` 用 classic `<script src="./src/version.js">`，早于 `<script type="module" src="./src/app.js">`。给 `window.SCRATCHPAD_VERSION`。
- `service-worker.js` 用 `importScripts("./src/version.js")`。给 SW 的 `CACHE_VERSION`。
- **SW fetch handler 拦截 `/src/version.js` 请求，合成响应** — 永远返当前 SW 自己的 CACHE_VERSION，不读 cache。保证 page 拿到的版本号 ≡ controller SW 版本，永不漂移。

```js
// service-worker.js
if (url.pathname.endsWith("/src/version.js")) {
  return new Response(
    `self.SCRATCHPAD_VERSION = "${CACHE_VERSION}";\n`,
    { headers: {
        "Content-Type": "application/javascript",
        "Cache-Control": "no-store",
      } }
  );
}
```

Bump 处：**只在 `src/version.js` 一处**，两边自动同步。

## 版本水印 + 手动检测：一个按钮

HUD 右下角的版本号既显示又可点击 = 视觉确认 + 主动 check 出口，一物两用：

```html
<div class="hud">
  <span id="zoomLabel">100%</span>
  <span class="sep">·</span>
  <span id="statusLabel">就绪</span>
  <span class="sep">·</span>
  <button id="versionLabel" class="version" type="button"
          title="点击检测更新">v?</button>
</div>
```

```js
versionLabel.addEventListener("click", async () => {
  setStatus("检测更新中…", true);
  const reg = _swRegistration || await navigator.serviceWorker?.getRegistration();
  if (!reg) { setStatus("Service Worker 未注册"); return; }
  await reg.update();
  setTimeout(() => {
    if (reg.waiting) setStatus("有新版本，点 toast 刷新");
    else setStatus(`已是最新（${window.SCRATCHPAD_VERSION || "v?"}）`);
  }, 1500);
});
```

**返回消息带版本号** — "已是最新（v16-2026-05-28）" 比 "已是最新" 信息量大十倍。
用户对照屏幕上的水印 = 闭环。

## Anti-pattern 复盘

- ❌ SW 注册放 `window.load` — module 加载完时 load 已 fire 完
- ❌ "刷新"推给 `controller` — 是旧 SW，skipWaiting 无意义
- ❌ 只挂路径 3 — iPad 90% 情况下浏览器不主动 check
- ❌ 没手动检测出口 — 用户想确认时没地方点
- ❌ 不显示版本号 — reload 之后没视觉确认
- ❌ 用 `navigator.serviceWorker.getRegistration()` 拿 reg — iPad PWA 偶尔返 undefined。启动时存模块级 `_swRegistration` 更稳
- ❌ 自动 reload — 用户可能正在写公式 / 画图。绝不自动刷
- ❌ 同 session 反复弹 toast — `updateAnnouncedThisLoad` (SW) + `updateDismissed` (page) 各守一边
- ❌ 在 localhost 注册 SW — 开发时 F5 拉不到最新。`LOCAL_DEV_HOSTS` 白名单排除
- ❌ 忘 bump 又改文件 — 路径 3 的 ETag 会救你，但 cache 名没换 → 下次 reload 还是旧 cache。**bump 才是真正解**
