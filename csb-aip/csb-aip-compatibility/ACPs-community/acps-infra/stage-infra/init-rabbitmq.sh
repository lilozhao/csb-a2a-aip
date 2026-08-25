#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
if [[ -d "${BASE_DIR}/lib" ]]; then
    LIB_DIR="${BASE_DIR}/lib"
else
    LIB_DIR="${BASE_DIR}/../lib"
fi

# shellcheck source=/dev/null
source "${LIB_DIR}/common.sh"
# shellcheck source=/dev/null
source "${LIB_DIR}/docker.sh"

source_env_file "${BASE_DIR}/.env"

: "${RABBITMQ_USER:=admin}"
: "${RABBITMQ_PASSWORD:?RABBITMQ_PASSWORD is required}"
: "${MQ_AUTH_MGMT_USER:=mq-auth-svc}"
: "${MQ_AUTH_MGMT_PASS:?MQ_AUTH_MGMT_PASS is required}"

RABBITMQ_CONTAINER="${RABBITMQ_CONTAINER:-stage-rabbitmq}"
VHOST_NAME="acps"
INBOX_EXCHANGE_NAME="inbox.topic"

if [[ "${RABBITMQ_USER}" == "${MQ_AUTH_MGMT_USER}" ]]; then
    err "RABBITMQ_USER 与 MQ_AUTH_MGMT_USER 必须不同"
    exit 1
fi

_rabbitmqctl() {
    docker exec "${RABBITMQ_CONTAINER}" rabbitmqctl "$@"
}

_rabbitmqadmin() {
    docker exec "${RABBITMQ_CONTAINER}" rabbitmqadmin \
        --username "${RABBITMQ_USER}" \
        --password "${RABBITMQ_PASSWORD}" \
        "$@"
}

user_exists() {
    local user="$1"
    _rabbitmqctl list_users --silent | awk '{print $1}' | grep -Fxq "${user}"
}

ensure_user() {
    local user="$1"
    local password="$2"

    if user_exists "${user}"; then
        log "RabbitMQ 用户已存在，更新密码: ${user}"
        _rabbitmqctl change_password "${user}" "${password}"
        return 0
    fi

    log "创建 RabbitMQ 用户: ${user}"
    _rabbitmqctl add_user "${user}" "${password}"
}

vhost_exists() {
    local vhost="$1"
    _rabbitmqctl list_vhosts --silent | grep -Fxq "${vhost}"
}

clear_permissions_if_present() {
    local vhost="$1"
    local user="$2"

    if _rabbitmqctl list_permissions -p "${vhost}" --silent | awk '{print $1}' | grep -Fxq "${user}"; then
        log "清理 ${user} 在 ${vhost} 上的现有权限"
        _rabbitmqctl clear_permissions -p "${vhost}" "${user}"
    fi
}

main() {
    if ! container_running "${RABBITMQ_CONTAINER}"; then
        err "RabbitMQ 容器未运行: ${RABBITMQ_CONTAINER}"
        exit 1
    fi

    log "等待 RabbitMQ 完成启动..."
    _rabbitmqctl await_startup

    ensure_user "${RABBITMQ_USER}" "${RABBITMQ_PASSWORD}"
    _rabbitmqctl set_user_tags "${RABBITMQ_USER}" administrator

    if vhost_exists "${VHOST_NAME}"; then
        log "RabbitMQ vhost 已存在: ${VHOST_NAME}"
    else
        log "创建 RabbitMQ vhost: ${VHOST_NAME}"
        _rabbitmqctl add_vhost "${VHOST_NAME}"
    fi

    log "确保管理员账户拥有 ${VHOST_NAME} 全部权限"
    _rabbitmqctl set_permissions -p "${VHOST_NAME}" "${RABBITMQ_USER}" ".*" ".*" ".*"

    ensure_user "${MQ_AUTH_MGMT_USER}" "${MQ_AUTH_MGMT_PASS}"
    _rabbitmqctl set_user_tags "${MQ_AUTH_MGMT_USER}" administrator
    clear_permissions_if_present "${VHOST_NAME}" "${MQ_AUTH_MGMT_USER}"

    log "确保 ${INBOX_EXCHANGE_NAME} 交换机存在"
    _rabbitmqadmin declare exchange \
        -V "${VHOST_NAME}" \
        --name "${INBOX_EXCHANGE_NAME}" \
        --type topic \
        --durable true \
        --non-interactive

    log "RabbitMQ 初始化完成"
}

main "$@"
