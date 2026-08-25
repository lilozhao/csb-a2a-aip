#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
WORKSPACE_DIR="$(cd "${RELEASE_DIR}/.." && pwd)"
OUTPUT_DIR="${RELEASE_DIR}/dist"
DEFAULT_PLATFORMS=("linux/arm64" "linux/amd64")

# 避免在 macOS 上打包时把 com.apple.* 扩展属性写进 tar，
# 否则目标 Linux 机解包会刷出大量 LIBARCHIVE.xattr 警告。
export COPYFILE_DISABLE=1

# shellcheck source=/dev/null
source "${RELEASE_DIR}/scripts/lib/build.sh"

usage() {
    cat <<'EOF'
用法: bash scripts/release-standalone/build.sh [VERSION]

环境变量:
  PLATFORMS   逗号分隔的平台列表，默认: linux/arm64,linux/amd64
    DISCOVERY_BUILD_PROFILE  discovery-server 构建档位，支持 cpu 或 gpu，默认: cpu

说明:
  - 统一构建并收集以下离线包：
        acps-stage-infra
    registry-server release-app
    ca-server release-app
    discovery-server release-app
    mq-auth-server release-app
    demo-partner
    demo-leader
    - 最终输出到 dist/acps-demo-standalone-{version}-{platform}.tar
EOF
}

VERSION_ARG="${1:-}"

# 注意：以下工程已加入 release-standalone：
#   acps-stage-infra, registry-server, ca-server, discovery-server,
#   mq-auth-server, demo-partner, demo-leader
if [[ "${VERSION_ARG}" == "-h" || "${VERSION_ARG}" == "--help" ]]; then
    usage
    exit 0
fi

if [[ "$#" -gt 1 ]]; then
    echo "错误：只允许提供一个可选的 VERSION 参数" >&2
    usage >&2
    exit 1
fi

VERSION="${VERSION_ARG:-$(date +%Y%m%d%H%M%S)}"

# 前置门禁
# shellcheck source=/dev/null
source "${RELEASE_DIR}/scripts/tests/preflight.sh"
export RELEASE_VERSION="${VERSION}"
run_preflight

parse_platforms() {
    local raw="${PLATFORMS:-}"
    local item

    if [[ -z "${raw}" ]]; then
        printf '%s\n' "${DEFAULT_PLATFORMS[@]}"
        return 0
    fi

    raw="${raw//,/ }"
    for item in ${raw}; do
        [[ -n "${item}" ]] || continue
        printf '%s\n' "${item}"
    done
}

require_file_exists_local() {
    local path="$1"
    if [[ ! -f "${path}" ]]; then
        echo "错误：缺少文件: ${path}" >&2
        exit 1
    fi
}

read_result_value() {
    local result_file="$1"
    local key="$2"

    require_file_exists_local "${result_file}"
    awk -F= -v key="${key}" '$1 == key { print substr($0, length(key) + 2); exit }' "${result_file}"
}

collect_artifact() {
    local src="$1"
    local dest_dir="$2"

    require_file_exists_local "${src}"
    cp "${src}" "${dest_dir}/"
}

collect_result_artifact() {
    local result_file="$1"
    local dest_dir="$2"
    local bundle_path=""

    bundle_path="$(read_result_value "${result_file}" bundle_path)"
    if [[ -z "${bundle_path}" ]]; then
        echo "错误：result file 缺少 bundle_path: ${result_file}" >&2
        exit 1
    fi

    collect_artifact "${bundle_path}" "${dest_dir}"
}

create_standalone_release_tar() {
    local staging_parent_dir="$1"
    local release_name="$2"
    local output_dir="$3"
    local release_tar
    local tar_args=()

    release_tar="${output_dir}/${release_name}.tar"
    # macOS 自带 bsdtar 会把 Apple 扩展属性写进归档；显式关闭，
    # 避免目标 Linux 解包时出现 LIBARCHIVE.xattr.com.apple.* 警告。
    if [[ "$(uname -s)" == "Darwin" ]]; then
        tar_args+=(--no-mac-metadata --no-xattrs --no-acls)
    fi

    tar_args+=(-cf "${release_tar}" -C "${staging_parent_dir}" "${release_name}")
    tar "${tar_args[@]}"
    printf '%s\n' "${release_tar}"
}

