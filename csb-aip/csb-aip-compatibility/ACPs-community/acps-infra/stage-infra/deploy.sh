#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
COMPOSE_PROJECT_NAME_VALUE="${COMPOSE_PROJECT_NAME:-stage-infra}"
if [[ -d "${BASE_DIR}/lib" ]]; then
    LIB_DIR="${BASE_DIR}/lib"
    SOURCE_ROOT="${BASE_DIR}"
else
    LIB_DIR="${BASE_DIR}/../lib"
    SOURCE_ROOT="$(cd "${BASE_DIR}/../.." && pwd)"
fi
SMOKE_TEST_SCRIPT="${BASE_DIR}/smoke-test.sh"
if [[ ! -f "${SMOKE_TEST_SCRIPT}" ]]; then
    SMOKE_TEST_SCRIPT="${BASE_DIR}/../smoke-test.sh"
fi
MQ_AUTH_INIT_SCRIPT="${BASE_DIR}/init-rabbitmq.sh"
BOOTSTRAP_ONLY="${STAGE_INFRA_BOOTSTRAP_ONLY:-false}"
SMOKE_TEST_RETRIES="${STAGE_INFRA_SMOKE_TEST_RETRIES:-3}"
SMOKE_TEST_RETRY_DELAY_SEC="${STAGE_INFRA_SMOKE_TEST_RETRY_DELAY_SEC:-5}"

# shellcheck source=/dev/null
source "${LIB_DIR}/common.sh"
# shellcheck source=/dev/null
source "${LIB_DIR}/docker.sh"

source_env_file "${BASE_DIR}/.env"
if [[ -f "${BASE_DIR}/images.tar.gz" ]]; then
    load_images "${BASE_DIR}/images.tar.gz"
fi

is_true() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON)
            return 0
            ;;
        *)
            return 1
            ;;
    esac
}

run_stage_infra_smoke_test() {
    local attempt=1

    while (( attempt <= SMOKE_TEST_RETRIES )); do
        if bash "${SMOKE_TEST_SCRIPT}"; then
            return 0
        fi

        if (( attempt == SMOKE_TEST_RETRIES )); then
            return 1
        fi

        log "stage-infra 冒烟测试未通过，${SMOKE_TEST_RETRY_DELAY_SEC}s 后重试 (${attempt}/${SMOKE_TEST_RETRIES})"
        sleep "${SMOKE_TEST_RETRY_DELAY_SEC}"
        attempt=$((attempt + 1))
    done
}

ensure_pgvector_ready() {
    local init_user="${POSTGRES_INIT_USER:?POSTGRES_INIT_USER is required}"
    local init_password="${POSTGRES_INIT_PASSWORD:?POSTGRES_INIT_PASSWORD is required}"
    local discovery_db="${DISCOVERY_DB_NAME:-agent_discovery}"

    if ! PGPASSWORD="${init_password}" docker exec -e PGPASSWORD="${init_password}" stage-postgres \
        psql --username "${init_user}" --dbname "${discovery_db}" --tuples-only --no-align \
        --command "SELECT extname FROM pg_extension WHERE extname='vector'" \
        | grep -Fxq vector; then
        err "stage-postgres 尚未启用 pgvector 扩展，请检查初始化脚本和镜像构建"
        exit 1
    fi
}

compose_args=(-p "${COMPOSE_PROJECT_NAME_VALUE}" -f "${BASE_DIR}/compose.yml" up -d)
if is_true "${BOOTSTRAP_ONLY}"; then
    compose_args+=(nginx postgres)
fi
compose_up_detached "${compose_args[@]}"

wait_healthy stage-postgres "${BASE_DIR}/compose.yml" 90 3
ensure_pgvector_ready
wait_healthy stage-nginx "${BASE_DIR}/compose.yml" 60 3

if is_true "${BOOTSTRAP_ONLY}"; then
    echo "stage-infra 引导部署完成（仅 nginx + postgres）"
    exit 0
fi

wait_healthy stage-redis "${BASE_DIR}/compose.yml" 60 3
wait_healthy stage-rabbitmq "${BASE_DIR}/compose.yml" 60 3
if [[ -f "${MQ_AUTH_INIT_SCRIPT}" ]]; then
    log "初始化 RabbitMQ 共享资源..."
    bash "${MQ_AUTH_INIT_SCRIPT}"
else
    err "未找到 RabbitMQ 初始化脚本: ${MQ_AUTH_INIT_SCRIPT}"
    exit 1
fi

if [[ -f "${SMOKE_TEST_SCRIPT}" ]]; then
    log "执行 stage-infra 冒烟测试..."
    if run_stage_infra_smoke_test; then
        log "✅ stage-infra 冒烟测试通过"
    else
        err "stage-infra 冒烟测试失败"
        exit 1
    fi
else
    log "未找到冒烟测试脚本，跳过自动验证"
fi

echo "stage-infra 部署完成"
