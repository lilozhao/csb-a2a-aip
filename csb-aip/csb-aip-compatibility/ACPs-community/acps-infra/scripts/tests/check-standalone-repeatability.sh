#!/usr/bin/env bash
set -euo pipefail

REPEATABILITY_TEMP_DIR=""

usage() {
    cat <<'EOF'
用法:
  bash scripts/tests/check-standalone-repeatability.sh <reference-standalone> <candidate-standalone>

参数:
  <reference-standalone>  基线 standalone 产物目录或 tar.gz
  <candidate-standalone>  待比较 standalone 产物目录或 tar.gz

说明:
  - 本脚本比较“可复现输入集合”相关元数据，而不是比较整包字节级完全一致。
  - 会比较顶层 `version-matrix.toml`，以及每个子 bundle 的 `VERSION` 文件。
  - 会忽略 `built_at` / `build_date` 这类时间戳字段，避免误报。
EOF
}

log() {
    echo "[$(date '+%H:%M:%S')] $*"
}

err() {
    echo "[$(date '+%H:%M:%S')] 错误: $*" >&2
}

require_path_exists() {
    local path="$1"
    local label="$2"

    if [[ ! -e "${path}" ]]; then
        err "缺少 ${label}: ${path}"
        exit 1
    fi
}

resolve_release_dir() {
    local input_path="$1"
    local output_dir="$2"

    if [[ -d "${input_path}" ]]; then
        printf '%s\n' "${input_path}"
        return 0
    fi

    require_path_exists "${input_path}" "standalone 产物"
    mkdir -p "${output_dir}"
    tar xzf "${input_path}" -C "${output_dir}"

    find "${output_dir}" -mindepth 1 -maxdepth 1 -type d | sort | head -n 1
}

normalize_key_value_file() {
    local input_file="$1"
    local output_file="$2"

    awk -F= '
        $1 == "build_date" { next }
        { print }
    ' "${input_file}" > "${output_file}"
}

normalize_toml_file() {
    local input_file="$1"
    local output_file="$2"

    awk '
        /^built_at = / { next }
        { print }
    ' "${input_file}" > "${output_file}"
}

extract_bundle_version_files() {
    local release_dir="$1"
    local output_dir="$2"
    local bundle_file=""
    local bundle_name=""
    local version_member=""

    mkdir -p "${output_dir}"

    while IFS= read -r bundle_file; do
        [[ -n "${bundle_file}" ]] || continue
        bundle_name="$(basename "${bundle_file}" .tar.gz)"
        version_member="$(tar tzf "${bundle_file}" | awk '$0 == "VERSION" || $0 ~ /\/VERSION$/ { print; exit }')"
        if [[ -z "${version_member}" ]]; then
            err "bundle 中缺少 VERSION: ${bundle_file}"
            exit 1
        fi
        tar xOf "${bundle_file}" "${version_member}" > "${output_dir}/${bundle_name}.env"
        normalize_key_value_file "${output_dir}/${bundle_name}.env" "${output_dir}/${bundle_name}.normalized.env"
    done < <(find "${release_dir}/bundles" -maxdepth 1 -type f -name '*.tar.gz' | sort)
}

compare_normalized_files() {
    local label="$1"
    local reference_file="$2"
    local candidate_file="$3"

    if ! diff -u "${reference_file}" "${candidate_file}" >/dev/null; then
        err "${label} 不一致"
        diff -u "${reference_file}" "${candidate_file}" || true
        return 1
    fi

    log "${label} 一致"
}

compare_bundle_versions() {
    local reference_dir="$1"
    local candidate_dir="$2"
    local reference_file=""
    local bundle_name=""

    while IFS= read -r reference_file; do
        [[ -n "${reference_file}" ]] || continue
        bundle_name="$(basename "${reference_file}")"
        compare_normalized_files \
            "bundle VERSION ${bundle_name}" \
            "${reference_file}" \
            "${candidate_dir}/${bundle_name}"
    done < <(find "${reference_dir}" -maxdepth 1 -type f -name '*.normalized.env' | sort)
}

main() {
    local reference_input="${1:-}"
    local candidate_input="${2:-}"
    local temp_dir=""
    local reference_release_dir=""
    local candidate_release_dir=""
    local reference_versions_dir=""
    local candidate_versions_dir=""

    if [[ -z "${reference_input}" || -z "${candidate_input}" ]]; then
        usage >&2
        exit 1
    fi

    if [[ "${reference_input}" == "-h" || "${reference_input}" == "--help" ]]; then
        usage
        exit 0
    fi

    temp_dir="$(mktemp -d)"
    REPEATABILITY_TEMP_DIR="${temp_dir}"
    trap 'rm -rf "${REPEATABILITY_TEMP_DIR}"' EXIT

    reference_release_dir="$(resolve_release_dir "${reference_input}" "${temp_dir}/reference")"
    candidate_release_dir="$(resolve_release_dir "${candidate_input}" "${temp_dir}/candidate")"

    require_path_exists "${reference_release_dir}/version-matrix.toml" "reference version-matrix.toml"
    require_path_exists "${candidate_release_dir}/version-matrix.toml" "candidate version-matrix.toml"
    require_path_exists "${reference_release_dir}/bundles" "reference bundles"
    require_path_exists "${candidate_release_dir}/bundles" "candidate bundles"

    normalize_toml_file "${reference_release_dir}/version-matrix.toml" "${temp_dir}/reference.version-matrix.toml"
    normalize_toml_file "${candidate_release_dir}/version-matrix.toml" "${temp_dir}/candidate.version-matrix.toml"
    compare_normalized_files \
        "version-matrix.toml" \
        "${temp_dir}/reference.version-matrix.toml" \
        "${temp_dir}/candidate.version-matrix.toml"

    reference_versions_dir="${temp_dir}/reference-bundle-versions"
    candidate_versions_dir="${temp_dir}/candidate-bundle-versions"
    extract_bundle_version_files "${reference_release_dir}" "${reference_versions_dir}"
    extract_bundle_version_files "${candidate_release_dir}" "${candidate_versions_dir}"
    compare_bundle_versions "${reference_versions_dir}" "${candidate_versions_dir}"

    log "standalone 可复现输入集合检查通过"
}

main "$@"