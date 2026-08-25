#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=/dev/null
source "${BASE_DIR}/install.sh"

ACTIVE_INSTALL_ROOT=""
CURRENT_RUNTIME_ROOT=""
RELEASES_DIR=""
CURRENT_LINK=""
STAGED_INSTALL_ROOT=""

upgrade_usage() {
    cat <<'EOF'
用法:
  bash upgrade.sh

说明:
- `upgrade.sh` 用于 same-host standalone 升级。
- 升级会先在 staged release 目录准备新版本配置，再对既有 compose project 执行原地升级与健康检查。
- 当前版本不再提供 standalone 自动回退或手动回退入口；升级失败后保留现场，等待人工处理。

环境变量:
- INSTALL_ROOT: 逻辑 runtime 入口，默认 `./runtime`
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    upgrade_usage
    exit 0
fi

resolve_runtime_layout() {
    ACTIVE_INSTALL_ROOT="$(resolve_path "${INSTALL_ROOT:-./runtime}")"
    RELEASES_DIR="${ACTIVE_INSTALL_ROOT}.releases"
    CURRENT_LINK="${ACTIVE_INSTALL_ROOT}.current"
    STAGED_INSTALL_ROOT="${RELEASES_DIR}/${BUNDLE_VERSION}"
}

resolve_current_runtime_root() {
    if [[ -L "${CURRENT_LINK}" ]]; then
        CURRENT_RUNTIME_ROOT="$(readlink "${CURRENT_LINK}")"
    elif [[ -L "${ACTIVE_INSTALL_ROOT}" ]]; then
        CURRENT_RUNTIME_ROOT="$(readlink "${ACTIVE_INSTALL_ROOT}")"
    elif [[ -d "${ACTIVE_INSTALL_ROOT}" ]]; then
        CURRENT_RUNTIME_ROOT="${ACTIVE_INSTALL_ROOT}"
    else
        err "未找到可升级的当前 runtime: ${ACTIVE_INSTALL_ROOT}"
        exit 1
    fi

    require_dir_exists "${CURRENT_RUNTIME_ROOT}" "当前 active runtime"
}

read_runtime_version() {
    local runtime_root="$1"
    local version_file="${runtime_root}/stage-infra/VERSION"
    local runtime_version=""

    runtime_version="$(read_bundle_version_value "${version_file}" version 2>/dev/null || true)"
    printf '%s\n' "${runtime_version:-unknown}"
}

prepare_staged_runtime() {
    mkdir -p "${RELEASES_DIR}"

    if [[ "${CURRENT_RUNTIME_ROOT}" == "${STAGED_INSTALL_ROOT}" ]]; then
        err "当前 active runtime 已是版本 ${BUNDLE_VERSION}，拒绝覆盖自身升级"
        exit 1
    fi

    rm -rf "${STAGED_INSTALL_ROOT}"
    INSTALL_ROOT="${STAGED_INSTALL_ROOT}"
    validate_inputs
    INSTALL_ROOT="${STAGED_INSTALL_ROOT}"
    prepare_common_paths
    prepare_bundle_layout
    prepare_runtime_configs
}

run_deploy_flow_for_runtime() {
    local runtime_root="$1"
    local deploy_demo_apps="$2"
    local run_business_smoke_flag="$3"
    local rc=0

    INSTALL_ROOT="${runtime_root}"
    DEPLOY_DEMO_APPS="${deploy_demo_apps}"
    RUN_BUSINESS_SMOKE="${run_business_smoke_flag}"
    STANDALONE_DEMO_REDEPLOY="${deploy_demo_apps}"
    initialize_env_defaults
    prepare_common_paths

    set +e
    deploy_standalone
    rc=$?
    if [[ ${rc} -eq 0 ]]; then
        run_core_health_checks
        rc=$?
    fi
    if [[ ${rc} -eq 0 && "${deploy_demo_apps}" == "true" && "${run_business_smoke_flag}" == "true" ]]; then
        run_business_smoke
        rc=$?
    fi
    set -e

    return ${rc}
}

archive_current_runtime_if_needed() {
    local current_root="$1"
    local archived_root="${current_root}"
    local current_version=""

    if [[ "${current_root}" == "${ACTIVE_INSTALL_ROOT}" && ! -L "${ACTIVE_INSTALL_ROOT}" ]]; then
        current_version="$(read_runtime_version "${current_root}")"
        archived_root="${RELEASES_DIR}/${current_version}"
        if [[ "${archived_root}" == "${STAGED_INSTALL_ROOT}" || -e "${archived_root}" ]]; then
            archived_root="${RELEASES_DIR}/${current_version}-$(date +%Y%m%d%H%M%S)"
        fi
        mv "${ACTIVE_INSTALL_ROOT}" "${archived_root}"
    fi
}

update_runtime_links() {
    local current_root="$1"
    local previous_link="${ACTIVE_INSTALL_ROOT}.previous"

    if [[ -L "${ACTIVE_INSTALL_ROOT}" ]]; then
        rm -f "${ACTIVE_INSTALL_ROOT}"
    fi
    if [[ -e "${ACTIVE_INSTALL_ROOT}" ]]; then
        err "无法切换 active runtime，路径仍被占用: ${ACTIVE_INSTALL_ROOT}"
        exit 1
    fi

    rm -f "${CURRENT_LINK}" "${previous_link}"
    ln -s "${current_root}" "${ACTIVE_INSTALL_ROOT}"
    ln -s "${current_root}" "${CURRENT_LINK}"
}

perform_upgrade() {
    local deploy_demo_apps="false"
    local run_smoke="false"

    if should_deploy_demo_apps; then
        deploy_demo_apps="true"
    fi
    if is_true "${RUN_BUSINESS_SMOKE:-true}"; then
        run_smoke="true"
    fi

    log "准备 staged release 目录: ${STAGED_INSTALL_ROOT}"
    prepare_staged_runtime

    log "开始执行原地升级部署: ${STAGED_INSTALL_ROOT}"
    if run_deploy_flow_for_runtime "${STAGED_INSTALL_ROOT}" "${deploy_demo_apps}" "${run_smoke}"; then
        archive_current_runtime_if_needed "${CURRENT_RUNTIME_ROOT}"
        update_runtime_links "${STAGED_INSTALL_ROOT}"
        log "升级完成：${CURRENT_RUNTIME_ROOT} -> ${STAGED_INSTALL_ROOT}"
        return 0
    fi

    err "升级失败，未切换 runtime 指针；staged release 保留在 ${STAGED_INSTALL_ROOT}，请人工检查当前容器状态和新 release 内容"
    exit 1
}

main() {
    if [[ $# -gt 0 ]]; then
        err "不支持的参数: $*"
        upgrade_usage >&2
        exit 1
    fi

    require_command readlink
    load_version
    source_env_file "${ENV_FILE}"
    resolve_runtime_layout
    resolve_current_runtime_root

    perform_upgrade
}

main "$@"