#!/usr/bin/env bash
# smoke-test.sh — mq-auth-server 部署后冒烟测试
# 用法: ./scripts/smoke-test.sh [GROUP_API_BASE_URL]
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${SCRIPT_DIR}/lib"
TEMP_HOST_KEY_FILES=()

cleanup_temp_host_key_files() {
    local path=""

    for path in "${TEMP_HOST_KEY_FILES[@]:-}"; do
        [[ -n "${path}" && -f "${path}" ]] || continue
        rm -f "${path}"
    done
}

trap cleanup_temp_host_key_files EXIT

if [[ -f "${LIB_DIR}/certs-permissions-lib.sh" ]]; then
    # shellcheck source=lib/certs-permissions-lib.sh
    source "${LIB_DIR}/certs-permissions-lib.sh"
fi

if [[ -f "${SCRIPT_DIR}/.env" ]]; then
    # shellcheck disable=SC1091
    source "${SCRIPT_DIR}/.env"
elif [[ -f "${SCRIPT_DIR}/../.env" ]]; then
    # shellcheck disable=SC1091
    source "${SCRIPT_DIR}/../.env"
fi

GROUP_API="${1:-https://localhost:9007}"
AUTH_API="${AUTH_API_URL:-${GROUP_API%:9007}:9008}"
PASS=0
FAIL=0
CURL_OPTS=(--silent --show-error --connect-timeout 3 --max-time 10)

HEALTHCHECK_CERT_FILE="${HEALTHCHECK_TLS_CERT_FILE:-}"
HEALTHCHECK_KEY_FILE="${HEALTHCHECK_TLS_KEY_FILE:-}"
HEALTHCHECK_CA_CERT_FILE="${HEALTHCHECK_TLS_CA_CERT_FILE:-${TLS_CA_CERT_FILE:-}}"

