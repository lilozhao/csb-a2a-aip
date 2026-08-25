#!/usr/bin/env bash
# init-databases.sh — 手动初始化应用数据库
# 用法: bash scripts/stage-infra/init-databases.sh
#
# 适用场景：postgres volume 已存在（非首次启动），需要补充创建应用数据库和用户。
# 幂等设计：用户或数据库已存在时跳过，不报错。
#
# 前置条件：stage-postgres 容器正在运行，.env 已配置。
#
# 注意：密码不得包含单引号（'）。
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"

if [[ -f "${BASE_DIR}/.env" ]]; then
    set -a
    # shellcheck source=/dev/null
    source "${BASE_DIR}/.env"
    set +a
fi

: "${POSTGRES_INIT_USER:?请在 .env 中设置 POSTGRES_INIT_USER}"
: "${POSTGRES_INIT_PASSWORD:?请在 .env 中设置 POSTGRES_INIT_PASSWORD}"
: "${REGISTRY_DB_USER:?请在 .env 中设置 REGISTRY_DB_USER}"
: "${REGISTRY_DB_PASSWORD:?请在 .env 中设置 REGISTRY_DB_PASSWORD}"
: "${REGISTRY_DB_NAME:?请在 .env 中设置 REGISTRY_DB_NAME}"
: "${CA_DB_USER:?请在 .env 中设置 CA_DB_USER}"
: "${CA_DB_PASSWORD:?请在 .env 中设置 CA_DB_PASSWORD}"
: "${CA_DB_NAME:?请在 .env 中设置 CA_DB_NAME}"
: "${DISCOVERY_DB_USER:?请在 .env 中设置 DISCOVERY_DB_USER}"
: "${DISCOVERY_DB_PASSWORD:?请在 .env 中设置 DISCOVERY_DB_PASSWORD}"
: "${DISCOVERY_DB_NAME:?请在 .env 中设置 DISCOVERY_DB_NAME}"

# 检查 stage-postgres 容器是否运行
if ! docker inspect stage-postgres &>/dev/null || \
   [[ "$(docker inspect -f '{{.State.Running}}' stage-postgres 2>/dev/null)" != "true" ]]; then
    echo "错误: stage-postgres 容器未运行，请先部署 stage-infra" >&2
    exit 1
fi

_psql() {
    PGPASSWORD="${POSTGRES_INIT_PASSWORD}" \
        docker exec -i stage-postgres \
        psql -v ON_ERROR_STOP=1 --username "${POSTGRES_INIT_USER}" "$@"
}

_user_exists() {
    local user="$1"
    _psql --tuples-only --no-align \
        --command "SELECT 1 FROM pg_catalog.pg_user WHERE usename='${user}'" \
        | head -1
}

_db_exists() {
    local db="$1"
    _psql --tuples-only --no-align \
        --command "SELECT 1 FROM pg_catalog.pg_database WHERE datname='${db}'" \
        | head -1
}

_create_user() {
    local user="$1"
    local password="$2"
    if [[ "$(_user_exists "$user")" == "1" ]]; then
        echo "  用户 ${user} 已存在，跳过"
        return 0
    fi
    _psql --command "CREATE USER \"${user}\" WITH PASSWORD '${password}'"
    echo "  ✓ 用户 ${user} 创建成功"
}

_create_db() {
    local db="$1"
    local owner="$2"
    if [[ "$(_db_exists "$db")" == "1" ]]; then
        echo "  数据库 ${db} 已存在，跳过"
        return 0
    fi
    _psql --command "CREATE DATABASE \"${db}\" OWNER \"${owner}\""
    echo "  ✓ 数据库 ${db} 创建成功"
}

_ensure_extension() {
    local db="$1"
    local extension="$2"
    _psql --dbname "${db}" --command "CREATE EXTENSION IF NOT EXISTS \"${extension}\""
    echo "  ✓ 数据库 ${db} 已确保扩展 ${extension} 可用"
}

echo "=== 初始化 registry-server 数据库 ==="
_create_user "${REGISTRY_DB_USER}" "${REGISTRY_DB_PASSWORD}"
_create_db   "${REGISTRY_DB_NAME}" "${REGISTRY_DB_USER}"

echo "=== 初始化 ca-server 数据库 ==="
_create_user "${CA_DB_USER}" "${CA_DB_PASSWORD}"
_create_db   "${CA_DB_NAME}" "${CA_DB_USER}"

echo "=== 初始化 discovery-server 数据库 ==="
_create_user "${DISCOVERY_DB_USER}" "${DISCOVERY_DB_PASSWORD}"
_create_db   "${DISCOVERY_DB_NAME}" "${DISCOVERY_DB_USER}"
_ensure_extension "${DISCOVERY_DB_NAME}" "vector"

echo "=== 数据库初始化完成 ==="
