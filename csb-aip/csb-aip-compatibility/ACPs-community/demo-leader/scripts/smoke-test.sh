#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -f "${SCRIPT_DIR}/leader/config.toml" ]]; then
	BUNDLE_ROOT_LAYOUT="true"
	PROJECT_DIR="${SCRIPT_DIR}"
else
	BUNDLE_ROOT_LAYOUT="false"
	PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
fi
# shellcheck source=scripts/lib/common.sh
source "${SCRIPT_DIR}/lib/common.sh"

ENV_FILE="${ENV_FILE:-${PROJECT_DIR}/.env}"
CONFIG_FILE="${LEADER_CONFIG_FILE:-${PROJECT_DIR}/leader/config.toml}"
CURL_CONNECT_TIMEOUT="${CURL_CONNECT_TIMEOUT:-3}"
CURL_MAX_TIME="${CURL_MAX_TIME:-15}"

resolve_http_host() {
	local configured_host="$1"
	case "${configured_host}" in
		""|"0.0.0.0"|"::"|"[::]")
			printf '%s\n' "localhost"
			;;
		*)
			printf '%s\n' "${configured_host}"
			;;
	esac
}

source_env_file "${ENV_FILE}"
require_file_exists "${CONFIG_FILE}" "leader/config.toml"

web_host_value="${WEB_APP_HOST:-$(extract_toml_section_string_value "web" "host" "${CONFIG_FILE}")}"
web_port_value="${WEB_APP_PORT:-$(extract_toml_section_integer_value "web" "port" "${CONFIG_FILE}")}"
leader_host_value="${LEADER_API_HOST:-$(extract_toml_section_string_value "uvicorn" "host" "${CONFIG_FILE}")}"
leader_port_value="${LEADER_API_PORT:-$(extract_toml_section_integer_value "uvicorn" "port" "${CONFIG_FILE}")}"

web_host="$(resolve_http_host "${web_host_value:-127.0.0.1}")"
leader_host="$(resolve_http_host "${leader_host_value:-0.0.0.0}")"
WEB_BASE_URL="${WEB_BASE_URL:-http://${web_host}:${web_port_value:-9010}}"
if [[ -z "${LEADER_HEALTH_URL:-}" ]]; then
	if [[ "${BUNDLE_ROOT_LAYOUT}" == "true" ]]; then
		LEADER_HEALTH_URL="http://${web_host}:${web_port_value:-9010}/api/v1/health"
	else
		LEADER_HEALTH_URL="http://${leader_host}:${leader_port_value:-9011}/api/v1/health"
	fi
fi

log "check web root: ${WEB_BASE_URL}"
curl --fail --silent --show-error \
	--connect-timeout "${CURL_CONNECT_TIMEOUT}" \
	--max-time "${CURL_MAX_TIME}" \
	"${WEB_BASE_URL}" >/dev/null

log "check leader api health: ${LEADER_HEALTH_URL}"
curl --fail --silent --show-error \
	--connect-timeout "${CURL_CONNECT_TIMEOUT}" \
	--max-time "${CURL_MAX_TIME}" \
	"${LEADER_HEALTH_URL}" >/dev/null

log "OK"
