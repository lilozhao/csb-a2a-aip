#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
CLEAN_DOCKER=false

# shellcheck source=/dev/null
source "${BASE_DIR}/bundle-common.sh"

usage() {
  cat <<'EOF'
用法: bash install.sh [--clean-docker]

选项:
  --clean-docker   先调用 ./cleanup.sh 清理 demo-apps 相关 Docker 资源，再执行首装
                    仅清理 demo-partners / demo-leader / demo-web-nginx、
                    leader-net / partner-net，不会触碰 stage-infra 或 release-app

说明:
  - install.sh 仅用于首装或验证性重装，不用于后续更新。
  - 后续应用更新请使用 ./upgrade.sh。
  - 单独更新证书或 trust bundle 时，请继续使用 ./provision.sh。
  - 如果只需要清理 Docker 资源，请直接执行 ./cleanup.sh。
EOF
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --clean-docker)
        CLEAN_DOCKER=true
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

assert_first_install_target() {
  if container_exists "demo-partners" || container_exists "demo-leader" || container_exists "demo-web-nginx"; then
    err "检测到现有 demo-apps 容器。install.sh 仅用于首装；若要更新应用，请使用 ./upgrade.sh；若要单独维护证书，请使用 ./provision.sh"
    return 1
  fi
}

run_install_flow() {
  log "执行首装前检查"
  validate_bundle_layout
  validate_config_files
  check_stage_infra_health

  if [[ "${CLEAN_DOCKER}" == "true" ]]; then
    log "按 --clean-docker 调用独立 cleanup 逻辑"
    cleanup_demo_docker_resources
  fi

  assert_first_install_target

  log "对齐 partners ACS 容器化 endpoint 与证书 SAN"
  align_partner_runtime_acs

  log "步骤 1/4: 执行 provision.sh setup"
  bash "${PROVISION_SCRIPT}" setup

  log "步骤 2/4: 部署 partners bundle"
  bash "${PARTNERS_DEPLOY_SCRIPT}"

  log "步骤 3/4: 部署 leader bundle"
  bash "${LEADER_DEPLOY_SCRIPT}"

  run_basic_smoke_checks "步骤 4/4"

  log "首装完成。后续若更新应用，请使用 bash ./upgrade.sh；若单独维护证书，请继续使用 bash ./provision.sh"
  log "业务 happy path 如需手动验证，可额外执行: bash ./smoke-test-business.sh"
}

parse_args "$@"
run_install_flow
