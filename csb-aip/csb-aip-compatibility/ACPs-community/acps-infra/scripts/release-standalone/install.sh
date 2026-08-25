#!/usr/bin/env bash
set -euo pipefail

BASE_DIR="$(cd "$(dirname "$0")" && pwd)"
LIB_DIR="${BASE_DIR}/lib"
BUNDLES_DIR="${BASE_DIR}/bundles"
ENV_FILE="${BASE_DIR}/.env"
VERSION_FILE="${BASE_DIR}/VERSION"
MANIFEST_FILE="${BASE_DIR}/manifest.toml"
CHECKSUM_FILE="${BASE_DIR}/checksums.txt"

usage() {
    cat <<'EOF'
用法: bash install.sh

步骤:
  1. 复制 .env.example 为 .env
  2. 填写 LLM、密码、安装目录等参数
  3. 执行 bash install.sh

说明:
- install.sh 仅用于 same-host 全新安装，不用于原地升级已有组件。
- 安装前会清理本流程管理的 Docker 容器、网络和卷。
- install.sh 会解压 bundles/ 下的 7 个组件包，并串联部署。
- 默认会在基础烟测后继续执行业务烟测。
- install.sh / upgrade.sh 默认不会在业务烟测失败时自动导出各组件长日志；如需恢复旧行为，可在 .env 中设置 DUMP_SMOKE_LOGS=true。
- 若需跳过业务烟测，请在 .env 中设置 RUN_BUSINESS_SMOKE=false。
- 如需更新某个组件，请参考对应项目文档或其 upgrade/deploy 脚本。
EOF
}

if [[ "${BASH_SOURCE[0]}" == "${0}" && ( "${1:-}" == "-h" || "${1:-}" == "--help" ) ]]; then
    usage
    exit 0
fi

# shellcheck source=lib/certs-permissions-lib.sh
source "${LIB_DIR}/certs-permissions-lib.sh"

# standalone 安装器专用：各 bind mount 目标容器的 uid/gid（非共享 lib 配置）
STANDALONE_APP_BIND_MOUNT_UID=1000
STANDALONE_APP_BIND_MOUNT_GID=1000
STANDALONE_STAGE_INFRA_REDIS_BIND_MOUNT_UID=999
STANDALONE_STAGE_INFRA_REDIS_BIND_MOUNT_GID=1000
STANDALONE_STAGE_INFRA_RABBITMQ_BIND_MOUNT_UID=100
STANDALONE_STAGE_INFRA_RABBITMQ_BIND_MOUNT_GID=101

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

err() {
    echo "[$(date '+%H:%M:%S')] 错误: $*" >&2
}

source_env_file() {
    local env_file="$1"

    if [[ ! -f "${env_file}" ]]; then
        return 0
    fi

    set -a
    # shellcheck source=/dev/null
    source "${env_file}"
    set +a
}

require_file_exists() {
    local path="$1"
    local label="${2:-$1}"

    if [[ ! -f "${path}" ]]; then
        err "缺少文件: ${label}"
        exit 1
    fi
}

require_dir_exists() {
    local path="$1"
    local label="${2:-$1}"

    if [[ ! -d "${path}" ]]; then
        err "缺少目录: ${label}"
        exit 1
    fi
}

require_command() {
    local command_name="$1"

    if ! command -v "${command_name}" >/dev/null 2>&1; then
        err "未找到命令: ${command_name}"
        exit 1
    fi
}

read_manifest_value() {
    local key="$1"

    awk -F ' = ' -v key="${key}" '
        $1 == key {
            value = $2
            gsub(/^"|"$/, "", value)
            print value
            exit
        }
    ' "${MANIFEST_FILE}"
}

verify_manifest_bundle_files() {
    local bundle_file=""

    while IFS= read -r bundle_file; do
        [[ -n "${bundle_file}" ]] || continue
        require_file_exists "${BASE_DIR}/${bundle_file}" "${bundle_file}"
    done < <(awk -F ' = ' '/^file = "bundles\// {
        value = $2
        gsub(/^"|"$/, "", value)
        print value
    }' "${MANIFEST_FILE}")
}

verify_release_manifest() {
    local manifest_version
    local manifest_platform

    manifest_version="$(read_manifest_value version)"
    manifest_platform="$(read_manifest_value platform)"

    if [[ -z "${manifest_version}" || -z "${manifest_platform}" ]]; then
        err "manifest.toml 缺少 version 或 platform 字段"
        exit 1
    fi

    if [[ "${manifest_version}" != "${BUNDLE_VERSION}" ]]; then
        err "manifest.toml 与 VERSION 的 version 不一致: manifest=${manifest_version}, VERSION=${BUNDLE_VERSION}"
        exit 1
    fi

    if [[ "${manifest_platform}" != "${BUNDLE_PLATFORM}" ]]; then
        err "manifest.toml 与 VERSION 的 platform 不一致: manifest=${manifest_platform}, VERSION=${BUNDLE_PLATFORM}"
        exit 1
    fi

    verify_manifest_bundle_files
}

verify_release_checksums() {
    log "验证 standalone 包 checksums..."

    if command -v sha256sum >/dev/null 2>&1; then
        (
            cd "${BASE_DIR}"
            sha256sum -c "${CHECKSUM_FILE}"
        ) >/dev/null
        return 0
    fi

    if command -v shasum >/dev/null 2>&1; then
        (
            cd "${BASE_DIR}"
            shasum -a 256 -c "${CHECKSUM_FILE}"
        ) >/dev/null
        return 0
    fi

    err "未找到 sha256sum 或 shasum 命令，无法校验 standalone 包 checksums"
    exit 1
}

require_docker_access() {
    if ! docker info >/dev/null 2>&1; then
        err "Docker daemon 未运行或当前用户无权访问"
        exit 1
    fi
}

require_linux_root_for_bind_mount_cert_owners() {
    local os_name=""

    os_name="$(uname -s 2>/dev/null || echo unknown)"
    if [[ "${os_name}" != "Linux" ]]; then
        return 0
    fi

    if [[ "$(id -u)" -eq 0 ]]; then
        return 0
    fi

    err "Linux same-host standalone 安装/升级需要 root 权限，以便安全调整 bind mount 证书属主到容器所需的 uid 1000/999"
    err "请使用 sudo bash install.sh（或 sudo bash upgrade.sh）"
    exit 1
}

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

resolve_path() {
    local input_path="$1"

    if [[ "${input_path}" == /* ]]; then
        printf '%s\n' "${input_path}"
    else
        printf '%s\n' "${BASE_DIR}/${input_path}"
    fi
}

normalize_bind_mount_private_key_owner() {
    local key_file="${1:?缺少私钥路径}"
    local target_uid="${2:?缺少目标 uid}"
    local target_gid="${3:?缺少目标 gid}"
    local label="${4:-私钥}"

    if [[ ! -f "${key_file}" ]]; then
        return 0
    fi

    if [[ "$(id -u)" -eq 0 ]]; then
        chown "${target_uid}:${target_gid}" "${key_file}"
        chmod 600 "${key_file}"
        log "已规范化 ${label} 权限: ${key_file} (owner=${target_uid}:${target_gid})"
        return 0
    fi

    if [[ -O "${key_file}" ]]; then
        chmod 600 "${key_file}"
        log "已规范化 ${label} 权限: ${key_file}"
        return 0
    fi

    log "警告: 无法调整 ${label} 属主: ${key_file}"
}

infer_embedding_dimension() {
    local model_name="$1"

    case "$model_name" in
        text-embedding-3-small|text-embedding-ada-002)
            echo "1536"
            ;;
        text-embedding-3-large)
            echo "3072"
            ;;
        *)
            echo "1024"
            ;;
    esac
}

generate_random_token() {
    local byte_count="${1:-24}"

    openssl rand -hex "${byte_count}"
}

ensure_generated_secret() {
    local var_name="$1"
    local placeholder="$2"
    local byte_count="$3"
    local label="$4"

    if [[ -n "${!var_name:-}" && "${!var_name}" != "${placeholder}" ]]; then
        return 0
    fi

    printf -v "${var_name}" '%s' "$(generate_random_token "${byte_count}")"
    log "检测到 ${label} 未设置或仍为占位值，已自动生成随机值"
}

set_env_value() {
    local env_file="$1"
    local key="$2"
    local value="$3"
    local tmp_file
    local serialized_value
    local awk_value

    # 运行时 .env 会被 docker compose 读取；这里统一做 quoting，避免空格、#、$ 等字符被误解析。
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
    awk -v key="${key}" -v value="${awk_value}" '
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
    ' "${env_file}" > "${tmp_file}"
    mv "${tmp_file}" "${env_file}"
}

set_conf_value() {
    local conf_file="$1"
    local key="$2"
    local value="$3"
    local tmp_file

    tmp_file="$(mktemp)"
    awk -v key="${key}" -v value="${value}" '
        BEGIN { updated = 0 }
        $0 ~ ("^[[:space:]]*" key "[[:space:]]*=") {
            print key " = " value
            updated = 1
            next
        }
        { print }
        END {
            if (updated == 0) {
                print key " = " value
            }
        }
    ' "${conf_file}" > "${tmp_file}"
    mv "${tmp_file}" "${conf_file}"
}

resolve_python_bin() {
    local candidate
    for candidate in \
        "${PROVISION_PYTHON:-}" \
        "/opt/venv/bin/python" \
        "/opt/venv/bin/python3" \
        "python3" \
        "python"; do
        [[ -n "${candidate}" ]] || continue
        if [[ "${candidate}" == */* ]]; then
            if [[ -x "${candidate}" ]]; then
                printf '%s\n' "${candidate}"
                return 0
            fi
            continue
        fi
        if command -v "${candidate}" >/dev/null 2>&1; then
            command -v "${candidate}"
            return 0
        fi
    done
    err "未找到可用 Python 解释器（优先 /opt/venv/bin/python）"
    exit 1
}

