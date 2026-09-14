#!/bin/bash
# restart-v5-with-handshake.sh — 一气呵成启动 v5 + 验证握手端点
# 创建: 2026-09-14 07:28 (Asia/Shanghai) · 墨白指示走 A 方案
# 流程:
#   1) 跑 setup-handshake-axuan.sh 生成密钥对（如果没生成）
#   2) 修 start-v5.sh 把 Jeason 改成 axuan（如果还没改）
#   3) 启动 v5（前台 5 秒看输出，然后 nohup 后台）
#   4) 验证 /health 和 /a2a/handshake/status
# 用法: bash /home/node/.openclaw/workspace/csb-a2a-aip/scripts/restart-v5-with-handshake.sh
set -e

WS=/home/node/.openclaw/workspace
AIP="$WS/csb-a2a-aip"
AID_PATH="$WS/csb-security/data/axuan-aid.json"
KEY_PATH="$WS/csb-security/data/axuan-private-key.pem"

# 1) 跑 setup-handshake 生成密钥对（如果没生成）
echo "[1/5] 跑 setup-handshake-axuan.sh"
if [ ! -f "$AID_PATH" ] || [ ! -f "$KEY_PATH" ]; then
    bash "$AIP/scripts/setup-handshake-axuan.sh"
else
    echo "    ✓ axuan-aid.json 和 axuan-private-key.pem 已存在，跳过生成"
    ls -la "$AID_PATH" "$KEY_PATH"
fi

# 2) 修 start-v5.sh 把 Jeason 改成 axuan
echo ""
echo "[2/5] 修 start-v5.sh"
START_V5="$WS/start-v5.sh"
if grep -q "Jeason-aid.json" "$START_V5"; then
    cp "$START_V5" "$START_V5.bak.$(date +%Y%m%d-%H%M%S)"
    echo "    备份 → $START_V5.bak.<ts>"
    sed -i 's|csb-security/data/Jeason-aid.json|csb-security/data/axuan-aid.json|g' "$START_V5"
    sed -i 's|csb-security/data/Jeason-private-key.pem|csb-security/data/axuan-private-key.pem|g' "$START_V5"
    echo "    ✓ Jeason → axuan 已替换"
else
    echo "    ✓ start-v5.sh 已经用 axuan，跳过"
fi
grep "A2A_SECURITY_HANDSHAKE_AID\|A2A_SECURITY_HANDSHAKE_KEY" "$START_V5" | grep -v "^#"

# 3) 启动 v5（用 start-v5.sh 自带的 stop_old 防 EADDRINUSE）
echo ""
echo "[3/5] 启动 v5"
cd "$WS"
# 先清理所有 v5 残留（防 EADDRINUSE）
pkill -f "node server_v5.js" 2>/dev/null && echo "    清理残留进程" || echo "    无残留进程"
sleep 2
# 启动（后台）
./start-v5.sh
sleep 4

# 4) 验证
echo ""
echo "[4/5] 验证"
echo "  --- 进程 ---"
ps -ef | grep "node server_v5.js" | grep -v grep | head -2
echo ""
echo "  --- /health ---"
curl -sS -m 5 http://127.0.0.1:3100/health 2>&1 | head -10
echo ""
echo "  --- /a2a/handshake/status ---"
curl -sS -m 5 http://127.0.0.1:3100/a2a/handshake/status 2>&1 | head -10

# 5) 提示
echo ""
echo "[5/5] 下一步"
echo "    - 把 $AID_PATH 发给若兰（公开信息可发）"
echo "    - 我侧等墨白确认后跑 watchdog 回滚（jobs.json）"
