#!/bin/bash
# sync-pack.sh — 把仓库里的接入包同步到 nginx 服务目录
# 为什么需要它：nginx worker 无法穿透 /root（0700），故服务目录必须在 /var/www（世界可读）。
# 单一来源 = 本目录（csb-identity/tools/）；/var/www/csb-identity-pack 是**部署产物**。
set -euo pipefail
SRC="$(cd "$(dirname "$0")" && pwd)"
DST="${1:-/var/www/csb-identity-pack}"
mkdir -p "$DST"
cp "$SRC/csb-onboard.js" "$SRC/aat-issue.js" "$SRC/README.txt" "$DST/"
echo "✅ 已同步 → $DST"
ls -l "$DST"
