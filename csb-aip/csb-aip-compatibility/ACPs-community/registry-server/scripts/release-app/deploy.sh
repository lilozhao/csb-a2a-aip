#!/usr/bin/env bash
# App-only 部署脚本（deploy.sh，依赖 stage-infra）
# 用法: ./deploy.sh [--rollback]
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="${BASE_DIR}/compose.yml"
COMPOSE_MTLS_PUBLISH_FILE="${BASE_DIR}/compose.mtls-publish.yml"
UPSTREAM_CONF="${BASE_DIR}/upstream.conf"
VERSION_FILE="${BASE_DIR}/VERSION"
IMAGES_TAR="${BASE_DIR}/images.tar.gz"
LIB_DIR="${BASE_DIR}/lib"
APP_NAME="registry-server"
APP_ROUTE_NAME="registry"
UPSTREAM_NAME="registry_server_backend"
STAGE_INFRA_DIR="${STAGE_INFRA_DIR:-${BASE_DIR}/../stage-infra}"
STAGE_NGINX_APPS_DIR="${STAGE_INFRA_DIR}/nginx/conf.d/apps"
STAGE_APP_CONF="${STAGE_NGINX_APPS_DIR}/${APP_ROUTE_NAME}.conf"
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

export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-registry-release-app}"

source_env_file "${BASE_DIR}/.env"

COMPOSE_ARGS=(-f "$COMPOSE_FILE")

set_env_value() {
    local env_file="$1"
    local key="$2"
    local value="$3"
    local tmp_file
    local serialized_value
    local awk_value

    if [[ "${value}" == *"'"* ]]; then
        serialized_value="$(printf '%s' "${value}" | sed \
            -e 's/\\/\\\\/g' \
            -e 's/"/\\"/g' \
            -e 's/\$/\\$/g' \
            -e 's/`/\\`/g')"
        serialized_value="\"${serialized_value}\""
    else
        serialized_value="'${value}'"
    fi
    awk_value="${serialized_value//\\/\\\\}"

    tmp_file="$(mktemp)"
    awk -v key="$key" -v value="$awk_value" '
        BEGIN { updated = 0 }
        $0 ~ ("^" key "=") {
            print key "=" value
            updated = 1
            next
        }
        { print }
        END {
            if (updated == 0) {
                print key "=" value
            }
        }
    ' "$env_file" > "$tmp_file"
    mv "$tmp_file" "$env_file"
}

ensure_secret_key() {
    local generated_secret

    if [[ -n "${SECRET_KEY:-}" && "${SECRET_KEY}" != "change-me-to-a-random-secret" ]]; then
        return 0
    fi

    generated_secret="$(openssl rand -hex 32)"
    set_env_value "${BASE_DIR}/.env" "SECRET_KEY" "$generated_secret"
    export SECRET_KEY="$generated_secret"
    log "检测到默认 SECRET_KEY，已自动生成新的随机密钥并写回 .env"
}

ensure_aic_crc_salt() {
    local generated_salt
    local placeholder_salt="0xAAAAAAAA"

    if [[ -n "${AIC_CRC_SALT:-}" && "${AIC_CRC_SALT}" != "$placeholder_salt" ]]; then
        return 0
    fi

    generated_salt="0x$(openssl rand -hex 4 | tr '[:lower:]' '[:upper:]')"
    set_env_value "${BASE_DIR}/.env" "AIC_CRC_SALT" "$generated_salt"
    export AIC_CRC_SALT="$generated_salt"
    log "检测到默认 AIC_CRC_SALT，已自动生成新的随机十六进制盐并写回 .env"
}

ensure_secret_key
ensure_aic_crc_salt

get_container_name() {
    local color="$1"

    echo "${APP_NAME}-${color}"
}

get_service_name() {
    local color="$1"

    echo "${APP_NAME}-${color}"
}

if [[ "${1:-}" == "--rollback" ]]; then
    ROLLBACK=true
fi

get_path_prefix() {
    local path_prefix="${APP_PATH_PREFIX:-$APP_NAME}"

    path_prefix="${path_prefix#/}"
    path_prefix="${path_prefix%/}"

    if [[ -z "$path_prefix" ]]; then
        err "APP_PATH_PREFIX 不能为空"
        exit 1
    fi

    echo "$path_prefix"
}

