#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
WEB_BASE_URL="${WEB_BASE_URL:-http://localhost:9010}"
API_BASE_URL="${API_BASE_URL:-${WEB_BASE_URL%/}/api/v1}"
RPC_POLL_INTERVAL="${RPC_POLL_INTERVAL:-1}"
RPC_POLL_TIMEOUT="${RPC_POLL_TIMEOUT:-120}"
TASK_POLL_TIMEOUT="${TASK_POLL_TIMEOUT:-180}"
GROUP_POLL_INTERVAL="${GROUP_POLL_INTERVAL:-2}"
GROUP_POLL_TIMEOUT="${GROUP_POLL_TIMEOUT:-300}"
HTTP_REQUEST_TIMEOUT="${HTTP_REQUEST_TIMEOUT:-180}"
GROUP_MIN_MEMBERS="${GROUP_MIN_MEMBERS:-2}"
SMOKE_LOG_TAIL="${SMOKE_LOG_TAIL:-300}"
DUMP_SMOKE_LOGS="${DUMP_SMOKE_LOGS:-true}"

# 业务冒烟默认采用混合静态/动态选路：
#   - hotel / intercity_transport 走静态映射
#   - food / local_transport / attraction 走动态 discovery
#
# 因此脚本仅执行一次 happy path。动态 discovery 是否命中可从 leader
# 日志中的 `(dynamic)` 和 `[ADP] Discovered` 关键字确认。

