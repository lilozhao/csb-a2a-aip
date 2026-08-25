#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${BASE_DIR}/lib"
if [[ ! -d "${LIB_DIR}" ]]; then
    LIB_DIR="${BASE_DIR}/../lib"
fi
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
    # shellcheck source=/dev/null
    source "${LIB_DIR}/certs-permissions-lib.sh"
fi

if [[ -f "${BASE_DIR}/compose.yml" ]]; then
    COMPOSE_DIR="${BASE_DIR}"
else
    COMPOSE_DIR="${BASE_DIR}/stage-infra"
fi

if [[ -f "${COMPOSE_DIR}/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${COMPOSE_DIR}/.env"
    set +a
fi

gateway_port="${NGINX_PORT:-9000}"
GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-http://localhost:${gateway_port}}"
RABBITMQ_PORT="${RABBITMQ_PORT:-5671}"
MQ_AUTH_PORT="${MQ_AUTH_PORT:-9007}"
RABBITMQ_USER="${RABBITMQ_USER:-admin}"
: "${RABBITMQ_PASSWORD:?RABBITMQ_PASSWORD is required}"
: "${REDIS_PASSWORD:?REDIS_PASSWORD is required}"
: "${MQ_AUTH_MGMT_USER:=mq-auth-svc}"
: "${MQ_AUTH_MGMT_PASS:?MQ_AUTH_MGMT_PASS is required}"

CERT_DIR="${COMPOSE_DIR}/certs"
CA_CERT="${CERT_DIR}/acps-root-ca.pem"
RABBITMQ_CLIENT_CERT="${CERT_DIR}/rabbitmq-client.pem"
RABBITMQ_CLIENT_KEY="${CERT_DIR}/rabbitmq-client.key"
RABBITMQ_CLIENT_KEY_FOR_HOST="${RABBITMQ_CLIENT_KEY}"

require_file() {
    local path="$1"
    if [[ ! -f "${path}" ]]; then
        echo "[smoke-test] missing file: ${path}" >&2
        return 1
    fi
}

check_http_status() {
    local url="$1"
    local expected_status="$2"
    local status

    status=$(curl --silent --show-error --connect-timeout 3 --max-time 10 \
        -o /dev/null -w "%{http_code}" "$url")
    if [[ "${status}" != "${expected_status}" ]]; then
        echo "[smoke-test] unexpected http status for ${url}: got ${status}, want ${expected_status}" >&2
        return 1
    fi
}

check_tcp_port_closed() {
    local host="$1"
    local port="$2"

    if command -v nc >/dev/null 2>&1; then
        if nc -z "${host}" "${port}" >/dev/null 2>&1; then
            echo "[smoke-test] expected ${host}:${port} to be closed" >&2
            return 1
        fi
        return 0
    fi

    python3 - "${host}" "${port}" <<'PY'
import socket
import sys

host = sys.argv[1]
port = int(sys.argv[2])

try:
    with socket.create_connection((host, port), timeout=3):
        raise SystemExit(1)
except OSError:
    raise SystemExit(0)
PY
}

check_container_port_not_published() {
    local container="$1"
    local port="$2"

    if docker port "${container}" "${port}/tcp" >/dev/null 2>&1; then
        echo "[smoke-test] expected ${container} ${port}/tcp to be unpublished" >&2
        docker port "${container}" "${port}/tcp" >&2 || true
        return 1
    fi
}

check_rabbitmq_tls() {
    python3 - "${RABBITMQ_PORT}" "${CA_CERT}" "${RABBITMQ_CLIENT_CERT}" "${RABBITMQ_CLIENT_KEY_FOR_HOST}" <<'PY'
import socket
import ssl
import sys

port = int(sys.argv[1])
ca_cert, client_cert, client_key = sys.argv[2:]

context = ssl.create_default_context(cafile=ca_cert)
context.minimum_version = ssl.TLSVersion.TLSv1_3
context.load_cert_chain(client_cert, client_key)

with socket.create_connection(("127.0.0.1", port), timeout=5) as sock:
    with context.wrap_socket(sock, server_hostname="rabbitmq") as tls_sock:
        if tls_sock.version() != "TLSv1.3":
            raise SystemExit(f"unexpected TLS version: {tls_sock.version()}")
PY
}

check_auth_service_health() {
    local port="$1"

    curl --silent --show-error --connect-timeout 3 --max-time 10 \
        --resolve "mq-auth-server:${port}:127.0.0.1" \
        --cacert "${CA_CERT}" \
        --cert "${RABBITMQ_CLIENT_CERT}" \
        --key "${RABBITMQ_CLIENT_KEY_FOR_HOST}" \
        "https://mq-auth-server:${port}/health" >/dev/null
}

find_running_mq_auth_container() {
    local container=""
    local state=""

    for container in mq-auth-server-blue mq-auth-server-green; do
        if ! docker inspect "${container}" >/dev/null 2>&1; then
            continue
        fi

        state="$(docker inspect --format '{{.State.Status}}' "${container}" 2>/dev/null || true)"
        if [[ "${state}" == "running" ]]; then
            echo "${container}"
            return 0
        fi
    done

    return 1
}

resolve_container_mount_source() {
    local container="$1"
    local destination="$2"

    docker inspect --format "{{range .Mounts}}{{if eq .Destination \"${destination}\"}}{{println .Source}}{{end}}{{end}}" "${container}" 2>/dev/null | awk 'NF { print; exit }'
}

resolve_expected_mq_auth_certs_dir() {
    local runtime_root=""

    runtime_root="$(cd "${COMPOSE_DIR}/.." && pwd -P)"
    echo "${runtime_root}/mq-auth-server/certs"
}

can_check_runtime_mq_auth_container() {
    local container="$1"
    local expected_dir=""
    local actual_dir=""

    expected_dir="$(resolve_expected_mq_auth_certs_dir)"
    actual_dir="$(resolve_container_mount_source "${container}" "/certs")"
    if [[ -z "${actual_dir}" ]]; then
        echo "[smoke-test] skip mq-auth-server checks (${container} has no /certs mount)"
        return 1
    fi

    if [[ "${actual_dir}" != "${expected_dir}" ]]; then
        echo "[smoke-test] skip mq-auth-server checks (${container} belongs to a different runtime: certs=${actual_dir}, expected=${expected_dir})"
        return 1
    fi

    return 0
}

echo "[smoke-test] validate certificate files"
require_file "${CA_CERT}"
require_file "${RABBITMQ_CLIENT_CERT}"
require_file "${RABBITMQ_CLIENT_KEY}"
if declare -F create_host_client_key_copy >/dev/null 2>&1; then
    TEMP_RABBITMQ_CLIENT_KEY="$(create_host_client_key_copy "${RABBITMQ_CLIENT_KEY}")"
    TEMP_HOST_KEY_FILES+=("${TEMP_RABBITMQ_CLIENT_KEY}")
    RABBITMQ_CLIENT_KEY_FOR_HOST="${TEMP_RABBITMQ_CLIENT_KEY}"
fi

echo "[smoke-test] check gateway root returns 404"
check_http_status "${GATEWAY_BASE_URL}" "404"

echo "[smoke-test] check rabbitmq AMQPS listener"
check_rabbitmq_tls

echo "[smoke-test] check plaintext AMQP is disabled"
check_tcp_port_closed 127.0.0.1 5672

echo "[smoke-test] check RabbitMQ management API is not exposed on host"
check_container_port_not_published stage-rabbitmq 15672

mq_auth_container="$(find_running_mq_auth_container || true)"
if [[ -z "${mq_auth_container}" ]]; then
    echo "[smoke-test] skip mq-auth-server checks (mq-auth-server not yet deployed)"
elif can_check_runtime_mq_auth_container "${mq_auth_container}"; then
    echo "[smoke-test] check mq-auth-server external mTLS listener (${mq_auth_container})"
    check_auth_service_health "${MQ_AUTH_PORT}"

    echo "[smoke-test] check mq-auth-server internal listener is not exposed on host"
    check_tcp_port_closed 127.0.0.1 9008

    echo "[smoke-test] check mq-auth-server internal auth listener from container (${mq_auth_container})"
    docker exec -i "${mq_auth_container}" /opt/venv/bin/python - <<'PY'
import ssl
import urllib.request

ctx = ssl.create_default_context(cafile="/certs/acps-root-ca.pem")
ctx.load_cert_chain("/certs/client.pem", "/certs/client.key")
urllib.request.urlopen("https://mq-auth-server:9008/health", context=ctx, timeout=5).read()
PY
fi

echo "[smoke-test] check redis TLS"
docker exec -e REDISCLI_AUTH="${REDIS_PASSWORD}" stage-redis \
    sh -lc "redis-cli --tls --cacert /certs/acps-root-ca.pem ping | grep -qx PONG"

echo "[smoke-test] check rabbitmq init resources"
docker exec stage-rabbitmq rabbitmqctl authenticate_user "${MQ_AUTH_MGMT_USER}" "${MQ_AUTH_MGMT_PASS}" >/dev/null
docker exec stage-rabbitmq rabbitmqctl list_vhosts --silent | grep -Fxq acps
docker exec stage-rabbitmq rabbitmqctl list_exchanges -p acps name type durable --formatter csv \
    | awk -F ',' '$1=="\"inbox.topic\"" && $2=="\"topic\"" && $3=="\"true\"" {found=1} END {exit(found ? 0 : 1)}'

echo "[smoke-test] OK"
