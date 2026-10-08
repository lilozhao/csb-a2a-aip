#!/bin/bash
# backup-identity.sh — 身份层数据备份（含 service-key / admin-token）
# 明德 🎋 2026-10-08（若琢 batch2 ③：service-key 丢失 = 审计链作废，全系统最不可再生的一份文件）
#
# 用法: ./backup-identity.sh [备份目录]    默认 /root/.openclaw/workspace/memory/identity-backups
set -euo pipefail
DATA_DIR="${A2A_IDENTITY_DATA:-/root/.openclaw/workspace/csb-a2a-aip/csb-identity/data}"
DEST="${1:-/root/.openclaw/workspace/memory/identity-backups}"
TS="$(date +%Y%m%d_%H%M%S)"
mkdir -p "$DEST"
[ -d "$DATA_DIR" ] || { echo "❌ 数据目录不存在: $DATA_DIR"; exit 1; }

OUT="$DEST/identity-data-$TS.tar.gz"
tar -czf "$OUT" -C "$(dirname "$DATA_DIR")" "$(basename "$DATA_DIR")" 2>/dev/null
chmod 600 "$OUT"

echo "✅ 备份完成: $OUT ($(du -h "$OUT" | cut -f1))"
echo "⚠️  内含 service-key.json / admin-token —— 属机密，勿外发、勿入库"
KEYF="$DATA_DIR/service-key.json"
if [ -f "$KEYF" ]; then
  FP=$(node -e "const k=require('$KEYF');console.log(k.publicJwk.x.slice(0,16)+'…')" 2>/dev/null || echo '?')
  echo "🔑 服务身份: $(node -e "const k=require('$KEYF');console.log(k.agentId)" 2>/dev/null)  指纹: $FP"
  echo "   校验法：GET /service/aid 的 public_key.x 前 16 位应等于上面这个指纹"
fi
echo "📌 恢复：systemctl stop mingde-registry → 解包覆盖 data 目录 → systemctl start mingde-registry → 看 GET /health 的 identity.mounted 与 /audit/verify"
