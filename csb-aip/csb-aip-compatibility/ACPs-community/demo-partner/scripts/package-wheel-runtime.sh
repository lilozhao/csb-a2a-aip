#!/usr/bin/env bash

set -eu -o pipefail
export COPYFILE_DISABLE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SIBLING_DIR="$(cd "${PROJECT_DIR}/.." && pwd)"
SIBLING_ROOT="$(dirname "${PROJECT_DIR}")"

source "${SCRIPT_DIR}/lib/build.sh"

OUTPUT_DIR="${PROJECT_DIR}/dist"
PYTHON_VERSION="${PACKAGE_PYTHON_VERSION:-3.14}"
PIP_PLATFORMS=()
if [[ -n "${PACKAGE_PIP_PLATFORM:-}" ]]; then
    PIP_PLATFORMS+=("${PACKAGE_PIP_PLATFORM}")
fi
PIP_IMPLEMENTATION="${PACKAGE_PIP_IMPLEMENTATION:-}"
PIP_ABI="${PACKAGE_PIP_ABI:-}"
OFFLINE=0

usage() {
    cat <<'EOF'
用法：scripts/package-wheel-runtime.sh [--offline] [--python-version <version>] [--pip-platform <tag>]... [--pip-implementation <impl>] [--pip-abi <abi>]

说明：
  --offline                 额外下载运行时依赖 wheelhouse，生成离线 Python 依赖包
  --python-version <ver>    目标 Python 版本，默认 3.14
  --pip-platform <tag>      pip download 的目标平台标签；可重复传入以覆盖同一目标环境的多个 manylinux tag
  --pip-implementation <i>  pip download 的目标实现，例如 cp
  --pip-abi <abi>           pip download 的目标 ABI，例如 cp314

示例：
  scripts/package-wheel-runtime.sh
  scripts/package-wheel-runtime.sh --offline
  scripts/package-wheel-runtime.sh --offline --pip-platform manylinux2014_x86_64 --pip-platform manylinux_2_28_x86_64 --pip-implementation cp --pip-abi cp314
EOF
}

require_command() {
    local command_name="$1"

    if ! command -v "${command_name}" >/dev/null 2>&1; then
        echo "错误：未找到 ${command_name} 命令" >&2
        exit 1
    fi
}

require_sibling_project() {
    local project_name="$1"
    local project_dir="${SIBLING_DIR}/${project_name}"

    if [[ ! -d "${project_dir}" ]]; then
        echo "错误：未找到 sibling ${project_name} 目录：${project_dir}" >&2
        return 1
    fi

    if [[ ! -f "${project_dir}/pyproject.toml" ]]; then
        echo "错误：${project_dir} 存在，但不是 ${project_name} 项目根目录（缺少 pyproject.toml）" >&2
        return 1
    fi

    return 0
}

require_sibling_projects() {
    local current_project
    local missing=0

    current_project="$(basename "${PROJECT_DIR}")"
    require_sibling_project "acps-sdk" || missing=1
    require_sibling_project "acps-cli" || missing=1

    if [[ "${missing}" -ne 0 ]]; then
        echo "请将 ${current_project}、acps-sdk、acps-cli 放在同一父目录，例如：" >&2
        echo "  ${SIBLING_ROOT}/${current_project}" >&2
        echo "  ${SIBLING_ROOT}/acps-sdk" >&2
        echo "  ${SIBLING_ROOT}/acps-cli" >&2
        echo "如果当前目录来自全新 clone，请额外 clone 缺失的 sibling 仓库后重试 just package wheel" >&2
        exit 1
    fi
}

resolve_target_platform() {
    if [[ "${#PIP_PLATFORMS[@]}" -gt 0 ]]; then
        printf '%s\n' "${PIP_PLATFORMS[0]}"
        return
    fi

    python3 -c 'import sysconfig; print(sysconfig.get_platform().replace("-", "_").replace(".", "_"))'
}

