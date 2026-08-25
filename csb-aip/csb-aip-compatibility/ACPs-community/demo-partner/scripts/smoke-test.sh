#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
# shellcheck source=scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

PARTNERS_DIR="${PARTNERS_ONLINE_DIR:-${PROJECT_DIR}/partners/online}"
ENV_FILE="${ENV_FILE:-${PROJECT_DIR}/.env}"
DEFAULT_HEALTH_HOST="${HEALTHCHECK_HOST:-localhost}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-3}"
CURL_MAX_TIME="${CURL_MAX_TIME:-15}"
PASS=0
FAIL=0

usage() {
	cat <<'EOF'
用法：scripts/smoke-test.sh

环境变量：
  PARTNERS_ONLINE_DIR     Partner 在线配置目录，默认 <project>/partners/online
  ENV_FILE                运行时 .env 文件路径，默认 <project>/.env
  HEALTHCHECK_HOST        当 config.toml 中 server.host 为 0.0.0.0 / :: 时使用的探测主机名，默认 localhost
  CURL_CONNECT_TIMEOUT    curl 连接超时秒数，默认 3
  CURL_MAX_TIME           curl 总超时秒数，默认 15

说明：
  1. 自动加载 ENV_FILE 中的环境变量
  2. 校验所有 Partner config.toml 中的 *_env 引用是否已解析
  3. 逐个使用 client.pem/client.key/trust-bundle.pem 对 https://<host>:<port>/health 执行 mTLS 健康检查
EOF
}

resolve_health_host() {
	local config_path="$1"
	local configured_host=""

	configured_host="$(extract_toml_string_value host "${config_path}")"
	case "${configured_host}" in
		""|"0.0.0.0"|"::"|"[::]")
			printf '%s\n' "${DEFAULT_HEALTH_HOST}"
			;;
		*)
			printf '%s\n' "${configured_host}"
			;;
	esac
}

run_healthcheck() {
	local agent_dir="$1"
	local agent_name="$2"
	local config_path="$3"
	local port="$4"
	local health_host="$5"
	local client_cert="$6"
	local client_key="$7"
	local ca_bundle="$8"
	local url="https://${health_host}:${port}/health"
	local status=""

	log "检查 ${agent_name} 健康端点: ${url}"
	status="$(curl \
		--silent \
		--show-error \
		--connect-timeout "${CURL_CONNECT_TIMEOUT}" \
		--max-time "${CURL_MAX_TIME}" \
		--cert "${client_cert}" \
		--key "${client_key}" \
		--cacert "${ca_bundle}" \
		-o /dev/null \
		-w '%{http_code}' \
		"${url}" || echo "000")"

	if [[ "${status}" == "200" ]]; then
		log "${agent_name} 通过（HTTP 200）"
		PASS=$((PASS + 1))
		return 0
	fi

	err "${agent_name} 健康检查失败，HTTP 状态=${status}"
	FAIL=$((FAIL + 1))
	return 1
}

check_partner() {
	local agent_dir="$1"
	local agent_name="$2"
	local config_path="${agent_dir}/config.toml"
	local client_cert="${agent_dir}/client.pem"
	local client_key="${agent_dir}/client.key"
	local ca_bundle_name=""
	local ca_bundle=""
	local health_host=""
	local port=""

	require_file_exists "${config_path}" "${agent_name}/config.toml" || return 1
	require_toml_env_refs_resolved "${config_path}" "${agent_name}/config.toml" || return 1

	port="$(extract_toml_integer_value port "${config_path}")"
	if [[ -z "${port}" ]]; then
		err "${agent_name}/config.toml 缺少 server.port"
		return 1
	fi

	ca_bundle_name="$(extract_toml_string_value ca_file "${config_path}")"
	ca_bundle="${agent_dir}/${ca_bundle_name:-trust-bundle.pem}"
	health_host="$(resolve_health_host "${config_path}")"

	require_file_exists "${client_cert}" "${agent_name}/client.pem" || return 1
	require_file_exists "${client_key}" "${agent_name}/client.key" || return 1
	require_file_exists "${ca_bundle}" "${agent_name}/${ca_bundle_name:-trust-bundle.pem}" || return 1

	run_healthcheck "${agent_dir}" "${agent_name}" "${config_path}" "${port}" "${health_host}" "${client_cert}" "${client_key}" "${ca_bundle}"
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
	usage
	exit 0
fi

source_env_file "${ENV_FILE}"
require_dir_exists "${PARTNERS_DIR}" "PARTNERS_ONLINE_DIR" || exit 1

shopt -s nullglob
partner_dirs=("${PARTNERS_DIR}"/*)
shopt -u nullglob

if [[ "${#partner_dirs[@]}" -eq 0 ]]; then
	err "${PARTNERS_DIR} 下未发现任何 Partner 目录"
	exit 1
fi

log "开始执行 demo-partner 冒烟测试"
log "PARTNERS_ONLINE_DIR=${PARTNERS_DIR}"
log "ENV_FILE=${ENV_FILE}"

for agent_dir in "${partner_dirs[@]}"; do
	[[ -d "${agent_dir}" ]] || continue
	check_partner "${agent_dir}" "$(basename "${agent_dir}")"
done

log "结果: ${PASS} 通过, ${FAIL} 失败"
if [[ "${FAIL}" -gt 0 ]]; then
	exit 1
fi
