#!/usr/bin/env bash
# deploy.sh — mq-auth-server 部署脚本（依赖 stage-infra）
# 用法: ./deploy.sh [--rollback]
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="${BASE_DIR}/compose.yml"
UPSTREAM_CONF="${BASE_DIR}/upstream.conf"
VERSION_FILE="${BASE_DIR}/VERSION"
IMAGES_TAR="${BASE_DIR}/images.tar.gz"
LIB_DIR="${BASE_DIR}/lib"
APP_NAME="mq-auth-server"
HEALTH_TIMEOUT=60
HEALTH_INTERVAL=3
ROLLBACK=false

if [[ ! -d "$LIB_DIR" ]]; then
    echo "错误: 发布包缺少 lib 目录: ${LIB_DIR}" >&2
    exit 1
fi

# shellcheck source=/dev/null
source "${LIB_DIR}/common.sh"
# shellcheck source=/dev/null
source "${LIB_DIR}/docker.sh"
# shellcheck source=/dev/null
source "${LIB_DIR}/blue-green.sh"

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-mq-auth-server-release}"

source_env_file "${BASE_DIR}/.env"

get_app_container_name() {
    local color="$1"
    echo "${APP_NAME}-${color}"
}

get_app_service_name() {
    local color="$1"
    echo "${APP_NAME}-${color}"
}

if [[ "${1:-}" == "--rollback" ]]; then
    ROLLBACK=true
fi

load_version() {
    if [[ ! -f "$VERSION_FILE" ]]; then
        err "未找到 VERSION 文件: ${VERSION_FILE}"
        exit 1
    fi

    export APP_IMAGE
    APP_IMAGE=$(grep '^image=' "$VERSION_FILE" | cut -d= -f2-)
    if [[ -z "$APP_IMAGE" ]]; then
        err "VERSION 文件中缺少 image 字段"
        exit 1
    fi

    log "应用镜像版本: ${APP_IMAGE}"
}

require_non_empty_env() {
    local var_name="$1"
    local value="${!var_name:-}"

    if [[ -z "$value" ]]; then
        err "环境变量未设置: ${var_name}"
        exit 1
    fi
}

