#!/usr/bin/env bash

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

err() {
    echo "[$(date '+%H:%M:%S')] 错误: $*" >&2
}

require_exact_args() {
    local function_name="$1"
    local expected="$2"
    local actual="$3"

    if [[ "$actual" -ne "$expected" ]]; then
        err "${function_name} 需要 ${expected} 个参数，实际收到 ${actual} 个"
        return 1
    fi
}

require_min_args() {
    local function_name="$1"
    local expected_min="$2"
    local actual="$3"

    if [[ "$actual" -lt "$expected_min" ]]; then
        err "${function_name} 至少需要 ${expected_min} 个参数，实际收到 ${actual} 个"
        return 1
    fi
}

source_env_file() {
    local env_file="$1"

    if [[ ! -f "$env_file" ]]; then
        return 0
    fi

    set -a
    # shellcheck source=/dev/null
    source "$env_file"
    set +a
}

require_file_exists() {
    local path="$1"
    local label="${2:-$1}"

    if [[ ! -f "$path" ]]; then
        err "缺少文件: ${label}"
        return 1
    fi
}

require_dir_exists() {
    local path="$1"
    local label="${2:-$1}"

    if [[ ! -d "$path" ]]; then
        err "缺少目录: ${label}"
        return 1
    fi
}

assert_file_not_contains() {
    local file_path="$1"
    local pattern="$2"
    local label="${3:-$1}"

    require_file_exists "$file_path" "$label" || return 1

    if grep -Eq "$pattern" "$file_path"; then
        err "检测到未替换的模板配置: ${label}"
        return 1
    fi
}

extract_toml_string_value() {
    local key="$1"
    local file_path="$2"

    awk -v key="$key" '
        $1 == key {
            if (match($0, /"[^"]+"/)) {
                value = substr($0, RSTART + 1, RLENGTH - 2)
                print value
                exit
            }
        }
    ' "$file_path"
}

extract_toml_integer_value() {
    local key="$1"
    local file_path="$2"

    awk -v key="$key" '
        $1 == key {
            if (match($0, /=[[:space:]]*[0-9]+/)) {
                value = substr($0, RSTART + 1, RLENGTH - 1)
                gsub(/^[[:space:]]+/, "", value)
                print value
                exit
            }
        }
    ' "$file_path"
}

extract_toml_section_string_value() {
    local section="$1"
    local key="$2"
    local file_path="$3"

    awk -v section="[$section]" -v key="$key" '
        /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
            header = $0
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", header)
            in_section = (header == section)
            next
        }

        !in_section { next }

        $1 == key {
            if (match($0, /"[^"]+"/)) {
                value = substr($0, RSTART + 1, RLENGTH - 2)
                print value
                exit
            }
        }
    ' "$file_path"
}

extract_toml_section_integer_value() {
    local section="$1"
    local key="$2"
    local file_path="$3"

    awk -v section="[$section]" -v key="$key" '
        /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
            header = $0
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", header)
            in_section = (header == section)
            next
        }

        !in_section { next }

        $1 == key {
            if (match($0, /=[[:space:]]*[0-9]+/)) {
                value = substr($0, RSTART + 1, RLENGTH - 1)
                gsub(/^[[:space:]]+/, "", value)
                print value
                exit
            }
        }
    ' "$file_path"
}

extract_toml_section_boolean_value() {
    local section="$1"
    local key="$2"
    local file_path="$3"

    awk -v section="[$section]" -v key="$key" '
        /^[[:space:]]*\[[^]]+\][[:space:]]*$/ {
            header = $0
            gsub(/^[[:space:]]+|[[:space:]]+$/, "", header)
            in_section = (header == section)
            next
        }

        !in_section { next }

        $1 == key {
            if (match($0, /=[[:space:]]*(true|false)/)) {
                value = substr($0, RSTART + 1, RLENGTH - 1)
                gsub(/^[[:space:]]+/, "", value)
                print value
                exit
            }
        }
    ' "$file_path"
}

check_tcp_endpoint() {
    local host="$1"
    local port="$2"
    local label="$3"

    if command -v nc >/dev/null 2>&1; then
        if ! nc -z "$host" "$port" >/dev/null 2>&1; then
            err "无法连接到 ${label}: ${host}:${port}"
            return 1
        fi
        return 0
    fi

    if ! bash -lc "</dev/tcp/${host}/${port}" >/dev/null 2>&1; then
        err "无法连接到 ${label}: ${host}:${port}"
        return 1
    fi
}

extract_toml_env_refs() {
    local file_path="$1"

    awk '
        match($0, /^[[:space:]]*(api_key_env|base_url_env|model_env)[[:space:]]*=[[:space:]]*"[^"]+"/) {
            value = substr($0, RSTART, RLENGTH)
            sub(/^[^=]+=[[:space:]]*"/, "", value)
            sub(/"$/, "", value)
            print value
        }
    ' "$file_path"
}

require_toml_env_refs_resolved() {
    local file_path="$1"
    local label="${2:-$1}"
    local env_name=""
    local found=0

    require_file_exists "$file_path" "$label" || return 1

    while IFS= read -r env_name; do
        [[ -n "$env_name" ]] || continue
        found=1
        if [[ -z "${!env_name:-}" ]]; then
            err "${label} 引用了未设置的环境变量: ${env_name}"
            return 1
        fi
    done < <(extract_toml_env_refs "$file_path")

    if [[ $found -eq 0 ]]; then
        err "${label} 缺少 *_env 形式的 LLM 配置"
        return 1
    fi
}