require_non_empty_vars() {
    local missing=()
    local var_name

    for var_name in "$@"; do
        if [[ -z "${!var_name:-}" ]]; then
            missing+=("${var_name}")
        fi
    done

    if [[ ${#missing[@]} -gt 0 ]]; then
        err "以下变量未配置，请先编辑 ${ENV_FILE}: ${missing[*]}"
        exit 1
    fi
}

prepare_user_supplied_ca_materials() {
    local certs_dir="${CA_DIR}/certs"
    local cert_target_path="${certs_dir}/ca.crt"
    local key_target_path="${certs_dir}/ca.key"
    local chain_target_path="${certs_dir}/ca-chain.pem"
    local trust_bundle_target_path="${certs_dir}/trust-bundle.pem"

    if is_true "${AUTO_GENERATE_CA_MATERIALS:-true}"; then
        return 0
    fi

    mkdir -p "${certs_dir}"
    cp "${CA_CERT_SOURCE_PATH}" "${cert_target_path}"
    cp "${CA_KEY_SOURCE_PATH}" "${key_target_path}"
    cp "${CA_CHAIN_SOURCE_PATH}" "${chain_target_path}"
    cp "${CA_TRUST_BUNDLE_SOURCE_PATH}" "${trust_bundle_target_path}"

    normalize_bind_mount_certs_dir \
        "${certs_dir}" \
        "${STANDALONE_APP_BIND_MOUNT_UID}" \
        "${STANDALONE_APP_BIND_MOUNT_GID}"
    log "已复制用户提供的 CA 证书套件到 ${certs_dir}"
}

should_deploy_demo_apps() {
    if [[ -n "${DEPLOY_DEMO_APPS:-}" ]]; then
        is_true "${DEPLOY_DEMO_APPS}"
        return $?
    fi
    is_true "${RUN_BUSINESS_SMOKE:-true}"
}

have_stage_infra_host_cli() {
    command -v acps-cli >/dev/null 2>&1
}

resolve_tool_runner_image() {
    local candidate
    for candidate in \
        "${TOOL_RUNNER_IMAGE:-}" \
        "demo-leader:latest" \
        "acps-demo-leader:latest" \
        "acps-demo-partners:latest"; do
        [[ -n "${candidate}" ]] || continue
        if docker image inspect "${candidate}" >/dev/null 2>&1; then
            printf '%s\n' "${candidate}"
            return 0
        fi
    done
    return 1
}

ensure_tool_runner_image_loaded() {
    local images_tar
    for images_tar in \
        "${DEMO_LEADER_DIR}/images.tar.gz" \
        "${DEMO_PARTNERS_DIR}/images.tar.gz"; do
        [[ -f "${images_tar}" ]] || continue
        log "导入工具镜像以执行 stage-infra 证书申请: ${images_tar}"
        docker load < "${images_tar}" >/dev/null
        return 0
    done
    return 1
}

extract_bundle() {
    local archive_path="$1"
    local target_dir="$2"

    require_file_exists "${archive_path}" "$(basename "${archive_path}")"
    rm -rf "${target_dir}"
    mkdir -p "${target_dir}"
    tar xzf "${archive_path}" -C "${target_dir}" --strip-components=1
}

prepare_common_paths() {
    INSTALL_ROOT="$(resolve_path "${INSTALL_ROOT:-./runtime}")"
    STAGE_INFRA_DIR="${INSTALL_ROOT}/stage-infra"
    REGISTRY_DIR="${INSTALL_ROOT}/registry-server"
    CA_DIR="${INSTALL_ROOT}/ca-server"
    DISCOVERY_DIR="${INSTALL_ROOT}/discovery-server"
    DEMO_ROOT_DIR="${INSTALL_ROOT}/demo"
    DEMO_PARTNERS_DIR="${DEMO_ROOT_DIR}/partners"
    DEMO_LEADER_DIR="${DEMO_ROOT_DIR}/leader"
    MQ_AUTH_SERVER_DIR="${INSTALL_ROOT}/mq-auth-server"
    INFRA_CLI_CONF="${INSTALL_ROOT}/acps-cli.toml"
    IMAGES_LOCK_FILE="${INSTALL_ROOT}/images.lock"
    LOCAL_GATEWAY_BASE_URL="http://localhost:${STAGE_NGINX_PORT}"

    PUBLIC_GATEWAY_BASE_URL="http://${GATEWAY_PUBLIC_HOST}:${STAGE_NGINX_PORT}"
    if [[ "${GATEWAY_SERVICE_PORT}" == "80" ]]; then
        SERVICE_GATEWAY_BASE_URL="http://${GATEWAY_SERVICE_HOST}"
    else
        SERVICE_GATEWAY_BASE_URL="http://${GATEWAY_SERVICE_HOST}:${GATEWAY_SERVICE_PORT}"
    fi
    BRIDGE_GATEWAY_BASE_URL="http://${GATEWAY_BRIDGE_HOST}:${STAGE_NGINX_PORT}"
}

read_bundle_version_value() {
    local version_file="$1"
    local key="$2"

    [[ -f "${version_file}" ]] || return 1
    awk -F= -v key="${key}" '$1 == key { print $2; exit }' "${version_file}"
}

read_bundle_image_ref() {
    local version_file="$1"
    local image_ref

    image_ref="$(read_bundle_version_value "${version_file}" image 2>/dev/null || true)"
    if [[ -z "${image_ref}" ]]; then
        err "bundle 缺少 image 元数据: ${version_file}"
        exit 1
    fi

    printf '%s\n' "${image_ref}"
}

append_unique_lock_entry() {
    local lock_file="$1"
    local entry="$2"

    [[ -n "${entry}" ]] || return 0
    if grep -Fxq "${entry}" "${lock_file}" 2>/dev/null; then
        return 0
    fi
    printf '%s\n' "${entry}" >> "${lock_file}"
}

build_runtime_images_lock() {
    local runtime_version_file
    local image_ref

    : > "${IMAGES_LOCK_FILE}"

    for runtime_version_file in \
        "${REGISTRY_DIR}/VERSION" \
        "${CA_DIR}/VERSION" \
        "${DISCOVERY_DIR}/VERSION" \
        "${MQ_AUTH_SERVER_DIR}/VERSION"; do
        image_ref="$(read_bundle_image_ref "${runtime_version_file}")"
        append_unique_lock_entry "${IMAGES_LOCK_FILE}" "${image_ref}"
    done

    if should_deploy_demo_apps; then
        for runtime_version_file in \
            "${DEMO_PARTNERS_DIR}/VERSION" \
            "${DEMO_LEADER_DIR}/VERSION"; do
            image_ref="$(read_bundle_image_ref "${runtime_version_file}")"
            append_unique_lock_entry "${IMAGES_LOCK_FILE}" "${image_ref}"
        done
    fi

    if [[ -s "${IMAGES_LOCK_FILE}" ]]; then
        log "已生成 runtime 镜像清单: ${IMAGES_LOCK_FILE}"
    else
        err "runtime 镜像清单为空: ${IMAGES_LOCK_FILE}"
        exit 1
    fi
}

remove_runtime_images_from_lock() {
    local image_ref=""

    if [[ ! -f "${IMAGES_LOCK_FILE}" ]]; then
        log "未找到 runtime 镜像清单，跳过镜像清理: ${IMAGES_LOCK_FILE}"
        return 0
    fi

    while IFS= read -r image_ref; do
        [[ -n "${image_ref}" ]] || continue
        if docker image inspect "${image_ref}" >/dev/null 2>&1; then
            log "删除 runtime 镜像: ${image_ref}"
            docker rmi -f "${image_ref}" >/dev/null 2>&1 || true
        fi
    done < "${IMAGES_LOCK_FILE}"
}

prepare_bundle_layout() {
    mkdir -p "${INSTALL_ROOT}" "${DEMO_ROOT_DIR}"

    extract_bundle "${BUNDLES_DIR}/acps-stage-infra-${BUNDLE_VERSION}.tar.gz" "${STAGE_INFRA_DIR}"
    extract_bundle "${BUNDLES_DIR}/registry-server-app-${BUNDLE_VERSION}.tar.gz" "${REGISTRY_DIR}"
    extract_bundle "${BUNDLES_DIR}/ca-server-app-${BUNDLE_VERSION}.tar.gz" "${CA_DIR}"
    extract_bundle "${BUNDLES_DIR}/discovery-server-app-${BUNDLE_VERSION}.tar.gz" "${DISCOVERY_DIR}"
    extract_bundle "${BUNDLES_DIR}/mq-auth-server-app-${BUNDLE_VERSION}.tar.gz" "${MQ_AUTH_SERVER_DIR}"
    extract_bundle "${BUNDLES_DIR}/demo-partner-${BUNDLE_VERSION}.tar.gz" "${DEMO_PARTNERS_DIR}"
    extract_bundle "${BUNDLES_DIR}/demo-leader-${BUNDLE_VERSION}.tar.gz" "${DEMO_LEADER_DIR}"
}

prepare_stage_infra_env() {
    local env_file="${STAGE_INFRA_DIR}/.env"

    cp "${STAGE_INFRA_DIR}/.env.example" "${env_file}"
    set_env_value "${env_file}" "POSTGRES_INIT_USER" "${POSTGRES_INIT_USER}"
    set_env_value "${env_file}" "POSTGRES_INIT_PASSWORD" "${POSTGRES_INIT_PASSWORD}"
    set_env_value "${env_file}" "POSTGRES_INIT_DB" "${POSTGRES_INIT_DB}"
    set_env_value "${env_file}" "REGISTRY_DB_USER" "${REGISTRY_DB_USER}"
    set_env_value "${env_file}" "REGISTRY_DB_PASSWORD" "${REGISTRY_DB_PASSWORD}"
    set_env_value "${env_file}" "REGISTRY_DB_NAME" "${REGISTRY_DB_NAME}"
    set_env_value "${env_file}" "CA_DB_USER" "${CA_DB_USER}"
    set_env_value "${env_file}" "CA_DB_PASSWORD" "${CA_DB_PASSWORD}"
    set_env_value "${env_file}" "CA_DB_NAME" "${CA_DB_NAME}"
    set_env_value "${env_file}" "DISCOVERY_DB_USER" "${DISCOVERY_DB_USER}"
    set_env_value "${env_file}" "DISCOVERY_DB_PASSWORD" "${DISCOVERY_DB_PASSWORD}"
    set_env_value "${env_file}" "DISCOVERY_DB_NAME" "${DISCOVERY_DB_NAME}"
    set_env_value "${env_file}" "REDIS_PASSWORD" "${REDIS_PASSWORD}"
    set_env_value "${env_file}" "NGINX_PORT" "${STAGE_NGINX_PORT}"
    set_env_value "${env_file}" "RABBITMQ_USER" "${RABBITMQ_USER}"
    set_env_value "${env_file}" "RABBITMQ_PASSWORD" "${RABBITMQ_PASSWORD}"
    set_env_value "${env_file}" "RABBITMQ_PORT" "${RABBITMQ_PORT}"
    set_env_value "${env_file}" "MQ_AUTH_PORT" "${MQ_AUTH_PORT}"
    set_env_value "${env_file}" "MQ_AUTH_MGMT_USER" "${MQ_AUTH_MGMT_USER}"
    set_env_value "${env_file}" "MQ_AUTH_MGMT_PASS" "${MQ_AUTH_MGMT_PASS}"
}

prepare_registry_env() {
    local env_file="${REGISTRY_DIR}/.env"
    local certs_dir="${REGISTRY_DIR}/certs"

    mkdir -p "${certs_dir}"
    cp "${REGISTRY_DIR}/.env.example" "${env_file}"
    set_env_value "${env_file}" "APP_BASE_URL" "${PUBLIC_GATEWAY_BASE_URL}/registry"
    set_env_value "${env_file}" "DATABASE_URL" "postgresql+asyncpg://${REGISTRY_DB_USER}:${REGISTRY_DB_PASSWORD}@stage-postgres:5432/${REGISTRY_DB_NAME}"
    set_env_value "${env_file}" "CA_SERVER_BASE_URL" "${SERVICE_GATEWAY_BASE_URL}/ca-server"
    set_env_value "${env_file}" "REGISTRY_SERVER_INTERNAL_API_TOKEN" "${REGISTRY_SERVER_INTERNAL_API_TOKEN}"
    set_env_value "${env_file}" "SMTP_SERVER" "${REGISTRY_SMTP_SERVER:-}"
    set_env_value "${env_file}" "SMTP_PORT" "${REGISTRY_SMTP_PORT:-}"
    set_env_value "${env_file}" "EMAIL_ADDRESS" "${REGISTRY_EMAIL_ADDRESS:-}"
    set_env_value "${env_file}" "EMAIL_PASSWORD" "${REGISTRY_EMAIL_PASSWORD:-}"
    set_env_value "${env_file}" "REGISTRY_CERTS_HOST_DIR" "${certs_dir}"
    set_env_value "${env_file}" "REGISTRY_SERVER_ENABLE_MTLS_LISTENER" "false"
    set_env_value "${env_file}" "REGISTRY_SERVER_MTLS_PUBLIC_HOST" "${REGISTRY_SERVER_MTLS_PUBLIC_HOST}"
    set_env_value "${env_file}" "REGISTRY_SERVER_MTLS_PORT" "${REGISTRY_SERVER_MTLS_PORT}"
    set_env_value "${env_file}" "REGISTRY_SERVER_MTLS_CERT_FILE" "/certs/server.pem"
    set_env_value "${env_file}" "REGISTRY_SERVER_MTLS_KEY_FILE" "/certs/server.key"
    set_env_value "${env_file}" "REGISTRY_SERVER_MTLS_CA_CERT_FILE" "/certs/trust-bundle.pem"
    set_env_value "${env_file}" "REGISTRY_SERVER_MTLS_PROBE_CERT_FILE" "/certs/probe-client.pem"
    set_env_value "${env_file}" "REGISTRY_SERVER_MTLS_PROBE_KEY_FILE" "/certs/probe-client.key"

    if [[ -n "${REGISTRY_SECRET_KEY:-}" ]]; then
        set_env_value "${env_file}" "SECRET_KEY" "${REGISTRY_SECRET_KEY}"
    fi
    if [[ -n "${REGISTRY_AIC_CRC_SALT:-}" ]]; then
        set_env_value "${env_file}" "AIC_CRC_SALT" "${REGISTRY_AIC_CRC_SALT}"
    fi
}

enable_registry_mtls_listener() {
    local env_file="${REGISTRY_DIR}/.env"

    set_env_value "${env_file}" "REGISTRY_SERVER_ENABLE_MTLS_LISTENER" "true"
}

prepare_ca_env() {
    local env_file="${CA_DIR}/.env"

    cp "${CA_DIR}/.env.example" "${env_file}"
    set_env_value "${env_file}" "APP_BASE_URL" "${PUBLIC_GATEWAY_BASE_URL}/ca-server"
    set_env_value "${env_file}" "DATABASE_URL" "postgresql://${CA_DB_USER}:${CA_DB_PASSWORD}@stage-postgres:5432/${CA_DB_NAME}"
    set_env_value "${env_file}" "AUTO_GENERATE_CA_MATERIALS" "${AUTO_GENERATE_CA_MATERIALS}"
    set_env_value "${env_file}" "ACME_DIRECTORY_URL" "${BRIDGE_GATEWAY_BASE_URL}/ca-server/acps-atr-v2/acme"
    set_env_value "${env_file}" "OCSP_RESPONDER_URL" "${BRIDGE_GATEWAY_BASE_URL}/ca-server/acps-atr-v2/ocsp"
    set_env_value "${env_file}" "CRL_DISTRIBUTION_POINT_URL" "${BRIDGE_GATEWAY_BASE_URL}/ca-server/acps-atr-v2/crl/current"
    set_env_value "${env_file}" "REGISTRY_SERVER_INTERNAL_API_TOKEN" "${REGISTRY_SERVER_INTERNAL_API_TOKEN}"
    set_env_value "${env_file}" "REGISTRY_SERVER_URL" "${SERVICE_GATEWAY_BASE_URL}/registry/acps-atr-v2"
}

prepare_discovery_env() {
    local env_file="${DISCOVERY_DIR}/.env"

    cp "${DISCOVERY_DIR}/.env.example" "${env_file}"
    set_env_value "${env_file}" "APP_BASE_URL" "${PUBLIC_GATEWAY_BASE_URL}/discovery"
    set_env_value "${env_file}" "DATABASE_URL" "postgresql+asyncpg://${DISCOVERY_DB_USER}:${DISCOVERY_DB_PASSWORD}@stage-postgres:5432/${DISCOVERY_DB_NAME}"
    set_env_value "${env_file}" "DSP_BASE_URL" "${SERVICE_GATEWAY_BASE_URL}/registry/acps-dsp-v2"
    set_env_value "${env_file}" "DSP_WEBHOOK_RECEIVE_URL" "${SERVICE_GATEWAY_BASE_URL}/discovery/admin/dsp/webhooks/receive"
    set_env_value "${env_file}" "DISCOVERY_MODE" "${DISCOVERY_MODE}"
    set_env_value "${env_file}" "DISCOVERY_LLM_API_KEY" "${DISCOVERY_LLM_API_KEY:-}"
    set_env_value "${env_file}" "DISCOVERY_LLM_BASE_URL" "${DISCOVERY_LLM_BASE_URL:-}"
    set_env_value "${env_file}" "DISCOVERY_LLM_MODEL_NAME" "${DISCOVERY_LLM_MODEL_NAME:-}"
    set_env_value "${env_file}" "EMBEDDING_API_KEY" "${EMBEDDING_API_KEY:-}"
    set_env_value "${env_file}" "EMBEDDING_BASE_URL" "${EMBEDDING_BASE_URL:-}"
    set_env_value "${env_file}" "EMBEDDING_MODEL_NAME" "${EMBEDDING_MODEL_NAME:-}"
    set_env_value "${env_file}" "EMBEDDING_DIM" "${EMBEDDING_DIM:-}"
    set_env_value "${env_file}" "EMBEDDING_MODEL_PATH" "${EMBEDDING_MODEL_PATH:-}"
    set_env_value "${env_file}" "EMBEDDING_DEVICES" "${EMBEDDING_DEVICES:-}"
    set_env_value "${env_file}" "RERANKER_URL" "${RERANKER_URL:-}"
    set_env_value "${env_file}" "DSP_WEBHOOK_SECRET" "${DSP_WEBHOOK_SECRET:-}"
}

prepare_demo_partners_env() {
    local env_file="${DEMO_PARTNERS_DIR}/.env"
    local image_ref

    image_ref="$(read_bundle_image_ref "${DEMO_PARTNERS_DIR}/VERSION")"
    cp "${DEMO_PARTNERS_DIR}/.env.example" "${env_file}"
    set_env_value "${env_file}" "PARTNERS_IMAGE" "${image_ref}"
    set_env_value "${env_file}" "INFRA_HOST" "${GATEWAY_BRIDGE_HOST}"
    set_env_value "${env_file}" "REGISTRY_API_BASE_URL" "${BRIDGE_GATEWAY_BASE_URL}/registry/api"
    set_env_value "${env_file}" "CA_SERVER_URL" "${BRIDGE_GATEWAY_BASE_URL}/ca-server"
    set_env_value "${env_file}" "DISCOVERY_SERVER_BASE_URL" "${BRIDGE_GATEWAY_BASE_URL}/discovery/acps-adp-v2"
    set_env_value "${env_file}" "RABBITMQ_HOST" "${GATEWAY_BRIDGE_HOST}"
    set_env_value "${env_file}" "RABBITMQ_PORT" "${RABBITMQ_PORT}"
    set_env_value "${env_file}" "RABBITMQ_VHOST" "acps"
    set_env_value "${env_file}" "MQ_AUTH_URL" "https://${GATEWAY_BRIDGE_HOST}:${MQ_AUTH_PORT}"
    set_env_value "${env_file}" "RABBITMQ_URL" "amqps://${GATEWAY_BRIDGE_HOST}:${RABBITMQ_PORT}/acps?auth=external"
    set_env_value "${env_file}" "PARTNER_LLM_FAST_API_KEY" "${PARTNER_LLM_FAST_API_KEY}"
    set_env_value "${env_file}" "PARTNER_LLM_FAST_BASE_URL" "${PARTNER_LLM_FAST_BASE_URL}"
    set_env_value "${env_file}" "PARTNER_LLM_FAST_MODEL" "${PARTNER_LLM_FAST_MODEL}"
    set_env_value "${env_file}" "PARTNER_LLM_DEFAULT_API_KEY" "${PARTNER_LLM_DEFAULT_API_KEY}"
    set_env_value "${env_file}" "PARTNER_LLM_DEFAULT_BASE_URL" "${PARTNER_LLM_DEFAULT_BASE_URL}"
    set_env_value "${env_file}" "PARTNER_LLM_DEFAULT_MODEL" "${PARTNER_LLM_DEFAULT_MODEL}"
}

prepare_demo_leader_env() {
    local env_file="${DEMO_LEADER_DIR}/.env"
    local image_ref

    image_ref="$(read_bundle_image_ref "${DEMO_LEADER_DIR}/VERSION")"
    cp "${DEMO_LEADER_DIR}/.env.example" "${env_file}"
    set_env_value "${env_file}" "LEADER_IMAGE" "${image_ref}"
    set_env_value "${env_file}" "WEB_PORT" "${LEADER_WEB_PORT}"
    set_env_value "${env_file}" "INFRA_HOST" "${GATEWAY_BRIDGE_HOST}"
    set_env_value "${env_file}" "RABBITMQ_HOST" "${GATEWAY_BRIDGE_HOST}"
    set_env_value "${env_file}" "RABBITMQ_PORT" "${RABBITMQ_PORT}"
    set_env_value "${env_file}" "RABBITMQ_VHOST" "acps"
    set_env_value "${env_file}" "MQ_AUTH_URL" "https://${GATEWAY_BRIDGE_HOST}:${MQ_AUTH_PORT}"
    set_env_value "${env_file}" "RABBITMQ_URL" "amqps://${GATEWAY_BRIDGE_HOST}:${RABBITMQ_PORT}/acps?auth=external"
    set_env_value "${env_file}" "REGISTRY_API_BASE_URL" "${BRIDGE_GATEWAY_BASE_URL}/registry/api"
    set_env_value "${env_file}" "CA_SERVER_URL" "${BRIDGE_GATEWAY_BASE_URL}/ca-server"
    set_env_value "${env_file}" "DISCOVERY_SERVER_BASE_URL" "${BRIDGE_GATEWAY_BASE_URL}/discovery/acps-adp-v2"
    set_env_value "${env_file}" "LEADER_LLM_FAST_API_KEY" "${LEADER_LLM_FAST_API_KEY}"
    set_env_value "${env_file}" "LEADER_LLM_FAST_BASE_URL" "${LEADER_LLM_FAST_BASE_URL}"
    set_env_value "${env_file}" "LEADER_LLM_FAST_MODEL" "${LEADER_LLM_FAST_MODEL}"
    set_env_value "${env_file}" "LEADER_LLM_DEFAULT_API_KEY" "${LEADER_LLM_DEFAULT_API_KEY}"
    set_env_value "${env_file}" "LEADER_LLM_DEFAULT_BASE_URL" "${LEADER_LLM_DEFAULT_BASE_URL}"
    set_env_value "${env_file}" "LEADER_LLM_DEFAULT_MODEL" "${LEADER_LLM_DEFAULT_MODEL}"
    set_env_value "${env_file}" "LEADER_LLM_PRO_API_KEY" "${LEADER_LLM_PRO_API_KEY}"
    set_env_value "${env_file}" "LEADER_LLM_PRO_BASE_URL" "${LEADER_LLM_PRO_BASE_URL}"
    set_env_value "${env_file}" "LEADER_LLM_PRO_MODEL" "${LEADER_LLM_PRO_MODEL}"
}

prepare_provision_conf() {
    local conf_file="${DEMO_LEADER_DIR}/provision.conf"

    cp "${DEMO_LEADER_DIR}/provision.conf.example" "${conf_file}"
    set_conf_value "${conf_file}" "REGISTRY_API_BASE_URL" "${BRIDGE_GATEWAY_BASE_URL}/registry/api"
    set_conf_value "${conf_file}" "REGISTRY_CLIENT_USERNAME" "${REGISTRY_CLIENT_USERNAME}"
    set_conf_value "${conf_file}" "REGISTRY_CLIENT_PASSWORD" "${REGISTRY_CLIENT_PASSWORD}"
    set_conf_value "${conf_file}" "REGISTRY_ADMIN_USERNAME" "${REGISTRY_ADMIN_USERNAME}"
    set_conf_value "${conf_file}" "REGISTRY_ADMIN_PASSWORD" "${REGISTRY_ADMIN_PASSWORD}"
    set_conf_value "${conf_file}" "CA_SERVER_BASE_URL" "${BRIDGE_GATEWAY_BASE_URL}/ca-server"
    set_conf_value "${conf_file}" "DISCOVERY_GATEWAY_URL" "${BRIDGE_GATEWAY_BASE_URL}/discovery"
}

prepare_mq_auth_server_env() {
    local env_file="${MQ_AUTH_SERVER_DIR}/.env"
    local certs_dir="${MQ_AUTH_SERVER_DIR}/certs"
    local image_ref

    image_ref="$(read_bundle_image_ref "${MQ_AUTH_SERVER_DIR}/VERSION")"
    cp "${MQ_AUTH_SERVER_DIR}/.env.example" "${env_file}"
    set_env_value "${env_file}" "APP_ENV" "production"
    set_env_value "${env_file}" "APP_IMAGE" "${image_ref}"
    set_env_value "${env_file}" "CERTS_HOST_DIR" "${certs_dir}"
    set_env_value "${env_file}" "RABBITMQ_MGMT_PASS" "${MQ_AUTH_MGMT_PASS}"
    set_env_value "${env_file}" "RABBITMQ_MGMT_URL" "http://stage-rabbitmq:15672"
    set_env_value "${env_file}" "REDIS_URL" "rediss://:${REDIS_PASSWORD}@stage-redis:6379/2"
    set_env_value "${env_file}" "REDIS_TLS_CA_CERT" "/certs/acps-root-ca.pem"
    set_env_value "${env_file}" "TLS_CERT_FILE" "/certs/server.pem"
    set_env_value "${env_file}" "TLS_KEY_FILE" "/certs/server.key"
    set_env_value "${env_file}" "TLS_CA_CERT_FILE" "/certs/acps-root-ca.pem"
    set_env_value "${env_file}" "HEALTHCHECK_TLS_CERT_FILE" "/certs/client.pem"
    set_env_value "${env_file}" "HEALTHCHECK_TLS_KEY_FILE" "/certs/client.key"
    set_env_value "${env_file}" "HEALTHCHECK_TLS_CA_CERT_FILE" "/certs/acps-root-ca.pem"
}

prepare_runtime_configs() {
    prepare_stage_infra_env
    prepare_registry_env
    prepare_ca_env
    prepare_user_supplied_ca_materials
    prepare_discovery_env
    prepare_mq_auth_server_env
    if should_deploy_demo_apps; then
        prepare_demo_partners_env
        prepare_demo_leader_env
    fi
    prepare_provision_conf
    build_runtime_images_lock
}

write_infra_cli_conf() {
    local conf_file="$1"
    local gateway_base_url="${2:-${PUBLIC_GATEWAY_BASE_URL}}"
    local registry_root_url="${gateway_base_url}/registry"
    local ca_root_url="${gateway_base_url}/ca-server"

    cat > "${conf_file}" <<EOF
[registry]
base_url = "${registry_root_url}"

[auth]
user_token_file = "./.acps-cli/tokens/registry-user.json"
admin_token_file = "./.acps-cli/tokens/registry-admin.json"

[ca]
base_url = "${ca_root_url}"
EOF
}

export_provisioner_credentials() {
    export REGISTRY_USER_USERNAME="${REGISTRY_CLIENT_USERNAME}"
    export REGISTRY_USER_PASSWORD="${REGISTRY_CLIENT_PASSWORD}"
    export REGISTRY_ADMIN_USERNAME="${REGISTRY_ADMIN_USERNAME}"
    export REGISTRY_ADMIN_PASSWORD="${REGISTRY_ADMIN_PASSWORD}"
}

run_provisioner() {
    local provisioner_script="$1"
    local container_cli_conf="${INSTALL_ROOT}/acps-cli.container.toml"
    shift
    # 剩余参数：传给 provisioner 的 -- 后参数，其中绝对路径需调用者自行处理
    local extra_args=("$@")

    require_file_exists "${provisioner_script}" "$(basename "${provisioner_script}")"
    export_provisioner_credentials
    write_infra_cli_conf "${INFRA_CLI_CONF}" "${PUBLIC_GATEWAY_BASE_URL}"

    if have_stage_infra_host_cli; then
        local python_bin
        python_bin="$(resolve_python_bin)"
        "${python_bin}" "${provisioner_script}" \
            --cli-conf "${INFRA_CLI_CONF}" \
            "${extra_args[@]}"
        return
    fi

    local tool_image=""
    tool_image="$(resolve_tool_runner_image 2>/dev/null || true)"
    if [[ -z "${tool_image}" ]]; then
        ensure_tool_runner_image_loaded || {
            err "宿主机缺少 acps-cli，且未找到可导入的工具镜像"
            exit 1
        }
        tool_image="$(resolve_tool_runner_image 2>/dev/null || true)"
    fi

    if [[ -z "${tool_image}" ]]; then
        err "宿主机缺少 acps-cli，且未找到可用工具镜像"
        exit 1
    fi

    # 容器内运行时将宿主机绝对路径映射到 /work/runtime
    write_infra_cli_conf "${container_cli_conf}" "${BRIDGE_GATEWAY_BASE_URL}"
    local provisioner_basename
    provisioner_basename="$(basename "${provisioner_script}")"
    docker run --rm \
        --user 0:0 \
        --workdir /work \
        --add-host host.docker.internal:host-gateway \
        -e REGISTRY_USER_USERNAME \
        -e REGISTRY_USER_PASSWORD \
        -e REGISTRY_USER_NAME \
        -e REGISTRY_USER_ORG_NAME \
        -e REGISTRY_ADMIN_USERNAME \
        -e REGISTRY_ADMIN_PASSWORD \
        -v "${INSTALL_ROOT}:/work/runtime" \
        -v "${provisioner_script}:/work/${provisioner_basename}:ro" \
        --entrypoint python3 \
        "${tool_image}" \
        "/work/${provisioner_basename}" \
        --cli-conf /work/runtime/acps-cli.container.toml \
        "${extra_args[@]}"
}

_merge_ca_chain_into_stage_infra_trust_bundle() {
    # acps-cli cert issue 内部的 cert trust-bundle update 副作用每次都会将
    # stage-infra/certs/acps-root-ca.pem 重置为仅含 Root CA。
    # 而 redis-server.pem 由中间 CA 签发，redis-cli --tls 在 Alpine 环境中不会
    # 自动跟随服务端发来的中间 CA 链做路径构建，导致 tlsv1 alert unknown ca。
    # 在 provision-stage-infra-certs.py 运行后，在 Shell 层补做一次 merge，
    # 将 ca-chain.pem（含中间CA + Root CA）合并进 acps-root-ca.pem。
    local chain_file="${CA_DIR}/certs/ca-chain.pem"
    local bundle_file="${STAGE_INFRA_DIR}/certs/acps-root-ca.pem"

    if [[ ! -f "${chain_file}" ]]; then
        log "WARN: ca-chain.pem 不存在（${chain_file}），跳过中间 CA 合并"
        return 0
    fi
    if [[ ! -f "${bundle_file}" ]]; then
        log "WARN: acps-root-ca.pem 不存在（${bundle_file}），跳过中间 CA 合并"
        return 0
    fi

    local python_bin
    python_bin="$(resolve_python_bin 2>/dev/null || true)"

    if [[ -n "${python_bin}" ]]; then
        # 用 Python 做 PEM 块级去重合并
        "${python_bin}" -c "
import sys

def pem_blocks(text):
    blocks, buf, inside = [], [], False
    for line in text.splitlines():
        if '-----BEGIN CERTIFICATE-----' in line:
            buf, inside = [line], True
        elif inside:
            buf.append(line)
            if '-----END CERTIFICATE-----' in line:
                blocks.append('\n'.join(buf).strip() + '\n')
                buf, inside = [], False
    return blocks

# argv[1] = ca-chain.pem (source), argv[2] = acps-root-ca.pem (target, merged in-place)
files = sys.argv[1:]
seen, merged = set(), []
for path in files:
    with open(path) as fh:
        for block in pem_blocks(fh.read()):
            if block not in seen:
                seen.add(block)
                merged.append(block)

with open(files[-1], 'w') as fh:
    fh.write(''.join(merged))
" "${chain_file}" "${bundle_file}"
    else
        # Python 不可用时降级：cat 拼接（Root CA 会重复，但对 OpenSSL 无害）
        local tmp_merged
        tmp_merged="$(mktemp)"
        cat "${chain_file}" "${bundle_file}" > "${tmp_merged}"
        mv "${tmp_merged}" "${bundle_file}"
    fi

    log "已合并 ca-chain.pem 到 stage-infra CA 信任包（含中间 CA，redis-cli 证书链验证可通过）"
}

provision_stage_infra_certs() {
    local provisioner="${BASE_DIR}/provision-stage-infra-certs.py"

    mkdir -p "${STAGE_INFRA_DIR}/certs"
    if have_stage_infra_host_cli; then
        run_provisioner "${provisioner}" \
            --stage-infra-dir "${STAGE_INFRA_DIR}"
    else
        run_provisioner "${provisioner}" \
            --stage-infra-dir /work/runtime/stage-infra
    fi
    _merge_ca_chain_into_stage_infra_trust_bundle
    normalize_bind_mount_certs_dir \
        "${STAGE_INFRA_DIR}/certs" \
        "${STANDALONE_STAGE_INFRA_REDIS_BIND_MOUNT_UID}" \
        "${STANDALONE_STAGE_INFRA_REDIS_BIND_MOUNT_GID}"
    normalize_bind_mount_private_key_owner \
        "${STAGE_INFRA_DIR}/certs/rabbitmq-server.key" \
        "${STANDALONE_STAGE_INFRA_RABBITMQ_BIND_MOUNT_UID}" \
        "${STANDALONE_STAGE_INFRA_RABBITMQ_BIND_MOUNT_GID}" \
        "RabbitMQ server key"
    normalize_bind_mount_private_key_owner \
        "${STAGE_INFRA_DIR}/certs/rabbitmq-client.key" \
        "${STANDALONE_STAGE_INFRA_RABBITMQ_BIND_MOUNT_UID}" \
        "${STANDALONE_STAGE_INFRA_RABBITMQ_BIND_MOUNT_GID}" \
        "RabbitMQ client key"
}

provision_registry_mtls_certs() {
    local provisioner="${BASE_DIR}/provision-registry-server-mtls-certs.py"

    mkdir -p "${REGISTRY_DIR}/certs"
    if have_stage_infra_host_cli; then
        run_provisioner "${provisioner}" \
            --registry-server-dir "${REGISTRY_DIR}" \
            --registry-public-base-url "${PUBLIC_GATEWAY_BASE_URL}/registry" \
            --mtls-public-host "${REGISTRY_SERVER_MTLS_PUBLIC_HOST}" \
            --mtls-public-port "${REGISTRY_SERVER_MTLS_PORT}"
    else
        run_provisioner "${provisioner}" \
            --registry-server-dir /work/runtime/registry-server \
            --registry-public-base-url "${PUBLIC_GATEWAY_BASE_URL}/registry" \
            --mtls-public-host "${REGISTRY_SERVER_MTLS_PUBLIC_HOST}" \
            --mtls-public-port "${REGISTRY_SERVER_MTLS_PORT}"
    fi
    normalize_bind_mount_certs_dir \
        "${REGISTRY_DIR}/certs" \
        "${STANDALONE_APP_BIND_MOUNT_UID}" \
        "${STANDALONE_APP_BIND_MOUNT_GID}"
    normalize_bind_mount_host_client_keys "${REGISTRY_DIR}/certs" probe-client.key
}

provision_mq_auth_server_certs() {
    local provisioner="${BASE_DIR}/provision-mq-auth-server-certs.py"

    mkdir -p "${MQ_AUTH_SERVER_DIR}/certs"
    if have_stage_infra_host_cli; then
        run_provisioner "${provisioner}" \
            --mq-auth-server-dir "${MQ_AUTH_SERVER_DIR}" \
            --stage-infra-dir "${STAGE_INFRA_DIR}"
    else
        run_provisioner "${provisioner}" \
            --mq-auth-server-dir /work/runtime/mq-auth-server \
            --stage-infra-dir /work/runtime/stage-infra
    fi
    normalize_bind_mount_certs_dir \
        "${MQ_AUTH_SERVER_DIR}/certs" \
        "${STANDALONE_APP_BIND_MOUNT_UID}" \
        "${STANDALONE_APP_BIND_MOUNT_GID}"
    normalize_bind_mount_host_client_keys "${MQ_AUTH_SERVER_DIR}/certs" client.key
}

compose_down_with_project() {
    local label="$1"
    local project_name="$2"
    local compose_file="$3"
    local env_file="$4"

    require_file_exists "${compose_file}" "${label} compose.yml"
    require_file_exists "${env_file}" "${label} .env"

    if ! docker ps -a --filter "label=com.docker.compose.project=${project_name}" -q | grep -q . \
        && ! docker network ls --filter "label=com.docker.compose.project=${project_name}" -q | grep -q . \
        && ! docker volume ls --filter "label=com.docker.compose.project=${project_name}" -q | grep -q .; then
        log "${label} 未发现需要清理的 Docker 资源"
        return 0
    fi

    log "清理 ${label} 的 Docker 资源"
    COMPOSE_PROJECT_NAME="${project_name}" docker compose --env-file "${env_file}" -f "${compose_file}" down -v --remove-orphans
}

cleanup_existing_docker_resources() {
    log "开始清理当前 same-host 全量安装管理的 Docker 环境"

    bash "${DEMO_LEADER_DIR}/cleanup.sh"
    compose_down_with_project "discovery-server release-app" "discovery-release-app" "${DISCOVERY_DIR}/compose.yml" "${DISCOVERY_DIR}/.env"
    compose_down_with_project "ca-server release-app" "ca-server-release-app" "${CA_DIR}/compose.yml" "${CA_DIR}/.env"
    compose_down_with_project "registry-server release-app" "registry-release-app" "${REGISTRY_DIR}/compose.yml" "${REGISTRY_DIR}/.env"
    if [[ -f "${MQ_AUTH_SERVER_DIR}/compose.yml" && -f "${MQ_AUTH_SERVER_DIR}/.env" ]]; then
        compose_down_with_project "mq-auth-server release-app" "mq-auth-server-release" "${MQ_AUTH_SERVER_DIR}/compose.yml" "${MQ_AUTH_SERVER_DIR}/.env"
    fi
    compose_down_with_project "stage-infra" "stage-infra" "${STAGE_INFRA_DIR}/compose.yml" "${STAGE_INFRA_DIR}/.env"
    remove_runtime_images_from_lock
}

deploy_standalone() {
    log "步骤 1: 引导 stage-infra（仅 nginx + postgres）"
    STAGE_INFRA_BOOTSTRAP_ONLY=true bash "${STAGE_INFRA_DIR}/deploy.sh"

    log "步骤 2: 部署 registry-server release-app（public plane）"
    STAGE_INFRA_DIR="${STAGE_INFRA_DIR}" bash "${REGISTRY_DIR}/deploy.sh"

    log "步骤 3: 部署 ca-server release-app"
    STAGE_INFRA_DIR="${STAGE_INFRA_DIR}" bash "${CA_DIR}/deploy.sh"

    log "步骤 4: 申请 registry-server 9002 证书"
    provision_registry_mtls_certs

    log "步骤 5: 重新部署 registry-server release-app（启用 9002 mTLS）"
    enable_registry_mtls_listener
    STAGE_INFRA_DIR="${STAGE_INFRA_DIR}" bash "${REGISTRY_DIR}/deploy.sh"

    log "步骤 6: 部署 discovery-server release-app"
    STAGE_INFRA_DIR="${STAGE_INFRA_DIR}" bash "${DISCOVERY_DIR}/deploy.sh"

    log "步骤 7: 申请 stage-infra 证书并写入 runtime/stage-infra/certs"
    provision_stage_infra_certs

    log "步骤 8: 完整部署 stage-infra MQ stack"
    bash "${STAGE_INFRA_DIR}/deploy.sh"

    log "步骤 9: 申请 mq-auth-server 证书并组装 certs 目录"
    provision_mq_auth_server_certs

    log "步骤 10: 部署 mq-auth-server release-app"
    STAGE_INFRA_DIR="${STAGE_INFRA_DIR}" bash "${MQ_AUTH_SERVER_DIR}/deploy.sh"

    if should_deploy_demo_apps; then
        log "步骤 11: 部署 demo-apps"
        if is_true "${STANDALONE_DEMO_REDEPLOY:-false}"; then
            bash "${DEMO_LEADER_DIR}/install.sh" --clean-docker
        else
            bash "${DEMO_LEADER_DIR}/install.sh"
        fi
    else
        log "已按配置跳过 demo-apps 部署（infra-only 模式）"
    fi
}

wait_for_http_status() {
    local label="$1"
    local url="$2"
    local expected_status="$3"
    local timeout_seconds="$4"
    local interval_seconds="$5"
    local elapsed_seconds=0
    local http_status="000"

    while (( elapsed_seconds < timeout_seconds )); do
        http_status="$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "${url}" || echo '000')"
        http_status="${http_status:0:3}"
        if [[ "${http_status}" == "${expected_status}" ]]; then
            log "${label} 检查通过 (${http_status})"
            return 0
        fi
        sleep "${interval_seconds}"
        elapsed_seconds=$((elapsed_seconds + interval_seconds))
    done

    err "${label} 检查失败，期望 ${expected_status}，实际 ${http_status}: ${url}"
    return 1
}

probe_stage_nginx_http_status() {
    local path="$1"
    local container_name="${STAGE_NGINX_CONTAINER_NAME:-stage-nginx}"
    local probe_url="http://127.0.0.1${path}"
    local status="000"

    status="$(docker exec "${container_name}" sh -lc "
if command -v curl >/dev/null 2>&1; then
    curl --silent --show-error --output /dev/null --write-out '%{http_code}' '${probe_url}'
elif command -v wget >/dev/null 2>&1; then
    wget --server-response --quiet --output-document /dev/null '${probe_url}' 2>&1 | awk '/^  HTTP\\// { code=\$2 } END { print code }'
else
    printf '000'
fi
" 2>/dev/null || echo '000')"
    status="${status//$'\r'/}"
    status="${status//$'\n'/}"
    printf '%s\n' "${status:0:3}"
}

wait_for_stage_nginx_http_status() {
    local label="$1"
    local path="$2"
    local expected_status="$3"
    local timeout_seconds="$4"
    local interval_seconds="$5"
    local elapsed_seconds=0
    local http_status="000"
    local container_name="${STAGE_NGINX_CONTAINER_NAME:-stage-nginx}"

    while (( elapsed_seconds < timeout_seconds )); do
        http_status="$(probe_stage_nginx_http_status "${path}")"
        if [[ "${http_status}" == "${expected_status}" ]]; then
            log "${label} 检查通过 (${http_status})"
            return 0
        fi
        sleep "${interval_seconds}"
        elapsed_seconds=$((elapsed_seconds + interval_seconds))
    done

    err "${label} 检查失败，期望 ${expected_status}，实际 ${http_status}: ${path} (via ${container_name})"
    return 1
}

run_core_health_checks() {
    log "执行 standalone 核心健康门禁"

    wait_for_http_status "registry-server /health" "${LOCAL_GATEWAY_BASE_URL}/registry/health" "200" 60 3
    wait_for_stage_nginx_http_status "registry-server /ready" "/registry/ready" "200" 60 3
    wait_for_http_status "ca-server /health" "${LOCAL_GATEWAY_BASE_URL}/ca-server/health" "200" 60 3
    wait_for_http_status "discovery-server /health" "${LOCAL_GATEWAY_BASE_URL}/discovery/health" "200" 60 3
    wait_for_stage_nginx_http_status "discovery-server /ready" "/discovery/ready" "200" 60 3

    log "执行 mq-auth-server 健康门禁"
    bash "${MQ_AUTH_SERVER_DIR}/smoke-test.sh" "https://localhost:${MQ_AUTH_PORT}"
}

print_business_smoke_log_hint() {
        cat >&2 <<EOF
[standalone] 如需手工查看日志，可执行：
    cd "${DEMO_LEADER_DIR}" && docker compose --env-file .env -f compose.yml logs -f --tail 100 leader
    cd "${DEMO_PARTNERS_DIR}" && docker compose --env-file .env -f compose.yml logs -f --tail 100 partners
    cd "${STAGE_INFRA_DIR}" && COMPOSE_PROJECT_NAME=stage-infra docker compose --env-file .env -f compose.yml logs -f --tail 100 mq-auth-server rabbitmq
[standalone] 如需重跑业务烟测，可执行：
    cd "${DEMO_LEADER_DIR}" && env DUMP_SMOKE_LOGS=false bash ./smoke-test-business.sh
EOF
}

run_business_smoke() {
        local dump_smoke_logs="${DUMP_SMOKE_LOGS:-false}"

    if ! should_deploy_demo_apps; then
        log "当前为 infra-only 模式，跳过业务烟测"
        return 0
    fi

    if ! is_true "${RUN_BUSINESS_SMOKE:-true}"; then
        log "已按配置跳过业务烟测"
        return 0
    fi

    log "执行 demo-apps 业务烟测"
    if ! (
        cd "${DEMO_LEADER_DIR}"
        GROUP_POLL_TIMEOUT="${BUSINESS_GROUP_POLL_TIMEOUT:-600}" \
        TASK_POLL_TIMEOUT="${BUSINESS_TASK_POLL_TIMEOUT:-600}" \
        HTTP_REQUEST_TIMEOUT="${BUSINESS_HTTP_REQUEST_TIMEOUT:-240}" \
        DUMP_SMOKE_LOGS="${dump_smoke_logs}" \
        bash ./smoke-test-business.sh
    ); then
        if [[ "${dump_smoke_logs}" != "true" ]]; then
            err "demo-apps 业务烟测失败；install.sh / upgrade.sh 默认不自动导出各组件长日志，以避免淹没最终结果。"
        else
            err "demo-apps 业务烟测失败。"
        fi
        print_business_smoke_log_hint
        return 1
    fi
}

load_version() {
    require_file_exists "${VERSION_FILE}" "VERSION"
    BUNDLE_VERSION="$(awk -F= '$1 == "version" { print $2; exit }' "${VERSION_FILE}")"
    if [[ -z "${BUNDLE_VERSION}" ]]; then
        err "无法从 VERSION 读取 version 字段"
        exit 1
    fi

    BUNDLE_PLATFORM="$(awk -F= '$1 == "platform" { print $2; exit }' "${VERSION_FILE}")"
    if [[ -z "${BUNDLE_PLATFORM}" ]]; then
        err "无法从 VERSION 读取 platform 字段"
        exit 1
    fi
}

initialize_env_defaults() {
    GATEWAY_PUBLIC_HOST="${GATEWAY_PUBLIC_HOST:-localhost}"
    GATEWAY_SERVICE_HOST="${GATEWAY_SERVICE_HOST:-stage-nginx}"
    GATEWAY_BRIDGE_HOST="${GATEWAY_BRIDGE_HOST:-${GATEWAY_INTERNAL_HOST:-host.docker.internal}}"
    STAGE_NGINX_PORT="${STAGE_NGINX_PORT:-9000}"
    GATEWAY_SERVICE_PORT="${GATEWAY_SERVICE_PORT:-80}"
    RABBITMQ_PORT="${RABBITMQ_PORT:-5671}"
    POSTGRES_INIT_USER="${POSTGRES_INIT_USER:-postgres}"
    POSTGRES_INIT_PASSWORD="${POSTGRES_INIT_PASSWORD:-postgres}"
    POSTGRES_INIT_DB="${POSTGRES_INIT_DB:-postgres}"
    REGISTRY_DB_USER="${REGISTRY_DB_USER:-registry}"
    REGISTRY_DB_PASSWORD="${REGISTRY_DB_PASSWORD:-registry}"
    REGISTRY_DB_NAME="${REGISTRY_DB_NAME:-agent_registry}"
    CA_DB_USER="${CA_DB_USER:-ca}"
    CA_DB_PASSWORD="${CA_DB_PASSWORD:-ca}"
    CA_DB_NAME="${CA_DB_NAME:-agent_ca}"
    DISCOVERY_DB_USER="${DISCOVERY_DB_USER:-discovery}"
    DISCOVERY_DB_PASSWORD="${DISCOVERY_DB_PASSWORD:-discovery}"
    DISCOVERY_DB_NAME="${DISCOVERY_DB_NAME:-agent_discovery}"
    REDIS_PASSWORD="${REDIS_PASSWORD:-}"
    RABBITMQ_USER="${RABBITMQ_USER:-admin}"
    RABBITMQ_PASSWORD="${RABBITMQ_PASSWORD:-}"
    MQ_AUTH_PORT="${MQ_AUTH_PORT:-9007}"
    MQ_AUTH_MGMT_USER="${MQ_AUTH_MGMT_USER:-mq-auth-svc}"
    MQ_AUTH_MGMT_PASS="${MQ_AUTH_MGMT_PASS:-}"
    REGISTRY_SERVER_MTLS_PUBLIC_HOST="${REGISTRY_SERVER_MTLS_PUBLIC_HOST:-${GATEWAY_PUBLIC_HOST}}"
    REGISTRY_SERVER_MTLS_PORT="${REGISTRY_SERVER_MTLS_PORT:-9002}"
    REGISTRY_SERVER_INTERNAL_API_TOKEN="${REGISTRY_SERVER_INTERNAL_API_TOKEN:-}"
    REGISTRY_CLIENT_USERNAME="${REGISTRY_CLIENT_USERNAME:-demo-client}"
    REGISTRY_CLIENT_PASSWORD="${REGISTRY_CLIENT_PASSWORD:-demo123}"
    REGISTRY_ADMIN_USERNAME="${REGISTRY_ADMIN_USERNAME:-admin}"
    REGISTRY_ADMIN_PASSWORD="${REGISTRY_ADMIN_PASSWORD:-admin123}"
    AUTO_GENERATE_CA_MATERIALS="${AUTO_GENERATE_CA_MATERIALS:-true}"
    CA_CERT_SOURCE_PATH="${CA_CERT_SOURCE_PATH:-}"
    CA_KEY_SOURCE_PATH="${CA_KEY_SOURCE_PATH:-}"
    CA_CHAIN_SOURCE_PATH="${CA_CHAIN_SOURCE_PATH:-}"
    CA_TRUST_BUNDLE_SOURCE_PATH="${CA_TRUST_BUNDLE_SOURCE_PATH:-}"
    DISCOVERY_MODE="${DISCOVERY_MODE:-cpu}"
    EMBEDDING_MODEL_PATH="${EMBEDDING_MODEL_PATH:-/models/embedding}"
    EMBEDDING_DEVICES="${EMBEDDING_DEVICES:-cuda:0}"
    RERANKER_URL="${RERANKER_URL:-}"
    DSP_WEBHOOK_SECRET="${DSP_WEBHOOK_SECRET:-change-me}"
    LEADER_WEB_PORT="${LEADER_WEB_PORT:-${WEB_PORT:-9010}}"
}

validate_inputs() {
    require_command bash
    require_command docker
    require_command tar
    require_command curl
    require_command openssl
    require_linux_root_for_bind_mount_cert_owners
    require_docker_access
    require_file_exists "${MANIFEST_FILE}" "manifest.toml"
    require_file_exists "${CHECKSUM_FILE}" "checksums.txt"
    require_dir_exists "${BUNDLES_DIR}" "bundles"
    require_file_exists "${ENV_FILE}" ".env"
    require_file_exists "${BASE_DIR}/provision-registry-server-mtls-certs.py" "provision-registry-server-mtls-certs.py"
    require_file_exists "${BASE_DIR}/provision-stage-infra-certs.py" "provision-stage-infra-certs.py"
    require_file_exists "${BASE_DIR}/provision-mq-auth-server-certs.py" "provision-mq-auth-server-certs.py"

    verify_release_manifest
    verify_release_checksums

    source_env_file "${ENV_FILE}"

    initialize_env_defaults

    ensure_generated_secret REDIS_PASSWORD "change-me" 18 "REDIS_PASSWORD"
    ensure_generated_secret RABBITMQ_PASSWORD "change-me" 18 "RABBITMQ_PASSWORD"
    ensure_generated_secret MQ_AUTH_MGMT_PASS "change-me" 18 "MQ_AUTH_MGMT_PASS"
    ensure_generated_secret REGISTRY_SERVER_INTERNAL_API_TOKEN "change-me-registry-server-internal-api-token" 24 "REGISTRY_SERVER_INTERNAL_API_TOKEN"
    ensure_generated_secret DSP_WEBHOOK_SECRET "change-me" 24 "DSP_WEBHOOK_SECRET"

    require_non_empty_vars \
        REDIS_PASSWORD \
        RABBITMQ_PASSWORD \
        MQ_AUTH_MGMT_PASS \
        DISCOVERY_LLM_API_KEY \
        DISCOVERY_LLM_BASE_URL \
        DISCOVERY_LLM_MODEL_NAME

    if ! is_true "${AUTO_GENERATE_CA_MATERIALS}"; then
        require_non_empty_vars \
            CA_CERT_SOURCE_PATH \
            CA_KEY_SOURCE_PATH \
            CA_CHAIN_SOURCE_PATH \
            CA_TRUST_BUNDLE_SOURCE_PATH

        CA_CERT_SOURCE_PATH="$(resolve_path "${CA_CERT_SOURCE_PATH}")"
        CA_KEY_SOURCE_PATH="$(resolve_path "${CA_KEY_SOURCE_PATH}")"
        CA_CHAIN_SOURCE_PATH="$(resolve_path "${CA_CHAIN_SOURCE_PATH}")"
        CA_TRUST_BUNDLE_SOURCE_PATH="$(resolve_path "${CA_TRUST_BUNDLE_SOURCE_PATH}")"

        require_file_exists "${CA_CERT_SOURCE_PATH}" "CA_CERT_SOURCE_PATH"
        require_file_exists "${CA_KEY_SOURCE_PATH}" "CA_KEY_SOURCE_PATH"
        require_file_exists "${CA_CHAIN_SOURCE_PATH}" "CA_CHAIN_SOURCE_PATH"
        require_file_exists "${CA_TRUST_BUNDLE_SOURCE_PATH}" "CA_TRUST_BUNDLE_SOURCE_PATH"
    fi

    case "${DISCOVERY_MODE}" in
        cpu)
            require_non_empty_vars \
                EMBEDDING_API_KEY \
                EMBEDDING_BASE_URL \
                EMBEDDING_MODEL_NAME

            if [[ -z "${EMBEDDING_DIM:-}" ]]; then
                EMBEDDING_DIM="$(infer_embedding_dimension "${EMBEDDING_MODEL_NAME}")"
            fi
            ;;
        gpu)
            require_non_empty_vars \
                EMBEDDING_MODEL_PATH \
                EMBEDDING_DEVICES \
                EMBEDDING_DIM
            ;;
        *)
            err "DISCOVERY_MODE 只支持 cpu 或 gpu，当前值为 ${DISCOVERY_MODE}"
            exit 1
            ;;
    esac

    if should_deploy_demo_apps; then
        require_non_empty_vars \
            LEADER_LLM_FAST_API_KEY \
            LEADER_LLM_FAST_BASE_URL \
            LEADER_LLM_FAST_MODEL \
            LEADER_LLM_DEFAULT_API_KEY \
            LEADER_LLM_DEFAULT_BASE_URL \
            LEADER_LLM_DEFAULT_MODEL \
            LEADER_LLM_PRO_API_KEY \
            LEADER_LLM_PRO_BASE_URL \
            LEADER_LLM_PRO_MODEL \
            PARTNER_LLM_FAST_API_KEY \
            PARTNER_LLM_FAST_BASE_URL \
            PARTNER_LLM_FAST_MODEL \
            PARTNER_LLM_DEFAULT_API_KEY \
            PARTNER_LLM_DEFAULT_BASE_URL \
            PARTNER_LLM_DEFAULT_MODEL
    fi

    prepare_common_paths
}

install_main() {
    load_version
    validate_inputs
    prepare_bundle_layout
    prepare_runtime_configs
    cleanup_existing_docker_resources
    deploy_standalone
    run_core_health_checks
    run_business_smoke

    log "完成：全部组件已部署到 ${INSTALL_ROOT}"
}

if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
    install_main
fi
