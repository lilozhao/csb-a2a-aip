#!/bin/bash
# ============================================================
# setup-handshake.sh —— 生成实例的 AID + Ed25519 私钥（自签）
# 输出路径与 start-v5.sh 的 slug 约定**一致**：
#   <repo>/csb-security/data/<slug>-aid.json
#   <repo>/csb-security/data/<slug>-private-key.pem
#
# 用法:
#   bash scripts/setup-handshake.sh <slug> <host> [port] [name]
#   bash scripts/setup-handshake.sh axuan 172.28.0.5 3100 阿轩
#
# 说明:
#   - AID 是**自签**：私钥本机生成，任何情况都不要外传
#   - 生成后请把新的 <slug>-aid.json（公开部分）发给对端替换，否则握手验不过
#   - 目录可用 CSB_SECURITY_DATA_DIR 覆盖（默认 <repo>/csb-security/data）
#
# 维护: 若兰 🌸 | 2026-09-14（修 08-25 版输出到 config/security 的路径不一致问题）
# ============================================================
set -euo pipefail

SLUG="${1:-}"; HOST="${2:-}"; PORT="${3:-3100}"; NAME="${4:-$SLUG}"
if [ -z "$SLUG" ] || [ -z "$HOST" ]; then
  echo "用法: bash scripts/setup-handshake.sh <slug> <host> [port] [name]"; exit 1
fi

# 定位仓库根：优先 git 顶层，退化为脚本上一级
SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(git -C "$SELF_DIR" rev-parse --show-toplevel 2>/dev/null || dirname "$SELF_DIR")"
OUT_DIR="${CSB_SECURITY_DATA_DIR:-$ROOT/csb-security/data}"
mkdir -p "$OUT_DIR"

echo "【1/2】自签生成 ${SLUG} 的 AID + Ed25519 私钥 → $OUT_DIR"
SLUG="$SLUG" HOST="$HOST" PORT="$PORT" NAME="$NAME" OUT_DIR="$OUT_DIR" node - <<'NODE'
const crypto = require('crypto'), fs = require('fs'), path = require('path');
const { SLUG, HOST, PORT, NAME, OUT_DIR } = process.env;
const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
const pub = publicKey.export({ format: 'jwk' });
const keyPath = path.join(OUT_DIR, `${SLUG}-private-key.pem`);
const aidPath = path.join(OUT_DIR, `${SLUG}-aid.json`);
fs.writeFileSync(keyPath, privateKey.export({ format: 'pem', type: 'pkcs8' }), { mode: 0o600 });
fs.chmodSync(keyPath, 0o600);
const aid = {
  csb_version: '1.0',
  agent_id: `${SLUG}@${HOST}:${PORT}`,
  name: NAME || SLUG,
  emoji: '',
  description: '',
  public_key: { crv: 'Ed25519', x: pub.x, kty: 'OKP', kid: `${SLUG}-${Date.now()}` },
  endpoint: `http://${HOST}:${PORT}/a2a/json-rpc`,
  created_at: new Date().toISOString(),
  expires_at: new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString(),
  capabilities: ['a2a.send', 'a2a.delegate', 'a2a.status', 'system.status', 'agent.health'],
};
fs.writeFileSync(aidPath, JSON.stringify(aid, null, 2));
console.log('  ✅ AID :', aidPath);
console.log('  ✅ KEY :', keyPath, '(勿外传)');
console.log('     kid :', aid.public_key.kid);
NODE

echo "【2/2】配置（二选一）:"
echo "  A) 显式 env："
echo "     export A2A_SECURITY_HANDSHAKE_AID=\"$OUT_DIR/${SLUG}-aid.json\""
echo "     export A2A_SECURITY_HANDSHAKE_KEY=\"$OUT_DIR/${SLUG}-private-key.pem\""
echo "  B) 声明式：identity.json 里加  {\"security\":{\"handshake\":{\"slug\":\"$SLUG\"}}}（start-v5.sh 自动推导）"
echo ""
echo "验收: curl -s 127.0.0.1:$PORT/a2a/handshake/status   # 期望 enabled:true"
echo "提醒: 把新的 ${SLUG}-aid.json（公开部分）发给对端替换，否则握手验不过"
