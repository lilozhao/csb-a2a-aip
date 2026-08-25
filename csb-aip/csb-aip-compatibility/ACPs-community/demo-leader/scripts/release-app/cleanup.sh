#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

# shellcheck source=/dev/null
source "${BASE_DIR}/bundle-common.sh"

usage() {
  cat <<'EOF'
用法: bash cleanup.sh

说明:
  - 仅清理 demo-apps 自身的 Docker 资源：
    demo-partners / demo-leader / demo-web-nginx、partner-net / leader-net
  - 不会触碰 stage-infra 或 registry-server / ca-server / discovery-server
EOF
}

if [[ $# -gt 0 ]]; then
  case "$1" in
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
fi

cleanup_demo_docker_resources
log "demo-apps Docker 资源清理完成"
