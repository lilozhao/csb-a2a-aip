#!/bin/bash
# ============================================
# A2A Registry (3099) v5 管理脚本
# ============================================
# 2026-08-26 创建（明德 🎋）
# 取代老的 /etc/systemd/system/a2a-registry.service（已废弃，仍 enabled 但 inactive）
#
# 用法:
#   ./manage-3099.sh start       # 启动 v5 Registry（先杀旧进程）
#   ./manage-3099.sh stop        # 停止当前 Registry
#   ./manage-3099.sh restart     # 重启
#   ./manage-3099.sh status      # 看状态
#   ./manage-3099.sh logs [N]    # 看最近 N 行日志（默认 50）
#   ./manage-3099.sh health      # 健康检查（端口 + /agents 端点）
#   ./manage-3099.sh guard       # 守护模式（每 30s 检查，挂前台）
# ============================================

set -u

# ==== 路径常量（绝对路径，不依赖 cwd）====
A2A_DIR="/root/.openclaw/workspace/csb-a2a-aip"
LOG_DIR="${A2A_DIR}/logs"
PID_FILE="${LOG_DIR}/registry.pid"
LOG_FILE="${LOG_DIR}/registry-v5.log"
DATA_DIR="${A2A_DATA_DIR:-${A2A_DIR}/data}"
REGISTRY_PORT="${REGISTRY_PORT:-3099}"

# ==== v5 启动方式（fork 子进程模式，start-registry.js 自动 fork registry.js）====
START_CMD="node start-registry.js"

# ==== 颜色（终端可读）====
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ok()   { echo -e "${GREEN}✅ $*${NC}"; }
err()   { echo -e "${RED}❌ $*${NC}"; }
warn()  { echo -e "${YELLOW}⚠️  $*${NC}"; }

mkdir -p "${LOG_DIR}"

# ==== 工具函数 ====

# 通过 PID 文件读老 PID
read_pid() {
    [ -f "${PID_FILE}" ] && cat "${PID_FILE}" 2>/dev/null | tr -d ' \n' || echo ""
}

# 通过 inode 反查本机 3099 上的真实 PID（绕过 PID 文件过期）
pid_by_port() {
    local port=$1 hex inode pid
    hex=$(printf '%04X' "${port}")
    inode=$(awk -v h="$hex" 'NR>1 && $2 ~ h"$" && $4=="0A" {print $10; exit}' /proc/net/tcp /proc/net/tcp6 2>/dev/null | head -1)
    [ -z "$inode" ] && return 1
    for pid in $(ls /proc 2>/dev/null | grep -E '^[0-9]+$'); do
        if ls -l /proc/$pid/fd/ 2>/dev/null | grep -q "socket:\[${inode}\]"; then
            echo "$pid"
            return 0
        fi
    done
    return 1
}

# 健康检查（端口 + /agents 端点）
is_healthy() {
    local code
    code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:${REGISTRY_PORT}/agents" 2>/dev/null)
    [ "$code" = "200" ]
}

# ==== 命令实现 ====

cmd_start() {
    # 1) 已运行？
    local live_pid
    live_pid=$(pid_by_port "${REGISTRY_PORT}" 2>/dev/null || echo "")
    if [ -n "${live_pid}" ] && kill -0 "${live_pid}" 2>/dev/null; then
        ok "Registry 已运行（PID=${live_pid}, 端口=${REGISTRY_PORT}）"
        return 0
    fi

    # 2) PID 文件还在但进程没了
    local stale_pid
    stale_pid=$(read_pid)
    if [ -n "${stale_pid}" ] && ! kill -0 "${stale_pid}" 2>/dev/null; then
        warn "PID 文件残留（PID=${stale_pid} 已死），清理"
        rm -f "${PID_FILE}"
    fi

    # 3) 杀任何残留的 registry.js 进程（防御性，不影响业务）
    pkill -f "csb-a2a-aip/registry\.js" 2>/dev/null
    pkill -f "csb-a2a-aip/start-registry\.js" 2>/dev/null
    sleep 1

    # 4) 启新进程
    echo "🚀 启动 A2A Registry v5（端口=${REGISTRY_PORT}）..."
    cd "${A2A_DIR}"
    nohup ${START_CMD} > "${LOG_FILE}" 2>&1 &
    local new_pid=$!
    echo "${new_pid}" > "${PID_FILE}"
    sleep 3

    # 5) 验证：进程存活 + /agents 通
    if ! kill -0 "${new_pid}" 2>/dev/null; then
        err "启动失败（PID=${new_pid} 已死），日志："
        tail -20 "${LOG_FILE}"
        rm -f "${PID_FILE}"
        return 1
    fi

    if is_healthy; then
        # 验证 fork 子进程（registry.js 真绑端口的进程）
        local child_pid
        child_pid=$(pid_by_port "${REGISTRY_PORT}" 2>/dev/null || echo "")
        ok "Registry 已启动（parent=${new_pid}, child=${child_pid}, 端口=${REGISTRY_PORT}）"
        ok "数据目录: ${DATA_DIR}"
        ok "日志: ${LOG_FILE}"
        return 0
    else
        err "进程在但 /agents 端点 200 不通"
        tail -20 "${LOG_FILE}"
        return 1
    fi
}

