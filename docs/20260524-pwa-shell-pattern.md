# PWA shell pattern (zero-build)

How the "lobster project" series is structured. Vanilla HTML/JS/CSS,
no build step, GitHub Pages hosted, IndexedDB for state, Service
Worker for offline.

## Layout

```
index.html                  # the only HTML, full-screen surface
manifest.webmanifest        # PWA install metadata
service-worker.js           # cache strategy
icon.svg                    # base icon
icon-192.png / icon-512.png # manifest icons (PNG)
apple-touch-icon-180.png    # iOS home screen icon (MUST be PNG)
src/
  app.js                    # orchestrator: boot, UI bindings, SW register
  <module>.js               # one module per concern (board, input, db, …)
  styles.css                # one CSS file
  vendor/                   # local copies of any 3rd-party libs
.gitignore                  # journals/, *.log, node_modules, .DS_Store
README.md                   # PWA link + status + arch + GH Pages setup
```

## Principles

1. **Zero build chain.** No bundler, no transpile. ES modules served
   directly. The only "release" action is `git push` + bump
   `CACHE_VERSION` in `service-worker.js`.

2. **Zero runtime cross-origin.** Every dependency is vendored under
   `src/vendor/`. The page should work disconnected from day one.
   The Service Worker only knows how to cache same-origin requests.

3. **One module per concern.** Keep `src/` flat. Typical breakdown
   for a drawing app:
   - `app.js` — boot sequence, UI wiring, SW register, theme
   - `board.js` — render + state model
   - `input.js` — event handling
   - `db.js` — IndexedDB wrapper
   - `export.js` — file output
   Don't sub-folder unless you actually have 15+ modules.

4. **No router.** Single-page surface. Sheets / overlays open as
   absolute-positioned divs toggled with `hidden` class. URL never
   changes after load.

5. **Persist what's useful, ignore the rest.** Drawing state in
   IndexedDB. Preferences (theme, toggles) in localStorage with
   try/catch (private mode throws). Viewport in IndexedDB meta store,
   debounced 300ms write.

## Local dev

```bash
python3 -m http.server 8000
# http://localhost:8000/
```

Crucial: **`localhost` / `127.0.0.1` must skip SW registration** so
`F5` always pulls fresh code. Add this guard in `app.js`:

```js
if ("serviceWorker" in navigator) {
  const host = location.hostname;
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "") {
    navigator.serviceWorker.register("./service-worker.js");
  }
}
```

To test PWA / offline / Add-to-Home behavior, hit LAN IP
(`http://192.168.x.x:8000/`) or the deployed URL.

## GitHub Pages deploy

1. New public repo (GH Pages free tier requires public).
2. Push `main`.
3. Settings → Pages → Source: **Deploy from a branch**,
   Branch: `main` / `/ (root)`.
4. Wait 1-2 min, link is live.

## README convention

Every README starts with:

```markdown
# project-name

> one-line positioning sentence

- **🔗 PWA**: https://fangzhangmnm.github.io/<name>/
- **📦 Source**: https://github.com/fangzhangmnm/<name>

## MVP 状态
- ✅ done items …
- ⏸ deferred items …

## 本地跑 / 部署 / 架构 …
```

## .gitignore essentials

```
journals/        # drafting notes, never go to remote
.DS_Store
*.log
node_modules/
```

## Commit style

Lowercase summary line, multi-paragraph body explaining the *why* not
just the *what*. Trailer:

```
Co-Authored-By: Claude Opus 4.7 <noreply@anthropic.com>
```

Per project convention (sibling repos all have this trailer).

## What this pattern is NOT good for

- Heavy JS framework needs (React / Vue) — would need a build chain.
- Server-side anything — pure static.
- Multi-page apps — single surface only.
- Auth / sync — base-class can do OneDrive via MSAL but each project
  decides; ScratchPad explicitly didn't ("write-then-burn").
