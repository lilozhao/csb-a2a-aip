#!/usr/bin/env bash
set -euo pipefail

usage() {
    cat <<'EOF'
用法: bash scripts/stage-infra/build-stage-infra-bundle.sh [VERSION]

环境变量:
  DOCKER_PLATFORM   目标平台；未设置时会进入交互选择
EOF
}

VERSION_ARG="${1:-}"

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
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
RELEASE_DIR="$(cd "${SCRIPT_DIR}/../.." && pwd)"
STAGE_INFRA_DIR="${RELEASE_DIR}/stage-infra"
WORKSPACE_DIR="$(cd "${RELEASE_DIR}/.." && pwd)"
OUTPUT_DIR="${RELEASE_DIR}/dist"
RELEASE_NAME="acps-stage-infra-${VERSION}"
IMAGE_LIST_FILE="${STAGE_INFRA_DIR}/images.txt"
LOCAL_POSTGRES_IMAGE="acps-stage-postgres:pg17-pgvector"
SOURCE_COMMIT="$(git -C "${RELEASE_DIR}" rev-parse HEAD 2>/dev/null || echo 'unknown')"
SHORT_SHA="$(git -C "${RELEASE_DIR}" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
BUILD_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

# shellcheck source=/dev/null
source "${RELEASE_DIR}/scripts/lib/platform.sh"
# shellcheck source=/dev/null
source "${RELEASE_DIR}/scripts/lib/build.sh"

select_platform
require_docker
require_docker_buildx
validate_required_files "${STAGE_INFRA_DIR}" \
    "acs/rabbitmq-acs.json" \
    "acs/redis-acs.json" \
    "postgres/Dockerfile" \
    "rabbitmq.conf" \
    "enabled_plugins" \
    "init-rabbitmq.sh"
mkdir -p "${OUTPUT_DIR}"
SHA256_CMD=()
while IFS= read -r token; do
    SHA256_CMD+=("$token")
done < <(detect_sha256_cmd)

build_stage_postgres_image() {
    echo "=== 构建 stage-postgres pgvector 镜像 ==="

    if docker image inspect "${LOCAL_POSTGRES_IMAGE}" >/dev/null 2>&1 \
        && image_platform_matches "${LOCAL_POSTGRES_IMAGE}" "${DOCKER_PLATFORM}"; then
        echo "  复用本地 stage-postgres 镜像缓存"
        verify_image_platform "${LOCAL_POSTGRES_IMAGE}" "${DOCKER_PLATFORM}"
        return 0
    fi

    docker buildx build \
        --platform "${DOCKER_PLATFORM}" \
        --load \
        -t "${LOCAL_POSTGRES_IMAGE}" \
        "${STAGE_INFRA_DIR}/postgres"
    verify_image_platform "${LOCAL_POSTGRES_IMAGE}" "${DOCKER_PLATFORM}"
}

