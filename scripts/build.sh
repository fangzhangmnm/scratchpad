#!/usr/bin/env bash
# scripts/build.sh —— src/ → dist/scratchpad-<hash>.mjs；in-place 改 index.html 引新 hash。
# （注：bundle 名是 scratchpad-；service-worker.js install regex 必须跟这个名一致。）
#
# 用法：编辑 src/ → 跑这个 → git commit && git push origin main
#   (push 后 GH Actions 把 main 分支的 dist + 源原样部署到 /dev/ 路径；prod 分支 → /)
#
# 抄自 sibling canonical（WebPaint/RealHome 的 scripts/build.sh）。ScratchPad 特化：
#   - ENTRY=./src/app.js（还没迁 TS；将来某个 .js → .ts 时 esbuild 自动 strip 类型，
#     把下面 tsc --noEmit 门配好（tsconfig + node_modules/.bin/tsc）就有真类型护栏）。
#   - 无 externals：vendor 库（jspdf / html2canvas / katex）都是运行时注入 <script>（读
#     window.* 全局），不是 ESM import，esbuild 根本不碰它们 → 不用 --external。src/vendor/
#     由 deploy.yml 原样部署，运行时按 ./src/vendor/... 路径注入照常。

set -euo pipefail
cd "$(dirname "$0")/.."

ENTRY="./src/app.js"
OUT_DIR="./dist"
ESBUILD_VER="0.24.0"
ESBUILD="./tools/esbuild/esbuild"

# 没 esbuild 自动 curl 一份（tools/esbuild/ gitignored；跨 OS 不通用故不入 git）。
# 注：tools/ = 构建工具；src/vendor/ = 运行时 lib（入 git）。两个目录不混。
if [ ! -x "$ESBUILD" ]; then
  case "$(uname -s)-$(uname -m)" in
    Linux-x86_64)   plat="linux-x64" ;;
    Linux-aarch64)  plat="linux-arm64" ;;
    Darwin-arm64)   plat="darwin-arm64" ;;
    Darwin-x86_64)  plat="darwin-x64" ;;
    *) echo "[build] 未知平台 $(uname -s)-$(uname -m)，手 vendor esbuild 进 $ESBUILD" >&2; exit 1 ;;
  esac
  echo "[build] 拉 esbuild $plat-$ESBUILD_VER..."
  mkdir -p tools/esbuild
  TMP=$(mktemp -d)
  curl -sL "https://registry.npmjs.org/@esbuild/${plat}/-/${plat}-${ESBUILD_VER}.tgz" | tar -xz -C "$TMP"
  mv "$TMP/package/bin/esbuild" "$ESBUILD"
  chmod +x "$ESBUILD"
  rm -rf "$TMP"
fi

mkdir -p "$OUT_DIR"
TMP_OUT="$OUT_DIR/scratchpad-tmp.mjs"

# 0. 类型检查门（TS-ready）：装了 tsc 就强制过；裸 clone（无 node_modules）静默跳过。
#    今天还没 TS，这块是占位——迁 TS 后加 tsconfig.json + npm i typescript 即生效。
TSC="./node_modules/.bin/tsc"
if [ -x "$TSC" ]; then
  echo "[build] 类型检查 tsc --noEmit…"
  "$TSC" --noEmit -p tsconfig.json || { echo "[build] ✗ 类型检查失败，已挡下构建。" >&2; exit 1; }
  echo "[build] ✓ 类型通过"
fi

# 1. esbuild bundle 到临时名
"$ESBUILD" "$ENTRY" \
  --bundle --format=esm --target=es2020 \
  --minify --sourcemap=linked \
  --tree-shaking=true \
  --outfile="$TMP_OUT"

# 2. content hash 截 12 位作文件名
HASH=$(sha256sum "$TMP_OUT" | awk '{print substr($1, 1, 12)}')
OUT="$OUT_DIR/scratchpad-$HASH.mjs"

# 3. mv 到最终名（先 mv 后清，否则 find 误删 scratchpad-tmp）
mv "$TMP_OUT"     "$OUT"
mv "$TMP_OUT.map" "$OUT.map"

# 老 hashed bundle 清掉，不堆积
find "$OUT_DIR" -maxdepth 1 -name 'scratchpad-*.mjs'     -not -name "scratchpad-$HASH.mjs"     -delete
find "$OUT_DIR" -maxdepth 1 -name 'scratchpad-*.mjs.map' -not -name "scratchpad-$HASH.mjs.map" -delete

# 4. sed 改 index.html 里引用，指向新 hash
if grep -q 'src="./dist/scratchpad-' index.html; then
  sed -i "s|src=\"./dist/scratchpad-[A-Za-z0-9-]*\\.mjs\"|src=\"./dist/scratchpad-$HASH.mjs\"|" index.html
else
  echo "[build] 警告：index.html 里没找到 ./dist/scratchpad-*.mjs script tag" >&2
fi

size=$(stat -c%s "$OUT" 2>/dev/null || wc -c < "$OUT")
echo "[build] $OUT ($size bytes, hash=$HASH)"
echo "[build] 完成。提交：git add . && git commit && git push origin main"
