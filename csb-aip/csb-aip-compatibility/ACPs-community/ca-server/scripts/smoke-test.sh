#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-http://localhost}"
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
HEALTH_HTTP_STATUS=$(curl "${CURL_OPTS[@]}" -o /tmp/ca-server-health-response.txt -w "%{http_code}" "${BASE_URL}/health" || echo "000")
HEALTH_RESP=$(cat /tmp/ca-server-health-response.txt 2>/dev/null || true)
HEALTH_STATUS=$(printf '%s' "$HEALTH_RESP" | json_field "status")
if [[ "$HEALTH_HTTP_STATUS" == "200" && "$HEALTH_STATUS" == "healthy" ]]; then
    echo "  ✅ 健康检查 /health — status=healthy"
    PASS=$((PASS + 1))
else
    echo "  ❌ 健康检查 /health — 期望 200(status=healthy)，实际 ${HEALTH_HTTP_STATUS}"
    FAIL=$((FAIL + 1))
fi
check "未知路径 /__should-not-exist__" "${BASE_URL}/__should-not-exist__" "404"
check "API 文档 /docs" "${BASE_URL}/docs" "200|404"
check "OpenAPI /openapi.json" "${BASE_URL}/openapi.json" "200|404"

echo ""
echo "--- ACPs 端点 ---"
check "ACME Directory" "${BASE_URL}/acps-atr-v2/acme/directory" "200"
check "CRL 下载" "${BASE_URL}/acps-atr-v2/crl?format=der" "200"
check "OCSP Responder Info" "${BASE_URL}/acps-atr-v2/ocsp/responder/info" "200|404"
check "Trust Bundle" "${BASE_URL}/acps-atr-v2/ca/trust-bundle" "200"

echo ""
echo "=== 结果: ${PASS} 通过, ${FAIL} 失败 ==="

if [[ "$FAIL" -gt 0 ]]; then
    exit 1
fi
