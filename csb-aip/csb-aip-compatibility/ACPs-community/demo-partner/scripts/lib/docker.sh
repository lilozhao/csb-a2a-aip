#!/usr/bin/env bash

container_exists() {
    local container="$1"
    docker inspect --type container "$container" &>/dev/null
}

container_running() {
    local container="$1"
    [[ "$(docker inspect --format='{{.State.Running}}' "$container" 2>/dev/null || echo false)" == "true" ]]
}

remove_container_if_exists() {
    local container="$1"

    if container_exists "$container"; then
        docker rm -f "$container" >/dev/null 2>&1 || true
    fi
}

stop_container_if_running() {
    local container="$1"

    if container_running "$container"; then
        docker stop "$container" >/dev/null
    fi
}

get_container_image() {
    local container="$1"
    docker inspect "$container" --format='{{.Config.Image}}' 2>/dev/null || echo ""
}

resolve_inspect_target() {
    local target="$1"
    local compose_file="$2"
    local container_id=""

    if ! require_exact_args "resolve_inspect_target" 2 "$#"; then
        return 1
    fi

    if [[ -n "$compose_file" ]]; then
        container_id="$(docker compose -f "$compose_file" ps -q "$target" 2>/dev/null | head -n 1)"
    fi

    if [[ -n "$container_id" ]]; then
        echo "$container_id"
    else
        echo "$target"
    fi
}

load_images() {
    local images_tar="${1:-}"

    if ! require_exact_args "load_images" 1 "$#"; then
        return 1
    fi

    if [[ ! -f "$images_tar" ]]; then
        err "未找到镜像包: ${images_tar}"
        return 1
    fi

    log "导入 Docker 镜像..."
    docker load < "$images_tar"
    log "镜像导入完成"
}

compose_up_detached() {
    if ! require_min_args "compose_up_detached" 1 "$#"; then
        return 1
    fi

    # 关闭 ANSI/交互式进度渲染，避免 docker compose up -d 在某些 TTY 环境中卡住。
    COMPOSE_PROGRESS=plain docker compose --ansi never "$@" </dev/null
}

wait_healthy() {
    local container="${1:-}"
    local compose_file="${2:-}"
    local timeout="${3:-60}"
    local interval="${4:-3}"
    local elapsed=0
    local inspect_target
    local status="missing"

    if ! require_min_args "wait_healthy" 2 "$#"; then
        return 1
    fi

    log "等待 ${container} 健康检查通过（最长 ${timeout}s）..."
    while [[ $elapsed -lt $timeout ]]; do
        inspect_target="$(resolve_inspect_target "$container" "$compose_file")"
        status=$(docker inspect --format='{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$inspect_target" 2>/dev/null || echo "missing")
        if [[ "$status" == "healthy" || "$status" == "running" ]]; then
            log "${container} 健康检查通过"
            return 0
        fi
        sleep "$interval"
        elapsed=$((elapsed + interval))
    done

    err "${container} 在 ${timeout}s 内未通过健康检查（最后状态: ${status}）"
    return 1
}

remove_network_if_exists() {
    local network_name="$1"
    if docker network inspect "${network_name}" >/dev/null 2>&1; then
        log "删除 Docker 网络: ${network_name}"
        docker network rm "${network_name}" >/dev/null 2>&1 || true
    fi
}