cmd_stop() {
    # 1) 找所有相关进程（parent start-registry.js + child registry.js）
    local parent_pid child_pid
    parent_pid=$(read_pid)
    child_pid=$(pid_by_port "${REGISTRY_PORT}" 2>/dev/null || echo "")

    local killed=0
    for pid in "${parent_pid}" "${child_pid}"; do
        if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
            kill -TERM "${pid}" 2>/dev/null
            killed=1
        fi
    done

    # 防御性：杀任何残留的 csb-a2a-aip/registry.js
    pkill -f "csb-a2a-aip/registry\.js" 2>/dev/null
    pkill -f "csb-a2a-aip/start-registry\.js" 2>/dev/null

    if [ "${killed}" = "1" ]; then
        sleep 2
        # 强杀兜底
        for pid in "${parent_pid}" "${child_pid}"; do
            if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then
                kill -9 "${pid}" 2>/dev/null
            fi
        done
        ok "Registry 已停止"
    else
        ok "Registry 本来就没在跑"
    fi

    rm -f "${PID_FILE}"
}

cmd_restart() {
    cmd_stop
    sleep 1
    cmd_start
}

cmd_status() {
    local live_pid child_pid
    child_pid=$(pid_by_port "${REGISTRY_PORT}" 2>/dev/null || echo "")
    local pid_file_pid
    pid_file_pid=$(read_pid)

    echo "=== Registry 3099 状态 ==="
    echo "  端口绑定 PID: ${child_pid:-(无)}"
    echo "  PID 文件内容: ${pid_file_pid:-(无)}"
    echo "  数据目录: ${DATA_DIR}"

    if [ -n "${child_pid}" ] && kill -0 "${child_pid}" 2>/dev/null; then
        ok "进程运行中"
        # 进程命令
        local cmdline
        cmdline=$(cat /proc/${child_pid}/cmdline 2>/dev/null | tr '\0' ' ')
        echo "  命令: ${cmdline}"
        # 健康
        if is_healthy; then
            local agents_count
            agents_count=$(curl -sS --max-time 3 "http://localhost:${REGISTRY_PORT}/agents" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('agents', [])))" 2>/dev/null || echo "?")
            ok "健康（/agents 通，agent 数=${agents_count}）"
        else
            err "/agents 端点不可达"
        fi
    else
        err "进程不在"
    fi
    echo
    echo "=== 系统提醒 ==="
    echo "  ⚠️  老 a2a-registry.service（systemd）已废弃，请勿手动 enable"
    echo "  📁  本机注册数据已废弃（改用 csbc.lilozkzy.top:3099 公网视图）"
}

cmd_logs() {
    local n=${1:-50}
    if [ -f "${LOG_FILE}" ]; then
        tail -n "${n}" "${LOG_FILE}"
    else
        err "日志文件不存在: ${LOG_FILE}"
    fi
}

cmd_health() {
    local code agents_count
    code=$(curl -sS -o /dev/null -w "%{http_code}" --max-time 3 "http://localhost:${REGISTRY_PORT}/agents" 2>/dev/null)
    agents_count=$(curl -sS --max-time 3 "http://localhost:${REGISTRY_PORT}/agents" 2>/dev/null | python3 -c "import sys,json; print(len(json.load(sys.stdin).get('agents', [])))" 2>/dev/null || echo "?")
    echo "  /agents HTTP code: ${code:-000}"
    echo "  agent 数: ${agents_count}"
    if [ "${code:-000}" = "200" ]; then
        ok "健康"
        return 0
    else
        err "不健康"
        return 1
    fi
}

cmd_guard() {
    ok "进入守护模式（每 30s 检查一次），Ctrl+C 终止"
    while true; do
        if ! is_healthy; then
            warn "$(date '+%Y-%m-%d %H:%M:%S') Registry 3099 不健康，自动重启"
            cmd_restart
        fi
        sleep 30
    done
}

# ==== 入口 ====
case "${1:-}" in
    start)    cmd_start ;;
    stop)     cmd_stop ;;
    restart)  cmd_restart ;;
    status)   cmd_status ;;
    logs)     cmd_logs "${2:-}" ;;
    health)   cmd_health ;;
    guard)    cmd_guard ;;
    *)
        echo "用法: $0 {start|stop|restart|status|logs [N]|health|guard}"
        exit 1
        ;;
esac