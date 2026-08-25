#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKSPACE_ROOT="$(cd "${REPO_ROOT}/.." && pwd)"

# shellcheck source=/dev/null
source "${REPO_ROOT}/scripts/lib/common.sh"

VERSION="$(date +%Y%m%d%H%M%S)"
STAGE_ROOT=""
SKIP_BUILD=false
SKIP_DEPLOY=false
USER_PREFIX="e2e"

ACPS_INFRA_REPO="${ACPS_INFRA_REPO:-${REPO_ROOT}}"
REGISTRY_SERVER_REPO="${REGISTRY_SERVER_REPO:-${WORKSPACE_ROOT}/registry-server}"
CA_SERVER_REPO="${CA_SERVER_REPO:-${WORKSPACE_ROOT}/ca-server}"
ACPS_CLI_REPO="${ACPS_CLI_REPO:-${WORKSPACE_ROOT}/acps-cli}"
DEMO_PARTNER_REPO="${DEMO_PARTNER_REPO:-${WORKSPACE_ROOT}/demo-partner}"

REGISTRY_BASE_URL="${REGISTRY_BASE_URL:-http://localhost:9000/registry}"
CA_GATEWAY_BASE_URL="${CA_GATEWAY_BASE_URL:-http://localhost:9000/ca-server}"
REGISTRY_ADMIN_USERNAME="${REGISTRY_ADMIN_USERNAME:-admin}"
REGISTRY_ADMIN_PASSWORD="${REGISTRY_ADMIN_PASSWORD:-admin123}"

usage() {
    cat <<'EOF'
用法: bash scripts/run-atr-eab-e2e.sh [选项]

默认行为：
1. 构建 stage-infra、registry-server、ca-server 发布包
2. 解压到临时目录并部署 stage-infra + registry-server + ca-server
3. 运行 acps-cli auth/agent/admin/cert 全链路
4. 使用 openssl 校验证书与 trust bundle

选项:
  --version <value>      指定统一发布版本号（默认: 当前时间戳）
  --stage-root <path>    指定解压与联调产物目录（默认: /tmp/acps-atr-eab-e2e-<version>）
  --skip-build           跳过发布包构建，直接使用 dist/ 下现有 tar.gz
  --skip-deploy          跳过 stage-infra / release-app 部署，仅运行 CLI 联调
  --user-prefix <value>  测试用户名前缀（默认: e2e）
  -h, --help             显示帮助

环境变量覆盖:
  ACPS_INFRA_REPO, REGISTRY_SERVER_REPO, CA_SERVER_REPO,
    ACPS_CLI_REPO, DEMO_PARTNER_REPO,
  REGISTRY_BASE_URL, CA_GATEWAY_BASE_URL,
  REGISTRY_ADMIN_USERNAME, REGISTRY_ADMIN_PASSWORD,
  DOCKER_PLATFORM
EOF
}

parse_args() {
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --version)
                VERSION="$2"
                shift 2
                ;;
            --stage-root)
                STAGE_ROOT="$2"
                shift 2
                ;;
            --skip-build)
                SKIP_BUILD=true
                shift
                ;;
            --skip-deploy)
                SKIP_DEPLOY=true
                shift
                ;;
            --user-prefix)
                USER_PREFIX="$2"
                shift 2
                ;;
            -h|--help)
                usage
                exit 0
                ;;
            *)
                err "未知参数: $1"
                usage >&2
                exit 1
                ;;
        esac
    done

    if [[ -z "$STAGE_ROOT" ]]; then
        STAGE_ROOT="/tmp/acps-atr-eab-e2e-${VERSION}"
    fi
}

set_default_platform() {
    if [[ -n "${DOCKER_PLATFORM:-}" ]]; then
        return 0
    fi

    if [[ "$(uname -s)" == "Darwin" && "$(uname -m)" == "arm64" ]]; then
        export DOCKER_PLATFORM="linux/arm64"
        log "检测到 Apple Silicon，默认使用 DOCKER_PLATFORM=${DOCKER_PLATFORM}"
    fi
}