resolve_project_version() {
    (
        cd "${PROJECT_DIR}"
        python3 -c 'import tomllib; from pathlib import Path; print(tomllib.loads(Path("pyproject.toml").read_text(encoding="utf-8"))["project"]["version"])'
    )
}

build_runtime_requirements() {
    local output_file="$1"

    (
        cd "${PROJECT_DIR}"
        uv export --format requirements-txt --no-dev --no-emit-project --no-hashes \
            | grep -Ev '^-e \.\./acps-(cli|sdk)$' > "${output_file}"
    )
}

download_wheelhouse() {
    local requirements_file="$1"
    local wheelhouse_dir="$2"
    local implementation="$3"
    local platform_tag
    local -a pip_args=(
        download
        --dest "${wheelhouse_dir}"
        --requirement "${requirements_file}"
        --only-binary=:all:
    )

    if [[ "${#PIP_PLATFORMS[@]}" -gt 0 ]]; then
        for platform_tag in "${PIP_PLATFORMS[@]}"; do
            pip_args+=(--platform "${platform_tag}")
        done
        pip_args+=(--python-version "${PYTHON_VERSION}")
        implementation="${implementation:-cp}"
    fi

    if [[ -n "${implementation}" ]]; then
        pip_args+=(--implementation "${implementation}")
    fi

    if [[ -n "${PIP_ABI}" ]]; then
        pip_args+=(--abi "${PIP_ABI}")
    fi

    (
        cd "${PROJECT_DIR}"
        uv run --python "${PYTHON_VERSION}" --with pip --no-project python -m pip "${pip_args[@]}"
    )
}

build_project_wheel() {
    local project_dir="$1"

    (
        cd "${project_dir}"
        uv build --wheel
    )
}

