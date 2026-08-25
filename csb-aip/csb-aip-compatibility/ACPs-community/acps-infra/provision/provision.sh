#!/usr/bin/env bash
# provision.sh — demo-apps Provision 配置工具（thin shell，委托给 Python 包执行）
# 用法: ./provision.sh [--conf PATH] <command> [args]
#
# 优先在宿主机 Python 虚拟环境下执行 python -m provision_tools；
# 若宿主机缺少必要条件，自动回退到工具镜像（docker run）执行。
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CONTAINER_MODE="${CONTAINER_MODE:-false}"
CA_WORK_DIR="${CA_WORK_DIR:-}"
LEADER_DIR="${LEADER_DIR:-}"
PARTNERS_DIR="${PARTNERS_DIR:-}"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log_info()  { echo -e "${GREEN}[INFO]${NC}  $*"; }
log_warn()  { echo -e "${YELLOW}[WARN]${NC}  $*" >&2; }
log_error() { echo -e "${RED}[ERROR]${NC} $*" >&2; }

_ENV_CLEANUP_KEYS=(
  REGISTRY_API_BASE_URL
  REGISTRY_SERVER_BASE_URL
  REGISTRY_ATR_BASE_URL
  REGISTRY_TIMEOUT_SECONDS
  REGISTRY_TOKEN_FILE
  REGISTRY_CLIENT_USERNAME
  REGISTRY_CLIENT_PASSWORD
  REGISTRY_ADMIN_USERNAME
  REGISTRY_ADMIN_PASSWORD
)

build_clean_env_args() {
  CLEAN_ENV_ARGS=()
  local key
  for key in "${_ENV_CLEANUP_KEYS[@]}"; do
    CLEAN_ENV_ARGS+=("-u" "$key")
  done
}

