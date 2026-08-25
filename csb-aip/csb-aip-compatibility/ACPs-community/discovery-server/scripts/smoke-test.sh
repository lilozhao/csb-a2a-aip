#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost:9005}"
PASS=0
FAIL=0
CURL_OPTS=(--silent --show-error --location --connect-timeout 3 --max-time 10)

json_field() {
    local field="$1"
    python3 -c 'import json, sys
try:
    data = json.load(sys.stdin)
except Exception:
    data = {}
print(data.get(sys.argv[1], ""))' "$field"
}

check_request() {
    local name="$1"
    local method="$2"
    local url="$3"
    local expected_status="${4:-200}"
    shift 4
    local status

    status=$(curl "${CURL_OPTS[@]}" -X "$method" "$@" -o /dev/null -w "%{http_code}" "$url" || echo "000")

    if [[ "|${expected_status}|" == *"|${status}|"* ]]; then
        echo "  ✅ ${name} — HTTP ${status}"
        PASS=$((PASS + 1))
    else
        echo "  ❌ ${name} — 期望 ${expected_status}，实际 ${status}"
        FAIL=$((FAIL + 1))
    fi
}

check() {
    local name="$1"
    local url="$2"
    local expected_status="${3:-200}"
    check_request "$name" "GET" "$url" "$expected_status"
}

echo "=== 冒烟测试: ${BASE_URL} ==="
echo ""

echo "--- 基础端点 ---"
ROOT_HTTP_STATUS=$(curl "${CURL_OPTS[@]}" -o /tmp/discovery-root-response.txt -w "%{http_code}" "${BASE_URL}/" || echo "000")
ROOT_RESP=$(cat /tmp/discovery-root-response.txt 2>/dev/null || true)
ROOT_STATUS=$(printf '%s' "$ROOT_RESP" | json_field "status")
if [[ "$ROOT_HTTP_STATUS" == "200" && "$ROOT_STATUS" == "healthy" ]]; then
    echo "  ✅ 根探针 / — status=healthy"
    PASS=$((PASS + 1))
else
    echo "  ❌ 根探针 / — 期望 200(status=healthy)，实际 ${ROOT_HTTP_STATUS}"
    FAIL=$((FAIL + 1))
fi

HEALTH_HTTP_STATUS=$(curl "${CURL_OPTS[@]}" -o /tmp/discovery-health-response.txt -w "%{http_code}" "${BASE_URL}/health" || echo "000")
HEALTH_RESP=$(cat /tmp/discovery-health-response.txt 2>/dev/null || true)
HEALTH_STATUS=$(printf '%s' "$HEALTH_RESP" | json_field "status")
if [[ "$HEALTH_HTTP_STATUS" == "200" && "$HEALTH_STATUS" == "ok" ]]; then
    echo "  ✅ 健康检查 /health — status=ok"
    PASS=$((PASS + 1))
else
    echo "  ❌ 健康检查 /health — 期望 200(status=ok)，实际 ${HEALTH_HTTP_STATUS}"
    FAIL=$((FAIL + 1))
fi

READY_HTTP_STATUS=$(curl "${CURL_OPTS[@]}" -o /tmp/discovery-ready-response.txt -w "%{http_code}" "${BASE_URL}/ready" || echo "000")
READY_RESP=$(cat /tmp/discovery-ready-response.txt 2>/dev/null || true)
READY_STATUS=$(printf '%s' "$READY_RESP" | json_field "status")
if [[ "$READY_HTTP_STATUS" == "200" && "$READY_STATUS" == "ready" ]]; then
    echo "  ✅ 就绪检查 /ready — status=ready"
    PASS=$((PASS + 1))
else
    echo "  ❌ 就绪检查 /ready — 期望 200(status=ready)，实际 ${READY_HTTP_STATUS}"
    FAIL=$((FAIL + 1))
fi

check "API 文档 /docs" "${BASE_URL}/docs" "200"
check "OpenAPI /openapi.json" "${BASE_URL}/openapi.json" "200"

echo ""
echo "--- Discovery 端点 ---"
DISCOVERY_HEALTH_HTTP_STATUS=$(curl "${CURL_OPTS[@]}" -o /tmp/discovery-adp-health-response.txt -w "%{http_code}" "${BASE_URL}/acps-adp-v2/health" || echo "000")
DISCOVERY_HEALTH_RESP=$(cat /tmp/discovery-adp-health-response.txt 2>/dev/null || true)
DISCOVERY_HEALTH_STATUS=$(printf '%s' "$DISCOVERY_HEALTH_RESP" | json_field "status")
if [[ "$DISCOVERY_HEALTH_HTTP_STATUS" == "200" && "$DISCOVERY_HEALTH_STATUS" == "healthy" ]]; then
    echo "  ✅ Discovery 健康检查 /acps-adp-v2/health — status=healthy"
    PASS=$((PASS + 1))
else
    echo "  ❌ Discovery 健康检查 /acps-adp-v2/health — 期望 200(status=healthy)，实际 ${DISCOVERY_HEALTH_HTTP_STATUS}"
    FAIL=$((FAIL + 1))
fi

check "数据库统计 /acps-adp-v2/stats" "${BASE_URL}/acps-adp-v2/stats" "200"
check "可用智能体缓存 /acps-adp-v2/available-agents-count" "${BASE_URL}/acps-adp-v2/available-agents-count" "200"
check "转发状态 /acps-adp-v2/forwarder-status" "${BASE_URL}/acps-adp-v2/forwarder-status" "200"

echo ""
echo "--- DSP 管理端点 ---"
check "DSP 状态 /admin/dsp/status" "${BASE_URL}/admin/dsp/status" "200"
check "Registry 信息 /admin/dsp/registry-info" "${BASE_URL}/admin/dsp/registry-info" "200|503"

echo ""
echo "=== 结果: ${PASS} 通过, ${FAIL} 失败 ==="

rm -f \
    /tmp/discovery-root-response.txt \
    /tmp/discovery-health-response.txt \
    /tmp/discovery-ready-response.txt \
    /tmp/discovery-adp-health-response.txt

if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
