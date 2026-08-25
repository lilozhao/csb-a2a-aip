#!/usr/bin/env bash
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

BASE_URL="${1:-http://localhost}"
PASS=0
FAIL=0
CURL_OPTS=(--silent --show-error --location --connect-timeout 3 --max-time 10)

is_true() {
    case "$(echo "${1:-}" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

resolve_host_cert_path() {
    local path="$1"

    if [[ "$path" == /certs/* ]]; then
        echo "${REGISTRY_CERTS_HOST_DIR%/}/${path#/certs/}"
        return 0
    fi

    echo "$path"
}

check() {
    local name="$1"
    local url="$2"
    local expected_status="${3:-200}"
    local status

    status=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" "$url" || echo "000")

    if [[ "|${expected_status}|" == *"|${status}|"* ]]; then
        echo "  ✅ ${name} — HTTP ${status}"
        PASS=$((PASS + 1))
    else
        echo "  ❌ ${name} — 期望 ${expected_status}，实际 ${status}"
        FAIL=$((FAIL + 1))
    fi
}

check_stage_nginx() {
    local name="$1"
    local path="$2"
    local expected_status="${3:-200}"
    local container_name="${STAGE_NGINX_CONTAINER_NAME:-stage-nginx}"
    local probe_url="http://127.0.0.1${path}"
    local status

    if ! command -v docker >/dev/null 2>&1 || ! docker ps --format '{{.Names}}' | grep -Fxq "${container_name}"; then
        echo "  WARN ${name} — 未检测到 ${container_name}，跳过仅内网探针"
        return 0
    fi

    status=$(docker exec "${container_name}" sh -lc "
if command -v curl >/dev/null 2>&1; then
    curl --silent --show-error --output /dev/null --write-out '%{http_code}' '${probe_url}'
elif command -v wget >/dev/null 2>&1; then
    wget --server-response --quiet --output-document /dev/null '${probe_url}' 2>&1 | awk '/^  HTTP\\// { code=\$2 } END { print code }'
else
    printf '000'
fi
" 2>/dev/null || echo "000")
    status="${status//$'\r'/}"
    status="${status//$'\n'/}"
    status="${status:0:3}"

    if [[ "|${expected_status}|" == *"|${status}|"* ]]; then
        echo "  ✅ ${name} — HTTP ${status}"
        PASS=$((PASS + 1))
    else
        echo "  ❌ ${name} — 期望 ${expected_status}，实际 ${status}"
        FAIL=$((FAIL + 1))
    fi
}

check_mtls() {
    local name="$1"
    local url="$2"
    local cert_file="$3"
    local key_file="$4"
    local ca_file="$5"
    local expected_status="${6:-200}"
    local status

    status=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" \
        --cert "${cert_file}" \
        --key "${key_file}" \
        --cacert "${ca_file}" \
        "$url" || echo "000")

    if [[ "|${expected_status}|" == *"|${status}|"* ]]; then
        echo "  ✅ ${name} — HTTP ${status}"
        PASS=$((PASS + 1))
    else
        echo "  ❌ ${name} — 期望 ${expected_status}，实际 ${status}"
        FAIL=$((FAIL + 1))
    fi
}

check_mtls_rejects_anonymous() {
    local name="$1"
    local url="$2"
    local ca_file="$3"
    local status

    status=$(curl "${CURL_OPTS[@]}" -o /dev/null -w "%{http_code}" \
        --cacert "${ca_file}" \
        "$url" || echo "000")

    if [[ "$status" != "200" ]]; then
        echo "  ✅ ${name} — 匿名请求被拒绝 (${status})"
        PASS=$((PASS + 1))
    else
        echo "  ❌ ${name} — 匿名请求意外成功"
        FAIL=$((FAIL + 1))
    fi
}

echo "=== 冒烟测试: ${BASE_URL} ==="
echo ""

echo "--- 基础端点 ---"
check "健康检查 /health" "${BASE_URL}/health" "200"
check_stage_nginx "就绪检查 /ready（stage-nginx 内部探针）" "/registry/ready" "200"
check "API 文档 /docs" "${BASE_URL}/docs"
check "OpenAPI /openapi.json" "${BASE_URL}/openapi.json"
check "DSP 信息 /acps-dsp-v2/info" "${BASE_URL}/acps-dsp-v2/info"

if is_true "${REGISTRY_SERVER_ENABLE_MTLS_LISTENER:-false}"; then
    echo ""
    echo "--- 9002 mTLS plane ---"

    MTLS_HOST="${REGISTRY_SERVER_MTLS_PUBLIC_HOST:-localhost}"
    MTLS_PORT="${REGISTRY_SERVER_MTLS_PORT:-9002}"
    MTLS_URL="https://${MTLS_HOST}:${MTLS_PORT}/health"
    MTLS_CERT_FILE="$(resolve_host_cert_path "${REGISTRY_SERVER_MTLS_PROBE_CERT_FILE:-}")"
    MTLS_KEY_FILE="$(resolve_host_cert_path "${REGISTRY_SERVER_MTLS_PROBE_KEY_FILE:-}")"
    MTLS_CA_FILE="$(resolve_host_cert_path "${REGISTRY_SERVER_MTLS_CA_CERT_FILE:-}")"
    MTLS_MATERIALS_MISSING=false

    for path in "${MTLS_CERT_FILE}" "${MTLS_KEY_FILE}" "${MTLS_CA_FILE}"; do
        if [[ ! -f "$path" ]]; then
            echo "  ❌ 9002 探针材料缺失: ${path}"
            FAIL=$((FAIL + 1))
            MTLS_MATERIALS_MISSING=true
        fi
    done

    if [[ "$MTLS_MATERIALS_MISSING" == true ]]; then
        :
    else
        if declare -F create_host_client_key_copy >/dev/null 2>&1; then
            TEMP_MTLS_KEY_FILE="$(create_host_client_key_copy "${MTLS_KEY_FILE}")"
            TEMP_HOST_KEY_FILES+=("${TEMP_MTLS_KEY_FILE}")
            MTLS_KEY_FILE="${TEMP_MTLS_KEY_FILE}"
        fi
        check_mtls "mTLS 健康检查 /health" "${MTLS_URL}" "${MTLS_CERT_FILE}" "${MTLS_KEY_FILE}" "${MTLS_CA_FILE}" "200"
        check_mtls_rejects_anonymous "mTLS 匿名访问拒绝" "${MTLS_URL}" "${MTLS_CA_FILE}"
    fi
fi

echo ""
echo "=== 结果: ${PASS} 通过, ${FAIL} 失败 ==="

if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
