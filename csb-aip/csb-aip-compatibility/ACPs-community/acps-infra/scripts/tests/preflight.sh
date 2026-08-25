#!/usr/bin/env bash
# preflight.sh — 打包前置门禁
# 在 scripts/release-standalone/build.sh 入口处 source 并调用 run_preflight
set -euo pipefail

_PREFLIGHT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORKSPACE_DIR="$(cd "${_PREFLIGHT_DIR}/../../.." && pwd)"

# 源头 lib 路径
LIB_SOURCE_DIR="${_PREFLIGHT_DIR}/../lib"

# 预期存在的 sibling 项目
REQUIRED_PROJECTS=(
    registry-server
    ca-server
    discovery-server
    mq-auth-server
    demo-leader
    demo-partner
    acps-cli
    acps-sdk
)

# 需要 Dockerfile 的项目
PROJECTS_WITH_DOCKERFILE=(
    registry-server
    ca-server
    discovery-server
    mq-auth-server
    demo-leader
    demo-partner
)

# 需要 scripts/release-app/ 的项目
PROJECTS_WITH_RELEASE_APP=(
    registry-server
    ca-server
    discovery-server
    mq-auth-server
    demo-leader
    demo-partner
)

# 打包流程实际依赖的 scripts/lib 文件及其预期来源。
# 格式: "项目名:文件1,文件2,..."
SHARED_LIB_EXPECTATIONS=(
    "registry-server:build.sh,common.sh,docker.sh,platform.sh,blue-green.sh,shared-lib-contracts-lib.sh,certs-permissions-lib.sh"
    "ca-server:build.sh,common.sh,docker.sh,platform.sh,blue-green.sh,zero-downtime-check-lib.sh,shared-lib-contracts-lib.sh,certs-permissions-lib.sh"
    "discovery-server:build.sh,common.sh,docker.sh,platform.sh,blue-green.sh,shared-lib-contracts-lib.sh,certs-permissions-lib.sh"
    "mq-auth-server:build.sh,common.sh,docker.sh,platform.sh,blue-green.sh,zero-downtime-check-lib.sh,shared-lib-contracts-lib.sh,certs-permissions-lib.sh"
    "demo-leader:build.sh,common.sh,docker.sh,platform.sh,certs-permissions-lib.sh"
    "demo-partner:build.sh,common.sh,docker.sh,platform.sh,certs-permissions-lib.sh"
)

REQUIRED_TOOLS=(docker uv openssl python3)
REQUIRED_RESULT_FIELDS=(
    schema_version
    project_name
    bundle_name
    bundle_path
    version
    platform
    source_commit
    version_file
    image
    image_digest
)

ERRORS=0

fail() {
    echo "  ✗ $1" >&2
    ERRORS=$((ERRORS + 1))
}

pass() {
    echo "  ✓ $1"
}

files_match_ignoring_trailing_newlines() {
    local source_file="$1"
    local target_file="$2"
    local source_content
    local target_content

    source_content="$(cat "${source_file}")"
    target_content="$(cat "${target_file}")"
    [[ "${source_content}" == "${target_content}" ]]
}

read_result_value() {
    local result_file="$1"
    local key="$2"

    awk -F= -v key="${key}" '$1 == key { print substr($0, length(key) + 2); exit }' "${result_file}"
}

check_sibling_projects_exist() {
    echo "== 检查项目完整性 =="
    for project in "${REQUIRED_PROJECTS[@]}"; do
        if [[ -d "${WORKSPACE_DIR}/${project}" ]]; then
            pass "${project}/ 存在"
        else
            fail "${project}/ 不存在（期望路径: ${WORKSPACE_DIR}/${project}）"
        fi
    done
}

check_dockerfiles_exist() {
    echo "== 检查 Dockerfile =="
    for project in "${PROJECTS_WITH_DOCKERFILE[@]}"; do
        local df="${WORKSPACE_DIR}/${project}/Dockerfile"
        if [[ -f "$df" ]]; then
            pass "${project}/Dockerfile"
        else
            fail "${project}/Dockerfile 不存在"
        fi
    done
}

check_release_scripts_exist() {
    echo "== 检查 release-app 脚本 =="
    for project in "${PROJECTS_WITH_RELEASE_APP[@]}"; do
        local dir="${WORKSPACE_DIR}/${project}/scripts/release-app"
        if [[ -d "$dir" ]]; then
            pass "${project}/scripts/release-app/"
        else
            fail "${project}/scripts/release-app/ 不存在"
        fi
    done
}

