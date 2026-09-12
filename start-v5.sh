#!/bin/sh
# A2A Server v5 launcher (csb-a2a-aip)
# 用法: ./start-v5.sh [--foreground] [--check]
cd "$(dirname "$0")"
export A2A_PORT=${A2A_PORT:-$(node -e "console.log(require('./identity.json').port||3100)")}
# 加载 LLM 配置（含 API key，不入库）
if [ -f .env.a2a ]; then
  . ./.env.a2a
fi
# 加载本地敏感配置（gateway token 等）
# 2026-09-11 修复：之前只加载 .env.a2a，.env 里的 A2A_GATEWAY_TOKEN 进不来
#   → bridge 注入缺 token（同一类 root cause：配置未进进程）
# set -a = 自动 export，确保子进程可见
if [ -f .env ]; then
  set -a
  . ./.env
  set +a
fi

# ============================================================
# CSB-Security 握手配置
# [2026-09-12 修复] 此前这里**硬编码成某个实例的凭据路径**（Jeason-aid.json /
#   Jeason-private-key.pem）+ 某人 home 的绝对路径。后果有两个，都很坏：
#     1) 其他实例拉下来 → 要么"以别人的身份握手"，要么（文件不存在时）**静默禁用握手**
#     2) 静默 = 没人发现。这是本项目第三次同类 bug（配置未进进程 + 失败不吭声）
#   现在改为：**优先级解析 + 缺文件明确告警**，不再硬编码任何人。
#     优先级：显式 env  >  identity.json 的 security.handshake 声明  >  按实例 slug 约定推导
#   注意：**绝不要**把 AID/私钥指向别的实例 —— 那等于以别人身份握手。
# ============================================================
SEC_DATA_DIR=${CSB_SECURITY_DATA_DIR:-../csb-security/data}

# 从 identity.json 读一个字段（读不到返回空串）
idhand() {
  node -e "try{const i=require('./identity.json');const h=(i.security&&i.security.handshake)||{};process.stdout.write(String(h['$1']||''))}catch(e){}"
}

SLUG=$(idhand slug)
if [ -z "$SLUG" ]; then
  SLUG=$(node -e "try{const i=require('./identity.json');process.stdout.write(String(i.slug||''))}catch(e){}")
fi

A2A_SECURITY_HANDSHAKE_AID=${A2A_SECURITY_HANDSHAKE_AID:-$(idhand aid)}
A2A_SECURITY_HANDSHAKE_KEY=${A2A_SECURITY_HANDSHAKE_KEY:-$(idhand key)}
A2A_SECURITY_HANDSHAKE_USER_PUBKEY=${A2A_SECURITY_HANDSHAKE_USER_PUBKEY:-$(idhand userPubkey)}

# 未声明 → 按实例 slug 走目录约定（<slug>-aid.json / <slug>-private-key.pem）
if [ -z "$A2A_SECURITY_HANDSHAKE_AID" ] && [ -n "$SLUG" ]; then
  A2A_SECURITY_HANDSHAKE_AID="$SEC_DATA_DIR/${SLUG}-aid.json"
fi
if [ -z "$A2A_SECURITY_HANDSHAKE_KEY" ] && [ -n "$SLUG" ]; then
  A2A_SECURITY_HANDSHAKE_KEY="$SEC_DATA_DIR/${SLUG}-private-key.pem"
fi
# 统一用户公钥：优先同目录的标准文件
if [ -z "$A2A_SECURITY_HANDSHAKE_USER_PUBKEY" ] && [ -f "$SEC_DATA_DIR/yilan-user-pub.json" ]; then
  A2A_SECURITY_HANDSHAKE_USER_PUBKEY=$(cat "$SEC_DATA_DIR/yilan-user-pub.json")
fi

export A2A_SECURITY_HANDSHAKE_AID A2A_SECURITY_HANDSHAKE_KEY A2A_SECURITY_HANDSHAKE_USER_PUBKEY

# ---- 配置自检：缺失就明说，绝不静默 ----
HS_PROBLEMS=0
if [ -z "$A2A_SECURITY_HANDSHAKE_AID" ]; then
  echo "⚠️  无法确定本实例 AID（identity.json 无 security.handshake.aid，且无 slug 可推导）→ 握手端点将禁用"
  HS_PROBLEMS=$((HS_PROBLEMS+1))
elif [ ! -f "$A2A_SECURITY_HANDSHAKE_AID" ]; then
  echo "⚠️  握手 AID 文件不存在: $A2A_SECURITY_HANDSHAKE_AID → 握手端点将禁用"
  echo "    修法: 生成该实例的 AID，或在 identity.json 写 security.handshake.aid，或用 env A2A_SECURITY_HANDSHAKE_AID 指定"
  echo "    ⛔ 不要指向其他实例的凭据（会以别人身份握手）"
  HS_PROBLEMS=$((HS_PROBLEMS+1))