sha256_file() {
    local path="$1"

    require_file_exists_local "${path}"
    if command -v sha256sum >/dev/null 2>&1; then
        sha256sum "${path}" | awk '{print $1}'
        return 0
    fi

    if command -v shasum >/dev/null 2>&1; then
        shasum -a 256 "${path}" | awk '{print $1}'
        return 0
    fi

    echo "错误：未找到 sha256sum 或 shasum 命令，无法生成 manifest 校验信息" >&2
    exit 1
}

git_commit_or_unknown() {
    local repo_path="$1"

    git -C "${repo_path}" rev-parse HEAD 2>/dev/null || echo "unknown"
}

write_manifest() {
    local release_dir="$1"
    local version="$2"
    local platform="$3"
    local built_at="$4"
    local registry_result_file="$5"
    local ca_result_file="$6"
    local discovery_result_file="$7"
    local mq_auth_result_file="$8"
    local demo_partner_result_file="$9"
    local demo_leader_result_file="${10}"
    local manifest_file="${release_dir}/manifest.toml"

    cat > "${manifest_file}" <<EOF
schema_version = 1
version = "${version}"
platform = "${platform}"
built_at = "${built_at}"
generator = "scripts/release-standalone/build.sh"

[[bundles]]
name = "acps-stage-infra"
file = "bundles/acps-stage-infra-${version}.tar.gz"
sha256 = "$(sha256_file "${release_dir}/bundles/acps-stage-infra-${version}.tar.gz")"
source_project = "acps-infra"
source_commit = "$(git_commit_or_unknown "${RELEASE_DIR}")"

[[bundles]]
name = "registry-server-app"
file = "bundles/registry-server-app-${version}.tar.gz"
sha256 = "$(sha256_file "${release_dir}/bundles/registry-server-app-${version}.tar.gz")"
source_project = "registry-server"
source_commit = "$(read_result_value "${registry_result_file}" source_commit)"

[[bundles]]
name = "ca-server-app"
file = "bundles/ca-server-app-${version}.tar.gz"
sha256 = "$(sha256_file "${release_dir}/bundles/ca-server-app-${version}.tar.gz")"
source_project = "ca-server"
source_commit = "$(read_result_value "${ca_result_file}" source_commit)"

[[bundles]]
name = "discovery-server-app"
file = "bundles/discovery-server-app-${version}.tar.gz"
sha256 = "$(sha256_file "${release_dir}/bundles/discovery-server-app-${version}.tar.gz")"
source_project = "discovery-server"
source_commit = "$(read_result_value "${discovery_result_file}" source_commit)"

[[bundles]]
name = "mq-auth-server-app"
file = "bundles/mq-auth-server-app-${version}.tar.gz"
sha256 = "$(sha256_file "${release_dir}/bundles/mq-auth-server-app-${version}.tar.gz")"
source_project = "mq-auth-server"
source_commit = "$(read_result_value "${mq_auth_result_file}" source_commit)"

[[bundles]]
name = "demo-partner"
file = "bundles/demo-partner-${version}.tar.gz"
sha256 = "$(sha256_file "${release_dir}/bundles/demo-partner-${version}.tar.gz")"
source_project = "demo-partner"
source_commit = "$(read_result_value "${demo_partner_result_file}" source_commit)"

[[bundles]]
name = "demo-leader"
file = "bundles/demo-leader-${version}.tar.gz"
sha256 = "$(sha256_file "${release_dir}/bundles/demo-leader-${version}.tar.gz")"
source_project = "demo-leader"
source_commit = "$(read_result_value "${demo_leader_result_file}" source_commit)"
EOF
}

