#!/bin/sh
# A2A Server v5 launcher (csb-a2a-aip)
# 用法: ./start-v5.sh [--foreground]
cd "$(dirname "$0")"
export A2A_PORT=${A2A_PORT:-$(node -e "console.log(require('./identity.json').port||3100)")}
# 加载 LLM 配置（含 API key，不入库）
if [ -f .env.a2a ]; then
  . ./.env.a2a
fi
if [ "$1" = "--foreground" ]; then
  exec node server_v5.js
fi
mkdir -p logs
nohup node server_v5.js > logs/server-v5.log 2>&1 &
echo $! > server.pid
echo "🚀 A2A v5 已启动 (PID $!, 端口 $A2A_PORT)"