fi
if [ -z "$A2A_SECURITY_HANDSHAKE_KEY" ]; then
  echo "⚠️  无法确定本实例私钥路径 → 握手端点将禁用"
  HS_PROBLEMS=$((HS_PROBLEMS+1))
elif [ ! -f "$A2A_SECURITY_HANDSHAKE_KEY" ]; then
  echo "⚠️  握手私钥文件不存在: $A2A_SECURITY_HANDSHAKE_KEY → 握手端点将禁用"
  HS_PROBLEMS=$((HS_PROBLEMS+1))
fi
if [ -z "$A2A_SECURITY_HANDSHAKE_USER_PUBKEY" ]; then
  echo "⚠️  未配置统一用户公钥 → 用户验签可能不可用"
  HS_PROBLEMS=$((HS_PROBLEMS+1))
fi
# 账本签名（9/11 签名纪元）：解析顺序必须与 a2a-trust-evidence.js 一致
#   env CSB_TRUST_LEDGER_KEY（PEM 内容）> 默认文件 keys/trust-ledger.pem
# [2026-09-12 修复] 此前只看 env → 明明有默认密钥文件也报 signed=false
#   （假告警，与"诊断指标撒谎"同族：检测口径 ≠ 实际生效口径）
LEDGER_KEY_FILE="$(pwd)/keys/trust-ledger.pem"
if [ -n "$CSB_TRUST_LEDGER_KEY" ]; then
  LEDGER_SIGN_STATE="✓已启用（来源 env CSB_TRUST_LEDGER_KEY）"
elif [ -f "$LEDGER_KEY_FILE" ]; then
  LEDGER_SIGN_STATE="✓已启用（来源 keys/trust-ledger.pem）"
else
  LEDGER_SIGN_STATE="✗未配置 → signed=false（账本仅链校验，挡不住格式完整的伪造插入）"
  echo "ℹ️  账本签名未配置（env CSB_TRUST_LEDGER_KEY 与 keys/trust-ledger.pem 均无）→ 信任账本以 signed=false 运行"
  echo "    修法: 生成 Ed25519 私钥到 keys/trust-ledger.pem，或启动前 export CSB_TRUST_LEDGER_KEY"
fi

# --check：只打印解析结果，不启动（其他实例排查用）
if [ "$1" = "--check" ]; then
  echo ""
  echo "── 握手配置解析（--check，不启动）──"
  echo "  数据目录      : $SEC_DATA_DIR"
  echo "  实例 slug     : ${SLUG:-（未设置）}"
  echo "  AID           : ${A2A_SECURITY_HANDSHAKE_AID:-（空）} $([ -f "$A2A_SECURITY_HANDSHAKE_AID" ] && echo '✓存在' || echo '✗缺失')"
  echo "  私钥          : ${A2A_SECURITY_HANDSHAKE_KEY:-（空）} $([ -f "$A2A_SECURITY_HANDSHAKE_KEY" ] && echo '✓存在' || echo '✗缺失')"
  echo "  用户公钥      : $([ -n "$A2A_SECURITY_HANDSHAKE_USER_PUBKEY" ] && echo '✓已配置' || echo '✗未配置')"
  echo "  账本签名 key  : ${LEDGER_SIGN_STATE:-（未解析）}"
  echo ""
  [ "$HS_PROBLEMS" -gt 0 ] && echo "⚠️  共 $HS_PROBLEMS 项待处理（见上方提示）" || echo "✅ 握手配置完整"
  exit 0
fi

if [ "$1" = "--foreground" ]; then
  exec node server_v5.js
fi

# 启动前自动停止旧进程（防 EADDRINUSE）
stop_old() {
  # 1) 读 server.pid（上次记录的 PID）
  if [ -f server.pid ]; then
    OLD_PID=$(cat server.pid 2>/dev/null)
    if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
      echo "🛑 停止旧进程 (PID $OLD_PID)..."
      kill "$OLD_PID" 2>/dev/null
      sleep 2
      kill -0 "$OLD_PID" 2>/dev/null && kill -9 "$OLD_PID" 2>/dev/null
    fi
    rm -f server.pid
  fi
  # 2) 按进程名清理残留（防 pid 文件丢失/漂移）
  for P in $(pgrep -f 'node server_v5.js' 2>/dev/null); do
    [ "$P" != "$$" ] && kill "$P" 2>/dev/null && echo "🛑 清理残留进程 (PID $P)..."
  done
  sleep 1
}
stop_old

mkdir -p logs
nohup node server_v5.js >> logs/server-v5.log 2>&1 &
echo $! > server.pid
echo "🚀 A2A v5 已启动 (PID $!, 端口 $A2A_PORT)"