write_version_matrix() {
    local release_dir="$1"
    local version="$2"
    local platform="$3"
    local built_at="$4"
    local registry_result_file="$5"
    local ca_result_file="$6"
    local discovery_result_file="$7"
    local mq_auth_result_file="$8"
    local demo_partner_result_file="$9"
    local demo_leader_result_file="${10}"
    local matrix_file="${release_dir}/version-matrix.toml"

    cat > "${matrix_file}" <<EOF
schema_version = 1
version = "${version}"
platform = "${platform}"
built_at = "${built_at}"

[[bundles]]
name = "acps-stage-infra"
bundle_file = "bundles/acps-stage-infra-${version}.tar.gz"
source_project = "acps-infra"
source_commit = "$(git_commit_or_unknown "${RELEASE_DIR}")"
metadata_file = "VERSION"
images_lock = "images.lock"

[[bundles]]
name = "registry-server-app"
bundle_file = "bundles/registry-server-app-${version}.tar.gz"
source_project = "registry-server"
source_commit = "$(read_result_value "${registry_result_file}" source_commit)"
metadata_file = "VERSION"
image = "$(read_result_value "${registry_result_file}" image)"
image_digest = "$(read_result_value "${registry_result_file}" image_digest)"

[[bundles]]
name = "ca-server-app"
bundle_file = "bundles/ca-server-app-${version}.tar.gz"
source_project = "ca-server"
source_commit = "$(read_result_value "${ca_result_file}" source_commit)"
metadata_file = "VERSION"
image = "$(read_result_value "${ca_result_file}" image)"
image_digest = "$(read_result_value "${ca_result_file}" image_digest)"

[[bundles]]
name = "discovery-server-app"
bundle_file = "bundles/discovery-server-app-${version}.tar.gz"
source_project = "discovery-server"
source_commit = "$(read_result_value "${discovery_result_file}" source_commit)"
metadata_file = "VERSION"
image = "$(read_result_value "${discovery_result_file}" image)"
image_digest = "$(read_result_value "${discovery_result_file}" image_digest)"

[[bundles]]
name = "mq-auth-server-app"
bundle_file = "bundles/mq-auth-server-app-${version}.tar.gz"
source_project = "mq-auth-server"
source_commit = "$(read_result_value "${mq_auth_result_file}" source_commit)"
metadata_file = "VERSION"
image = "$(read_result_value "${mq_auth_result_file}" image)"
image_digest = "$(read_result_value "${mq_auth_result_file}" image_digest)"

[[bundles]]
name = "demo-partner"
bundle_file = "bundles/demo-partner-${version}.tar.gz"
source_project = "demo-partner"
source_commit = "$(read_result_value "${demo_partner_result_file}" source_commit)"
metadata_file = "VERSION"
image = "$(read_result_value "${demo_partner_result_file}" image)"
image_digest = "$(read_result_value "${demo_partner_result_file}" image_digest)"

[[bundles]]
name = "demo-leader"
bundle_file = "bundles/demo-leader-${version}.tar.gz"
source_project = "demo-leader"
source_commit = "$(read_result_value "${demo_leader_result_file}" source_commit)"
metadata_file = "VERSION"
image = "$(read_result_value "${demo_leader_result_file}" image)"
image_digest = "$(read_result_value "${demo_leader_result_file}" image_digest)"
EOF
}

