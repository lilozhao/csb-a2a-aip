#!/usr/bin/env bash
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
IMAGE_NAME="demo-leader"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
SIBLING_DIR="$(cd "${PROJECT_DIR}/.." && pwd)"
OUTPUT_DIR="${PROJECT_DIR}/dist"
RELEASE_NAME="${IMAGE_NAME}-${VERSION}"
PROJECT_NAME="demo-leader"
SOURCE_COMMIT="$(git -C "${PROJECT_DIR}" rev-parse HEAD 2>/dev/null || echo 'unknown')"
SHORT_SHA="$(git -C "${PROJECT_DIR}" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
IMAGE_DIGEST="dry-run-unavailable"

# shellcheck source=/dev/null
source "${PROJECT_DIR}/scripts/lib/platform.sh"
# shellcheck source=/dev/null
source "${PROJECT_DIR}/scripts/lib/build.sh"

RELEASE_DIR="${SIBLING_DIR}/acps-infra"

PROJECT_REQUIRED_FILES=(
  "Dockerfile"
  "pyproject.toml"
  "uv.lock"
  "leader/config.toml"
  "leader/atr"
  "leader/scenario"
  "web_app"
  "scripts/release-app/compose.yml"
  "scripts/release-app/.env.example"
  "scripts/release-app/deploy.sh"
  "scripts/release-app/bundle-common.sh"
  "scripts/release-app/cleanup.sh"
  "scripts/release-app/install.sh"
  "scripts/release-app/nginx/default.conf"
  "scripts/smoke-test.sh"
  "scripts/lib/common.sh"
  "scripts/lib/docker.sh"
  "scripts/lib/certs-permissions-lib.sh"
)

RELEASE_REQUIRED_FILES=(
  "scripts/tests/smoke-test-business.sh"
  "scripts/tests/smoke"
  "provision/provision.sh"
  "provision/provision.conf.example"
  "provision/provision_tools"
)

BUNDLE_CONTENTS=(
  "images.tar.gz  (Docker 镜像)"
  "checksums.txt  (SHA-256 校验文件)"
  "VERSION"
  "compose.yml"
  ".env.example"
  "deploy.sh"
  "bundle-common.sh"
  "cleanup.sh"
  "install.sh"
  "nginx/default.conf"
  "smoke-test.sh"
  "smoke-test-business.sh"
  "smoke/"
  "lib/common.sh"
  "lib/docker.sh"
  "lib/certs-permissions-lib.sh"
  "leader/config.toml"
  "leader/atr/"
  "leader/scenario/"
  "web_app/"
  "provision.sh"
  "provision.conf.example"
  "provision_tools/"
)

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

select_platform
validate_required_files "${PROJECT_DIR}" "${PROJECT_REQUIRED_FILES[@]}"
validate_required_files "${RELEASE_DIR}" "${RELEASE_REQUIRED_FILES[@]}"
if [[ ! -d "${SIBLING_DIR}/acps-sdk" ]]; then
  echo "错误：未找到 sibling 目录 ${SIBLING_DIR}/acps-sdk" >&2
  exit 1
fi
if [[ ! -d "${SIBLING_DIR}/acps-cli" ]]; then
  echo "错误：未找到 sibling 目录 ${SIBLING_DIR}/acps-cli" >&2
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
  echo "CLI 目录: ${SIBLING_DIR}/acps-cli"
  echo ""
  echo "--- 将构建的镜像 ---"
  echo "  ${IMAGE_NAME}:${VERSION}"
  echo "  ${IMAGE_NAME}:latest"
  echo ""
  echo "--- 统一发布包内容 ---"
  for entry in "${BUNDLE_CONTENTS[@]}"; do
    echo "  ${entry}"
  done
  echo ""
  echo "=== Dry-run 完成，未执行实际构建 ==="
  exit 0
fi

require_docker
require_docker_buildx
mkdir -p "${OUTPUT_DIR}"
IMAGES_TAR="${OUTPUT_DIR}/release-app-images.tar.gz"
IMAGES_TAR_TMP="${OUTPUT_DIR}/release-app-images.tar.gz.tmp"
BUILD_METADATA_FILE="$(mktemp)"
rm -f "${OUTPUT_DIR}/release-app-images.tar" "$IMAGES_TAR" "$IMAGES_TAR_TMP"

BUILD_ARGS=(
  --build-arg "VERSION=${VERSION}"
  --build-arg "SHORT_SHA=${SHORT_SHA}"
  --build-arg "BUILD_DATE=${BUILD_DATE}"
)
if [[ -n "${PYTHON_IMAGE:-}" ]]; then
  BUILD_ARGS+=(--build-arg "PYTHON_IMAGE=${PYTHON_IMAGE}")
fi