check_shared_lib_consistency() {
    echo "== 检查共享库一致性 =="
    for entry in "${SHARED_LIB_EXPECTATIONS[@]}"; do
        local project="${entry%%:*}"
        local files_str="${entry#*:}"
        IFS=',' read -ra files <<< "$files_str"
        for file in "${files[@]}"; do
            local source="${LIB_SOURCE_DIR}/${file}"
            local target="${WORKSPACE_DIR}/${project}/scripts/lib/${file}"
            if [[ ! -f "$target" ]]; then
                fail "${project}/scripts/lib/${file} 不存在"
            elif ! files_match_ignoring_trailing_newlines "$source" "$target"; then
                fail "${project}/scripts/lib/${file} 与源头不一致（diff ${source} ${target}）"
            else
                pass "${project}/scripts/lib/${file}"
            fi
        done
    done
}

check_required_tools() {
    echo "== 检查工具链 =="
    for tool in "${REQUIRED_TOOLS[@]}"; do
        if command -v "$tool" >/dev/null 2>&1; then
            pass "${tool} 可用"
        else
            fail "${tool} 命令不可用"
        fi
    done
}

check_docker_daemon() {
    echo "== 检查 Docker daemon =="
    if docker info >/dev/null 2>&1; then
        pass "Docker daemon 运行中"
    else
        fail "Docker daemon 未运行或无权限"
    fi
}

check_docker_buildx() {
    echo "== 检查 Docker Buildx =="
    if docker buildx version >/dev/null 2>&1; then
        pass "Docker Buildx 可用"
    else
        fail "Docker Buildx 不可用"
    fi
}

check_image_tags_defined() {
    echo "== 检查镜像 tag 变量 =="
    if [[ -n "${RELEASE_VERSION:-}" ]]; then
        pass "RELEASE_VERSION=${RELEASE_VERSION}"
    else
        fail "RELEASE_VERSION 环境变量未设置"
    fi
}

check_release_app_contracts() {
    echo "== 检查打包接口契约 =="

    local temp_dir=""
    local project=""
    local script_path=""
    local result_file=""
    local field=""
    local missing_fields=()
    local result_version=""
    local result_platform=""

    temp_dir="$(mktemp -d)"

    for project in "${PROJECTS_WITH_RELEASE_APP[@]}"; do
        script_path="${WORKSPACE_DIR}/${project}/scripts/release-app/build-app-bundle.sh"
        result_file="${temp_dir}/${project}.env"
        missing_fields=()

        if [[ ! -f "${script_path}" ]]; then
            fail "${project} 缺少 build-app-bundle.sh"
            continue
        fi

        if ! DOCKER_PLATFORM="linux/arm64" bash "${script_path}" --dry-run --result-file "${result_file}" "${RELEASE_VERSION}" >/dev/null 2>&1; then
            fail "${project} 不满足统一打包入口契约（--dry-run --result-file 调用失败）"
            continue
        fi

        if [[ ! -f "${result_file}" ]]; then
            fail "${project} 未输出 result file"
            continue
        fi

        for field in "${REQUIRED_RESULT_FIELDS[@]}"; do
            if [[ -z "$(read_result_value "${result_file}" "${field}")" ]]; then
                missing_fields+=("${field}")
            fi
        done

        if [[ ${#missing_fields[@]} -gt 0 ]]; then
            fail "${project} result file 缺少字段: ${missing_fields[*]}"
            continue
        fi

        result_version="$(read_result_value "${result_file}" version)"
        result_platform="$(read_result_value "${result_file}" platform)"

        if [[ "${result_version}" != "${RELEASE_VERSION}" ]]; then
            fail "${project} result file version 不匹配: ${result_version}"
            continue
        fi

        if [[ "${result_platform}" != "linux/arm64" ]]; then
            fail "${project} result file platform 不匹配: ${result_platform}"
            continue
        fi

        pass "${project} 打包接口契约"
    done

    rm -rf "${temp_dir}"
}

run_preflight() {
    echo "========================================"
    echo "  ACPs Release Preflight Check"
    echo "========================================"
    echo ""

    check_sibling_projects_exist
    echo ""
    check_dockerfiles_exist
    echo ""
    check_release_scripts_exist
    echo ""
    check_shared_lib_consistency
    echo ""
    check_required_tools
    echo ""
    check_docker_daemon
    echo ""
    check_docker_buildx
    echo ""
    check_image_tags_defined
    echo ""
    check_release_app_contracts
    echo ""

    if [[ "$ERRORS" -gt 0 ]]; then
        echo "========================================"
        echo "  Preflight FAILED: ${ERRORS} 项检查未通过"
        echo "========================================"
        exit 1
    else
        echo "========================================"
        echo "  Preflight PASSED: 所有检查通过"
        echo "========================================"
    fi
}

# 如果直接执行（非 source），立即运行
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    run_preflight
fi
