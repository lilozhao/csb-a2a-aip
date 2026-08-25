#!/usr/bin/env bash

validate_required_files() {
    local project_dir="$1"
    shift
    local missing=0
    local file_path

    if [[ $# -eq 0 ]]; then
        echo "错误：validate_required_files 至少需要一个待检查路径" >&2
        return 1
    fi

    echo "=== 检查文件完整性 ==="
    for file_path in "$@"; do
        if [[ ! -e "${project_dir}/${file_path}" ]]; then
            echo "  缺失: ${file_path}" >&2
            missing=$((missing + 1))
        fi
    done

    if [[ $missing -gt 0 ]]; then
        echo "错误：缺少 ${missing} 个必要文件" >&2
        return 1
    fi

    echo "  所有必要文件检查通过"
}

detect_sha256_cmd() {
    if command -v sha256sum &>/dev/null; then
        printf '%s\n' sha256sum
    elif command -v shasum &>/dev/null; then
        printf '%s\n' shasum -a 256
    else
        echo "错误：未找到 sha256sum 或 shasum 命令，无法生成校验文件" >&2
        return 1
    fi
}

require_docker() {
    if ! command -v docker &>/dev/null; then
        echo "错误：未找到 docker 命令，请先安装 Docker CLI" >&2
        return 1
    fi

    if ! docker info &>/dev/null; then
        echo "错误：Docker daemon 未运行或无权限访问" >&2
        return 1
    fi
}

require_docker_buildx() {
    if ! docker buildx version &>/dev/null; then
        echo "错误：当前 Docker 环境缺少 buildx，请先启用 Docker Buildx" >&2
        return 1
    fi
}

normalize_platform() {
    local platform="${1:-}"

    if [[ -z "$platform" ]]; then
        echo "错误：平台不能为空" >&2
        return 1
    fi

    case "$platform" in
        linux/arm64/v8)
            printf '%s\n' "linux/arm64"
            ;;
        *)
            printf '%s\n' "$platform"
            ;;
    esac
}

inspect_image_platform() {
    local image="${1:-}"
    local platform="${2:-}"
    local os
    local arch
    local variant
    local inspect_args=()

    if [[ -z "$image" ]]; then
        echo "错误：镜像名称不能为空" >&2
        return 1
    fi

    if [[ -n "$platform" ]]; then
        inspect_args+=(--platform "$platform")
    fi

    os="$(docker image inspect "${inspect_args[@]}" --format '{{.Os}}' "$image" 2>/dev/null)"
    arch="$(docker image inspect "${inspect_args[@]}" --format '{{.Architecture}}' "$image" 2>/dev/null)"
    variant="$(docker image inspect "${inspect_args[@]}" --format '{{.Variant}}' "$image" 2>/dev/null || true)"

    if [[ -n "$variant" && "$variant" != "<no value>" ]]; then
        printf '%s/%s/%s\n' "$os" "$arch" "$variant"
    else
        printf '%s/%s\n' "$os" "$arch"
    fi
}

image_platform_matches() {
    local image="${1:-}"
    local expected_platform="${2:-${DOCKER_PLATFORM:-}}"
    local actual_platform
    local normalized_actual
    local normalized_expected

    if [[ -z "$image" || -z "$expected_platform" ]]; then
        echo "错误：image_platform_matches 需要镜像名和目标平台" >&2
        return 1
    fi

    actual_platform="$(inspect_image_platform "$image" "$expected_platform")"
    normalized_actual="$(normalize_platform "$actual_platform")"
    normalized_expected="$(normalize_platform "$expected_platform")"
    [[ "$normalized_actual" == "$normalized_expected" ]]
}

pull_image_for_platform() {
    local image="${1:-}"
    local platform="${2:-${DOCKER_PLATFORM:-}}"

    if [[ -z "$image" || -z "$platform" ]]; then
        echo "错误：pull_image_for_platform 需要镜像名和目标平台" >&2
        return 1
    fi

    docker pull --platform "$platform" "$image"

    if image_platform_matches "$image" "$platform"; then
        return 0
    fi

    echo "  检测到本地缓存标签未切换到 ${platform}，尝试移除旧标签后重新拉取..."
    docker image rm "$image" >/dev/null 2>&1 || true
    docker pull --platform "$platform" "$image"
}