_resolve_default_provision_conf() {
  local candidate
  for candidate in \
    "${SCRIPT_DIR}/provision.conf" \
    "${SCRIPT_DIR}/../leader/provision.conf"; do
    if [[ -f "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  printf '%s\n' "${SCRIPT_DIR}/provision.conf"
}

PROVISION_CONF="${PROVISION_CONF:-$(_resolve_default_provision_conf)}"

# ─── 目录自动推断 ─────────────────────────────────────────────────────────────

_resolve_default_leader_dir() {
  local candidate
  for candidate in \
    "${SCRIPT_DIR}/leader" \
    "${SCRIPT_DIR}/../../demo-leader/leader" \
    "${SCRIPT_DIR}/../../demo-leader" \
    "${SCRIPT_DIR}/../leader/leader" \
    "${SCRIPT_DIR}/../leader"; do
    if [[ -d "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  printf '%s\n' "${SCRIPT_DIR}/leader"
}

_resolve_default_partners_dir() {
  local candidate
  for candidate in \
    "${SCRIPT_DIR}/partners/online" \
    "${SCRIPT_DIR}/../../demo-partner/partners/online" \
    "${SCRIPT_DIR}/../partners/partners/online" \
    "${SCRIPT_DIR}/../partners/online"; do
    if [[ -d "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  printf '%s\n' "${SCRIPT_DIR}/partners/online"
}

[[ -n "${LEADER_DIR}" ]]   || LEADER_DIR="$(_resolve_default_leader_dir)"
[[ -n "${PARTNERS_DIR}" ]] || PARTNERS_DIR="$(_resolve_default_partners_dir)"

if [[ -z "${CA_WORK_DIR}" ]]; then
  CA_WORK_DIR="${SCRIPT_DIR}/.ca-data"
fi

# ─── Python 解析 ─────────────────────────────────────────────────────────────

resolve_python_bin() {
  local candidate
  for candidate in \
    "${PROVISION_PYTHON:-}" \
    "${SCRIPT_DIR}/.venv/bin/python" \
    "${SCRIPT_DIR}/venv/bin/python" \
    "/opt/venv/bin/python"; do
    if [[ -n "${candidate}" && -x "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  if command -v python3 >/dev/null 2>&1; then
    command -v python3
    return 0
  fi
  if command -v python >/dev/null 2>&1; then
    command -v python
    return 0
  fi
  return 1
}

provision_tools_importable() {
  local py_bin="$1"
  PYTHONPATH="${SCRIPT_DIR}:${PYTHONPATH:-}" \
    "${py_bin}" -c "import provision_tools" >/dev/null 2>&1
}

resolve_cli_bin() {
  local explicit_var_name="$1"
  local default_bin_name="$2"
  local explicit_bin="${!explicit_var_name:-}"

  if [[ -n "${explicit_bin}" ]]; then
    if command -v "${explicit_bin}" >/dev/null 2>&1; then
      return 0
    fi
    if [[ -x "${explicit_bin}" ]]; then
      return 0
    fi
  fi

  command -v "${default_bin_name}" >/dev/null 2>&1
}

required_host_tools_available() {
  local command_name=""

  while [[ $# -gt 0 ]]; do
    case "$1" in
      --conf)
        shift 2
        continue
        ;;
      -*)
        shift
        continue
        ;;
      *)
        command_name="$1"
        break
        ;;
    esac
  done

  case "${command_name}" in
    setup)
      resolve_cli_bin ACPS_CLI acps-cli || return 1
      ;;
    register|clean)
      resolve_cli_bin ACPS_CLI acps-cli || return 1
      ;;
    certs|new|renew|trust-bundle)
      resolve_cli_bin ACPS_CLI acps-cli || return 1
      ;;
  esac

  return 0
}

# ─── 容器委托 ─────────────────────────────────────────────────────────────────

can_delegate_to_container() {
  [[ "${CONTAINER_MODE}" != "true" ]] || return 1
  command -v docker >/dev/null 2>&1    || return 1
  docker version >/dev/null 2>&1       || return 1
  return 0
}

resolve_root_images_tar() {
  local candidate
  for candidate in \
    "${SCRIPT_DIR}/images.tar.gz" \
    "${SCRIPT_DIR}/../images.tar.gz"; do
    if [[ -f "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

resolve_tool_runner_image() {
  local candidate
  for candidate in \
    "${TOOL_RUNNER_IMAGE:-}" \
    "demo-leader:latest" \
    "acps-demo-leader:latest" \
    "acps-demo-partners:latest"; do
    [[ -n "${candidate}" ]] || continue
    if docker image inspect "${candidate}" >/dev/null 2>&1; then
      printf '%s\n' "${candidate}"
      return 0
    fi
  done
  return 1
}

ensure_tool_runner_image_loaded() {
  local images_tar
  images_tar="$(resolve_root_images_tar 2>/dev/null || true)"
  [[ -n "${images_tar}" ]] || return 0
  log_info "检测到 bundle 镜像包，先导入当前包内镜像以支持工具镜像回退执行"
  if ! docker load < "${images_tar}" >/dev/null; then
    log_error "导入 bundle 镜像失败: ${images_tar}"
    return 1
  fi
  return 0
}

resolve_local_ca_chain_path() {
  local explicit="${ACPS_CA_CHAIN_PATH:-${CA_CHAIN_PATH:-}}"
  local current=""
  local candidate=""

  if [[ -n "${explicit}" && -f "${explicit}" ]]; then
    printf '%s\n' "${explicit}"
    return 0
  fi

  current="$(cd "${SCRIPT_DIR}" && pwd)"
  while true; do
    candidate="${current}/ca-server/certs/ca-chain.pem"
    if [[ -f "${candidate}" ]]; then
      printf '%s\n' "${candidate}"
      return 0
    fi
    if [[ "${current}" == "/" ]]; then
      break
    fi
    current="$(dirname "${current}")"
  done

  return 1
}

delegate_to_container() {
  local tool_image
  local ca_chain_host_path=""
  local -a ca_chain_mount_args=()

  log_info "当前宿主机缺少运行条件，切换到工具镜像执行"

  tool_image="$(resolve_tool_runner_image 2>/dev/null || true)"
  if [[ -z "${tool_image}" ]]; then
    ensure_tool_runner_image_loaded || return 1
    tool_image="$(resolve_tool_runner_image 2>/dev/null || true)"
  fi

  if [[ -z "${tool_image}" ]]; then
    log_error "未找到可用工具镜像。请先加载 images.tar.gz 或设置 TOOL_RUNNER_IMAGE"
    return 1
  fi

  ca_chain_host_path="$(resolve_local_ca_chain_path 2>/dev/null || true)"
  if [[ -n "${ca_chain_host_path}" ]]; then
    ca_chain_mount_args=(
      -e ACPS_CA_CHAIN_PATH=/app/ca-chain.pem
      -v "${ca_chain_host_path}:/app/ca-chain.pem:ro"
    )
  fi

  docker run --rm \
    --user 0:0 \
    --workdir /app \
    --add-host host.docker.internal:host-gateway \
    -e CONTAINER_MODE=true \
    -e LEADER_DIR=/app/leader \
    -e PARTNERS_DIR=/app/partners/online \
    -e PROVISION_CONF=/app/provision.conf \
    -e CA_WORK_DIR=/app/ca-data \
    -e PYTHONPATH=/app \
    "${ca_chain_mount_args[@]}" \
    -v "${SCRIPT_DIR}/provision_tools:/app/provision_tools:ro" \
    -v "${SCRIPT_DIR}/smoke:/app/smoke:ro" \
    -v "${PROVISION_CONF}:/app/provision.conf:ro" \
    -v "${LEADER_DIR}/atr:/app/leader/atr" \
    -v "${PARTNERS_DIR}:/app/partners/online" \
    -v "${CA_WORK_DIR}:/app/ca-data" \
    "${tool_image}" \
    python3 -m provision_tools "$@"
}

# ─── 主执行 ───────────────────────────────────────────────────────────────────

PYTHON_BIN=""
if PYTHON_BIN="$(resolve_python_bin 2>/dev/null)"; then
  if provision_tools_importable "${PYTHON_BIN}" && required_host_tools_available "$@"; then
    export PROVISION_CONF
    export CA_WORK_DIR
    export LEADER_DIR
    export PARTNERS_DIR
    build_clean_env_args
    exec env "${CLEAN_ENV_ARGS[@]}" PYTHONPATH="${SCRIPT_DIR}:${PYTHONPATH:-}" \
      "${PYTHON_BIN}" -m provision_tools "$@"
  fi
fi

if can_delegate_to_container; then
  delegate_to_container "$@"
  exit $?
fi

# 两种路径均不可用
if [[ -z "${PYTHON_BIN}" ]]; then
  log_error "未找到 Python 解释器。请安装 Python 3.9+ 或确保 Docker 可用"
elif ! provision_tools_importable "${PYTHON_BIN}"; then
  log_error "provision_tools 包不可导入（PYTHONPATH=${SCRIPT_DIR}）。请检查 provision/provision_tools/ 目录是否存在"
else
  log_error "宿主机缺少当前命令所需的 CLI 依赖，且未能回退到工具镜像执行"
fi
log_error "亦未能回退到工具镜像：Docker 不可用或未找到镜像"
exit 1
