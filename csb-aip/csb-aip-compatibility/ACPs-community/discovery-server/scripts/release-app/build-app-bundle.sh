#!/usr/bin/env bash
# 构建 App-only 发布包（build-app-bundle.sh）
# 用法: ./scripts/release-app/build-app-bundle.sh [--dry-run] [--result-file <path>] [VERSION]
set -euo pipefail

DRY_RUN=false
RESULT_FILE=""
VERSION_ARG=""

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run)
            DRY_RUN=true
            ;;
        --result-file)
            shift
            if [[ $# -eq 0 ]]; then
                echo "错误：--result-file 需要参数" >&2
                exit 1
            fi
            RESULT_FILE="$1"
            ;;
        -h|--help)
            echo "用法: ./scripts/release-app/build-app-bundle.sh [--dry-run] [--result-file <path>] [VERSION]"
            exit 0
            ;;
        *)
            if [[ -n "${VERSION_ARG}" ]]; then
                echo "错误：只允许提供一个可选 VERSION 参数" >&2
                exit 1
            fi
            VERSION_ARG="$1"
            ;;
    esac
    shift
done
VERSION="${VERSION_ARG:-$(date +%Y%m%d%H%M%S)}"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SIBLING_DIR="$(cd "${PROJECT_DIR}/.." && pwd)"
OUTPUT_DIR="${PROJECT_DIR}/dist"
PROJECT_NAME="discovery-server"
SOURCE_COMMIT="$(git -C "${PROJECT_DIR}" rev-parse HEAD 2>/dev/null || echo 'unknown')"
SHORT_SHA="$(git -C "${PROJECT_DIR}" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE_NAME="discovery-server"
RELEASE_NAME="discovery-server-app-${VERSION}"
IMAGE_DIGEST="dry-run-unavailable"
DISCOVERY_BUILD_PROFILE="${DISCOVERY_BUILD_PROFILE:-cpu}"

# shellcheck source=/dev/null
source "${PROJECT_DIR}/scripts/lib/platform.sh"
# shellcheck source=/dev/null
source "${PROJECT_DIR}/scripts/lib/build.sh"
select_platform

case "${DISCOVERY_BUILD_PROFILE}" in
    cpu|gpu)
        ;;
    *)
        echo "错误：DISCOVERY_BUILD_PROFILE 只支持 cpu 或 gpu，当前值为 ${DISCOVERY_BUILD_PROFILE}" >&2
        exit 1
        ;;
esac

REQUIRED_FILES=(
    "Dockerfile"
    ".dockerignore"
    "pyproject.toml"
    "uv.lock"
    "alembic.ini"
    "alembic/env.py"
    "app/main.py"
    "config/default.toml"
    "config/production.toml"
    "scripts/release-app/compose.yml"
    "scripts/release-app/deploy.sh"
    "scripts/release-app/README.md"
    "scripts/release-app/.env.example"
    "scripts/release-app/upstream.conf"
    "scripts/lib/build.sh"
    "scripts/lib/platform.sh"
    "scripts/lib/common.sh"
    "scripts/lib/docker.sh"
    "scripts/lib/blue-green.sh"
    "scripts/lib/shared-lib-contracts-lib.sh"
)

if [[ "${DISCOVERY_BUILD_PROFILE}" == "cpu" ]]; then
    REQUIRED_FILES+=(
        "scripts/release-app/cpu-build-manifest/pyproject.toml"
        "scripts/release-app/cpu-build-manifest/uv.lock"
    )
fi

BUNDLE_MAP=(
    "scripts/release-app/compose.yml|compose.yml"
    "scripts/release-app/deploy.sh|deploy.sh"
    "scripts/release-app/README.md|README.md"
    "scripts/release-app/.env.example|.env.example"
    "scripts/release-app/upstream.conf|upstream.conf"
    "scripts/lib/common.sh|lib/common.sh"
    "scripts/lib/docker.sh|lib/docker.sh"
    "scripts/lib/blue-green.sh|lib/blue-green.sh"
    "config/|config/"
    "alembic.ini|alembic.ini"
    "alembic/|alembic/"
)

EXCLUDE_MAP=("${DEFAULT_BUNDLE_EXCLUDE_MAP[@]}")

read_build_metadata_digest() {
    local metadata_file="$1"

    python3 - "${metadata_file}" <<'PY'
import json
import sys

with open(sys.argv[1], encoding="utf-8") as handle:
    data = json.load(handle)

print(data.get("containerimage.digest", ""))
PY
}

write_result_file() {
    local bundle_path="$1"

    [[ -n "${RESULT_FILE}" ]] || return 0
    mkdir -p "$(dirname "${RESULT_FILE}")"
    cat > "${RESULT_FILE}" <<EOF
schema_version=1
project_name=${PROJECT_NAME}
bundle_name=$(basename "${bundle_path}")
bundle_path=${bundle_path}
version=${VERSION}
platform=${DOCKER_PLATFORM}
source_commit=${SOURCE_COMMIT}
version_file=VERSION
image=${IMAGE_NAME}:${VERSION}
image_digest=${IMAGE_DIGEST}
EOF
}

validate_required_files "$PROJECT_DIR" "${REQUIRED_FILES[@]}"
if [[ ! -d "${SIBLING_DIR}/acps-sdk" ]]; then
    echo "错误：未找到 sibling 目录 ${SIBLING_DIR}/acps-sdk" >&2
    exit 1
fi

SHA256_CMD=()
while IFS= read -r token; do
    SHA256_CMD+=("$token")
