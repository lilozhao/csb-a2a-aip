#!/bin/sh
# A2A Server v5 launcher (csb-a2a-aip)
# 用法: ./start-v5.sh [--foreground]
cd "$(dirname "$0")"
export A2A_PORT=${A2A_PORT:-$(node -e "console.log(require('./identity.json').port||3100)")}
# 加载 LLM 配置（含 API key，不入库）
if [ -f .env.a2a ]; then
  . ./.env.a2a
fi
# CSB-Security 握手配置（AID/私钥/统一用户公钥）
export A2A_SECURITY_HANDSHAKE_AID=/home/node/.openclaw/workspace/csb-security/data/Jeason-aid.json
export A2A_SECURITY_HANDSHAKE_KEY=/home/node/.openclaw/workspace/csb-security/data/Jeason-private-key.pem
export A2A_SECURITY_HANDSHAKE_USER_PUBKEY='{"crv":"Ed25519","x":"rpNYnf224QbmIuK1Ivrj7u7BMa5KnUFFCAe54Tm-_4U","kty":"OKP","kid":"user-yilan"}'
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
nohup node server_v5.js > logs/server-v5.log 2>&1 &
echo $! > server.pid
echo "🚀 A2A v5 已启动 (PID $!, 端口 $A2A_PORT)"
