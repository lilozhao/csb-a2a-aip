#!/usr/bin/env bash

set -eu -o pipefail
export COPYFILE_DISABLE=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
SIBLING_ROOT="$(dirname "${PROJECT_DIR}")"
SDK_DIR="${SIBLING_ROOT}/acps-sdk"

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

require_sdk_project() {
    if [[ ! -d "${SDK_DIR}" ]]; then
        echo "错误：未找到 sibling acps-sdk 目录：${SDK_DIR}" >&2
        echo "请将 discovery-server 与 acps-sdk 放在同一父目录，例如：" >&2
        echo "  ${SIBLING_ROOT}/discovery-server" >&2
        echo "  ${SIBLING_ROOT}/acps-sdk" >&2
        echo "如果当前目录来自全新 clone，请额外 clone acps-sdk 后重试 just package wheel" >&2
        exit 1
    fi

    if [[ ! -f "${SDK_DIR}/pyproject.toml" ]]; then
        echo "错误：${SDK_DIR} 存在，但不是 acps-sdk 项目根目录（缺少 pyproject.toml）" >&2
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
    local temp_file
    temp_file="$(mktemp)"

    (
        cd "${PROJECT_DIR}"
        uv export --format requirements-txt --no-dev --no-emit-project --no-hashes > "${temp_file}"
    )

    awk '
        $0 == "-e ../acps-sdk" { skip_next_via = 1; next }
        skip_next_via == 1 && $0 ~ /^    # via / { skip_next_via = 0; next }
        { skip_next_via = 0; print }
    ' "${temp_file}" > "${output_file}"
    rm -f "${temp_file}"
}

download_wheelhouse() {
    local requirements_file="$1"
    local wheelhouse_dir="$2"
    local implementation="$3"
    local platform_tag
    local -a pip_args

    if [[ "${#PIP_PLATFORMS[@]}" -eq 0 ]]; then
        pip_args=(
            wheel
            --wheel-dir "${wheelhouse_dir}"
            --requirement "${requirements_file}"
        )
    else
        pip_args=(
            download
            --dest "${wheelhouse_dir}"
            --requirement "${requirements_file}"
            --only-binary=:all:
        )

        for platform_tag in "${PIP_PLATFORMS[@]}"; do
            pip_args+=(--platform "${platform_tag}")
        done
        pip_args+=(--python-version "${PYTHON_VERSION}")
        implementation="${implementation:-cp}"

        if [[ -n "${implementation}" ]]; then
            pip_args+=(--implementation "${implementation}")
        fi

        if [[ -n "${PIP_ABI}" ]]; then
            pip_args+=(--abi "${PIP_ABI}")
        fi
    fi

    if ! (
        cd "${PROJECT_DIR}"
        uv run --python "${PYTHON_VERSION}" --with pip --no-project python -m pip "${pip_args[@]}"
    ); then
        if [[ "${#PIP_PLATFORMS[@]}" -gt 0 ]]; then
            echo "错误：当前目标平台存在缺少预编译 wheel 的依赖（例如 cbor）。" >&2
            echo "请在匹配目标平台的构建机或容器内重新执行 just package wheel offline，或改为直接在目标平台本机打包。" >&2
        fi
        exit 1
    fi
}

build_sdk_wheel() {
    local output_dir="$1"

    require_sdk_project

    uv build --wheel --out-dir "${output_dir}" "${SDK_DIR}"
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
release_name="discovery-server-wheel-${project_version}-${target_platform}"

if [[ "${OFFLINE}" -eq 1 ]]; then
    release_name="discovery-server-wheel-offline-${project_version}-${target_platform}"
fi

validate_required_files "${PROJECT_DIR}" \
    config \
    alembic \
    alembic.ini \
    .env.example \
    README.md \
    pyproject.toml \
    scripts/prompts/planner_prompt.txt \
    scripts/prompts/cluster_prompt.txt \
    scripts/smoke-test.sh \
    scripts/systemd/discovery-server.service

require_sdk_project

echo "=== 构建应用 wheel ==="
(
    cd "${PROJECT_DIR}"
    uv build --wheel
)

wheel_path="$(find "${OUTPUT_DIR}" -maxdepth 1 -type f -name "discovery_server-${project_version}-*.whl" | LC_ALL=C sort | tail -n 1)"
if [[ -z "${wheel_path}" ]]; then
    echo "错误：未在 dist/ 下找到 discovery_server-${project_version}-*.whl" >&2
    exit 1
fi

staging_parent_dir="$(mktemp -d)"
sdk_build_dir="$(mktemp -d)"
staging_dir="${staging_parent_dir}/${release_name}"
trap 'rm -rf "${staging_parent_dir}" "${sdk_build_dir}"' EXIT
mkdir -p "${staging_dir}/dist"

echo "=== 构建 sibling acps-sdk wheel ==="
build_sdk_wheel "${sdk_build_dir}"
sdk_wheel_path="$(find "${sdk_build_dir}" -maxdepth 1 -type f -name 'acps_sdk-*.whl' | LC_ALL=C sort | tail -n 1)"
if [[ -z "${sdk_wheel_path}" ]]; then
    echo "错误：未找到 acps_sdk-*.whl" >&2
    exit 1
fi

RUNTIME_BUNDLE_MAP=(
    "config|config"
    "alembic|alembic"
    "alembic.ini|alembic.ini"
    ".env.example|.env.example"
    "README.md|README.md"
    "scripts/prompts|scripts/prompts"
    "scripts/smoke-test.sh|scripts/smoke-test.sh"
    "scripts/systemd/discovery-server.service|discovery-server.service"
)

RUNTIME_BUNDLE_EXCLUDE_MAP=(
    "${DEFAULT_BUNDLE_EXCLUDE_MAP[@]}"
    "._*"
    "*/._*"
)

copy_bundle_files "${PROJECT_DIR}" "${staging_dir}" RUNTIME_BUNDLE_MAP RUNTIME_BUNDLE_EXCLUDE_MAP
cp "${wheel_path}" "${staging_dir}/dist/"
cp "${sdk_wheel_path}" "${staging_dir}/dist/"

echo "=== 导出运行时依赖清单 ==="
build_runtime_requirements "${staging_dir}/requirements-runtime.txt"

if [[ "${OFFLINE}" -eq 1 ]]; then
    echo "=== 下载离线 wheelhouse ==="
    mkdir -p "${staging_dir}/wheelhouse"
    download_wheelhouse "${staging_dir}/requirements-runtime.txt" "${staging_dir}/wheelhouse" "${PIP_IMPLEMENTATION}"
    cp "${sdk_wheel_path}" "${staging_dir}/wheelhouse/"

    if [[ "${#PIP_PLATFORMS[@]}" -eq 0 ]]; then
        echo "[INFO]  未指定 --pip-platform，wheelhouse 将按当前构建机平台解析。"
    fi
fi

sha256_cmd=($(detect_sha256_cmd))
generate_checksums "${staging_dir}" "${sha256_cmd[@]}"
release_tar="$(create_release_tar "${staging_parent_dir}" "${release_name}" "${OUTPUT_DIR}")"

echo "=== 构建完成 ==="
echo "  运行包: ${release_tar}"
echo "  应用 wheel: $(basename "${wheel_path}")"
echo "  依赖 wheel: $(basename "${sdk_wheel_path}")"
echo "  目标平台: ${target_platform}"
if [[ "${OFFLINE}" -eq 1 ]]; then
    echo "  模式: offline（包含 wheelhouse/）"
else
    echo "  模式: online（不包含 wheelhouse/）"
fi
