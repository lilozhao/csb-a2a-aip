#!/usr/bin/env bash
# cleanup-docker-resources.sh — 清理 stage-infra 相关的 Docker 资源
# 用法: bash scripts/stage-infra/cleanup-docker-resources.sh [选项]
set -euo pipefail

# stage-infra compose 项目名（docker compose 默认取 compose.yml 所在目录名）
DEFAULT_COMPOSE_PROJECT_NAME="stage-infra"

# 历史兼容回退：未提供 metadata lock 时，仍按已知应用镜像仓库名清理
APP_IMAGE_REPOSITORIES=(
    "acps/mq-auth-server"
    "registry-server"
    "ca-server"
    "discovery-server"
)

COMPOSE_PROJECT_NAME_VALUE="${COMPOSE_PROJECT_NAME:-$DEFAULT_COMPOSE_PROJECT_NAME}"
ALSO_PROJECTS=()
REMOVE_APP_IMAGES=true
REMOVE_APP_ROUTES=false
STAGE_INFRA_DIR=""
IMAGES_LOCK_FILE="${IMAGES_LOCK_FILE:-}"
PURGE_ALL_DOCKER_RESOURCES=false
CONFIRM_PURGE=false

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

err() {
    echo "[$(date '+%H:%M:%S')] 错误: $*" >&2
}

usage() {
    cat <<'EOF'
用法:
  bash scripts/stage-infra/cleanup-docker-resources.sh [选项]

选项:
  --project-name <name>   指定当前要清理的 Compose 项目名（默认: stage-infra）
                          一般情况下无需手工指定（deploy.sh 与 cleanup 默认一致）
  --also-project <name>   额外清理另一个 Compose 项目名，可重复传入
                          例：--also-project registry-server-app-20260101
    --images-lock <path>    指定应用镜像清单文件（每行一个镜像引用）
                                                    未指定时会优先尝试使用 stage-infra 邻近的 ../images.lock
    --skip-app-images       跳过应用镜像清理（registry-server、ca-server、discovery-server）
  --remove-app-routes     清理 stage-infra nginx/conf.d/apps 下的业务路由文件
                          （仅删除 *.conf，保留 *.example）
  --stage-infra-dir <p>  指定 stage-infra 目录（用于定位 nginx/conf.d/apps）
  --purge-all-docker-resources
                          清空 Docker 中的所有容器、镜像、自定义网络、卷和构建缓存
  --confirm-purge         与 --purge-all-docker-resources 配合使用，显式确认执行危险操作
  --help                  显示帮助

注意：
  --purge-all-docker-resources 会删除宿主机上所有 Docker 资源，包括其他项目的数据，
  仅在完全隔离的 staging 环境中使用。
EOF
}

require_docker() {
    if ! command -v docker >/dev/null 2>&1; then
        err "未找到 docker 命令"
        exit 1
    fi

    if ! docker info >/dev/null 2>&1; then
        err "Docker daemon 未运行或当前用户无权限访问"
        exit 1
    fi
}

append_unique_project() {
    local candidate="$1"
    local existing

    for existing in "${ALSO_PROJECTS[@]:-}"; do
        if [[ "$existing" == "$candidate" ]]; then
            return 0
        fi
    done

    ALSO_PROJECTS+=("$candidate")
}

resolve_images_lock_file() {
    if [[ -n "$IMAGES_LOCK_FILE" ]]; then
        printf '%s\n' "$IMAGES_LOCK_FILE"
        return 0
    fi

    if [[ -n "$STAGE_INFRA_DIR" && -f "$STAGE_INFRA_DIR/../images.lock" ]]; then
        printf '%s\n' "$STAGE_INFRA_DIR/../images.lock"
        return 0
    fi

    return 1
}

validate_images_lock_file() {
    local lock_file="$1"

    if [[ ! -f "$lock_file" ]]; then
        err "镜像清单文件不存在: ${lock_file}"
        exit 1
    fi

    if [[ ! -s "$lock_file" ]]; then
        err "镜像清单文件为空: ${lock_file}"
        exit 1
    fi
}

iter_image_refs() {
    local lock_file="$1"
    local repo=""

    if [[ -n "$lock_file" ]]; then
        validate_images_lock_file "$lock_file"
        awk 'NF { print }' "$lock_file"
        return 0
    fi

    for repo in "${APP_IMAGE_REPOSITORIES[@]}"; do
        docker images --format '{{.Repository}}:{{.Tag}}' | grep "^${repo}:" || true
    done
}

remove_app_routes() {
    local route_dir="$1"
    local route_file removed=false

    if [[ ! -d "$route_dir" ]]; then
        log "未找到路由目录，跳过业务路由清理: ${route_dir}"
        return 0
    fi

    while IFS= read -r route_file; do
        if [[ -n "$route_file" ]]; then
            log "删除业务路由文件: ${route_file}"
            rm -f "$route_file"
            removed=true
        fi
    done < <(find "$route_dir" -maxdepth 1 -type f -name '*.conf' ! -name '*.example' | sort)

    if [[ "$removed" == false ]]; then
        log "未发现可删除的业务路由文件"
    fi
}

