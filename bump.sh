#!/usr/bin/env bash
# 唯一版本号在 src/version.js（classic script，给 window.SCRATCHPAD_VERSION + SW 水印）。
# bump 一处生效。用法: ./bump.sh v27-2026-07-04
set -e
NEW="${1:?usage: ./bump.sh vN-YYYY-MM-DD}"
cd "$(dirname "$0")"
sed -i "s/SCRATCHPAD_VERSION = \"[^\"]*\"/SCRATCHPAD_VERSION = \"$NEW\"/" src/version.js
echo "bumped to $NEW:"
grep -H "SCRATCHPAD_VERSION" src/version.js
