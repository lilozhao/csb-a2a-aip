#!/bin/bash
# 美硅 A2A v5 启动脚本
# 包含安全环境变量和 .env 加载

A2A_DIR="$(cd "$(dirname "$0")" && pwd)"
A2A_LOG_FILE="${A2A_DIR}/logs/server-v5-meigui.log"
A2A_DATA_DIR="${A2A_DIR}/data"
PID_FILE="${A2A_DIR}/server.pid"

# 安全配置路径
CSB_SECURITY_DIR="/home/admin/.openclaw/workspace/csb-security"
AID_PATH="${CSB_SECURITY_DIR}/data/meigui-aid.json"
KEY_PATH="${CSB_SECURITY_DIR}/data/meigui-private-key.pem"
USER_PUBKEY='{"crv":"Ed25519","x":"rpNYnf224QbmIuK1Ivrj7u7BMa5KnUFFCAe54Tm-_4U","kty":"OKP","kid":"user-yilan"}'

# 加载 .env（美硅的 API Key）
if [ -f "${A2A_DIR}/.env" ]; then
    export $(grep -v '^#' "${A2A_DIR}/.env" | xargs)
    echo "✅ .env 已加载"
fi

# 设置安全环境变量
export A2A_SECURITY_HANDSHAKE_AID="${AID_PATH}"
export A2A_SECURITY_HANDSHAKE_KEY="${KEY_PATH}"
export A2A_SECURITY_HANDSHAKE_USER_PUBKEY="${USER_PUBKEY}"
export A2A_REGISTRY_URL="http://csbc.lilozkzy.top:3099"
export A2A_DATA_DIR="${A2A_DATA_DIR}"
export A2A_LOG_FILE="${A2A_LOG_FILE}"
# [美硅 2026-10-24] 固定走 direct 适配器：openclaw 适配器需 A2A_GATEWAY_TOKEN（本机未设），
# hermes 适配器会把请求打回自己 3100 端口拿到 HTML，两者都会拖慢并可能落到降级文案。
export A2A_ADAPTER="direct"
export A2A_LLM_DEBUG="1"

# 确保目录存在
mkdir -p "${A2A_DIR}/logs" "${A2A_DATA_DIR}" "${A2A_DATA_DIR}/memory"

# 检查 identity.json
if [ ! -f "${A2A_DIR}/identity.json" ]; then
    echo "❌ 错误：找不到 identity.json"
    exit 1
fi

# 端口冲突检测
PORT=$(node -e "console.log(require('${A2A_DIR}/identity.json').port || 3100)")
echo "🔍 检查端口 ${PORT}..."

EXISTING_PID=$(lsof -ti:${PORT} 2>/dev/null || echo "")
if [ -n "${EXISTING_PID}" ]; then
    if [ -f "${PID_FILE}" ]; then
        OLD_PID=$(cat "${PID_FILE}")
        if [ "${EXISTING_PID}" = "${OLD_PID}" ] && kill -0 "${OLD_PID}" 2>/dev/null; then
            echo "✅ 端口 ${PORT} 已被自己占用 (PID: ${OLD_PID})"
            exit 0
        fi
    fi
    echo "⚠️ 端口 ${PORT} 被其他进程占用 (PID: ${EXISTING_PID})，正在 kill..."
    fuser -k ${PORT}/tcp 2>/dev/null
    sleep 2
fi

# 停止旧进程
if [ -f "${PID_FILE}" ]; then
    OLD_PID=$(cat "${PID_FILE}")
    kill -0 "$OLD_PID" 2>/dev/null && kill "$OLD_PID" && sleep 2
    rm -f "${PID_FILE}"
fi

# 启动 v5 Server
echo "🚀 启动美硅 A2A v5 Server (端口: $PORT)..."
cd "${A2A_DIR}"
# [美硅 2026-10-29] 改用 setsid：原来的 `nohup ... &` 只挡 SIGHUP，**不脱离启动它的 session scope**。
# 后果（实测）：2026-10-29 07:15 我从 OpenClaw 的 exec 会话里跑本脚本重启 A2A，
# 进程被放进 gateway 的 session scope；07:46 gateway 被 OOM 杀掉时，
# **整个 session scope 一起被拆，我刚重启的 A2A 跟着陪葬**（08:00 由 guardian 才发现并拉起）。
# setsid 让 A2A 独立成 session，不再与 gateway 的生死绑定。
setsid node server_v5.js >> "${A2A_LOG_FILE}" 2>&1 < /dev/null &
NEW_PID=$!
echo "$NEW_PID" > "${PID_FILE}"

sleep 3

# 健康检查（v5.2.1 启动要初始化 DHT/AIP，3s 不够 → 轮询最多 40s）
HEALTH_OK=0
for i in $(seq 1 20); do
    sleep 2
    if curl -s "http://localhost:${PORT}/health" --connect-timeout 5 | grep -q '"status":"ok"'; then
        HEALTH_OK=1
        break
    fi
done
if [ "$HEALTH_OK" = "1" ]; then
    VERSION=$(curl -s "http://localhost:${PORT}/health" | node -e "const d=JSON.parse(require('fs').readFileSync('/dev/stdin','utf8'));console.log(d.version)")
    echo "✅ 美硅 A2A v${VERSION} 已启动 (PID: $NEW_PID, 端口: ${PORT})"
    echo "   日志: ${A2A_LOG_FILE}"
else
    echo "❌ 启动失败，请检查: tail -30 ${A2A_LOG_FILE}"
    exit 1
fi
