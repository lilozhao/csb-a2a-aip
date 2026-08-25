#!/usr/bin/env bash
# deploy.sh — 自动部署脚本（首次部署 + 版本更新）
# 用法: ./deploy.sh [--rollback]
#
# 功能：自动检测首次部署或版本更新，执行对应操作
#   首次部署：启动基础设施 → 执行迁移 → 启动 ca-server-blue
#   版本更新：加载镜像 → 执行迁移 → 蓝绿切换
#   回滚：    将流量切回上一个颜色
#
# 选项：
#   --rollback  回滚到上一个颜色（版本更新模式专用）
#
# 前置条件：
#   - 在发布包根目录执行
#   - .env 文件已配置
#   - 版本更新时：postgres 已运行
set -euo pipefail

# deploy.sh 位于发布包根目录
BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_FILE="${BASE_DIR}/compose.yml"
NGINX_UPSTREAM_DIR="${BASE_DIR}/nginx/includes"
UPSTREAM_CONF="${NGINX_UPSTREAM_DIR}/upstream.conf"
VERSION_FILE="${BASE_DIR}/VERSION"
IMAGES_TAR="${BASE_DIR}/images.tar.gz"
LIB_DIR="${BASE_DIR}/lib"
HEALTH_TIMEOUT=60
HEALTH_INTERVAL=3
APP_CONTAINER_PREFIX="ca-server"
export COMPOSE_PROJECT_NAME="${COMPOSE_PROJECT_NAME:-ca-server-release-bundle}"
NGINX_CONTAINER_NAME="${COMPOSE_PROJECT_NAME}-nginx-1"

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

source_env_file "${BASE_DIR}/.env"

generate_ca_materials() {
    local cert_host_path="$1"
    local key_host_path="$2"

    mkdir -p "$(dirname "$cert_host_path")"
    openssl req -x509 -newkey rsa:4096 -sha256 -nodes \
        -days "${AUTO_GENERATED_CA_VALID_DAYS:-3650}" \
        -keyout "$key_host_path" \
        -out "$cert_host_path" \
        -subj "${AUTO_GENERATED_CA_SUBJECT:-/C=CN/ST=Beijing/L=Beijing/O=Agent CA/OU=Certificate Authority/CN=Agent CA Root Certificate}" \
        -addext "basicConstraints=critical,CA:TRUE" \
        -addext "keyUsage=critical,keyCertSign,cRLSign" \
        -addext "subjectKeyIdentifier=hash"
}

validate_ca_materials() {
    local cert_filename key_filename cert_host_path key_host_path

    cert_filename="$(basename "${CA_CERT_PATH:-/app/certs/ca.crt}")"
    key_filename="$(basename "${CA_KEY_PATH:-/app/certs/ca.key}")"
    cert_host_path="${BASE_DIR}/certs/${cert_filename}"
    key_host_path="${BASE_DIR}/certs/${key_filename}"

    if [[ ! -f "$cert_host_path" && ! -f "$key_host_path" ]]; then
        if [[ "${AUTO_GENERATE_CA_MATERIALS:-true}" == "true" ]]; then
            log "未检测到 CA 根证书材料，正在自动生成同机验证用自签根 CA"
            generate_ca_materials "$cert_host_path" "$key_host_path"
        else
            err "未找到 CA 证书文件: ${cert_host_path}"
            err "请先将 ${cert_filename} 放入发布包目录下的 certs/ 中"
            exit 1
        fi
    fi

    if [[ ! -f "$cert_host_path" || ! -f "$key_host_path" ]]; then
        err "CA 证书材料不完整: cert=$(basename "$cert_host_path"), key=$(basename "$key_host_path")"
        err "请补齐 certs/ 下的证书和私钥，或删除残缺文件后重新执行 deploy.sh 触发自动生成"
        exit 1
    fi

    log "CA 证书材料检查通过: certs/${cert_filename}, certs/${key_filename}"
}

get_color_container_name() {
    local color="$1"

    echo "${APP_CONTAINER_PREFIX}-${color}"
}

get_color_service_name() {
    local color="$1"

    echo "${APP_CONTAINER_PREFIX}-${color}"
}

ROLLBACK=false
if [[ "${1:-}" == "--rollback" ]]; then
    ROLLBACK=true
fi