verify_image_platform() {
    local image="${1:-}"
    local expected_platform="${2:-${DOCKER_PLATFORM:-}}"
    local actual_platform

    if [[ -z "$image" || -z "$expected_platform" ]]; then
        echo "错误：verify_image_platform 需要镜像名和目标平台" >&2
        return 1
    fi

    actual_platform="$(inspect_image_platform "$image" "$expected_platform")"

    if ! image_platform_matches "$image" "$expected_platform"; then
        echo "错误：镜像平台不匹配: ${image}，期望 $(normalize_platform "$expected_platform")，实际 ${actual_platform}" >&2
        return 1
    fi

    echo "  ${image} -> ${actual_platform}"
}

DEFAULT_BUNDLE_EXCLUDE_MAP=(
    "__pycache__"
    "*/__pycache__"
    "*.pyc"
    "*.pyo"
    ".pytest_cache"
    "*/.pytest_cache"
    ".mypy_cache"
    "*/.mypy_cache"
    ".ruff_cache"
    "*/.ruff_cache"
    ".DS_Store"
)

copy_bundle_files() {
    local project_dir="$1"
    local staging_dir="$2"
    local bundle_map_name="${3:-}"
    local exclude_map_name="${4:-}"
    local entry
    local src_path
    local dest_path
    local src
    local dest
    local pattern
    local exclude_args=()
    local bundle_map=()
    local exclude_map=()

    if [[ -z "$bundle_map_name" ]]; then
        echo "错误：copy_bundle_files 需要提供打包映射数组名" >&2
        return 1
    fi

    eval "bundle_map=(\"\${${bundle_map_name}[@]}\")"
    if [[ ${#bundle_map[@]} -eq 0 ]]; then
        echo "错误：copy_bundle_files 至少需要一个打包映射" >&2
        return 1
    fi

    if [[ -n "$exclude_map_name" ]]; then
        eval "exclude_map=(\"\${${exclude_map_name}[@]}\")"
    fi

    for pattern in "${exclude_map[@]}"; do
        exclude_args+=("--exclude=${pattern}")
    done

    for entry in "${bundle_map[@]}"; do
        src_path="${entry%%|*}"
        dest_path="${entry#*|}"
        src="${project_dir}/${src_path}"
        dest="${staging_dir}/${dest_path}"
        mkdir -p "$(dirname "$dest")"
        if [[ -d "$src" ]]; then
            mkdir -p "$dest"
            tar "${exclude_args[@]}" -cf - -C "$src" . | tar -xf - -C "$dest"
        else
            cp "$src" "$dest"
        fi
    done
}

generate_checksums() {
    local staging_dir="$1"
    shift

    if [[ $# -eq 0 ]]; then
        echo "错误：generate_checksums 需要显式传入校验命令" >&2
        return 1
    fi

    (
        cd "$staging_dir"
        find . -type f ! -name 'checksums.txt' -print0 \
            | LC_ALL=C sort -z \
            | xargs -0 "$@" > checksums.txt
    )
}

create_release_tar() {
    local staging_parent_dir="$1"
    local release_name="$2"
    local output_dir="$3"
    local release_tar
    local tar_args=()

    release_tar="${output_dir}/${release_name}.tar.gz"
    # macOS 自带 bsdtar 会把 Apple 扩展属性写进归档；显式关闭，
    # 避免目标 Linux 解包时出现 LIBARCHIVE.xattr.com.apple.* 警告。
    if [[ "$(uname -s)" == "Darwin" ]]; then
        tar_args+=(--no-mac-metadata --no-xattrs --no-acls)
    fi

    tar_args+=(-czf "$release_tar" -C "$staging_parent_dir" "$release_name")
    tar "${tar_args[@]}"
    printf '%s\n' "$release_tar"
}
