#!/usr/bin/env bash
# 构建镜像并打包为统一可部署产物（build-release-bundle.sh）
# 用法: ./scripts/release-bundle/build-release-bundle.sh [--dry-run] [VERSION]
#
# 输出: dist/registry-server-release-{VERSION}.tar.gz（包含镜像 + 配置 + 部署脚本 + 文档）
#
# 选项：
#   --dry-run   仅验证前置条件和文件完整性，不执行 Docker 构建
#
# 前提条件：
#   - 已安装 Docker CLI 且 Docker daemon 正在运行（dry-run 模式除外）
#   - 在项目根目录或脚本所在目录执行
set -euo pipefail

DRY_RUN=false
if [[ "${1:-}" == "--dry-run" ]]; then
    DRY_RUN=true
    shift
fi

VERSION="${1:-$(date +%Y%m%d%H%M%S)}"
SHORT_SHA="$(git rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE_NAME="registry-server"

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
OUTPUT_DIR="${PROJECT_DIR}/dist"

# shellcheck source=/dev/null
source "${PROJECT_DIR}/scripts/lib/platform.sh"
# shellcheck source=/dev/null
source "${PROJECT_DIR}/scripts/lib/build.sh"
select_platform

# 检查必要文件是否存在
REQUIRED_FILES=(
    "Dockerfile"
    "pyproject.toml"
    "uv.lock"
    "alembic.ini"
    "alembic/env.py"
    "app/main.py"
    "scripts/release-bundle/compose.yml"
    "scripts/release-bundle/nginx/conf.d/registry.conf"
    "scripts/release-bundle/nginx/includes/upstream.conf"
    "scripts/release-bundle/images.txt"
    "scripts/release-bundle/deploy.sh"
    "scripts/release-bundle/cleanup-docker-resources.sh"
    "scripts/release-bundle/README.md"
    "scripts/release-bundle/.env.example"
    "scripts/lib/common.sh"
    "scripts/lib/docker.sh"
    "scripts/lib/blue-green.sh"
    "scripts/smoke-test.sh"
)
validate_required_files "$PROJECT_DIR" "${REQUIRED_FILES[@]}"
SHA256_CMD=()
while IFS= read -r token; do
    SHA256_CMD+=("$token")
done < <(detect_sha256_cmd)

# 打包映射：源路径 → 发布包内目标路径
# 格式："源路径|目标路径"，目录以 / 结尾
BUNDLE_MAP=(
    "scripts/release-bundle/compose.yml|compose.yml"
    "scripts/release-bundle/nginx/conf.d/registry.conf|nginx/conf.d/registry.conf"
    "scripts/release-bundle/nginx/includes/upstream.conf|nginx/includes/upstream.conf"
    "scripts/release-bundle/deploy.sh|deploy.sh"
    "scripts/release-bundle/cleanup-docker-resources.sh|cleanup-docker-resources.sh"
    "scripts/release-bundle/README.md|README.md"
    "scripts/lib/common.sh|lib/common.sh"
    "scripts/lib/docker.sh|lib/docker.sh"
    "scripts/lib/blue-green.sh|lib/blue-green.sh"
    "scripts/smoke-test.sh|smoke-test.sh"
    "scripts/release-bundle/.env.example|.env.example"
    "alembic.ini|alembic.ini"
    "alembic/|alembic/"
)

EXCLUDE_MAP=("${DEFAULT_BUNDLE_EXCLUDE_MAP[@]}")