get_root_path() {
    local path_prefix
    local expected_root_path
    local configured_root_path

    path_prefix="$(get_path_prefix)"
    expected_root_path="/${path_prefix}"
    configured_root_path="${ROOT_PATH:-$expected_root_path}"
    configured_root_path="${configured_root_path%/}"

    if [[ "$configured_root_path" != "$expected_root_path" ]]; then
        err "ROOT_PATH 必须与 APP_PATH_PREFIX 对齐，期望值: ${expected_root_path}"
        exit 1
    fi

    echo "$configured_root_path"
}

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

normalize_bool() {
    local value="${1:-}"

    case "$(echo "$value" | tr '[:upper:]' '[:lower:]')" in
        1|true|yes|on)
            echo "true"
            ;;
        *)
            echo "false"
            ;;
    esac
}

mtls_listener_enabled() {
    [[ "$(normalize_bool "${REGISTRY_SERVER_ENABLE_MTLS_LISTENER:-false}")" == "true" ]]
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
    echo "${REGISTRY_CERTS_HOST_DIR%/}/${container_path#/certs/}"
}

prepare_registry_certs_dir() {
    require_non_empty_env "REGISTRY_CERTS_HOST_DIR"

    if [[ ! -d "$REGISTRY_CERTS_HOST_DIR" ]]; then
        mkdir -p "$REGISTRY_CERTS_HOST_DIR"
        log "已创建 registry 证书目录: ${REGISTRY_CERTS_HOST_DIR}"
    fi
}

validate_mtls_mount_contract() {
    local required_vars=(
        REGISTRY_SERVER_MTLS_CERT_FILE
        REGISTRY_SERVER_MTLS_KEY_FILE
        REGISTRY_SERVER_MTLS_CA_CERT_FILE
        REGISTRY_SERVER_MTLS_PROBE_CERT_FILE
        REGISTRY_SERVER_MTLS_PROBE_KEY_FILE
    )
    local var_name=""
    local container_path=""
    local host_path=""

    prepare_registry_certs_dir

    for var_name in "${required_vars[@]}"; do
        require_non_empty_env "$var_name"
        container_path="${!var_name}"
        require_container_cert_path "$container_path" "$var_name"
    done

    if ! mtls_listener_enabled; then
        log "9002 mTLS listener 当前关闭，仅校验证书挂载路径合同"
        return 0
    fi

    for var_name in "${required_vars[@]}"; do
        container_path="${!var_name}"
        host_path="$(resolve_host_cert_path "$container_path")"
        require_file_exists "$host_path" "${var_name} -> ${host_path}" || exit 1
    done

    log "9002 证书挂载约定检查通过: REGISTRY_CERTS_HOST_DIR=${REGISTRY_CERTS_HOST_DIR} -> /certs"
}

prepare_compose_args() {
    COMPOSE_ARGS=(-f "$COMPOSE_FILE")

    if mtls_listener_enabled; then
        require_file_exists "$COMPOSE_MTLS_PUBLISH_FILE" "compose.mtls-publish.yml"
        COMPOSE_ARGS+=(-f "$COMPOSE_MTLS_PUBLISH_FILE")
        log "9002 mTLS listener 已启用，将发布宿主机端口: ${REGISTRY_SERVER_MTLS_PORT:-9002}"
    else
        log "9002 mTLS listener 当前关闭，仅部署 public plane"
    fi
}

normalize_arch() {
    local arch="${1:-}"

    case "$arch" in
        x86_64)
            echo "amd64"
            ;;
        aarch64)
            echo "arm64"
            ;;
        *)
            echo "$arch"
            ;;
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
        err "请在构建机使用 DOCKER_PLATFORM=${host_os}/${host_arch} 重新打包并重新部署"
        exit 1
    fi

    log "平台检查通过: bundle=${bundle_platform}, host=${host_os}/${host_arch}"
}