set_env_value() {
    local env_file="$1"
    local key="$2"
    local value="$3"
    local tmp_file

    tmp_file="$(mktemp)"
    awk -v key="$key" -v value="$value" '
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

require_command() {
    local name="$1"

    if ! command -v "$name" >/dev/null 2>&1; then
        err "缺少命令: ${name}"
        exit 1
    fi
}

require_cli_binary() {
    local path="$1"
    local label="$2"

    if [[ ! -x "$path" ]]; then
        err "缺少可执行文件: ${label} (${path})"
        err "请先在对应仓库执行 uv sync"
        exit 1
    fi
}

ensure_prerequisites() {
    require_command tar
    require_command curl
    require_command openssl
    require_command python3
    require_command bash

    require_dir_exists "$ACPS_INFRA_REPO" "acps-infra 仓库"
    require_dir_exists "$REGISTRY_SERVER_REPO" "registry-server 仓库"
    require_dir_exists "$CA_SERVER_REPO" "ca-server 仓库"
    require_dir_exists "$ACPS_CLI_REPO" "acps-cli 仓库"
    require_dir_exists "$DEMO_PARTNER_REPO" "demo-partner 仓库"

    require_file_exists "${ACPS_INFRA_REPO}/scripts/stage-infra/build-stage-infra-bundle.sh"
    require_file_exists "${REGISTRY_SERVER_REPO}/scripts/release-app/build-app-bundle.sh"
    require_file_exists "${CA_SERVER_REPO}/scripts/release-app/build-app-bundle.sh"

    ACPS_CLI="${ACPS_CLI_REPO}/.venv/bin/acps-cli"

    require_cli_binary "$ACPS_CLI" "acps-cli"
}

prepare_stage_layout() {
    STAGE_INFRA_DEPLOY_DIR="${STAGE_ROOT}/stage-infra"
    REGISTRY_STAGE_DIR="${STAGE_ROOT}/registry-server"
    CA_STAGE_DIR="${STAGE_ROOT}/ca-server"
    E2E_ROOT="${STAGE_ROOT}/artifacts"

    mkdir -p "$STAGE_ROOT"
    rm -rf "$STAGE_INFRA_DEPLOY_DIR" "$REGISTRY_STAGE_DIR" "$CA_STAGE_DIR" "$E2E_ROOT"
    mkdir -p "$STAGE_INFRA_DEPLOY_DIR" "$REGISTRY_STAGE_DIR" "$CA_STAGE_DIR" "$E2E_ROOT"
}

build_bundles() {
    log "开始构建发布包，版本号: ${VERSION}"

    pushd "$ACPS_INFRA_REPO" >/dev/null
    bash scripts/stage-infra/build-stage-infra-bundle.sh "$VERSION"
    popd >/dev/null

    pushd "$REGISTRY_SERVER_REPO" >/dev/null
    bash scripts/release-app/build-app-bundle.sh "$VERSION"
    popd >/dev/null

    pushd "$CA_SERVER_REPO" >/dev/null
    bash scripts/release-app/build-app-bundle.sh "$VERSION"
    popd >/dev/null
}

extract_bundle() {
    local tarball="$1"
    local destination="$2"

    require_file_exists "$tarball"
    tar xzf "$tarball" -C "$destination" --strip-components=1
}

prepare_release_bundles() {
    log "解压发布包到 ${STAGE_ROOT}"

    extract_bundle "${ACPS_INFRA_REPO}/dist/acps-stage-infra-${VERSION}.tar.gz" "$STAGE_INFRA_DEPLOY_DIR"
    extract_bundle "${REGISTRY_SERVER_REPO}/dist/registry-server-app-${VERSION}.tar.gz" "$REGISTRY_STAGE_DIR"
    extract_bundle "${CA_SERVER_REPO}/dist/ca-server-app-${VERSION}.tar.gz" "$CA_STAGE_DIR"

    cp "${STAGE_INFRA_DEPLOY_DIR}/.env.example" "${STAGE_INFRA_DEPLOY_DIR}/.env"
    cp "${REGISTRY_STAGE_DIR}/.env.example" "${REGISTRY_STAGE_DIR}/.env"
    cp "${CA_STAGE_DIR}/.env.example" "${CA_STAGE_DIR}/.env"
    set_env_value "${CA_STAGE_DIR}/.env" "ACME_DIRECTORY_URL" "http://localhost:9000/ca-server/acps-atr-v2/acme"
}

deploy_stack() {
    log "部署 stage-infra"
    pushd "$STAGE_INFRA_DEPLOY_DIR" >/dev/null
    bash ./deploy.sh
    popd >/dev/null

    log "部署 registry-server release-app"
    pushd "$REGISTRY_STAGE_DIR" >/dev/null
    bash ./deploy.sh
    popd >/dev/null

    log "部署 ca-server release-app"
    pushd "$CA_STAGE_DIR" >/dev/null
    bash ./deploy.sh
    popd >/dev/null
}

check_running_stack() {
    log "检查现有运行环境"
    curl --silent --show-error --fail "${REGISTRY_BASE_URL%/}/health" >/dev/null
    curl --silent --show-error --fail "${CA_GATEWAY_BASE_URL%/}/health" >/dev/null
}

write_acps_cli_config() {
    ACPS_CLI_CONFIG="${E2E_ROOT}/acps-cli.toml"
    local user_token_path="${E2E_ROOT}/.acps-cli/tokens/registry-user.json"
    local admin_token_path="${E2E_ROOT}/.acps-cli/tokens/registry-admin.json"
    local keyfiles_dir="${E2E_ROOT}/keyfiles"

    mkdir -p "$(dirname "$user_token_path")" "$keyfiles_dir/accounts"

    cat > "$ACPS_CLI_CONFIG" <<EOF
[registry]
base_url = "${REGISTRY_BASE_URL%/}/api"

[auth]
user_token_file = "${user_token_path}"
admin_token_file = "${admin_token_path}"

[ca]
base_url = "${CA_GATEWAY_BASE_URL%/}/acps-atr-v2"
account_keys_dir = "${keyfiles_dir}/accounts"
private_keys_dir = "${keyfiles_dir}/private"
certs_dir = "${keyfiles_dir}/certs"
csr_dir = "${keyfiles_dir}/csr"
trust_bundle_path = "${keyfiles_dir}/trust-bundle.pem"
EOF
}

build_test_acs() {
    local output_path="$1"
    local agent_name="$2"
    local example_path="${DEMO_PARTNER_REPO}/partners/online/beijing_urban/acs.json"

    python3 - "$example_path" "$output_path" "$agent_name" <<'PY'
import json
import sys
from pathlib import Path

example_path = Path(sys.argv[1])
output_path = Path(sys.argv[2])
agent_name = sys.argv[3]

payload = json.loads(example_path.read_text(encoding="utf-8"))
payload["name"] = agent_name
payload.setdefault("securitySchemes", {})
for scheme in payload["securitySchemes"].values():
    if isinstance(scheme, dict):
        scheme.pop("x-caChallengeBaseUrl", None)

output_path.write_text(
    json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
    encoding="utf-8",
)
PY
}

json_get() {
    local file_path="$1"
    local key="$2"

    python3 - "$file_path" "$key" <<'PY'
import json
import sys

data = json.load(open(sys.argv[1], encoding="utf-8"))
value = data
for part in sys.argv[2].split('.'):
    value = value[part]
print(value)
PY
}

run_e2e_flow() {
    local run_id username password display_name org_name agent_name user_token admin_token
    local agent_id aic cert_path trust_bundle_path

    run_id="${VERSION}-$$"
    username="${USER_PREFIX}_${run_id}"
    password="Passw0rd!${run_id}"
    display_name="E2E User ${run_id}"
    org_name="ACPS E2E"
    agent_name="ACPS ATR E2E ${run_id}"

    USER_ACS_PATH="${E2E_ROOT}/acs-e2e.json"
    build_test_acs "$USER_ACS_PATH" "$agent_name"
    write_acps_cli_config

    user_token="${E2E_ROOT}/.acps-cli/tokens/registry-user.json"
    admin_token="${E2E_ROOT}/.acps-cli/tokens/registry-admin.json"

    log "Provider 登录 / 自动注册"
    REGISTRY_TOKEN_FILE="$user_token" \
        "$ACPS_CLI" --config "$ACPS_CLI_CONFIG" \
        auth \
        login \
        --username "$username" \
        --password "$password" \
        --name "$display_name" \
        --org-name "$org_name" \
        --json > "${E2E_ROOT}/login.json"

    log "创建并提交 Agent 草稿"
    REGISTRY_TOKEN_FILE="$user_token" \
        "$ACPS_CLI" --config "$ACPS_CLI_CONFIG" \
        agent \
        save \
        --acs-file "$USER_ACS_PATH" \
        --json > "${E2E_ROOT}/upsert.json"
    agent_id="$(json_get "${E2E_ROOT}/upsert.json" "agent_id")"

    REGISTRY_TOKEN_FILE="$user_token" \
        "$ACPS_CLI" --config "$ACPS_CLI_CONFIG" \
        agent \
        submit \
        --agent-id "$agent_id" \
        --json > "${E2E_ROOT}/submit.json"

    log "管理员审批 Agent"
    REGISTRY_TOKEN_FILE="$admin_token" \
        "$ACPS_CLI" --config "$ACPS_CLI_CONFIG" \
        admin \
        auth \
        login \
        --username "$REGISTRY_ADMIN_USERNAME" \
        --password "$REGISTRY_ADMIN_PASSWORD" \
        --json > "${E2E_ROOT}/admin-login.json"

    REGISTRY_TOKEN_FILE="$admin_token" \
        "$ACPS_CLI" --config "$ACPS_CLI_CONFIG" \
        admin \
        registry \
        review \
        approve \
        --agent-id "$agent_id" \
        --json > "${E2E_ROOT}/approve.json"
    aic="$(json_get "${E2E_ROOT}/approve.json" "aic")"
    printf '%s\n' "$aic" > "${E2E_ROOT}/aic.txt"

    log "获取 EAB 凭证"
    REGISTRY_TOKEN_FILE="$user_token" \
        "$ACPS_CLI" --config "$ACPS_CLI_CONFIG" \
        cert \
        eab \
        fetch \
        --aic "$aic" \
        --output "${E2E_ROOT}/eab.json" \
        --json > "${E2E_ROOT}/eab-fetch.json"

    log "使用 acps-cli 申请证书"
    "$ACPS_CLI" --config "$ACPS_CLI_CONFIG" cert issue --aic "$aic" --eab-file "${E2E_ROOT}/eab.json" --usage clientAuth

    cert_path="${E2E_ROOT}/keyfiles/certs/${aic}.pem"
    trust_bundle_path="${E2E_ROOT}/keyfiles/trust-bundle.pem"
    require_file_exists "$cert_path" "签发证书"
    require_file_exists "$trust_bundle_path" "trust bundle"

    openssl x509 -in "$cert_path" -noout -subject -issuer -serial > "${E2E_ROOT}/cert-summary.txt"
    openssl verify -CAfile "$trust_bundle_path" "$cert_path" > "${E2E_ROOT}/openssl-verify.txt"

    log "ATR/EAB E2E 验证完成"
    cat <<EOF

=== E2E 结果 ===
stage_root=${STAGE_ROOT}
artifacts=${E2E_ROOT}
agent_id=${agent_id}
aic=${aic}
eab_json=${E2E_ROOT}/eab.json
certificate=${cert_path}
trust_bundle=${trust_bundle_path}
cert_summary=${E2E_ROOT}/cert-summary.txt
openssl_verify=${E2E_ROOT}/openssl-verify.txt
EOF
}

main() {
    parse_args "$@"
    set_default_platform
    ensure_prerequisites
    prepare_stage_layout

    if [[ "$SKIP_BUILD" == false ]]; then
        build_bundles
    else
        log "跳过发布包构建"
    fi

    if [[ "$SKIP_DEPLOY" == false ]]; then
        prepare_release_bundles
        deploy_stack
    else
        log "跳过部署，复用现有运行环境"
        check_running_stack
    fi

    run_e2e_flow
}

main "$@"