resolve_host_cert_path() {
    local path="$1"

    if [[ -z "$path" ]]; then
        echo ""
        return 0
    fi
    if [[ "$path" == /certs/* ]]; then
        if [[ -z "${CERTS_HOST_DIR:-}" ]]; then
            echo "错误: 使用容器内 /certs 路径时，必须设置 CERTS_HOST_DIR" >&2
            exit 1
        fi
        echo "${CERTS_HOST_DIR%/}/${path#/certs/}"
        return 0
    fi
    echo "$path"
}

require_file() {
    local path="$1"
    local label="$2"

    if [[ ! -f "$path" ]]; then
        echo "错误: 缺少文件 ${label}: ${path}" >&2
        exit 1
    fi
}

if [[ "${APP_ENV:-production}" != "development" ]]; then
    if [[ -z "${HEALTHCHECK_CERT_FILE}" || -z "${HEALTHCHECK_KEY_FILE}" ]]; then
        echo "错误: 非 development 环境必须设置 HEALTHCHECK_TLS_CERT_FILE 和 HEALTHCHECK_TLS_KEY_FILE" >&2
        exit 1
    fi
fi

HEALTHCHECK_CERT_FILE="$(resolve_host_cert_path "${HEALTHCHECK_CERT_FILE}")"
HEALTHCHECK_KEY_FILE="$(resolve_host_cert_path "${HEALTHCHECK_KEY_FILE}")"
HEALTHCHECK_CA_CERT_FILE="$(resolve_host_cert_path "${HEALTHCHECK_CA_CERT_FILE}")"

if [[ -n "${HEALTHCHECK_CERT_FILE}" ]]; then
    require_file "${HEALTHCHECK_CERT_FILE}" "HEALTHCHECK_TLS_CERT_FILE"
fi
if [[ -n "${HEALTHCHECK_KEY_FILE}" ]]; then
    require_file "${HEALTHCHECK_KEY_FILE}" "HEALTHCHECK_TLS_KEY_FILE"
    if declare -F create_host_client_key_copy >/dev/null 2>&1; then
        TEMP_HEALTHCHECK_KEY_FILE="$(create_host_client_key_copy "${HEALTHCHECK_KEY_FILE}")"
        TEMP_HOST_KEY_FILES+=("${TEMP_HEALTHCHECK_KEY_FILE}")
        HEALTHCHECK_KEY_FILE="${TEMP_HEALTHCHECK_KEY_FILE}"
    fi
fi
if [[ -n "${HEALTHCHECK_CA_CERT_FILE}" ]]; then
    require_file "${HEALTHCHECK_CA_CERT_FILE}" "HEALTHCHECK_TLS_CA_CERT_FILE"
fi

if [[ -n "${HEALTHCHECK_CERT_FILE}" ]]; then
    CURL_OPTS+=(--cert "${HEALTHCHECK_CERT_FILE}")
fi
if [[ -n "${HEALTHCHECK_KEY_FILE}" ]]; then
    CURL_OPTS+=(--key "${HEALTHCHECK_KEY_FILE}")
fi
if [[ -n "${HEALTHCHECK_CA_CERT_FILE}" ]]; then
    CURL_OPTS+=(--cacert "${HEALTHCHECK_CA_CERT_FILE}")
fi

check() {
    local name="$1"
    local url="$2"
    local expected_status="${3:-200}"

    status=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" "$url" || echo "000")

    if [[ "|${expected_status}|" == *"|${status}|"* ]]; then
        echo "  ✅ ${name} — HTTP ${status}"
        PASS=$((PASS + 1))
    else
        echo "  ❌ ${name} — 期望 ${expected_status}，实际 ${status}"
        FAIL=$((FAIL + 1))
    fi
}

# 检查内部端口（9008 仅在 Docker 网络内可达），当直连失败时通过 docker exec 在容器内测试
check_internal() {
    local name="$1"
    local url="$2"
    local expected_status="${3:-200}"

    # 先尝试直连（连接失败时 curl 可能输出 "000" + "000"，取前3位规范化）
    local raw_status
    raw_status=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || true)
    local http_status="${raw_status:0:3}"

    if [[ "|${expected_status}|" == *"|${http_status}|"* ]]; then
        echo "  ✅ ${name} — HTTP ${http_status}"
        PASS=$((PASS + 1))
        return 0
    fi

    # 直连失败时，通过 docker exec 在容器内运行 health_probe
    if [[ "$http_status" == "000" ]] && command -v docker &>/dev/null; then
        # 查找正在运行的 mq-auth-server 容器
        local container
        container=$(docker ps --filter "name=mq-auth-server" --filter "status=running" \
            --format "{{.Names}}" 2>/dev/null | head -1)
        if [[ -n "$container" ]]; then
            local probe_exit=0
            docker exec "$container" python -m app.core.health_probe \
                --url "$url" >/dev/null 2>&1 || probe_exit=$?
            if [[ $probe_exit -eq 0 ]]; then
                echo "  ✅ ${name} — via docker exec OK (port is internal-only)"
                PASS=$((PASS + 1))
                return 0
            fi
        fi
    fi

    echo "  ❌ ${name} — 期望 ${expected_status}，实际 ${http_status:-000}"
    FAIL=$((FAIL + 1))
}

echo "=== mq-auth-server 冒烟测试 ==="
echo "Group API: ${GROUP_API}"
echo "Auth API:  ${AUTH_API}"
echo "mTLS cert: ${HEALTHCHECK_CERT_FILE:-<unset>}"
echo "certs dir: ${CERTS_HOST_DIR:-<unset>}"
echo ""

echo "--- 健康检查 ---"
check "Group API /health" "${GROUP_API}/health" "200"
check_internal "Auth API /health"  "${AUTH_API}/health" "200"

echo ""
echo "=== 结果: ${PASS} 通过, ${FAIL} 失败 ==="

if [ "$FAIL" -gt 0 ]; then
    exit 1
fi
