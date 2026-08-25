#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
FORCE_RECREATE=false

usage() {
  cat <<'EOF'
用法: bash deploy.sh [--force-recreate]

选项:
  --force-recreate  强制重建 leader 与 web-nginx 容器
EOF
}

leader_bundle_needs_reload() {
  if [[ "${FORCE_RECREATE}" == "true" ]]; then
    return 0
  fi

  container_exists "demo-leader" || container_exists "demo-web-nginx"
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --force-recreate)
        FORCE_RECREATE=true
        shift
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        err "未知参数: $1"
        usage
        exit 1
        ;;
    esac
  done
}

validate_leader_bundle() {
  require_file_exists "${BASE_DIR}/.env" ".env"
  require_file_exists "${BASE_DIR}/compose.yml" "compose.yml"
  require_file_exists "${BASE_DIR}/leader/config.toml" "leader/config.toml"
  require_file_exists "${BASE_DIR}/nginx/default.conf" "nginx/default.conf"
  require_dir_exists "${BASE_DIR}/leader/atr" "leader/atr"
  require_dir_exists "${BASE_DIR}/leader/scenario" "leader/scenario"
  require_dir_exists "${BASE_DIR}/web_app" "web_app"

  assert_file_not_contains \
    "${BASE_DIR}/leader/config.toml" \
    '^[[:space:]]*(api_key|base_url|model)[[:space:]]*=' \
    "leader/config.toml"
  require_toml_env_refs_resolved "${BASE_DIR}/leader/config.toml" "leader/config.toml"

  local cert_rel
  local key_rel
  local ca_rel
  cert_rel="$(extract_toml_string_value "cert_file" "${BASE_DIR}/leader/config.toml")"
  key_rel="$(extract_toml_string_value "key_file" "${BASE_DIR}/leader/config.toml")"
  ca_rel="$(extract_toml_string_value "ca_file" "${BASE_DIR}/leader/config.toml")"

  [[ -n "${cert_rel}" ]] || { err "leader/config.toml 缺少 mtls.cert_file"; return 1; }
  [[ -n "${key_rel}" ]] || { err "leader/config.toml 缺少 mtls.key_file"; return 1; }
  [[ -n "${ca_rel}" ]] || { err "leader/config.toml 缺少 mtls.ca_file"; return 1; }

  require_file_exists "${BASE_DIR}/leader/${cert_rel}" "leader/${cert_rel}"
  require_file_exists "${BASE_DIR}/leader/${key_rel}" "leader/${key_rel}"
  require_file_exists "${BASE_DIR}/leader/${ca_rel}" "leader/${ca_rel}"

  if grep -R 'https://localhost:' "${BASE_DIR}/leader/scenario" >/dev/null 2>&1; then
    err "leader/scenario 中仍包含 localhost endpoint，容器化部署下不可用"
    return 1
  fi
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
parse_args "$@"
validate_leader_bundle
normalize_bind_mount_certs_dir "${BASE_DIR}/leader/atr" 1000 1000

if [[ -f "${BASE_DIR}/images.tar.gz" ]]; then
  load_images "${BASE_DIR}/images.tar.gz"
fi

compose_args=(-f "${BASE_DIR}/compose.yml" up -d)
if leader_bundle_needs_reload; then
  log "检测到已部署的 demo-leader bundle，使用 --force-recreate 重新加载 bind mount 中的配置和证书"
  compose_args+=(--force-recreate)
fi

compose_up_detached "${compose_args[@]}" leader web-nginx
wait_healthy "leader" "${BASE_DIR}/compose.yml" 90 3
wait_healthy "web-nginx" "${BASE_DIR}/compose.yml" 90 3

echo "demo-leader 发布完成。请确认以下目录已准备："
echo "  ${BASE_DIR}/leader"
echo "  ${BASE_DIR}/web_app"
