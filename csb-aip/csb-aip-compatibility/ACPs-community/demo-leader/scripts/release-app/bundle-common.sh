#!/usr/bin/env bash
# bundle-common.sh — demo-leader 发布包公共函数库
# 由 install.sh / cleanup.sh 等 source

BASE_DIR="${BASE_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PARTNERS_BUNDLE_DIR="${PARTNERS_BUNDLE_DIR:-$(cd "${BASE_DIR}/../partners" 2>/dev/null && pwd || true)}"
LEADER_ENV_FILE="${LEADER_ENV_FILE:-${BASE_DIR}/.env}"
PARTNERS_ENV_FILE="${PARTNERS_ENV_FILE:-${PARTNERS_BUNDLE_DIR:+${PARTNERS_BUNDLE_DIR}/.env}}"
PROVISION_CONF="${PROVISION_CONF:-${BASE_DIR}/provision.conf}"
PROVISION_SCRIPT="${BASE_DIR}/provision.sh"
LEADER_DEPLOY_SCRIPT="${BASE_DIR}/deploy.sh"
PARTNERS_DEPLOY_SCRIPT="${PARTNERS_BUNDLE_DIR:+${PARTNERS_BUNDLE_DIR}/deploy.sh}"
SMOKE_TEST_SCRIPT="${BASE_DIR}/smoke-test.sh"
BUSINESS_SMOKE_TEST_SCRIPT="${BASE_DIR}/smoke-test-business.sh"
RABBITMQ_PORT="${RABBITMQ_PORT:-5671}"

if [[ -d "${BASE_DIR}/lib" ]]; then
  # shellcheck source=/dev/null
  source "${BASE_DIR}/lib/common.sh"
  # shellcheck source=/dev/null
  source "${BASE_DIR}/lib/docker.sh"
elif [[ -d "${BASE_DIR}/../lib" ]]; then
  # shellcheck source=/dev/null
  source "${BASE_DIR}/../lib/common.sh"
  # shellcheck source=/dev/null
  source "${BASE_DIR}/../lib/docker.sh"
else
  echo "缺少脚本依赖目录: lib" >&2
  exit 1
fi

