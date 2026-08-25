#!/usr/bin/env bash
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
pid_file="${repo_root}/logs/discovery-server-secondary.pid"
log_file="${repo_root}/logs/discovery-server-secondary.log"

load_env() {
    if [[ -f "${repo_root}/.env" ]]; then
        set -a
        # shellcheck disable=SC1091
        source "${repo_root}/.env"
        set +a
    fi
}

secondary_port() {
    printf '%s\n' "${DISCOVERY_SECONDARY_PORT:-9006}"
}

secondary_database_url() {
    if [[ -n "${DISCOVERY_SECONDARY_DATABASE_URL:-}" ]]; then
        printf '%s\n' "${DISCOVERY_SECONDARY_DATABASE_URL}"
        return
    fi

    if [[ -n "${TEST_DATABASE_URL:-}" ]]; then
        printf '%s\n' "${TEST_DATABASE_URL}"
        return
    fi

    echo "[ERROR] 未配置 DISCOVERY_SECONDARY_DATABASE_URL，且 .env/环境变量中缺少 TEST_DATABASE_URL。" >&2
    exit 1
}

secondary_webhook_url() {
    printf '%s\n' "${DISCOVERY_SECONDARY_WEBHOOK_RECEIVE_URL:-http://localhost:$(secondary_port)/admin/dsp/webhooks/receive}"
}

secondary_dsp_base_url() {
    if [[ -n "${DISCOVERY_SECONDARY_DSP_BASE_URL:-}" ]]; then
        printf '%s\n' "${DISCOVERY_SECONDARY_DSP_BASE_URL}"
        return
    fi

    if [[ -n "${DSP_BASE_URL:-}" ]]; then
        printf '%s\n' "${DSP_BASE_URL}"
        return
    fi

    printf '%s\n' "http://localhost:9001/acps-dsp-v2"
}

read_live_pid() {
    local candidate="$1"

    if [[ ! -f "${candidate}" ]]; then
        return 1
    fi

    local pid
    pid="$(tr -d '[:space:]' <"${candidate}")"
    if [[ -z "${pid}" ]]; then
        rm -f "${candidate}"
        return 1
    fi

    if kill -0 "${pid}" 2>/dev/null; then
        printf '%s\n' "${pid}"
        return 0
    fi

    rm -f "${candidate}"
    return 1
}

stop_pid() {
    local target_pid="$1"

    kill "${target_pid}" 2>/dev/null || true
    sleep 2
    if kill -0 "${target_pid}" 2>/dev/null; then
        kill -9 "${target_pid}" 2>/dev/null || true
        sleep 1
    fi
}

start_bg() {
    load_env
    mkdir -p "${repo_root}/logs"

    if pid="$(read_live_pid "${pid_file}")"; then
        echo "[INFO] secondary discovery instance 已在运行（PID=${pid}）。"
        return
    fi

    local port database_url webhook_url dsp_base_url app_env
    port="$(secondary_port)"
    database_url="$(secondary_database_url)"
    webhook_url="$(secondary_webhook_url)"
    dsp_base_url="$(secondary_dsp_base_url)"
    app_env="${DISCOVERY_SECONDARY_APP_ENV:-testing}"

    cd "${repo_root}"
    nohup env \
        APP_ENV="${app_env}" \
        UVICORN_PORT="${port}" \
        DATABASE_URL="${database_url}" \
        TEST_DATABASE_URL="${TEST_DATABASE_URL:-${database_url}}" \
        DSP_BASE_URL="${dsp_base_url}" \
        DSP_WEBHOOK_RECEIVE_URL="${webhook_url}" \
        POLLING_SERVER_URL="${DISCOVERY_SECONDARY_POLLING_SERVER_URL:-}" \
        FORWARDER_SERVER_ENABLED="${DISCOVERY_SECONDARY_FORWARDER_ENABLED:-false}" \
        FORWARDER_SERVER_URL="${DISCOVERY_SECONDARY_FORWARDER_SERVER_URL:-}" \
        PYTHONPATH="${repo_root}" \
        uv run python -m app.main >>"${log_file}" 2>&1 &
    app_pid=$!
    echo "${app_pid}" >"${pid_file}"

    sleep 3
    if ! kill -0 "${app_pid}" 2>/dev/null; then
        rm -f "${pid_file}"
        echo "[ERROR] secondary discovery instance 启动失败，请检查 ${log_file}。" >&2
        exit 1
    fi

    echo "[INFO] secondary discovery instance 已启动（PID=${app_pid}）。"
    echo "[INFO] 服务地址：http://localhost:${port}"
    echo "[INFO] 健康检查：http://localhost:${port}/health"
    echo "[INFO] 日志文件：${log_file}"
}

status_instance() {
    local port
    port="$(secondary_port)"

    if pid="$(read_live_pid "${pid_file}")"; then
        echo "[INFO] secondary discovery instance 正在运行（PID=${pid}）。"
        echo "[INFO] 服务地址：http://localhost:${port}"
        echo "[INFO] 健康检查：http://localhost:${port}/health"
    else
        echo "[INFO] secondary discovery instance 未运行。"
    fi
}

stop_instance() {
    if pid="$(read_live_pid "${pid_file}")"; then
        stop_pid "${pid}"
        rm -f "${pid_file}"
        echo "[INFO] 已停止 secondary discovery instance（PID=${pid}）。"
    else
        echo "[INFO] secondary discovery instance 当前未运行。"
    fi
}

show_logs() {
    mkdir -p "${repo_root}/logs"
    touch "${log_file}"
    if [[ "${1:-}" == "follow" ]]; then
        exec tail -n 200 -f "${log_file}"
    fi
    tail -n 200 "${log_file}"
}

usage() {
    cat <<'EOF'
用法：
  ./scripts/local-dev/secondary-instance.sh start
  ./scripts/local-dev/secondary-instance.sh stop
  ./scripts/local-dev/secondary-instance.sh status
  ./scripts/local-dev/secondary-instance.sh logs [follow]

默认行为：
  - 端口：DISCOVERY_SECONDARY_PORT，默认 9006
  - 数据库：DISCOVERY_SECONDARY_DATABASE_URL，默认回退到 .env / 环境变量中的 TEST_DATABASE_URL
  - APP_ENV：DISCOVERY_SECONDARY_APP_ENV，默认 testing
    - DSP_BASE_URL：DISCOVERY_SECONDARY_DSP_BASE_URL，默认回退到当前环境中的 DSP_BASE_URL，再回退到 http://localhost:9001/acps-dsp-v2
  - webhook receive URL：DISCOVERY_SECONDARY_WEBHOOK_RECEIVE_URL，默认 http://localhost:<port>/admin/dsp/webhooks/receive
  - polling：DISCOVERY_SECONDARY_POLLING_SERVER_URL，默认空字符串（禁用）
  - forwarder：DISCOVERY_SECONDARY_FORWARDER_ENABLED=false，FORWARDER_SERVER_URL 默认空字符串
EOF
}

main() {
    local action="${1:-help}"

    case "${action}" in
        start)
            start_bg
            ;;
        stop)
            stop_instance
            ;;
        status)
            status_instance
            ;;
        logs)
            show_logs "${2:-}"
            ;;
        help|--help|-h)
            usage
            ;;
        *)
            echo "[ERROR] 未知动作：${action}" >&2
            usage >&2
            exit 2
            ;;
    esac
}

main "$@"
