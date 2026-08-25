#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
STATIC_ACS_COPIES_SYNCED=false
SKIP_SIBLING_LEADER_RELOAD="${DEMO_SKIP_SIBLING_LEADER_RELOAD:-false}"

skip_sibling_leader_reload() {
  [[ "${SKIP_SIBLING_LEADER_RELOAD}" == "1" || "${SKIP_SIBLING_LEADER_RELOAD}" == "true" ]]
}

partners_bundle_needs_reload() {
  container_exists "demo-partners"
}

resolve_provision_script() {
  local candidate
  for candidate in \
    "${BASE_DIR}/provision.sh" \
    "${BASE_DIR}/../leader/provision.sh"; do
    if [[ -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

resolve_provision_conf() {
  local candidate
  for candidate in \
    "${BASE_DIR}/provision.conf" \
    "${BASE_DIR}/../leader/provision.conf"; do
    if [[ -f "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

sync_partner_acs_metadata() {
  local provision_script=""
  local provision_conf=""
  local agent_names=()
  local agent_dir=""

  provision_script="$(resolve_provision_script || true)"
  provision_conf="$(resolve_provision_conf || true)"

  if [[ -z "${provision_script}" || -z "${provision_conf}" ]]; then
    log "未找到可用的 provision 脚本或配置，跳过 ACS metadata 对齐"
    return 0
  fi

  while IFS= read -r agent_dir; do
    [[ -n "${agent_dir}" ]] || continue
    agent_names+=("$(basename "${agent_dir}")")
  done < <(find "${BASE_DIR}/partners/online" -mindepth 1 -maxdepth 1 -type d | sort)

  if [[ ${#agent_names[@]} -eq 0 ]]; then
    log "partners/online 下未发现任何 agent 目录，跳过 ACS metadata 对齐"
    return 0
  fi

  log "检测到现有 partners 部署，先同步本地 ACS metadata 与 registry"
  PROVISION_CONF="${provision_conf}" bash "${provision_script}" register "${agent_names[@]}"
}

sync_static_acs_copies() {
  local scenario_root="${BASE_DIR}/../leader/leader/scenario"
  local agent_dir=""
  local agent_name=""
  local runtime_acs=""
  local static_copy=""
  local synced_any=false

  if [[ ! -d "${scenario_root}" ]]; then
    log "未找到 sibling leader scenario 目录，跳过静态 ACS 副本同步"
    return 0
  fi

  while IFS= read -r agent_dir; do
    [[ -n "${agent_dir}" ]] || continue
    agent_name="$(basename "${agent_dir}")"
    runtime_acs="${agent_dir}/acs.json"
    [[ -f "${runtime_acs}" ]] || continue

    while IFS= read -r static_copy; do
      [[ -n "${static_copy}" ]] || continue
      if cmp -s "${runtime_acs}" "${static_copy}"; then
        continue
      fi
      cp "${runtime_acs}" "${static_copy}"
      synced_any=true
      STATIC_ACS_COPIES_SYNCED=true
      log "已同步静态 ACS 副本: ${static_copy}"
    done < <(find "${scenario_root}" -type f -name "${agent_name}.json" | sort)
  done < <(find "${BASE_DIR}/partners/online" -mindepth 1 -maxdepth 1 -type d | sort)

  if [[ "${synced_any}" != "true" ]]; then
    log "未发现需要同步的静态 ACS 副本"
  fi
}

refresh_sibling_leader_bundle() {
  local leader_deploy_script="${BASE_DIR}/../leader/deploy.sh"

  if [[ "${STATIC_ACS_COPIES_SYNCED}" != "true" ]]; then
    return 0
  fi

  if skip_sibling_leader_reload; then
    log "检测到静态 ACS 副本已更新，但当前流程会在后续步骤统一重建 leader，跳过中间 leader 重载"
    return 0
  fi

  if [[ ! -x "${leader_deploy_script}" ]]; then
    log "未找到 sibling leader deploy.sh，跳过 leader 重载"
    return 0
  fi

  if ! container_exists "demo-leader"; then
    log "未检测到 demo-leader 容器，跳过 leader 重载"
    return 0
  fi

  log "检测到静态 ACS 副本已更新，重新加载 sibling leader bundle 以刷新内存缓存"
  bash "${leader_deploy_script}" --force-recreate
}

validate_partner_bundle() {
  require_file_exists "${BASE_DIR}/.env" ".env"
  require_file_exists "${BASE_DIR}/compose.yml" "compose.yml"
  require_dir_exists "${BASE_DIR}/partners/online" "partners/online"

  local config_file
  while IFS= read -r config_file; do
    [[ -n "${config_file}" ]] || continue

    assert_file_not_contains \
      "${config_file}" \
      '^[[:space:]]*(api_key|base_url|model)[[:space:]]*=' \
      "${config_file#${BASE_DIR}/}"
    require_toml_env_refs_resolved "${config_file}" "${config_file#${BASE_DIR}/}"

    local agent_dir
    local cert_rel
    local key_rel
    local ca_rel
    agent_dir="$(dirname "${config_file}")"
    cert_rel="$(extract_toml_string_value "cert_file" "${config_file}")"
    key_rel="$(extract_toml_string_value "key_file" "${config_file}")"
    ca_rel="$(extract_toml_string_value "ca_file" "${config_file}")"

    [[ -n "${cert_rel}" ]] || { err "${config_file#${BASE_DIR}/} 缺少 mtls.cert_file"; return 1; }
    [[ -n "${key_rel}" ]] || { err "${config_file#${BASE_DIR}/} 缺少 mtls.key_file"; return 1; }
    [[ -n "${ca_rel}" ]] || { err "${config_file#${BASE_DIR}/} 缺少 mtls.ca_file"; return 1; }

    require_file_exists "${agent_dir}/${cert_rel}" "${cert_rel}"
    require_file_exists "${agent_dir}/${key_rel}" "${key_rel}"
    require_file_exists "${agent_dir}/${ca_rel}" "${ca_rel}"
  done < <(find "${BASE_DIR}/partners/online" -mindepth 2 -maxdepth 2 -name 'config.toml' | sort)
}

if [[ -d "${BASE_DIR}/lib" ]]; then
  # shellcheck source=/dev/null
  source "${BASE_DIR}/lib/common.sh"
  # shellcheck source=/dev/null
  source "${BASE_DIR}/lib/docker.sh"
  # shellcheck source=/dev/null
  source "${BASE_DIR}/lib/certs-permissions-lib.sh"
elif [[ -d "${BASE_DIR}/../lib" ]]; then
  # shellcheck source=/dev/null
  source "${BASE_DIR}/../lib/common.sh"
  # shellcheck source=/dev/null
  source "${BASE_DIR}/../lib/docker.sh"
  # shellcheck source=/dev/null
  source "${BASE_DIR}/../lib/certs-permissions-lib.sh"
else
  echo "缺少脚本依赖目录: lib" >&2
  exit 1
fi

source_env_file "${BASE_DIR}/.env"
validate_partner_bundle

while IFS= read -r agent_dir; do
  [[ -n "${agent_dir}" ]] || continue
  normalize_bind_mount_certs_dir "${agent_dir}" 1000 1000
done < <(find "${BASE_DIR}/partners/online" -mindepth 1 -maxdepth 1 -type d | sort)

if [[ -f "${BASE_DIR}/images.tar.gz" ]]; then
  load_images "${BASE_DIR}/images.tar.gz"
fi

compose_args=(-f "${BASE_DIR}/compose.yml" up -d)
if partners_bundle_needs_reload; then
  sync_partner_acs_metadata
  log "检测到已部署的 partners bundle，使用 --force-recreate 重新加载 bind mount 中的配置、AIC 和证书"
  compose_args+=(--force-recreate)
fi

sync_static_acs_copies

compose_up_detached "${compose_args[@]}"
wait_healthy "partners" "${BASE_DIR}/compose.yml" 90 3
refresh_sibling_leader_bundle

echo "partners 发布完成。请确认以下目录已准备："
echo "  ${BASE_DIR}/partners"