read_conf_value() {
  local conf_file="$1"
  local key="$2"

  [[ -f "${conf_file}" ]] || return 0

  awk -F= -v config_key="${key}" '
    /^[[:space:]]*#/ { next }
    $0 ~ "^[[:space:]]*" config_key "[[:space:]]*=" {
      sub(/^[[:space:]]*[^=]+=[[:space:]]*/, "", $0)
      sub(/[[:space:]]*(#.*)?$/, "", $0)
      print $0
      exit
    }
  ' "${conf_file}"
}

strip_wrapping_quotes() {
  local value="$1"
  if [[ ${#value} -ge 2 ]]; then
    if [[ "${value:0:1}" == '"' && "${value: -1}" == '"' ]]; then
      value="${value:1:${#value}-2}"
    elif [[ "${value:0:1}" == "'" && "${value: -1}" == "'" ]]; then
      value="${value:1:${#value}-2}"
    fi
  fi
  printf '%s\n' "${value}"
}

normalize_host_for_local_checks() {
  local host="$1"
  case "${host}" in
    ""|host.docker.internal|127.0.0.1|::1)
      printf '%s\n' "localhost"
      ;;
    *)
      printf '%s\n' "${host}"
      ;;
  esac
}

check_http_status() {
  local url="$1"
  local expected_status="$2"
  local status

  status="$(curl --silent --show-error --connect-timeout 3 --max-time 10 -o /dev/null -w "%{http_code}" "${url}")"
  if [[ "${status}" != "${expected_status}" ]]; then
    err "共享网关检查失败: ${url} 返回 ${status}，期望 ${expected_status}"
    return 1
  fi
}

derive_gateway_base_url() {
  local registry_api_base_url="$1"
  local gateway_base_url="${registry_api_base_url}"

  gateway_base_url="${gateway_base_url%/registry/api}"
  if [[ "${gateway_base_url}" == "${registry_api_base_url}" ]]; then
    gateway_base_url="${gateway_base_url%/api}"
  fi

  gateway_base_url="${gateway_base_url//host.docker.internal/localhost}"
  printf '%s\n' "${gateway_base_url}"
}

load_bundle_envs() {
  source_env_file "${LEADER_ENV_FILE}"
  [[ -n "${PARTNERS_ENV_FILE:-}" ]] && source_env_file "${PARTNERS_ENV_FILE}"
}

cleanup_demo_docker_resources() {
  log "清理 demo-apps Docker 资源"

  if [[ -n "${PARTNERS_BUNDLE_DIR:-}" && -f "${PARTNERS_BUNDLE_DIR}/compose.yml" ]]; then
    docker compose -f "${PARTNERS_BUNDLE_DIR}/compose.yml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi

  if [[ -f "${BASE_DIR}/compose.yml" ]]; then
    docker compose -f "${BASE_DIR}/compose.yml" down --volumes --remove-orphans >/dev/null 2>&1 || true
  fi

  remove_container_if_exists "demo-partners"
  remove_container_if_exists "demo-leader"
  remove_container_if_exists "demo-web-nginx"

  remove_network_if_exists "partner-net"
  remove_network_if_exists "leader-net"
}

validate_bundle_layout() {
  require_dir_exists "${BASE_DIR}" "leader bundle 根目录"
  require_dir_exists "${BASE_DIR}/leader" "leader"
  require_dir_exists "${BASE_DIR}/web_app" "web_app"
  require_file_exists "${PROVISION_SCRIPT}" "provision.sh"
  require_file_exists "${LEADER_DEPLOY_SCRIPT}" "deploy.sh"
  require_file_exists "${SMOKE_TEST_SCRIPT}" "smoke-test.sh"
  require_file_exists "${BUSINESS_SMOKE_TEST_SCRIPT}" "smoke-test-business.sh"

  [[ -n "${PARTNERS_BUNDLE_DIR:-}" ]] || { err "未发现 sibling partners bundle，请确认目录结构为 ../partners"; return 1; }
  require_dir_exists "${PARTNERS_BUNDLE_DIR}" "partners bundle 根目录"
  require_dir_exists "${PARTNERS_BUNDLE_DIR}/partners/online" "../partners/partners/online"
  require_file_exists "${PARTNERS_DEPLOY_SCRIPT}" "../partners/deploy.sh"
}

validate_config_files() {
  require_file_exists "${LEADER_ENV_FILE}" ".env"
  require_file_exists "${PARTNERS_ENV_FILE:-}" "../partners/.env"
  require_file_exists "${PROVISION_CONF}" "provision.conf"
  require_file_exists "${BASE_DIR}/leader/config.toml" "leader/config.toml"

  load_bundle_envs

  require_toml_env_refs_resolved "${BASE_DIR}/leader/config.toml" "leader/config.toml"

  local partner_config
  local found_config=0
  while IFS= read -r partner_config; do
    [[ -n "${partner_config}" ]] || continue
    found_config=1
    require_toml_env_refs_resolved "${partner_config}" "${partner_config#${PARTNERS_BUNDLE_DIR}/}"
  done < <(find "${PARTNERS_BUNDLE_DIR}/partners/online" -mindepth 2 -maxdepth 2 -name 'config.toml' | sort)

  if [[ ${found_config} -eq 0 ]]; then
    err "../partners/partners/online 下未找到任何 config.toml"
    return 1
  fi
}

check_stage_infra_health() {
  local registry_api_base_url
  local gateway_base_url
  local infra_host

  registry_api_base_url="$(strip_wrapping_quotes "$(read_conf_value "${PROVISION_CONF}" "REGISTRY_API_BASE_URL")")"
  [[ -n "${registry_api_base_url}" ]] || { err "provision.conf 缺少 REGISTRY_API_BASE_URL"; return 1; }

  gateway_base_url="$(derive_gateway_base_url "${registry_api_base_url}")"
  infra_host="$(normalize_host_for_local_checks "${INFRA_HOST:-localhost}")"

  log "检查 acps-infra 共享网关: ${gateway_base_url}"
  check_http_status "${gateway_base_url}" "404"

  log "检查 RabbitMQ 端口: ${infra_host}:${RABBITMQ_PORT}"
  check_tcp_endpoint "${infra_host}" "${RABBITMQ_PORT}" "RabbitMQ"
}

align_partner_runtime_acs() {
  local partner_endpoint_host="${PARTNER_ENDPOINT_HOST:-host.docker.internal}"
  local rabbitmq_port="${RABBITMQ_PORT:-5671}"
  local acs_file
  local rewrite_result
  local changed_any=false

  while IFS= read -r acs_file; do
    [[ -n "${acs_file}" ]] || continue

    rewrite_result="$(/usr/bin/python3 - "${acs_file}" "${partner_endpoint_host}" "${rabbitmq_port}" <<'PY'
import json
import re
import sys
from pathlib import Path

path = Path(sys.argv[1])
partner_host = sys.argv[2]
rabbitmq_port = sys.argv[3]

data = json.loads(path.read_text(encoding="utf-8"))
changed = False

for endpoint in data.get("endPoints", []):
    url = endpoint.get("url")
    if not isinstance(url, str):
        continue

    new_url = re.sub(
        r"^https://localhost:(\d+)(/.*)?$",
        lambda match: f"https://{partner_host}:{match.group(1)}{match.group(2) or ''}",
        url,
    )
    if new_url == url:
        new_url = re.sub(
            r"^amqps://localhost:\d+(/.*)?$",
            lambda match: f"amqps://{partner_host}:{rabbitmq_port}{match.group(1) or ''}",
            url,
        )

    if new_url != url:
        endpoint["url"] = new_url
        changed = True

certificate = data.setdefault("certificate", {})
alt_names = certificate.setdefault("altNames", {})
dns_names = alt_names.get("dns")
if dns_names is None:
    alt_names["dns"] = [partner_host]
    changed = True
elif isinstance(dns_names, list) and partner_host not in dns_names:
    dns_names.append(partner_host)
    changed = True

if changed:
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print("changed")
PY
    )"

    if [[ "${rewrite_result}" == "changed" ]]; then
      changed_any=true
      log "已对齐 partner ACS 容器化 endpoint: ${acs_file#${PARTNERS_BUNDLE_DIR}/}"
    fi
  done < <(find "${PARTNERS_BUNDLE_DIR}/partners/online" -mindepth 2 -maxdepth 2 -name 'acs.json' | sort)

  if [[ "${changed_any}" != "true" ]]; then
    log "partner ACS 已符合容器化部署要求，无需额外对齐"
  fi
}

resolve_partner_smoke_target() {
  local partner_dir
  local partner_port

  partner_dir="$(find "${PARTNERS_BUNDLE_DIR}/partners/online" -mindepth 1 -maxdepth 1 -type d | sort | head -n 1)"
  [[ -n "${partner_dir}" ]] || { err "未找到可用于 mTLS 冒烟的在线 partner"; return 1; }

  partner_port="$(awk '$1 == "port" { print $3; exit }' "${partner_dir}/config.toml")"
  [[ -n "${partner_port}" ]] || partner_port="9021"

  printf '%s|%s\n' "${partner_dir}" "https://localhost:${partner_port}/health"
}

run_basic_smoke_checks() {
  local step_label="$1"
  local partner_smoke_cert_dir
  local partner_smoke_url
  local leader_cert_rel
  local leader_key_rel
  local leader_ca_rel

  IFS='|' read -r partner_smoke_cert_dir partner_smoke_url < <(resolve_partner_smoke_target)
  leader_cert_rel="$(extract_toml_string_value "cert_file" "${BASE_DIR}/leader/config.toml")"
  leader_key_rel="$(extract_toml_string_value "key_file" "${BASE_DIR}/leader/config.toml")"
  leader_ca_rel="$(extract_toml_string_value "ca_file" "${BASE_DIR}/leader/config.toml")"

  log "${step_label}: 执行基础冒烟"
  bash "${SMOKE_TEST_SCRIPT}"

  log "${step_label}: 执行 partner mTLS 冒烟 (${partner_smoke_url})"
  PARTNER_HEALTH_CLIENT_CERT="${BASE_DIR}/leader/${leader_cert_rel}" \
  PARTNER_HEALTH_CLIENT_KEY="${BASE_DIR}/leader/${leader_key_rel}" \
  PARTNER_HEALTH_CA_FILE="${BASE_DIR}/leader/${leader_ca_rel}" \
  PARTNER_HEALTH_URL="${partner_smoke_url}" \
  bash "${SMOKE_TEST_SCRIPT}"
}