assert_app_routes_clean() {
    local route_dir="$1"
    local remaining_routes

    if [[ ! -d "$route_dir" ]]; then
        log "路由目录不存在，视为已清理: ${route_dir}"
        return 0
    fi

    remaining_routes="$(find "$route_dir" -maxdepth 1 -type f -name '*.conf' ! -name '*.example' | sort)"
    if [[ -n "$remaining_routes" ]]; then
        err "业务路由文件仍有残留: ${remaining_routes//$'\n'/, }"
        return 1
    fi

    log "业务路由文件已清理完成（仅保留 *.example）"
}

remove_containers_for_project() {
    local project_name="$1"
    local container_id

    while IFS= read -r container_id; do
        if [[ -n "$container_id" ]]; then
            log "删除容器: ${container_id} (project=${project_name})"
            docker rm -f "$container_id" >/dev/null
        fi
    done < <(docker ps -a --filter "label=com.docker.compose.project=${project_name}" --format '{{.ID}}')
}

remove_networks_for_project() {
    local project_name="$1"
    local network_id

    while IFS= read -r network_id; do
        if [[ -n "$network_id" ]]; then
            log "删除网络: ${network_id} (project=${project_name})"
            docker network rm "$network_id" >/dev/null
        fi
    done < <(docker network ls --filter "label=com.docker.compose.project=${project_name}" --format '{{.ID}}')
}

remove_volumes_for_project() {
    local project_name="$1"
    local volume_name

    while IFS= read -r volume_name; do
        if [[ -n "$volume_name" ]]; then
            log "删除卷: ${volume_name} (project=${project_name})"
            docker volume rm "$volume_name" >/dev/null
        fi
    done < <(docker volume ls --filter "label=com.docker.compose.project=${project_name}" --format '{{.Name}}')
}

remove_app_images() {
    local image_ref
    local lock_file=""

    lock_file="$(resolve_images_lock_file || true)"
    if [[ -n "$lock_file" ]]; then
        log "使用镜像清单执行应用镜像清理: ${lock_file}"
    else
        log "未找到镜像清单，回退到历史仓库匹配方式执行应用镜像清理"
    fi

    while IFS= read -r image_ref; do
        if [[ -n "$image_ref" ]]; then
            if docker image inspect "$image_ref" >/dev/null 2>&1; then
                log "删除应用镜像: ${image_ref}"
                docker rmi -f "$image_ref" >/dev/null
            fi
        fi
    done < <(iter_image_refs "$lock_file")
}

assert_project_clean() {
    local project_name="$1"
    local remaining_containers remaining_networks remaining_volumes

    remaining_containers="$(docker ps -a --filter "label=com.docker.compose.project=${project_name}" --format '{{.ID}}')"
    remaining_networks="$(docker network ls --filter "label=com.docker.compose.project=${project_name}" --format '{{.ID}}')"
    remaining_volumes="$(docker volume ls --filter "label=com.docker.compose.project=${project_name}" --format '{{.Name}}')"

    if [[ -n "$remaining_containers" || -n "$remaining_networks" || -n "$remaining_volumes" ]]; then
        err "项目 ${project_name} 仍有残留资源，请人工检查"
        [[ -n "$remaining_containers" ]] && err "残留容器: ${remaining_containers//$'\n'/, }"
        [[ -n "$remaining_networks" ]] && err "残留网络: ${remaining_networks//$'\n'/, }"
        [[ -n "$remaining_volumes" ]] && err "残留卷: ${remaining_volumes//$'\n'/, }"
        return 1
    fi

    log "项目 ${project_name} 相关容器、网络、卷已清理完成"
}

assert_app_images_clean() {
    local remaining_images=""
    local all_remaining=""
    local image_ref
    local lock_file=""

    lock_file="$(resolve_images_lock_file || true)"

    while IFS= read -r image_ref; do
        [[ -n "$image_ref" ]] || continue
        if docker image inspect "$image_ref" >/dev/null 2>&1; then
            all_remaining="${all_remaining}${image_ref}"$'\n'
        fi
    done < <(iter_image_refs "$lock_file")

    if [[ -n "$all_remaining" ]]; then
        err "应用镜像仍有残留: ${all_remaining//$'\n'/, }"
        return 1
    fi

    if [[ -n "$lock_file" ]]; then
        log "镜像清单中的应用镜像已清理完成"
    else
        log "应用镜像（历史仓库匹配模式）已清理完成"
    fi
}

remove_all_containers() {
    local container_id

    while IFS= read -r container_id; do
        if [[ -n "$container_id" ]]; then
            log "删除容器: ${container_id}"
            docker rm -f "$container_id" >/dev/null
        fi
    done < <(docker ps -aq)
}

remove_all_images() {
    local image_id

    while IFS= read -r image_id; do
        if [[ -n "$image_id" ]]; then
            log "删除镜像: ${image_id}"
            docker rmi -f "$image_id" >/dev/null
        fi
    done < <(docker images -aq | sort -u)
}