if [[ "$DRY_RUN" == true ]]; then
    echo ""
    echo "=== Dry-run 模式 ==="
    echo "版本:    ${VERSION}"
    echo "提交 SHA: ${SHORT_SHA}"
    echo "平台:    ${DOCKER_PLATFORM}"
    echo "镜像名:  ${IMAGE_NAME}:${VERSION}"
    echo ""
    echo "--- 将构建的镜像 ---"
    echo "  ${IMAGE_NAME}:${VERSION}"
    echo "  ${IMAGE_NAME}:latest"
    echo ""
    echo "--- 将拉取的基础设施镜像 ---"
    while IFS= read -r image || [[ -n "$image" ]]; do
        [[ -z "$image" || "$image" == \#* ]] && continue
        echo "  ${image}"
    done < "${SCRIPT_DIR}/images.txt"
    echo ""
    echo "--- 统一发布包内容 ---"
    echo "  images.tar.gz  (Docker 镜像)"
    echo "  checksums.txt  (SHA-256 校验文件)"
    for entry in "${BUNDLE_MAP[@]}"; do
        dest="${entry#*|}"
        echo "  ${dest}"
    done
    echo ""
    echo "=== Dry-run 完成，未执行实际构建 ==="
    exit 0
fi

require_docker
require_docker_buildx

echo "=== 构建镜像: ${IMAGE_NAME}:${VERSION} (${DOCKER_PLATFORM}) ==="

docker buildx build \
    --platform "${DOCKER_PLATFORM}" \
    --load \
    --build-arg "VERSION=${VERSION}" \
    --build-arg "SHORT_SHA=${SHORT_SHA}" \
    --build-arg "BUILD_DATE=${BUILD_DATE}" \
    -t "${IMAGE_NAME}:${VERSION}" \
    -t "${IMAGE_NAME}:latest" \
    "$PROJECT_DIR"

verify_image_platform "${IMAGE_NAME}:${VERSION}" "${DOCKER_PLATFORM}"

echo "=== 拉取基础设施镜像 ==="
while IFS= read -r image || [[ -n "$image" ]]; do
    [[ -z "$image" || "$image" == \#* ]] && continue
    echo "  拉取: $image"
    pull_image_for_platform "$image" "${DOCKER_PLATFORM}"
    verify_image_platform "$image" "${DOCKER_PLATFORM}"
done < "${SCRIPT_DIR}/images.txt"

echo "=== 导出镜像 ==="
mkdir -p "$OUTPUT_DIR"

IMAGES=("${IMAGE_NAME}:${VERSION}")
while IFS= read -r image || [[ -n "$image" ]]; do
    [[ -z "$image" || "$image" == \#* ]] && continue
    IMAGES+=("$image")
done < "${SCRIPT_DIR}/images.txt"

IMAGES_TAR="${OUTPUT_DIR}/images.tar.gz"
docker image save --platform "${DOCKER_PLATFORM}" "${IMAGES[@]}" | gzip > "$IMAGES_TAR"
echo "  镜像包: $IMAGES_TAR ($(du -h "$IMAGES_TAR" | cut -f1))"

echo "=== 打包统一发布包 ==="

# 创建临时打包目录
STAGING_DIR=$(mktemp -d)
trap 'rm -rf "$STAGING_DIR"' EXIT

RELEASE_NAME="registry-server-release-${VERSION}"
STAGING="${STAGING_DIR}/${RELEASE_NAME}"
mkdir -p "$STAGING"

# 复制镜像包
cp "$IMAGES_TAR" "$STAGING/images.tar.gz"

# 复制部署文件（扁平化到发布包根目录）
copy_bundle_files "$PROJECT_DIR" "$STAGING" BUNDLE_MAP EXCLUDE_MAP

# 从 images.txt 读取基础设施版本
POSTGRES_VERSION=""
while IFS= read -r image || [[ -n "$image" ]]; do
    [[ -z "$image" || "$image" == \#* ]] && continue
    if [[ "$image" == postgres:* ]]; then
        POSTGRES_VERSION="$image"
    fi
done < "${SCRIPT_DIR}/images.txt"

# 写入版本信息
cat > "$STAGING/VERSION" <<EOF
version=${VERSION}
short_sha=${SHORT_SHA}
build_date=${BUILD_DATE}
platform=${DOCKER_PLATFORM}
image=${IMAGE_NAME}:${VERSION}
postgres_image=${POSTGRES_VERSION}
EOF

# 为发布包中的所有文件生成校验清单，便于部署前后验证完整性。
generate_checksums "$STAGING" "${SHA256_CMD[@]}"

RELEASE_TAR="$(create_release_tar "$STAGING_DIR" "$RELEASE_NAME" "$OUTPUT_DIR")"

# 清理中间文件
rm -f "$IMAGES_TAR"

echo ""
echo "=== 构建完成 ==="
echo "版本:    ${VERSION}"
echo "提交 SHA: ${SHORT_SHA}"
echo "平台:    ${DOCKER_PLATFORM}"
echo "发布包:  ${RELEASE_TAR} ($(du -h "$RELEASE_TAR" | cut -f1))"
echo ""
echo "部署步骤请参考: scripts/release-bundle/README.md"