BUILDX_ARGS=(
  --platform "${DOCKER_PLATFORM}"
  --build-context acps_sdk="${SIBLING_DIR}/acps-sdk"
  --build-context acps_cli="${SIBLING_DIR}/acps-cli"
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
  "${PROJECT_DIR}" | gzip -c > "$IMAGES_TAR_TMP"

IMAGE_DIGEST="$(read_build_metadata_digest "${BUILD_METADATA_FILE}")"
rm -f "${BUILD_METADATA_FILE}"
if [[ -z "${IMAGE_DIGEST}" ]]; then
  rm -f "$IMAGES_TAR_TMP"
  echo "错误：未能从 build metadata 中解析镜像 digest" >&2
  exit 1
fi

mv "$IMAGES_TAR_TMP" "$IMAGES_TAR"

STAGING_ROOT="$(mktemp -d)"
trap 'rm -rf "${STAGING_ROOT}"' EXIT
STAGING_DIR="${STAGING_ROOT}/${RELEASE_NAME}"
mkdir -p "${STAGING_DIR}/lib" "${STAGING_DIR}/leader" "${STAGING_DIR}/nginx"

cp "${SCRIPT_DIR}/compose.yml" "${STAGING_DIR}/compose.yml"
cp "${SCRIPT_DIR}/.env.example" "${STAGING_DIR}/.env.example"
cp "${SCRIPT_DIR}/nginx/default.conf" "${STAGING_DIR}/nginx/default.conf"
cp "${SCRIPT_DIR}/deploy.sh" "${STAGING_DIR}/deploy.sh"
cp "${SCRIPT_DIR}/bundle-common.sh" "${STAGING_DIR}/bundle-common.sh"
cp "${SCRIPT_DIR}/cleanup.sh" "${STAGING_DIR}/cleanup.sh"
cp "${SCRIPT_DIR}/install.sh" "${STAGING_DIR}/install.sh"
cp "${PROJECT_DIR}/scripts/smoke-test.sh" "${STAGING_DIR}/smoke-test.sh"
cp "${RELEASE_DIR}/scripts/tests/smoke-test-business.sh" "${STAGING_DIR}/smoke-test-business.sh"
cp -R "${RELEASE_DIR}/scripts/tests/smoke" "${STAGING_DIR}/smoke"
cp "${PROJECT_DIR}/scripts/lib/common.sh" "${STAGING_DIR}/lib/common.sh"
cp "${PROJECT_DIR}/scripts/lib/docker.sh" "${STAGING_DIR}/lib/docker.sh"
cp "${PROJECT_DIR}/scripts/lib/certs-permissions-lib.sh" "${STAGING_DIR}/lib/certs-permissions-lib.sh"
cp "${PROJECT_DIR}/leader/config.toml" "${STAGING_DIR}/leader/config.toml"
cp -R "${PROJECT_DIR}/leader/atr" "${STAGING_DIR}/leader/atr"
cp -R "${PROJECT_DIR}/leader/scenario" "${STAGING_DIR}/leader/scenario"
cp -R "${PROJECT_DIR}/web_app" "${STAGING_DIR}/web_app"
cp "${RELEASE_DIR}/provision/provision.sh" "${STAGING_DIR}/provision.sh"
cp "${RELEASE_DIR}/provision/provision.conf.example" "${STAGING_DIR}/provision.conf.example"
cp -R "${RELEASE_DIR}/provision/provision_tools" "${STAGING_DIR}/provision_tools"

find "${STAGING_DIR}/leader/atr" -type f \( -name '*.pem' -o -name '*.key' -o -name '*.csr' -o -name '*.srl' \) -delete

chmod +x "${STAGING_DIR}/deploy.sh" "${STAGING_DIR}/smoke-test.sh" \
  "${STAGING_DIR}/smoke-test-business.sh" "${STAGING_DIR}/provision.sh" \
  "${STAGING_DIR}/cleanup.sh" "${STAGING_DIR}/install.sh"

cp "${IMAGES_TAR}" "${STAGING_DIR}/images.tar.gz"

cat > "${STAGING_DIR}/VERSION" <<EOF
version=${VERSION}
source_commit=${SOURCE_COMMIT}
short_sha=${SHORT_SHA}
build_date=${BUILD_DATE}
platform=${DOCKER_PLATFORM}
image=${IMAGE_NAME}:${VERSION}
image_digest=${IMAGE_DIGEST}
EOF

generate_checksums "${STAGING_DIR}" "${SHA256_CMD[@]}"

RELEASE_TAR="$(create_release_tar "${STAGING_ROOT}" "${RELEASE_NAME}" "${OUTPUT_DIR}")"
write_result_file "${RELEASE_TAR}"

echo ""
echo "=== 构建完成 ==="
echo "版本:    ${VERSION}"
echo "提交 SHA: ${SHORT_SHA}"
echo "平台:    ${DOCKER_PLATFORM}"
echo "发布包:  ${RELEASE_TAR} ($(du -h "${RELEASE_TAR}" | cut -f1))"
