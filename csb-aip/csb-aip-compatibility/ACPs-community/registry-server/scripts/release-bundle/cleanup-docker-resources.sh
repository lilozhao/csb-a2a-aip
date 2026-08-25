#!/usr/bin/env bash
# 清理当前 release-bundle 相关 Docker 资源（cleanup-docker-resources.sh）
set -euo pipefail

DEFAULT_COMPOSE_PROJECT_NAME="registry-release-bundle"
APP_IMAGE_REPOSITORY="registry-server"

COMPOSE_PROJECT_NAME_VALUE="${COMPOSE_PROJECT_NAME:-$DEFAULT_COMPOSE_PROJECT_NAME}"
ALSO_PROJECTS=()
REMOVE_APP_IMAGES=true
PURGE_ALL_DOCKER_RESOURCES=false
CONFIRM_PURGE=false
CLEANUP_RESIDUALS=false

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

err() {
    echo "[$(date '+%H:%M:%S')] 错误: $*" >&2
}

usage() {
    cat <<'EOF'
用法:
  bash cleanup-docker-resources.sh [选项]

选项:
  --project-name <name>   指定当前要清理的 Compose 项目名
  --also-project <name>   额外清理另一个 Compose 项目名，可重复传入
  --skip-app-images       跳过应用镜像清理
  --cleanup-residuals     额外清理跨部署模式残留（按容器名）
  --purge-all-docker-resources
                          清空 Docker 中的所有容器、镜像、自定义网络、卷和构建缓存
  --confirm-purge         与 --purge-all-docker-resources 配合使用，显式确认执行危险操作
  --help                  显示帮助
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

    while IFS= read -r image_ref; do
        if [[ -n "$image_ref" ]]; then
            log "删除应用镜像: ${image_ref}"
            docker rmi -f "$image_ref" >/dev/null
        fi
    done < <(docker images --format '{{.Repository}}:{{.Tag}}' | grep "^${APP_IMAGE_REPOSITORY}:" || true)
}

remove_container_by_name_if_exists() {
    local container_name="$1"

    if docker ps -a --format '{{.Names}}' | grep -Fx "$container_name" >/dev/null 2>&1; then
        log "删除跨模式残留容器: ${container_name}"
        docker rm -f "$container_name" >/dev/null
    fi
}

remove_residual_containers() {
    local residual_names=(
        "${APP_IMAGE_REPOSITORY}-blue"
        "${APP_IMAGE_REPOSITORY}-green"
        "shared-nginx"
        "shared-postgres"
    )
    local name

    for name in "${residual_names[@]}"; do
        remove_container_by_name_if_exists "$name"
    done
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

assert_images_clean() {
    local remaining_images

    remaining_images="$(docker images --format '{{.Repository}}:{{.Tag}}' | grep "^${APP_IMAGE_REPOSITORY}:" || true)"
    if [[ -n "$remaining_images" ]]; then
        err "应用镜像仍有残留: ${remaining_images//$'\n'/, }"
        return 1
    fi

    log "应用镜像 ${APP_IMAGE_REPOSITORY}:* 已清理完成"
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
            --cleanup-residuals)
                CLEANUP_RESIDUALS=true
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

    if [[ "$PURGE_ALL_DOCKER_RESOURCES" == true ]]; then
        purge_all_docker_resources
        exit 0
    fi

    append_unique_project "$COMPOSE_PROJECT_NAME_VALUE"

    log "开始清理 release-bundle Docker 资源"
    for project_name in "${ALSO_PROJECTS[@]}"; do
        log "清理 Compose 项目: ${project_name}"
        remove_containers_for_project "$project_name"
        remove_networks_for_project "$project_name"
        remove_volumes_for_project "$project_name"
        assert_project_clean "$project_name"
    done

    if [[ "$REMOVE_APP_IMAGES" == true ]]; then
        remove_app_images
        assert_images_clean
    else
        log "跳过应用镜像清理"
    fi

    if [[ "$CLEANUP_RESIDUALS" == true ]]; then
        log "执行跨部署模式残留清理"
        remove_residual_containers
    fi

    log "清理完成。建议随后执行 docker ps、docker volume ls、docker network ls 做一次目视确认。"
}

main "$@"