remove_all_custom_networks() {
    local network_id

    while IFS= read -r network_id; do
        if [[ -n "$network_id" ]]; then
            log "删除自定义网络: ${network_id}"
            docker network rm "$network_id" >/dev/null
        fi
    done < <(docker network ls --filter type=custom --format '{{.ID}}')
}

remove_all_volumes() {
    local volume_name

    while IFS= read -r volume_name; do
        if [[ -n "$volume_name" ]]; then
            log "删除卷: ${volume_name}"
            docker volume rm -f "$volume_name" >/dev/null
        fi
    done < <(docker volume ls -q)
}

prune_builder_cache() {
    if docker builder prune --help >/dev/null 2>&1; then
        log "清理 Docker builder 缓存"
        docker builder prune -af >/dev/null
    fi
}

assert_all_docker_resources_clean() {
    local remaining_containers remaining_images remaining_networks remaining_volumes

    remaining_containers="$(docker ps -aq)"
    remaining_images="$(docker images -aq | sort -u)"
    remaining_networks="$(docker network ls --filter type=custom --format '{{.ID}}')"
    remaining_volumes="$(docker volume ls -q)"

    if [[ -n "$remaining_containers" || -n "$remaining_images" || -n "$remaining_networks" || -n "$remaining_volumes" ]]; then
        err "全量清理后仍有 Docker 资源残留，请人工检查"
        [[ -n "$remaining_containers" ]] && err "残留容器: ${remaining_containers//$'\n'/, }"
        [[ -n "$remaining_images" ]] && err "残留镜像: ${remaining_images//$'\n'/, }"
        [[ -n "$remaining_networks" ]] && err "残留自定义网络: ${remaining_networks//$'\n'/, }"
        [[ -n "$remaining_volumes" ]] && err "残留卷: ${remaining_volumes//$'\n'/, }"
        return 1
    fi

    log "Docker 已完成全量清理（默认 bridge/host/none 网络保留）"
}

purge_all_docker_resources() {
    if [[ "$CONFIRM_PURGE" != true ]]; then
        err "--purge-all-docker-resources 是危险操作，必须同时提供 --confirm-purge"
        exit 1
    fi

    log "开始全量清空 Docker 资源"
    remove_all_containers
    remove_all_images
    remove_all_custom_networks
    remove_all_volumes
    prune_builder_cache
    assert_all_docker_resources_clean
}

main() {
    local project_name

    while [[ $# -gt 0 ]]; do
        case "$1" in
            --project-name)
                shift
                if [[ $# -eq 0 ]]; then
                    err "--project-name 需要参数"
                    exit 1
                fi
                COMPOSE_PROJECT_NAME_VALUE="$1"
                ;;
            --also-project)
                shift
                if [[ $# -eq 0 ]]; then
                    err "--also-project 需要参数"
                    exit 1
                fi
                append_unique_project "$1"
                ;;
            --skip-app-images)
                REMOVE_APP_IMAGES=false
                ;;
            --remove-app-routes)
                REMOVE_APP_ROUTES=true
                ;;
            --stage-infra-dir)
                shift
                if [[ $# -eq 0 ]]; then
                    err "--stage-infra-dir 需要参数"
                    exit 1
                fi
                STAGE_INFRA_DIR="$1"
                ;;
            --images-lock)
                shift
                if [[ $# -eq 0 ]]; then
                    err "--images-lock 需要参数"
                    exit 1
                fi
                IMAGES_LOCK_FILE="$1"
                ;;
            --purge-all-docker-resources)
                PURGE_ALL_DOCKER_RESOURCES=true
                ;;
            --confirm-purge)
                CONFIRM_PURGE=true
                ;;
            --help)
                usage
                exit 0
                ;;
            *)
                err "未知参数: $1"
                usage
                exit 1
                ;;
        esac
        shift
    done

    require_docker

    if [[ -z "$STAGE_INFRA_DIR" ]]; then
        STAGE_INFRA_DIR="$(cd "$(dirname "$0")" && pwd)"
    fi

    if [[ "$PURGE_ALL_DOCKER_RESOURCES" == true ]]; then
        purge_all_docker_resources
        exit 0
    fi

    append_unique_project "$COMPOSE_PROJECT_NAME_VALUE"

    log "开始清理 stage-infra Docker 资源"
    for project_name in "${ALSO_PROJECTS[@]}"; do
        log "清理 Compose 项目: ${project_name}"
        remove_containers_for_project "$project_name"
        remove_networks_for_project "$project_name"
        remove_volumes_for_project "$project_name"
        assert_project_clean "$project_name"
    done

    if [[ "$REMOVE_APP_IMAGES" == true ]]; then
        remove_app_images
        assert_app_images_clean
    else
        log "跳过应用镜像清理"
    fi

    if [[ "$REMOVE_APP_ROUTES" == true ]]; then
        remove_app_routes "$STAGE_INFRA_DIR/nginx/conf.d/apps"
        assert_app_routes_clean "$STAGE_INFRA_DIR/nginx/conf.d/apps"
    else
        log "跳过业务路由文件清理（如需启用请添加 --remove-app-routes）"
    fi

    log "清理完成。建议随后执行 docker ps、docker volume ls、docker network ls 做一次目视确认。"
}

main "$@"