build_for_platform() {
    local platform="$1"
    local built_at
    local staging_root
    local release_name
    local release_dir
    local bundles_dir
    local results_dir
    local checksum_cmd=()
    local registry_result
    local ca_result
    local discovery_result
    local mq_auth_result
    local demo_partner_result
    local demo_leader_result
    local -a build_pids=()
    local build_failed=0

    echo "=== 构建 standalone: version=${VERSION}, platform=${platform} ==="

    export DOCKER_PLATFORM="${platform}"

    staging_root="$(mktemp -d)"
    results_dir="${staging_root}/results"
    mkdir -p "${results_dir}"
    registry_result="${results_dir}/registry-server.env"
    ca_result="${results_dir}/ca-server.env"
    discovery_result="${results_dir}/discovery-server.env"
    mq_auth_result="${results_dir}/mq-auth-server.env"
    demo_partner_result="${results_dir}/demo-partner.env"
    demo_leader_result="${results_dir}/demo-leader.env"

    bash "${RELEASE_DIR}/scripts/stage-infra/build-stage-infra-bundle.sh" "${VERSION}"

    (
        set -euo pipefail
        bash "${WORKSPACE_DIR}/registry-server/scripts/release-app/build-app-bundle.sh" --result-file "${registry_result}" "${VERSION}"
        bash "${WORKSPACE_DIR}/ca-server/scripts/release-app/build-app-bundle.sh" --result-file "${ca_result}" "${VERSION}"
        bash "${WORKSPACE_DIR}/mq-auth-server/scripts/release-app/build-app-bundle.sh" --result-file "${mq_auth_result}" "${VERSION}"
        bash "${WORKSPACE_DIR}/demo-partner/scripts/release-app/build-app-bundle.sh" --result-file "${demo_partner_result}" "${VERSION}"
        bash "${WORKSPACE_DIR}/demo-leader/scripts/release-app/build-app-bundle.sh" --result-file "${demo_leader_result}" "${VERSION}"
    ) &
    build_pids+=("$!")

    (
        set -euo pipefail
        bash "${WORKSPACE_DIR}/discovery-server/scripts/release-app/build-app-bundle.sh" --result-file "${discovery_result}" "${VERSION}"
    ) &
    build_pids+=("$!")

    for pid in "${build_pids[@]}"; do
        if ! wait "${pid}"; then
            build_failed=1
        fi
    done

    if [[ "${build_failed}" -ne 0 ]]; then
        echo "错误：standalone 子 bundle 构建失败" >&2
        rm -rf "${staging_root}"
        exit 1
    fi

    mkdir -p "${OUTPUT_DIR}"
    built_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    release_name="acps-demo-standalone-${VERSION}-$(echo "${platform}" | tr '/' '-')"
    release_dir="${staging_root}/${release_name}"
    bundles_dir="${release_dir}/bundles"
    mkdir -p "${bundles_dir}"

    collect_artifact "${RELEASE_DIR}/dist/acps-stage-infra-${VERSION}.tar.gz" "${bundles_dir}"
    collect_result_artifact "${registry_result}" "${bundles_dir}"
    collect_result_artifact "${ca_result}" "${bundles_dir}"
    collect_result_artifact "${discovery_result}" "${bundles_dir}"
    collect_result_artifact "${mq_auth_result}" "${bundles_dir}"
    collect_result_artifact "${demo_partner_result}" "${bundles_dir}"
    collect_result_artifact "${demo_leader_result}" "${bundles_dir}"

    cp "${SCRIPT_DIR}/install.sh" "${release_dir}/install.sh"
    cp "${SCRIPT_DIR}/upgrade.sh" "${release_dir}/upgrade.sh"
    mkdir -p "${release_dir}/lib"
    cp "${SCRIPT_DIR}/../lib/certs-permissions-lib.sh" "${release_dir}/lib/certs-permissions-lib.sh"
    cp "${SCRIPT_DIR}/provision-registry-server-mtls-certs.py" "${release_dir}/provision-registry-server-mtls-certs.py"
    cp "${SCRIPT_DIR}/provision-stage-infra-certs.py" "${release_dir}/provision-stage-infra-certs.py"
    cp "${SCRIPT_DIR}/provision-mq-auth-server-certs.py" "${release_dir}/provision-mq-auth-server-certs.py"
    cp "${SCRIPT_DIR}/.env.example" "${release_dir}/.env.example"
    cp "${SCRIPT_DIR}/README.md" "${release_dir}/README.md"
    chmod +x "${release_dir}/install.sh" "${release_dir}/upgrade.sh"

    cat > "${release_dir}/VERSION" <<EOF
version=${VERSION}
platform=${platform}
built_at=${built_at}
EOF

    write_manifest \
        "${release_dir}" \
        "${VERSION}" \
        "${platform}" \
        "${built_at}" \
        "${registry_result}" \
        "${ca_result}" \
        "${discovery_result}" \
        "${mq_auth_result}" \
        "${demo_partner_result}" \
        "${demo_leader_result}"
    write_version_matrix \
        "${release_dir}" \
        "${VERSION}" \
        "${platform}" \
        "${built_at}" \
        "${registry_result}" \
        "${ca_result}" \
        "${discovery_result}" \
        "${mq_auth_result}" \
        "${demo_partner_result}" \
        "${demo_leader_result}"

    while IFS= read -r token; do
        checksum_cmd+=("${token}")
    done < <(detect_sha256_cmd)
    generate_checksums "${release_dir}" "${checksum_cmd[@]}"
    create_standalone_release_tar "${staging_root}" "${release_name}" "${OUTPUT_DIR}" >/dev/null

    echo "输出: ${OUTPUT_DIR}/${release_name}.tar"
    rm -rf "${staging_root}"
}

while IFS= read -r platform; do
    [[ -n "${platform}" ]] || continue
    build_for_platform "${platform}"
done < <(parse_platforms)