resolve_remote_image_ref() {
    local image="$1"
    local platform="$2"

    if [[ "${image}" == "${LOCAL_POSTGRES_IMAGE}" ]]; then
        printf '%s\n' "${image}"
        return 0
    fi

    python3 - "${image}" "${platform}" <<'PY'
import json
import subprocess
import sys

image = sys.argv[1]
platform = sys.argv[2]
parts = platform.split("/")
expected_os = parts[0] if len(parts) > 0 else ""
expected_arch = parts[1] if len(parts) > 1 else ""
expected_variant = parts[2] if len(parts) > 2 else ""


def repo_name(ref: str) -> str:
    last_slash = ref.rfind("/")
    last_colon = ref.rfind(":")
    if last_colon > last_slash:
        return ref[:last_colon]
    return ref


def image_repo(ref: str) -> str:
    return repo_name(ref.split("@", 1)[0])


def platform_matches(ref: str) -> bool:
    os_name = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Os}}", ref],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    arch = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Architecture}}", ref],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    variant = subprocess.run(
        ["docker", "image", "inspect", "--format", "{{.Variant}}", ref],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    if variant == "<no value>":
        variant = ""

    if os_name != expected_os or arch != expected_arch:
        return False
    if expected_variant and variant != expected_variant:
        return False
    return True


def resolve_from_remote() -> str:
    result = subprocess.run(
        ["docker", "buildx", "imagetools", "inspect", image, "--format", "{{json .Manifest}}"],
        check=True,
        capture_output=True,
        text=True,
        timeout=15,
    )
    manifest = json.loads(result.stdout)

    for item in manifest.get("manifests", []):
        item_platform = item.get("platform") or {}
        item_os = item_platform.get("os", "")
        item_arch = item_platform.get("architecture", "")
        item_variant = item_platform.get("variant", "")
        if item_os in {"", "unknown"} or item_arch in {"", "unknown"}:
            continue
        if item_os != expected_os or item_arch != expected_arch:
            continue
        if expected_variant and item_variant != expected_variant:
            continue
        return f"{image.split('@', 1)[0]}@{item['digest']}"

    raise SystemExit(f"未找到匹配平台 {platform} 的镜像 digest: {image}")


def resolve_from_local() -> str:
    repo = image_repo(image)
    local_digests = subprocess.run(
        ["docker", "image", "ls", "--digests", "--format", "{{.Repository}}|{{.Tag}}|{{.Digest}}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()

    for entry in local_digests:
        repository, _tag, digest = (entry.split("|", 2) + ["", "", ""])[:3]
        repository = repository.strip()
        digest = digest.strip()

        if repository != repo:
            continue
        if not digest or digest == "<none>":
            continue

        digest_ref = f"{repository}@{digest}"
        if platform_matches(digest_ref):
            return digest_ref

    local_images = subprocess.run(
        ["docker", "image", "ls", "--format", "{{.Repository}}:{{.Tag}}"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.splitlines()

    for ref in local_images:
        ref = ref.strip()
        if not ref or ref.endswith(":<none>"):
            continue
        if repo_name(ref) != repo:
            continue
        if not platform_matches(ref):
            continue

        repo_digests = json.loads(
            subprocess.run(
                ["docker", "image", "inspect", "--format", "{{json .RepoDigests}}", ref],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
        )
        for digest_ref in repo_digests:
            if image_repo(digest_ref) == repo:
                return digest_ref

        if repo_digests == []:
            return ref

    raise SystemExit(
        f"远端 manifest inspect 失败，且本地未找到匹配平台 {platform} 的缓存镜像: {image}"
    )

try:
    print(resolve_from_remote())
except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
    print(
        f"[build-stage-infra] WARN: 远端 manifest inspect 失败，回退到本地缓存: {image} ({exc})",
        file=sys.stderr,
    )
    print(resolve_from_local())
PY
}

ensure_image_available_for_platform() {
    local image_ref="$1"
    local platform="$2"

    if docker image inspect "${image_ref}" >/dev/null 2>&1 && image_platform_matches "${image_ref}" "${platform}"; then
        echo "  使用本地缓存镜像: ${image_ref}"
        verify_image_platform "${image_ref}" "${platform}"
        return 0
    fi

    pull_image_for_platform "${image_ref}" "${platform}"
    verify_image_platform "${image_ref}" "${platform}"
}

echo "=== 打包目标平台 ==="
echo "  ${DOCKER_PLATFORM}"

STAGING_DIR="$(mktemp -d)/${RELEASE_NAME}"
mkdir -p "${STAGING_DIR}/lib"

cp "${STAGE_INFRA_DIR}/compose.yml" "${STAGING_DIR}/compose.yml"
cp "${STAGE_INFRA_DIR}/.env.example" "${STAGING_DIR}/.env.example"
cp "${STAGE_INFRA_DIR}/deploy.sh" "${STAGING_DIR}/deploy.sh"
cp "${STAGE_INFRA_DIR}/cleanup-docker-resources.sh" "${STAGING_DIR}/cleanup-docker-resources.sh"
cp "${STAGE_INFRA_DIR}/init-databases.sh" "${STAGING_DIR}/init-databases.sh"
cp "${STAGE_INFRA_DIR}/init-rabbitmq.sh" "${STAGING_DIR}/init-rabbitmq.sh"
cp "${STAGE_INFRA_DIR}/images.txt" "${STAGING_DIR}/images.txt"
cp "${STAGE_INFRA_DIR}/rabbitmq.conf" "${STAGING_DIR}/rabbitmq.conf"
cp "${STAGE_INFRA_DIR}/enabled_plugins" "${STAGING_DIR}/enabled_plugins"
cp "${SCRIPT_DIR}/smoke-test.sh" "${STAGING_DIR}/smoke-test.sh"
cp -R "${STAGE_INFRA_DIR}/acs" "${STAGING_DIR}/acs"
cp -R "${STAGE_INFRA_DIR}/nginx" "${STAGING_DIR}/nginx"
cp -R "${STAGE_INFRA_DIR}/postgres" "${STAGING_DIR}/postgres"
cp "${RELEASE_DIR}/scripts/lib/common.sh" "${STAGING_DIR}/lib/common.sh"
cp "${RELEASE_DIR}/scripts/lib/certs-permissions-lib.sh" "${STAGING_DIR}/lib/certs-permissions-lib.sh"
cp "${RELEASE_DIR}/scripts/lib/docker.sh" "${STAGING_DIR}/lib/docker.sh"

build_stage_postgres_image

echo "=== 拉取基础设施镜像 ==="
IMAGES=()
while read -r image; do
    [[ -n "${image}" ]] || continue
    if [[ "${image}" == "${LOCAL_POSTGRES_IMAGE}" ]]; then
        IMAGES+=("${image}")
        continue
    fi
    resolved_image="$(resolve_remote_image_ref "${image}" "${DOCKER_PLATFORM}")"
    IMAGES+=("${resolved_image}")
    ensure_image_available_for_platform "${resolved_image}" "${DOCKER_PLATFORM}"
done < "${IMAGE_LIST_FILE}"

if [[ "${#IMAGES[@]}" -eq 0 ]]; then
    echo "错误：镜像清单为空: ${IMAGE_LIST_FILE}" >&2
    exit 1
fi

printf '%s\n' "${IMAGES[@]}" > "${STAGING_DIR}/images.lock"

echo "=== 导出离线镜像包 ==="
docker save --platform "${DOCKER_PLATFORM}" "${IMAGES[@]}" | gzip > "${STAGING_DIR}/images.tar.gz"

cat > "${STAGING_DIR}/VERSION" <<EOF
version=${VERSION}
source_commit=${SOURCE_COMMIT}
short_sha=${SHORT_SHA}
build_date=${BUILD_DATE}
platform=${DOCKER_PLATFORM}
images_file=images.txt
images_lock=images.lock
EOF

generate_checksums "${STAGING_DIR}" "${SHA256_CMD[@]}"

TAR_ARGS=()
if [[ "$(uname -s)" == "Darwin" ]]; then
    TAR_ARGS+=(--no-mac-metadata --no-xattrs --no-acls)
fi

TAR_ARGS+=(-czf "${OUTPUT_DIR}/${RELEASE_NAME}.tar.gz" -C "$(dirname "${STAGING_DIR}")" "${RELEASE_NAME}")
tar "${TAR_ARGS[@]}"
echo "输出: ${OUTPUT_DIR}/${RELEASE_NAME}.tar.gz"