require_container_cert_path() {
    local path="$1"
    local var_name="$2"

    if [[ "$path" != /certs/* ]]; then
        err "${var_name} 必须使用容器内 /certs/ 前缀路径，实际为: ${path}"
        exit 1
    fi
}

resolve_host_cert_path() {
    local container_path="$1"

    require_container_cert_path "$container_path" "证书路径"
    echo "${CERTS_HOST_DIR%/}/${container_path#/certs/}"
}

validate_tls_mount_contract() {
    require_non_empty_env "CERTS_HOST_DIR"
    require_dir_exists "$CERTS_HOST_DIR" "CERTS_HOST_DIR"

    local required_vars=(
        TLS_CERT_FILE
        TLS_KEY_FILE
        TLS_CA_CERT_FILE
        HEALTHCHECK_TLS_CERT_FILE
        HEALTHCHECK_TLS_KEY_FILE
        HEALTHCHECK_TLS_CA_CERT_FILE
    )
    local var_name=""
    local container_path=""
    local host_path=""

    for var_name in "${required_vars[@]}"; do
        require_non_empty_env "$var_name"
        container_path="${!var_name}"
        require_container_cert_path "$container_path" "$var_name"
        host_path="$(resolve_host_cert_path "$container_path")"
        require_file_exists "$host_path" "${var_name} -> ${host_path}" || exit 1
    done

    log "证书挂载约定检查通过: CERTS_HOST_DIR=${CERTS_HOST_DIR} -> /certs"
}

normalize_arch() {
    local arch="${1:-}"
    case "$arch" in
        x86_64) echo "amd64" ;;
        aarch64) echo "arm64" ;;
        *) echo "$arch" ;;
    esac
}

check_platform_compatibility() {
    local bundle_platform host_os_raw host_arch_raw host_os host_arch
    local bundle_os bundle_arch bundle_rest

    bundle_platform=$(grep '^platform=' "$VERSION_FILE" | cut -d= -f2-)
    if [[ -z "$bundle_platform" ]]; then
        log "未在 VERSION 中找到 platform 字段，跳过平台兼容性检查"
        return 0
    fi

    host_os_raw=$(docker info --format '{{.OSType}}' 2>/dev/null || echo "")
    host_arch_raw=$(docker info --format '{{.Architecture}}' 2>/dev/null || echo "")
    if [[ -z "$host_os_raw" || -z "$host_arch_raw" ]]; then
        err "无法获取宿主机 Docker 平台信息，请检查 Docker daemon 状态"
        exit 1
    fi

    host_os=$(echo "$host_os_raw" | tr '[:upper:]' '[:lower:]')
    host_arch=$(normalize_arch "$(echo "$host_arch_raw" | tr '[:upper:]' '[:lower:]')")

    bundle_os="${bundle_platform%%/*}"
    bundle_rest="${bundle_platform#*/}"
    bundle_arch="${bundle_rest%%/*}"

    if [[ "$bundle_os" != "$host_os" || "$bundle_arch" != "$host_arch" ]]; then
        err "发布包平台与宿主机不匹配: bundle=${bundle_platform}, host=${host_os}/${host_arch}"
        exit 1
    fi

    log "平台检查通过: bundle=${bundle_platform}, host=${host_os}/${host_arch}"
}

get_active_color() {
    if [[ -f "$UPSTREAM_CONF" ]] && grep -q "$(get_app_container_name green):9007" "$UPSTREAM_CONF" 2>/dev/null; then
        echo "green"
    else
        echo "blue"
    fi
}

write_upstream() {
    local color="$1"
    cat > "$UPSTREAM_CONF" <<EOF
# 由 deploy.sh 自动生成 — 请勿手动编辑
# 活跃颜色: ${color}
# 切换时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)
upstream mq_auth_group_backend {
    server $(get_app_container_name "$color"):9007;
}
upstream mq_auth_auth_backend {
    server $(get_app_container_name "$color"):9008;
}
EOF
    log "upstream 已切换到 $(get_app_container_name "$color")"
}

is_first_deploy() {
    ! container_exists "$(get_app_container_name blue)" && ! container_exists "$(get_app_container_name green)"
}

start_app_blue() {
    log "启动应用 (blue)..."
    remove_container_if_exists "$(get_app_container_name blue)"
    compose_up_detached -f "$COMPOSE_FILE" up -d "$(get_app_service_name blue)"
    wait_healthy "$(get_app_container_name blue)" "$COMPOSE_FILE" "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL"
    write_upstream "blue"
}

blue_green_deploy() {
    local active target
    active=$(get_active_color)
    target=$(get_target_color "$active")

    log "当前活跃: ${active}，目标: ${target}"

    if [[ "$ROLLBACK" == true ]]; then
        if ! container_exists "$(get_app_container_name "$target")"; then
            err "无法回滚：未找到旧容器 $(get_app_container_name "$target")"
            exit 1
        fi
        log "回滚模式：停止当前容器后启动 $(get_app_container_name "$target")..."
        stop_container_if_running "$(get_app_container_name "$active")"
        docker start "$(get_app_container_name "$target")" >/dev/null
    else
        log "停止 $(get_app_container_name "$active") 以释放端口..."
        stop_container_if_running "$(get_app_container_name "$active")"

        log "启动 $(get_app_container_name "$target")..."
        remove_container_if_exists "$(get_app_container_name "$target")"
        compose_up_detached -f "$COMPOSE_FILE" up -d "$(get_app_service_name "$target")"
    fi

    if ! wait_healthy "$(get_app_container_name "$target")" "$COMPOSE_FILE" "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL"; then
        if [[ "$ROLLBACK" == false ]]; then
            remove_container_if_exists "$(get_app_container_name "$target")"
            log "新容器不健康，尝试恢复 $(get_app_container_name "$active")..."
            compose_up_detached -f "$COMPOSE_FILE" up -d "$(get_app_service_name "$active")"
        fi
        exit 1
    fi
    write_upstream "$target"
}

run_smoke_test() {
    local smoke_script="${BASE_DIR}/smoke-test.sh"
    if [[ ! -f "$smoke_script" ]]; then
        log "未找到冒烟测试脚本，跳过验证"
        return 0
    fi

    local base_url="https://localhost:9007"
    log "执行冒烟测试: ${base_url}"
    if bash "$smoke_script" "$base_url"; then
        log "✅ 冒烟测试全部通过"
    else
        log "⚠️  冒烟测试存在失败项，请检查服务状态"
    fi
}

main() {
    load_version
    check_platform_compatibility
    validate_tls_mount_contract

    if is_first_deploy; then
        log "=== 首次部署应用 ==="
        load_images "$IMAGES_TAR"
        start_app_blue
        run_smoke_test
        log "=== 首次部署完成 ==="
        exit 0
    fi

    if [[ "$ROLLBACK" == true ]]; then
        log "=== 回滚部署 ==="
        blue_green_deploy
    else
        log "=== 版本更新 ==="
        load_images "$IMAGES_TAR"
        blue_green_deploy
    fi

    run_smoke_test
    log "=== 部署完成 ==="
}

main