find_wheel() {
    local search_dir="$1"
    local pattern="$2"

    find "${search_dir}" -maxdepth 1 -type f -name "${pattern}" | LC_ALL=C sort | tail -n 1
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --offline)
            OFFLINE=1
            ;;
        --python-version)
            shift
            if [[ $# -eq 0 ]]; then
                echo "错误：--python-version 需要一个值" >&2
                exit 2
            fi
            PYTHON_VERSION="$1"
            ;;
        --pip-platform)
            shift
            if [[ $# -eq 0 ]]; then
                echo "错误：--pip-platform 需要一个值" >&2
                exit 2
            fi
            PIP_PLATFORMS+=("$1")
            ;;
        --pip-implementation)
            shift
            if [[ $# -eq 0 ]]; then
                echo "错误：--pip-implementation 需要一个值" >&2
                exit 2
            fi
            PIP_IMPLEMENTATION="$1"
            ;;
        --pip-abi)
            shift
            if [[ $# -eq 0 ]]; then
                echo "错误：--pip-abi 需要一个值" >&2
                exit 2
            fi
            PIP_ABI="$1"
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "错误：未知参数 $1" >&2
            usage >&2
            exit 2
            ;;
    esac
    shift
done

if [[ -n "${PIP_ABI}" && "${#PIP_PLATFORMS[@]}" -eq 0 ]]; then
    echo "错误：--pip-abi 需要与 --pip-platform 一起使用" >&2
    exit 2
fi

if [[ -n "${PIP_IMPLEMENTATION}" && "${#PIP_PLATFORMS[@]}" -eq 0 ]]; then
    echo "错误：--pip-implementation 需要与 --pip-platform 一起使用" >&2
    exit 2
fi

require_command uv
require_command python3

project_version="$(resolve_project_version)"
target_platform="$(resolve_target_platform)"
release_name="demo-partner-wheel-${project_version}-${target_platform}"

if [[ "${OFFLINE}" -eq 1 ]]; then
    release_name="demo-partner-wheel-offline-${project_version}-${target_platform}"
fi

validate_required_files "${PROJECT_DIR}" \
    .env.example \
    README.md \
    pyproject.toml \
    partners/online \
    scripts/smoke-test.sh \
    scripts/systemd/demo-partner.service

require_sibling_projects

echo "=== 构建应用 wheel ==="
build_project_wheel "${SIBLING_DIR}/acps-sdk"
build_project_wheel "${SIBLING_DIR}/acps-cli"
build_project_wheel "${PROJECT_DIR}"

sdk_wheel_path="$(find_wheel "${SIBLING_DIR}/acps-sdk/dist" 'acps_sdk-*.whl')"
cli_wheel_path="$(find_wheel "${SIBLING_DIR}/acps-cli/dist" 'acps_cli-*.whl')"
app_wheel_path="$(find_wheel "${OUTPUT_DIR}" "demo_partner-${project_version}-*.whl")"

if [[ -z "${sdk_wheel_path}" ]]; then
    echo "错误：未在 ../acps-sdk/dist/ 下找到 acps_sdk-*.whl" >&2
    exit 1
fi

if [[ -z "${cli_wheel_path}" ]]; then
    echo "错误：未在 ../acps-cli/dist/ 下找到 acps_cli-*.whl" >&2
    exit 1
fi

if [[ -z "${app_wheel_path}" ]]; then
    echo "错误：未在 dist/ 下找到 demo_partner-${project_version}-*.whl" >&2
    exit 1
fi

staging_parent_dir="$(mktemp -d)"
staging_dir="${staging_parent_dir}/${release_name}"
trap 'rm -rf "${staging_parent_dir}"' EXIT
mkdir -p "${staging_dir}/dist"

RUNTIME_BUNDLE_MAP=(
    ".env.example|.env.example"
    "README.md|README.md"
    "partners/online|partners/online"
    "scripts/lib/common.sh|scripts/lib/common.sh"
    "scripts/smoke-test.sh|scripts/smoke-test.sh"
    "scripts/systemd/demo-partner.service|demo-partner.service"
)

RUNTIME_BUNDLE_EXCLUDE_MAP=(
    "${DEFAULT_BUNDLE_EXCLUDE_MAP[@]}"
    "._*"
    "*/._*"
)

copy_bundle_files "${PROJECT_DIR}" "${staging_dir}" RUNTIME_BUNDLE_MAP RUNTIME_BUNDLE_EXCLUDE_MAP
find "${staging_dir}/partners/online" -type f \( -name '*.pem' -o -name '*.key' -o -name '*.csr' -o -name '*.srl' \) -delete

cp "${sdk_wheel_path}" "${staging_dir}/dist/"
cp "${cli_wheel_path}" "${staging_dir}/dist/"
cp "${app_wheel_path}" "${staging_dir}/dist/"

echo "=== 导出运行时依赖清单 ==="
build_runtime_requirements "${staging_dir}/requirements-runtime.txt"

if [[ "${OFFLINE}" -eq 1 ]]; then
    echo "=== 下载离线 wheelhouse ==="
    mkdir -p "${staging_dir}/wheelhouse"
    download_wheelhouse "${staging_dir}/requirements-runtime.txt" "${staging_dir}/wheelhouse" "${PIP_IMPLEMENTATION}"

    if [[ "${#PIP_PLATFORMS[@]}" -eq 0 ]]; then
        echo "[INFO]  未指定 --pip-platform，wheelhouse 将按当前构建机平台解析。"
    fi
fi

sha256_cmd=($(detect_sha256_cmd))
generate_checksums "${staging_dir}" "${sha256_cmd[@]}"
release_tar="$(create_release_tar "${staging_parent_dir}" "${release_name}" "${OUTPUT_DIR}")"

echo "=== 构建完成 ==="
echo "  运行包: ${release_tar}"
echo "  应用 wheel: $(basename "${app_wheel_path}")"
echo "  依赖 wheel: $(basename "${sdk_wheel_path}"), $(basename "${cli_wheel_path}")"
echo "  目标平台: ${target_platform}"
if [[ "${OFFLINE}" -eq 1 ]]; then
    echo "  模式: offline（包含 wheelhouse/）"
else
    echo "  模式: online（不包含 wheelhouse/）"
fi