# 从 VERSION 文件读取版本信息
load_version() {
    if [[ ! -f "$VERSION_FILE" ]]; then
        err "未找到 VERSION 文件: ${VERSION_FILE}"
        exit 1
    fi
    local app_image postgres_image
    app_image=$(grep '^image=' "$VERSION_FILE" | cut -d= -f2-)
    postgres_image=$(grep '^postgres_image=' "$VERSION_FILE" | cut -d= -f2-)
    
    if [[ -z "$app_image" ]]; then
        err "VERSION 文件中缺少 image 字段"
        exit 1
    fi
    
    export APP_IMAGE="$app_image"
    export POSTGRES_IMAGE="${postgres_image:-postgres:17-alpine}"
    log "应用镜像版本: ${APP_IMAGE}"
    log "基础设施版本: postgres=${POSTGRES_IMAGE}"
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

# 获取容器当前运行的镜像版本
get_running_image() {
    local container="$1"
    local inspect_target

    inspect_target="$(resolve_inspect_target "$container" "$COMPOSE_FILE")"
    docker inspect "$inspect_target" --format='{{.Config.Image}}' 2>/dev/null || echo "none"
}

get_nginx_upstream_conf_path() {
    local mounted_dir

    if container_exists "$NGINX_CONTAINER_NAME"; then
        mounted_dir="$(docker inspect "$NGINX_CONTAINER_NAME" --format='{{range .Mounts}}{{if eq .Destination "/etc/nginx/includes"}}{{.Source}}{{end}}{{end}}' 2>/dev/null || echo "")"
        if [[ -n "$mounted_dir" ]]; then
            echo "${mounted_dir}/upstream.conf"
            return 0
        fi
    fi

    echo "$UPSTREAM_CONF"
}

# 检查基础设施版本是否需要升级
check_infra_versions() {
    local postgres_current
    local need_postgres=false
    
    # 检查 postgres
    postgres_current=$(get_running_image "postgres")
    if [[ "$postgres_current" != "$POSTGRES_IMAGE" ]]; then
        log "⚠️  PostgreSQL 版本差异: 当前=$postgres_current, 目标=$POSTGRES_IMAGE"
        need_postgres=true
    else
        log "✓ PostgreSQL 版本一致: $POSTGRES_IMAGE"
    fi
    
    export NEED_POSTGRES="$need_postgres"
}

# 更新基础设施版本（停止旧容器并启动新版本）
upgrade_infra() {
    if [[ "$NEED_POSTGRES" == "true" ]]; then
        log "升级 PostgreSQL..."
        docker compose -f "$COMPOSE_FILE" stop postgres
        log "启动新版本基础设施..."
        compose_up_detached -f "$COMPOSE_FILE" up -d postgres
        log "等待数据库就绪..."
        for i in {1..30}; do
            if docker compose -f "$COMPOSE_FILE" exec -T postgres pg_isready -U "${POSTGRES_INIT_USER:-ca}" &>/dev/null; then
                log "数据库就绪"
                return 0
            fi
            sleep 2
        done
        err "数据库升级后仍未就绪"
        exit 1
    fi
}

# 检测是否首次部署（应用容器是否存在）
is_first_deploy() {
    ! container_exists "$(get_color_container_name blue)" && ! container_exists "$(get_color_container_name green)"
}

# 启动基础设施（postgres）
start_infrastructure() {
    log "启动基础设施..."
    compose_up_detached -f "$COMPOSE_FILE" up -d postgres

    log "等待数据库就绪..."
    if ! wait_healthy "postgres" "$COMPOSE_FILE" "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL"; then
        err "数据库在 ${HEALTH_TIMEOUT}s 内未就绪"
        exit 1
    fi
    log "数据库就绪"
}

# 执行数据库迁移
run_migrations() {
    local migration_container

    log "执行数据库迁移..."
    migration_container="bundle-migrate-$(date +%s)"
    docker compose -f "$COMPOSE_FILE" run --rm --no-deps --name "$migration_container" "$(get_color_service_name blue)" alembic upgrade head
    log "数据库迁移完成"
}

# 启动应用（首次部署模式）
start_app_blue() {
    log "启动应用..."
    compose_up_detached -f "$COMPOSE_FILE" up -d "$(get_color_service_name blue)" nginx
    
    if ! wait_healthy "$(get_color_service_name blue)" "$COMPOSE_FILE" "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL"; then
        err "应用启动失败"
        exit 1
    fi
    
    # 初始化 upstream 指向 blue
    write_upstream "blue"
    reload_nginx
}

# 获取当前活跃颜色
get_active_color() {
    local upstream_conf

    upstream_conf="$(get_nginx_upstream_conf_path)"

    if [[ ! -f "$upstream_conf" ]]; then
        echo "blue"
        return
    fi
    if grep -q "ca-server-green:9003" "$upstream_conf" 2>/dev/null; then
        echo "green"
    else
        echo "blue"
    fi
}

# 生成 upstream 配置文件
write_upstream() {
    local color="$1"
    local upstream_conf

    upstream_conf="$(get_nginx_upstream_conf_path)"
    mkdir -p "$(dirname "$upstream_conf")"
    cat > "$upstream_conf" <<EOF
# 由 deploy.sh 自动生成 — 请勿手动编辑
# 活跃颜色: ${color}
# 切换时间: $(date -u +%Y-%m-%dT%H:%M:%SZ)
map \$request_uri \$app_backend {
    default http://$(get_color_container_name "$color"):9003;
}
EOF
    log "upstream 已切换到 $(get_color_container_name "$color")"
}

# 重新加载 nginx 配置
reload_nginx() {
    log "重新加载 nginx 配置..."
    docker compose -f "$COMPOSE_FILE" exec -T nginx nginx -s reload
    log "nginx 配置重新加载完成"
}

# 蓝绿部署（版本更新）
blue_green_deploy() {
    local active target
    local active_container target_container
    local target_image
    active=$(get_active_color)
    target=$(get_target_color "$active")
    active_container="$(get_color_container_name "$active")"
    target_container="$(get_color_container_name "$target")"
    target_image="$APP_IMAGE"

    log "当前活跃: ${active}，目标: ${target}"

    if [[ "$ROLLBACK" == true ]]; then
        if ! container_exists "$target_container"; then
            err "无法回滚：未找到旧容器 ${target_container}"
            err "提示：回滚依赖上一个颜色的旧容器仍然存在且未被删除"
            exit 1
        fi

        target_image="$(get_container_image "$target_container")"
        if [[ -z "$target_image" || "$target_image" == "none" ]]; then
            err "无法确定回滚目标 ${target_container} 的镜像版本"
            exit 1
        fi
        export APP_IMAGE="$target_image"
        log "回滚目标镜像: ${APP_IMAGE}"

        if container_running "$target_container"; then
            log "回滚目标 ${target_container} 已在运行，继续执行流量切换"
        else
            log "回滚模式：直接启动旧容器 ${target_container}..."
            docker start "$target_container" >/dev/null
        fi
    else
        # 启动新颜色
        log "启动 ${target_container}..."
        compose_up_detached -f "$COMPOSE_FILE" up -d "$(get_color_service_name "$target")"
    fi

    # 等待健康检查
    if ! wait_healthy "$(get_color_service_name "$target")" "$COMPOSE_FILE" "$HEALTH_TIMEOUT" "$HEALTH_INTERVAL"; then
        err "目标容器启动失败，中止部署"
        if [[ "$ROLLBACK" == false ]]; then
            remove_container_if_exists "$target_container"
        fi
        exit 1
    fi

    # 切换流量
    write_upstream "$target"
    reload_nginx

    # 排空旧连接
    log "等待 5s 让旧连接完成排空..."
    sleep 5

    # 停止旧容器
    log "停止 ${active_container}..."
    docker compose -f "$COMPOSE_FILE" stop "$(get_color_service_name "$active")"

    log "蓝绿部署完成：${active} → ${target}"
}

# 冒烟测试
run_smoke_test() {
    local smoke_script="${BASE_DIR}/smoke-test.sh"
    local base_url="http://localhost:${NGINX_PORT:-9003}"

    if [[ ! -f "$smoke_script" ]]; then
        log "未找到冒烟测试脚本，跳过验证"
        return 0
    fi

    log "执行冒烟测试: ${base_url}"
    echo ""
    if bash "$smoke_script" "$base_url"; then
        echo ""
        log "✅ 冒烟测试全部通过"
    else
        echo ""
        log "⚠️  冒烟测试存在失败项，请检查服务状态"
        log "提示: 版本更新可执行 $0 --rollback 回滚"
    fi
}

# --- 主流程 ---

main() {
    validate_ca_materials

    # 检测部署模式
    if is_first_deploy; then
        # ============ 首次部署 ============
        log "=== 首次部署 ==="
        load_version
        check_platform_compatibility
        load_images "$IMAGES_TAR"
        start_infrastructure
        run_migrations
        start_app_blue
        run_smoke_test
        
        log ""
        log "=== 首次部署完成 ==="
        log "应用地址：http://localhost:${NGINX_PORT:-9003}"
        log ""
        log "提示："
        log "  - 查看日志：docker compose logs -f $(get_color_service_name blue)"
        log "  - 版本更新：将新版包解压到 ../ 目录，执行 bash deploy.sh"
        
    else
        # ============ 版本更新 ============
        if [[ "$ROLLBACK" == true ]]; then
            log "=== 回滚部署 ==="
        else
            log "=== 版本更新 ==="
        fi

        load_version
        check_platform_compatibility
        
        if [[ "$ROLLBACK" == false ]]; then
            load_images "$IMAGES_TAR"
            # 检查基础设施版本，选择性升级
            check_infra_versions
            if [[ "$NEED_POSTGRES" == "true" ]]; then
                log "检测到基础设施版本变化，执行升级..."
                upgrade_infra
            fi
            run_migrations
        else
            log "回滚模式：跳过镜像导入、版本检查和数据库迁移"
        fi

        blue_green_deploy
        run_smoke_test

        log ""
        log "=== 部署完成 ==="
        active=$(get_active_color)
        log "活跃应用：$(get_color_container_name "$active")"
        log ""
        log "提示："
        log "  - 查看日志：docker compose logs -f $(get_color_service_name "$active")"
        log "  - 回滚：bash deploy.sh --rollback"
    fi
}

main