done < <(detect_sha256_cmd)

if [[ "$DRY_RUN" == true ]]; then
    write_result_file "${OUTPUT_DIR}/${RELEASE_NAME}.tar.gz"
    echo ""
    echo "=== Dry-run 模式 ==="
    echo "版本:    ${VERSION}"
    echo "提交 SHA: ${SHORT_SHA}"
    echo "平台:    ${DOCKER_PLATFORM}"
    echo "镜像名:  ${IMAGE_NAME}:${VERSION}"
    echo "SDK 目录: ${SIBLING_DIR}/acps-sdk"
    echo ""
    echo "--- 将构建的镜像 ---"
    echo "  ${IMAGE_NAME}:${VERSION}"
    echo "  ${IMAGE_NAME}:latest"
    echo ""
    echo "--- 统一发布包内容 ---"
    echo "  images.tar.gz  (Docker 镜像)"
    echo "  checksums.txt  (SHA-256 校验文件)"
    echo "  VERSION"
    for entry in "${BUNDLE_MAP[@]}"; do
        echo "  ${entry#*|}"
    done
    echo ""
    echo "=== Dry-run 完成，未执行实际构建 ==="
    exit 0
fi

require_docker
require_docker_buildx

echo "=== 构建镜像: ${IMAGE_NAME}:${VERSION} (${DOCKER_PLATFORM}, profile=${DISCOVERY_BUILD_PROFILE}) ==="
mkdir -p "$OUTPUT_DIR"
IMAGES_TAR="${OUTPUT_DIR}/release-app-images.tar.gz"
IMAGES_TAR_TMP="${OUTPUT_DIR}/release-app-images.tar.gz.tmp"
BUILD_METADATA_FILE="$(mktemp)"
rm -f "${OUTPUT_DIR}/release-app-images.tar" "$IMAGES_TAR" "$IMAGES_TAR_TMP"

BUILD_ARGS=(
    --build-arg "VERSION=${VERSION}"
    --build-arg "SHORT_SHA=${SHORT_SHA}"
    --build-arg "BUILD_DATE=${BUILD_DATE}"
    --build-arg "DISCOVERY_BUILD_PROFILE=${DISCOVERY_BUILD_PROFILE}"
)
if [[ -n "${PYTHON_IMAGE:-}" ]]; then
    BUILD_ARGS+=(--build-arg "PYTHON_IMAGE=${PYTHON_IMAGE}")
fi

BUILDX_ARGS=(
    --platform "${DOCKER_PLATFORM}"
    --build-context acps_sdk="${SIBLING_DIR}/acps-sdk"
    --metadata-file "${BUILD_METADATA_FILE}"
    --output "type=docker,name=${IMAGE_NAME}:${VERSION},dest=-"
)

if [[ -n "${PYTHON_IMAGE:-}" ]] \
    && docker image inspect "${PYTHON_IMAGE}" >/dev/null 2>&1 \
    && image_platform_matches "${PYTHON_IMAGE}" "${DOCKER_PLATFORM}"; then
    echo "=== 复用本地 Python 基础镜像缓存 ==="
    verify_image_platform "${PYTHON_IMAGE}" "${DOCKER_PLATFORM}"
    BUILDX_ARGS+=(--pull=false)
fi

echo "=== 导出镜像 ==="
docker buildx build \
    "${BUILDX_ARGS[@]}" \
    "${BUILD_ARGS[@]}" \
    -t "${IMAGE_NAME}:${VERSION}" \
    -t "${IMAGE_NAME}:latest" \
    "$PROJECT_DIR" | gzip -c > "$IMAGES_TAR_TMP"

IMAGE_DIGEST="$(read_build_metadata_digest "${BUILD_METADATA_FILE}")"
rm -f "${BUILD_METADATA_FILE}"
if [[ -z "${IMAGE_DIGEST}" ]]; then
    rm -f "$IMAGES_TAR_TMP"
    echo "错误：未能从 build metadata 中解析镜像 digest" >&2
    exit 1
fi

mv "$IMAGES_TAR_TMP" "$IMAGES_TAR"

STAGING_DIR="$(mktemp -d)"
trap 'rm -rf "$STAGING_DIR"' EXIT

STAGING="${STAGING_DIR}/${RELEASE_NAME}"
mkdir -p "$STAGING"
cp "$IMAGES_TAR" "$STAGING/images.tar.gz"

copy_bundle_files "$PROJECT_DIR" "$STAGING" BUNDLE_MAP EXCLUDE_MAP

cat > "$STAGING/VERSION" <<EOF
version=${VERSION}
source_commit=${SOURCE_COMMIT}
short_sha=${SHORT_SHA}
build_date=${BUILD_DATE}
platform=${DOCKER_PLATFORM}
image=${IMAGE_NAME}:${VERSION}
image_digest=${IMAGE_DIGEST}
EOF

generate_checksums "$STAGING" "${SHA256_CMD[@]}"

RELEASE_TAR="$(create_release_tar "$STAGING_DIR" "$RELEASE_NAME" "$OUTPUT_DIR")"
write_result_file "${RELEASE_TAR}"
rm -f "$IMAGES_TAR"

echo ""
echo "=== 构建完成 ==="
echo "版本:    ${VERSION}"
echo "提交 SHA: ${SHORT_SHA}"
echo "平台:    ${DOCKER_PLATFORM}"
echo "发布包:  ${RELEASE_TAR} ($(du -h "$RELEASE_TAR" | cut -f1))"
echo ""
echo "部署步骤请参考: scripts/release-app/README.md"