ensure_stage_infra() {
    if [[ ! -d "$STAGE_INFRA_DIR" ]]; then
        err "未找到 stage-infra 目录: ${STAGE_INFRA_DIR}"
        exit 1
    fi

    for container in stage-postgres stage-nginx; do
        if ! docker inspect "$container" &>/dev/null; then
            err "共享基础设施未启动，缺少容器: ${container}"
            exit 1
        fi
        if ! container_running "$container"; then
            err "共享基础设施容器未运行: ${container}"
            exit 1
        fi
    done
}

validate_path_prefix_settings() {
    local path_prefix
    local root_path

    path_prefix="$(get_path_prefix)"
    root_path="$(get_root_path)"
    log "共享网关路径前缀: /${path_prefix}"
    log "FastAPI ROOT_PATH: ${root_path}"
}

is_first_deploy() {
    ! container_exists "$(get_container_name blue)" && ! container_exists "$(get_container_name green)"
}

run_migrations() {
    log "执行数据库迁移..."
    docker compose -f "$COMPOSE_FILE" run --rm "$(get_service_name blue)" alembic upgrade head
    log "数据库迁移完成"
}

get_active_color() {
    if [[ -f "$STAGE_APP_CONF" ]] && grep -q "$(get_container_name green):9001" "$STAGE_APP_CONF" 2>/dev/null; then
        echo "green"
        return
    fi

    if [[ -f "$STAGE_APP_CONF" ]] && grep -q "$(get_container_name blue):9001" "$STAGE_APP_CONF" 2>/dev/null; then
        echo "blue"
        return
    fi

    if [[ ! -f "$UPSTREAM_CONF" ]]; then
        echo "blue"
        return
    fi
    if grep -q "$(get_container_name green):9001" "$UPSTREAM_CONF" 2>/dev/null; then
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
upstream ${UPSTREAM_NAME} {
    server $(get_container_name "$color"):9001;
}
EOF
    log "upstream 已切换到 $(get_container_name "$color")"
}

render_stage_nginx_conf() {
    local color="$1"
    local path_prefix

    path_prefix="$(get_path_prefix)"
    mkdir -p "$STAGE_NGINX_APPS_DIR"
    cat > "$STAGE_APP_CONF" <<EOF
# ${APP_NAME} 应用路由配置
location = /${path_prefix} {
    return 301 /${path_prefix}/;
}

location = /${path_prefix}/health {
    rewrite ^/${path_prefix}(/.*)$ \$1 break;
    proxy_pass http://$(get_container_name "$color"):9001;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Prefix /${path_prefix};
    proxy_set_header X-Request-ID \$request_id;

    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    proxy_send_timeout 10s;
}

location ~ ^/${path_prefix}/(ready|metrics)$ {
    allow 10.0.0.0/8;
    allow 172.16.0.0/12;
    allow 192.168.0.0/16;
    allow 127.0.0.1;
    allow ::1;
    allow fc00::/7;
    allow fe80::/10;
    deny all;

    rewrite ^/${path_prefix}(/.*)$ \$1 break;
    proxy_pass http://$(get_container_name "$color"):9001;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Prefix /${path_prefix};
    proxy_set_header X-Request-ID \$request_id;

    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    proxy_send_timeout 10s;
}

location /${path_prefix}/ {
    proxy_pass http://$(get_container_name "$color"):9001/;
    proxy_set_header Host \$host;
    proxy_set_header X-Real-IP \$remote_addr;
    proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto \$scheme;
    proxy_set_header X-Forwarded-Host \$host;
    proxy_set_header X-Forwarded-Prefix /${path_prefix};
    proxy_set_header X-Request-ID \$request_id;

    proxy_connect_timeout 5s;
    proxy_read_timeout 30s;
    proxy_send_timeout 10s;
}
EOF
}

reload_nginx() {
    log "重新加载 stage-nginx 配置..."
    docker exec stage-nginx nginx -s reload
    log "stage-nginx 配置重新加载完成"
}