if [[ -f "${BASE_DIR}/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${BASE_DIR}/.env"
    set +a
fi

RUN_CORE_SERVICES_SMOKE="${RUN_CORE_SERVICES_SMOKE:-true}"
RUN_AIP_V210_AUDIT="${RUN_AIP_V210_AUDIT:-${RUN_AIPV210_AUDIT:-true}}"
AIP_V210_AUDIT_OUTPUT="${AIP_V210_AUDIT_OUTPUT:-${AIPV210_AUDIT_OUTPUT:-${BASE_DIR}/logs/aip-v210-audit.json}}"
AIP_V210_LOG_SINCE="${AIP_V210_LOG_SINCE:-${AIPV210_LOG_SINCE:-$(date -u +"%Y-%m-%dT%H:%M:%SZ")}}"
AIP_V210_INFRA_CERT_DIR="${AIP_V210_INFRA_CERT_DIR:-${AIPV210_INFRA_CERT_DIR:-}}"

resolve_infra_cert_dir() {
    local explicit_dir="${AIP_V210_INFRA_CERT_DIR:-}"
    local candidate=""

    if [[ -n "${explicit_dir}" ]]; then
        if [[ ! -d "${explicit_dir}" ]]; then
            echo "[smoke-test-business] ERROR: AIP_V210_INFRA_CERT_DIR 不存在: ${explicit_dir}" >&2
            return 1
        fi
        printf '%s\n' "${explicit_dir}"
        return 0
    fi

    for candidate in \
        "${BASE_DIR}/../../stage-infra/certs" \
        "${BASE_DIR}/../../acps-infra/stage-infra/certs"; do
        if [[ -d "${candidate}" ]]; then
            printf '%s\n' "${candidate}"
            return 0
        fi
    done

    echo "[smoke-test-business] ERROR: 未找到基础设施证书目录，请设置 AIP_V210_INFRA_CERT_DIR" >&2
    return 1
}

AIP_V210_INFRA_CERT_DIR="$(resolve_infra_cert_dir)"

if [[ -n "${LEADER_CONFIG_FILE:-}" ]]; then
  LEADER_CONFIG_FILE="${LEADER_CONFIG_FILE}"
elif [[ -f "${BASE_DIR}/leader/config.toml" ]]; then
    LEADER_CONFIG_FILE="${BASE_DIR}/leader/config.toml"
elif [[ -f "${BASE_DIR}/config/leader.toml" ]]; then
  LEADER_CONFIG_FILE="${BASE_DIR}/config/leader.toml"
elif [[ -f "${BASE_DIR}/../leader/config.toml" ]]; then
  LEADER_CONFIG_FILE="${BASE_DIR}/../leader/config.toml"
else
  echo "[smoke-test-business] ERROR: 未找到 leader.toml，请设置 LEADER_CONFIG_FILE" >&2
  exit 1
fi

echo "[smoke-test-business] api base: ${API_BASE_URL}"
echo "[smoke-test-business] leader config: ${LEADER_CONFIG_FILE}"
echo "[smoke-test-business] infra cert dir: ${AIP_V210_INFRA_CERT_DIR}"
echo "[smoke-test-business] group min members: ${GROUP_MIN_MEMBERS}"

LEADER_COMPOSE_FILE="${BASE_DIR}/release-leader/compose.yml"
LEADER_ENV_FILE="${BASE_DIR}/release-leader/.env"
PARTNERS_COMPOSE_FILE="${BASE_DIR}/release-partners/compose.yml"
PARTNERS_ENV_FILE="${BASE_DIR}/release-partners/.env"
STAGE_INFRA_COMPOSE_FILE="${BASE_DIR}/../../acps-infra/stage-infra/compose.yml"
STAGE_INFRA_ENV_FILE="${BASE_DIR}/../../acps-infra/stage-infra/.env"

if [[ -f "${BASE_DIR}/compose.yml" && -f "${BASE_DIR}/.env" ]]; then
    LEADER_COMPOSE_FILE="${BASE_DIR}/compose.yml"
    LEADER_ENV_FILE="${BASE_DIR}/.env"
    PARTNERS_COMPOSE_FILE="${BASE_DIR}/../partners/compose.yml"
    PARTNERS_ENV_FILE="${BASE_DIR}/../partners/.env"
    STAGE_INFRA_COMPOSE_FILE="${BASE_DIR}/../../stage-infra/compose.yml"
    STAGE_INFRA_ENV_FILE="${BASE_DIR}/../../stage-infra/.env"
fi

dump_compose_logs() {
    local label="$1"
    local compose_file="$2"
    local env_file="$3"
    local project_name="$4"
    shift 4

    if [[ ! -f "${compose_file}" || ! -f "${env_file}" ]]; then
        echo "[smoke-test-business] WARN: 跳过 ${label} 日志导出，compose 或 env 不存在" >&2
        return 0
    fi

    echo "[smoke-test-business] --- ${label} logs (tail=${SMOKE_LOG_TAIL}) ---"
    if [[ -n "${project_name}" ]]; then
        COMPOSE_PROJECT_NAME="${project_name}" docker compose --env-file "${env_file}" -f "${compose_file}" logs --tail "${SMOKE_LOG_TAIL}" "$@" || true
    else
        docker compose --env-file "${env_file}" -f "${compose_file}" logs --tail "${SMOKE_LOG_TAIL}" "$@" || true
    fi
}

dump_runtime_logs() {
    if [[ "${DUMP_SMOKE_LOGS}" != "true" ]]; then
        return 0
    fi

    dump_compose_logs "leader" "${LEADER_COMPOSE_FILE}" "${LEADER_ENV_FILE}" "" leader
    dump_compose_logs "partners" "${PARTNERS_COMPOSE_FILE}" "${PARTNERS_ENV_FILE}" "" partners
    dump_compose_logs "stage-infra mq-auth-server/rabbitmq" "${STAGE_INFRA_COMPOSE_FILE}" "${STAGE_INFRA_ENV_FILE}" "stage-infra" mq-auth-server rabbitmq
}

have_host_acps_cli() {
    [[ -n "${ACPS_CLI_BIN:-}" ]] && return 0
    command -v acps-cli >/dev/null 2>&1
}

host_python_supports_modern_smoke() {
    python3 - <<'PY' >/dev/null 2>&1
import sys
import tomllib

raise SystemExit(0 if sys.version_info >= (3, 11) else 1)
PY
}

resolve_smoke_tool_image() {
    local candidate

    for candidate in \
        "${CORE_SERVICES_SMOKE_TOOL_IMAGE:-}" \
        "demo-leader:latest" \
        "acps-demo-leader:latest" \
        "demo-partners:latest" \
        "acps-demo-partners:latest"; do
        [[ -n "${candidate}" ]] || continue
        if docker image inspect "${candidate}" >/dev/null 2>&1; then
            printf '%s\n' "${candidate}"
            return 0
        fi
    done

    return 1
}

rewrite_loopback_url_for_container() {
    local url="${1:-}"
    local bridge_host="${2:-host.docker.internal}"

    url="${url/https:\/\/localhost/https://${bridge_host}}"
    url="${url/http:\/\/localhost/http://${bridge_host}}"
    url="${url/https:\/\/127.0.0.1/https://${bridge_host}}"
    url="${url/http:\/\/127.0.0.1/http://${bridge_host}}"
    printf '%s\n' "${url}"
}

resolve_smoke_package_root() {
    cd "${BASE_DIR}/../../.." && pwd
}

run_python_module_in_tool_image() {
    local tool_image=""
    local package_root=""
    local bridge_host=""
    local module="${1:-}"
    local api_base_url=""
    local web_base_url=""
    local gateway_base_url=""

    if [[ -z "${module}" ]]; then
        echo "[smoke-test-business] ERROR: run_python_module_in_tool_image 缺少模块名" >&2
        return 1
    fi

    tool_image="$(resolve_smoke_tool_image 2>/dev/null || true)"
    if [[ -z "${tool_image}" ]]; then
        echo "[smoke-test-business] ERROR: 未找到可用工具镜像执行 ${module}" >&2
        return 1
    fi

    package_root="$(resolve_smoke_package_root)"
    bridge_host="${GATEWAY_BRIDGE_HOST:-host.docker.internal}"
    api_base_url="$(rewrite_loopback_url_for_container "${API_BASE_URL}" "${bridge_host}")"
    web_base_url="$(rewrite_loopback_url_for_container "${WEB_BASE_URL}" "${bridge_host}")"
    gateway_base_url="$(rewrite_loopback_url_for_container "${GATEWAY_BASE_URL:-http://${GATEWAY_PUBLIC_HOST:-localhost}:${STAGE_NGINX_PORT:-9000}}" "${bridge_host}")"

    docker run --rm \
        --user 0:0 \
        --workdir /work/runtime/demo/leader \
        --add-host host.docker.internal:host-gateway \
        --env-file "${BASE_DIR}/.env" \
        -e REGISTRY_API_BASE_URL= \
        -e REGISTRY_SERVER_BASE_URL= \
        -e REGISTRY_ATR_BASE_URL= \
        -e REGISTRY_TOKEN_FILE= \
        -e CA_SERVER_BASE_URL= \
        -e CA_SERVER_ATR_BASE_URL= \
        -e DISCOVERY_SERVER_BASE_URL= \
        -e REGISTRY_BASE_URL="${gateway_base_url}/registry" \
        -e CA_BASE_URL="${gateway_base_url}/ca-server" \
        -e DISCOVERY_BASE_URL="${gateway_base_url}/discovery" \
        -e PYTHONPATH=/work/runtime/demo/leader \
        -e ACPS_CLI_BIN="${ACPS_CLI_BIN:-}" \
        -e WEB_BASE_URL="${web_base_url}" \
        -e API_BASE_URL="${api_base_url}" \
        -e RPC_POLL_INTERVAL="${RPC_POLL_INTERVAL}" \
        -e RPC_POLL_TIMEOUT="${RPC_POLL_TIMEOUT}" \
        -e TASK_POLL_TIMEOUT="${TASK_POLL_TIMEOUT}" \
        -e GROUP_POLL_INTERVAL="${GROUP_POLL_INTERVAL}" \
        -e GROUP_POLL_TIMEOUT="${GROUP_POLL_TIMEOUT}" \
        -e HTTP_REQUEST_TIMEOUT="${HTTP_REQUEST_TIMEOUT}" \
        -e GROUP_MIN_MEMBERS="${GROUP_MIN_MEMBERS}" \
        -e GATEWAY_BASE_URL="${gateway_base_url}" \
        -e GATEWAY_PUBLIC_HOST="${bridge_host}" \
        -e STAGE_NGINX_PORT="${STAGE_NGINX_PORT:-9000}" \
        -e LEADER_CONFIG_FILE=/work/runtime/demo/leader/leader/config.toml \
        -e REGISTRY_ADMIN_USERNAME="${REGISTRY_ADMIN_USERNAME:-admin}" \
        -e REGISTRY_ADMIN_PASSWORD="${REGISTRY_ADMIN_PASSWORD:-admin123}" \
        -e CA_SERVER_ADMIN_API_TOKEN="${CA_SERVER_ADMIN_API_TOKEN:-test-ca-admin-token}" \
        -e AIP_V210_INFRA_CERT_DIR=/work/runtime/stage-infra/certs \
        -v "${package_root}:/work" \
        --entrypoint python3 \
        "${tool_image}" \
        -m "${module}"
}

run_llm_config_check_in_tool_image() {
    local tool_image=""
    local package_root=""

    tool_image="$(resolve_smoke_tool_image 2>/dev/null || true)"
    if [[ -z "${tool_image}" ]]; then
        echo "[smoke-test-business] ERROR: 宿主机 Python 不满足要求，且未找到可用工具镜像执行 LLM 配置检查" >&2
        return 1
    fi

    package_root="$(resolve_smoke_package_root)"
    echo "[smoke-test-business] INFO: 宿主机 Python 不满足要求，切换到工具镜像执行 LLM 配置检查 (${tool_image})" >&2

    docker run --rm -i \
        --user 0:0 \
        --workdir /work/runtime/demo/leader \
        --add-host host.docker.internal:host-gateway \
        --env-file "${BASE_DIR}/.env" \
        -e LEADER_CONFIG_FILE=/work/runtime/demo/leader/leader/config.toml \
        -v "${package_root}:/work" \
        --entrypoint python3 \
        "${tool_image}" \
        - <<'PY'
import os
import pathlib
import sys
import tomllib

config_path = pathlib.Path(os.environ["LEADER_CONFIG_FILE"])
config = tomllib.loads(config_path.read_text(encoding="utf-8"))
llm = config.get("llm") or {}

profiles = [profile for profile in llm.values() if isinstance(profile, dict)]
if not profiles:
    print("missing")
    raise SystemExit(0)

for profile in profiles:
    api_key_env = (profile.get("api_key_env") or "").strip()
    base_url_env = (profile.get("base_url_env") or "").strip()
    model_env = (profile.get("model_env") or "").strip()
    if api_key_env or base_url_env or model_env:
        for env_name in (api_key_env, base_url_env, model_env):
            if not env_name or not os.environ.get(env_name, "").strip():
                print("missing")
                raise SystemExit(0)
        continue

    literal_values = [
        (profile.get("api_key") or "").strip(),
        (profile.get("base_url") or "").strip(),
        (profile.get("model") or "").strip(),
    ]
    if any(not value or value == "OPENAI_API_KEY" for value in literal_values):
        print("missing")
        raise SystemExit(0)

print("ready")
PY
}

run_core_services_smoke_in_tool_image() {
    echo "[smoke-test-business] INFO: 切换到工具镜像执行核心 happy-path 冒烟"
    ACPS_CLI_BIN=/opt/venv/bin/acps-cli run_python_module_in_tool_image smoke.core_services
}

on_exit() {
    local exit_code="$1"
    if [[ "${exit_code}" -ne 0 ]]; then
        echo "[smoke-test-business] WARN: 业务冒烟失败，导出关键运行日志" >&2
        dump_runtime_logs
    fi
}

trap 'on_exit "$?"' EXIT

if host_python_supports_modern_smoke; then
LLM_KEY_STATUS="$(LEADER_CONFIG_FILE="${LEADER_CONFIG_FILE}" python3 - <<'PY'
import os
import pathlib
import sys
import tomllib

config_path = pathlib.Path(os.environ["LEADER_CONFIG_FILE"])
config = tomllib.loads(config_path.read_text())
llm = config.get("llm") or {}

profiles = [profile for profile in llm.values() if isinstance(profile, dict)]
if not profiles:
    print("missing")
    sys.exit(0)

for profile in profiles:
    api_key_env = (profile.get("api_key_env") or "").strip()
    base_url_env = (profile.get("base_url_env") or "").strip()
    model_env = (profile.get("model_env") or "").strip()
    if api_key_env or base_url_env or model_env:
        for env_name in (api_key_env, base_url_env, model_env):
            if not env_name or not os.environ.get(env_name, "").strip():
                print("missing")
                sys.exit(0)
        continue

    literal_values = [
        (profile.get("api_key") or "").strip(),
        (profile.get("base_url") or "").strip(),
        (profile.get("model") or "").strip(),
    ]
    if any(not value or value == "OPENAI_API_KEY" for value in literal_values):
        print("missing")
        sys.exit(0)

print("ready")
PY
)"
else
LLM_KEY_STATUS="$(run_llm_config_check_in_tool_image)"
fi

if [[ "${LLM_KEY_STATUS}" != "ready" ]]; then
  echo "[smoke-test-business] ERROR: leader/config.toml 引用的 LLM 环境变量未准备完成，跳过业务 happy path 测试" >&2
  exit 0
fi

# 封装：带完整环境变量前缀调用 Python 测试
_run_api_tests() {
    if ! host_python_supports_modern_smoke; then
        run_python_module_in_tool_image smoke
        return
    fi

    PYTHONPATH="${BASE_DIR}:${PYTHONPATH:-}" \
    API_BASE_URL="${API_BASE_URL}" \
    RPC_POLL_INTERVAL="${RPC_POLL_INTERVAL}" \
    RPC_POLL_TIMEOUT="${RPC_POLL_TIMEOUT}" \
    TASK_POLL_TIMEOUT="${TASK_POLL_TIMEOUT}" \
    GROUP_POLL_INTERVAL="${GROUP_POLL_INTERVAL}" \
    GROUP_POLL_TIMEOUT="${GROUP_POLL_TIMEOUT}" \
    HTTP_REQUEST_TIMEOUT="${HTTP_REQUEST_TIMEOUT}" \
    GROUP_MIN_MEMBERS="${GROUP_MIN_MEMBERS}" \
    python3 -m smoke
}

_run_core_services_smoke() {
    if ! host_python_supports_modern_smoke || ! have_host_acps_cli; then
        run_core_services_smoke_in_tool_image
        return
    fi

    PYTHONPATH="${BASE_DIR}:${PYTHONPATH:-}" \
    GATEWAY_BASE_URL="${GATEWAY_BASE_URL:-http://${GATEWAY_PUBLIC_HOST:-localhost}:${STAGE_NGINX_PORT:-9000}}" \
    GATEWAY_PUBLIC_HOST="${GATEWAY_PUBLIC_HOST:-localhost}" \
    STAGE_NGINX_PORT="${STAGE_NGINX_PORT:-9000}" \
    REGISTRY_ADMIN_USERNAME="${REGISTRY_ADMIN_USERNAME:-admin}" \
    REGISTRY_ADMIN_PASSWORD="${REGISTRY_ADMIN_PASSWORD:-admin123}" \
    CA_SERVER_ADMIN_API_TOKEN="${CA_SERVER_ADMIN_API_TOKEN:-test-ca-admin-token}" \
    python3 -m smoke.core_services
}

_run_aip_v210_audit() {
    PYTHONPATH="${BASE_DIR}:${PYTHONPATH:-}" \
    LEADER_CONFIG_FILE="${LEADER_CONFIG_FILE}" \
    AIP_V210_INFRA_CERT_DIR="${AIP_V210_INFRA_CERT_DIR}" \
    AIP_V210_AUDIT_OUTPUT="${AIP_V210_AUDIT_OUTPUT}" \
    AIP_V210_LOG_SINCE="${AIP_V210_LOG_SINCE}" \
    python3 -m smoke.aip_v210_audit
}

if [[ "${RUN_CORE_SERVICES_SMOKE}" == "true" ]]; then
    echo "[smoke-test-business] === registry / ca / discovery 核心 happy-path 冒烟 ==="
    _run_core_services_smoke
fi

echo "[smoke-test-business] === 混合静态/动态业务冒烟测试 ==="
_run_api_tests || _dynamic_exit=$?

_dynamic_exit="${_dynamic_exit:-0}"

if [[ "${_dynamic_exit}" -ne 0 ]]; then
    exit "${_dynamic_exit}"
fi

if [[ "${RUN_AIP_V210_AUDIT}" == "true" ]]; then
    echo "[smoke-test-business] === AIP v2.1.0 审计冒烟 ==="
    _run_aip_v210_audit
fi

dump_runtime_logs
echo "[smoke-test-business] OK"