wait_gateway_route_ready() {
    local path_prefix
    local base_url
    local probe_url
    local elapsed=0
    local status="000"

    path_prefix="$(get_path_prefix)"
    base_url="${APP_BASE_URL:-http://localhost:9000/${path_prefix}}"
    probe_url="${base_url}/docs"

    log "等待 stage 网关路由生效（最长 ${HEALTH_TIMEOUT}s）..."
    while [[ $elapsed -lt $HEALTH_TIMEOUT ]]; do
        status=$(curl --silent --show-error --location --connect-timeout 3 --max-time 10 \
            -o /dev/null -w "%{http_code}" "$probe_url" || echo "000")
        if [[ "$status" == "200" ]]; then
            log "stage 网关路由已生效: ${probe_url}"
            return 0
        fi
        sleep "$HEALTH_INTERVAL"
        elapsed=$((elapsed + HEALTH_INTERVAL))
    done

    err "stage 网关路由在 ${HEALTH_TIMEOUT}s 内未生效（最后状态: ${status}）"
    return 1
}

start_app_blue() {
    log "启动应用..."
    remove_container_if_exists "$(get_container_name blue)"
    compose_up_detached "${COMPOSE_ARGS[@]}" up -d "$(get_service_name blue)"
    wait_healthy "$(get_service_name blue)" "$COMPOSE_FILE" "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL"
    write_upstream "blue"
    render_stage_nginx_conf "blue"
    reload_nginx
    wait_gateway_route_ready
}

blue_green_deploy() {
    local active target
    local active_container target_container
    local target_image
    local zero_downtime_public_plane=true
    active=$(get_active_color)
    target=$(get_target_color "$active")
    active_container="$(get_container_name "$active")"
    target_container="$(get_container_name "$target")"
    target_image="$APP_IMAGE"

    if mtls_listener_enabled; then
        zero_downtime_public_plane=false
    fi

    log "当前活跃: ${active}，目标: ${target}"

    if [[ "$ROLLBACK" == true ]]; then
        if ! container_exists "$target_container"; then
            err "无法回滚：未找到旧容器 ${target_container}"
            exit 1
        fi
        target_image="$(get_container_image "$target_container")"
        if [[ -z "$target_image" || "$target_image" == "none" ]]; then
            err "无法确定回滚目标 ${target_container} 的镜像版本"
            exit 1
        fi
        export APP_IMAGE="$target_image"
        log "回滚目标镜像: ${APP_IMAGE}"
        if [[ "$zero_downtime_public_plane" == false ]]; then
            log "回滚模式：因 9002 需要释放宿主机端口，先停止 ${active_container} 再启动 ${target_container}..."
            stop_container_if_running "$active_container"
        else
            log "回滚模式：直接启动 ${target_container}..."
        fi
        docker start "$target_container" >/dev/null
    else
        if [[ "$zero_downtime_public_plane" == false ]]; then
            log "因 9002 需要独立宿主机端口，先停止 ${active_container} 以释放端口..."
            stop_container_if_running "$active_container"
        fi

        log "启动 ${target_container}..."
        remove_container_if_exists "$target_container"
        compose_up_detached "${COMPOSE_ARGS[@]}" up -d "$(get_service_name "$target")"
    fi

    wait_healthy "$(get_service_name "$target")" "$COMPOSE_FILE" "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL"
    write_upstream "$target"
    render_stage_nginx_conf "$target"
    reload_nginx
    wait_gateway_route_ready

    if [[ "$zero_downtime_public_plane" == true ]]; then
        log "等待 5s 让旧连接完成排空..."
        sleep 5

        log "停止 ${active_container}..."
        stop_container_if_running "$active_container"
    fi
}

run_smoke_test() {
    local smoke_script="${BASE_DIR}/smoke-test.sh"
    local path_prefix
    local base_url

    path_prefix="$(get_path_prefix)"
    base_url="${APP_BASE_URL:-http://localhost:9000/${path_prefix}}"

    if [[ ! -f "$smoke_script" ]]; then
        log "未找到冒烟测试脚本，跳过验证"
        return 0
    fi

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
    ensure_stage_infra
    validate_path_prefix_settings
    validate_mtls_mount_contract
    prepare_compose_args

    if is_first_deploy; then
        log "=== 首次部署应用 ==="
        load_images "$IMAGES_TAR"
        run_migrations
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
        run_migrations
        blue_green_deploy
    fi

    run_smoke_test
    log "=== 部署完成 ==="
}

main
