"""release-partners deploy.sh 首装路径回归测试。"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
from pathlib import Path
from textwrap import dedent
from typing import Any

import pytest

PROJECT_ROOT = Path(__file__).resolve().parents[2]
DEPLOY_SCRIPT = PROJECT_ROOT / "scripts" / "release-app" / "deploy.sh"


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _write_json(path: Path, payload: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def _create_fake_common_sh(path: Path) -> None:
    _write_text(
        path,
        dedent("""\
            #!/usr/bin/env bash
            set -euo pipefail

            log() {
              printf '%s\n' "$*"
            }

            err() {
              printf '%s\n' "$*" >&2
            }

            source_env_file() {
              local env_file="$1"
              set -a
              # shellcheck source=/dev/null
              source "${env_file}"
              set +a
            }

            require_file_exists() {
              local path="$1"
              local label="$2"
              [[ -f "${path}" ]] || {
                err "missing file: ${label}"
                return 1
              }
            }

            require_dir_exists() {
              local path="$1"
              local label="$2"
              [[ -d "${path}" ]] || {
                err "missing dir: ${label}"
                return 1
              }
            }

            assert_file_not_contains() {
              local file_path="$1"
              local pattern="$2"
              local label="$3"
              if grep -Eq "${pattern}" "${file_path}"; then
                err "unexpected literal config in ${label}"
                return 1
              fi
            }

            require_toml_env_refs_resolved() {
              return 0
            }

            extract_toml_string_value() {
              local key="$1"
              local file_path="$2"
              awk -F= -v lookup_key="${key}" '
                $1 ~ "^[[:space:]]*" lookup_key "[[:space:]]*$" {
                  value=$2
                  gsub(/^[[:space:]]*\"/, "", value)
                  gsub(/\"[[:space:]]*$/, "", value)
                  print value
                  exit
                }
              ' "${file_path}"
            }

            load_images() {
              return 0
            }
            """),
    )
    path.chmod(0o755)


def _create_fake_docker_lib(path: Path) -> None:
    _write_text(
        path,
        dedent("""\
            #!/usr/bin/env bash
            set -euo pipefail

            container_exists() {
              case "$1" in
                demo-partners)
                  [[ "${TEST_DEMO_PARTNERS_EXISTS:-false}" == "true" ]]
                  ;;
                demo-leader)
                  [[ "${TEST_DEMO_LEADER_EXISTS:-false}" == "true" ]]
                  ;;
                demo-web-nginx)
                  [[ "${TEST_DEMO_WEB_NGINX_EXISTS:-false}" == "true" ]]
                  ;;
                *)
                  return 1
                  ;;
              esac
            }

            wait_healthy() {
              local container="$1"
              printf 'wait_healthy %s\n' "${container}" >> "${TEST_EVENT_LOG:?}"
            }

            compose_up_detached() {
              docker compose "$@"
              printf 'compose_up_detached %s\n' "$*" >> "${TEST_EVENT_LOG:?}"
            }
            """),
    )
    path.chmod(0o755)


def _create_fake_certs_permissions_lib(path: Path) -> None:
    _write_text(
        path,
        dedent("""\
            #!/usr/bin/env bash
            set -euo pipefail

            normalize_bind_mount_certs_dir() {
              return 0
            }
            """),
    )
    path.chmod(0o755)


def _create_fake_docker_binary(path: Path) -> None:
    _write_text(
        path,
        dedent("""\
            #!/usr/bin/env bash
            set -euo pipefail

            printf '%s\n' "$*" >> "${TEST_DOCKER_LOG:?}"
            exit 0
            """),
    )
    path.chmod(0o755)


def _create_partner_agent(agent_dir: Path, runtime_acs: dict[str, Any]) -> None:
    _write_json(agent_dir / "acs.json", runtime_acs)
    _write_text(
        agent_dir / "config.toml",
        dedent("""\
            [mtls]
            cert_file = "server.pem"
            key_file = "server.key"
            ca_file = "trust-bundle.pem"
            """),
    )
    _write_text(agent_dir / "server.pem", "cert\n")
    _write_text(agent_dir / "server.key", "key\n")
    _write_text(agent_dir / "trust-bundle.pem", "ca\n")


@pytest.mark.unit
def test_first_install_syncs_static_acs_copies_before_compose_up(
    tmp_path: Path,
) -> None:
    """首装路径即使没有已有容器，也必须先同步 leader 静态 ACS 副本。"""
    work_root = tmp_path / "release-root"
    partners_bundle = work_root / "partners"
    leader_bundle = work_root / "leader"
    partners_bundle.mkdir(parents=True, exist_ok=True)

    shutil.copy2(DEPLOY_SCRIPT, partners_bundle / "deploy.sh")
    (partners_bundle / "deploy.sh").chmod(0o755)

    _write_text(partners_bundle / ".env", "PARTNERS_IMAGE=acps-demo-partners:latest\n")
    _write_text(partners_bundle / "compose.yml", "services:\n  partners:\n    image: demo\n")
    _create_fake_common_sh(partners_bundle / "lib" / "common.sh")
    _create_fake_docker_lib(partners_bundle / "lib" / "docker.sh")
    _create_fake_certs_permissions_lib(
        partners_bundle / "lib" / "certs-permissions-lib.sh",
    )

    runtime_acs = {
        "aic": "runtime-aic-001",
        "name": "北京美食推荐智能体",
        "description": "runtime copy",
    }
    _create_partner_agent(partners_bundle / "partners" / "online" / "beijing_food", runtime_acs)

    stale_static_copy = {
        "aic": "stale-aic-001",
        "name": "北京美食推荐智能体",
        "description": "stale static copy",
    }
    static_copy_path = leader_bundle / "leader" / "scenario" / "expert" / "tour" / "beijing_food.json"
    _write_json(static_copy_path, stale_static_copy)

    fake_bin = tmp_path / "bin"
    _create_fake_docker_binary(fake_bin / "docker")
    docker_log = tmp_path / "docker.log"
    event_log = tmp_path / "events.log"

    env = {
        **os.environ,
        "PATH": f"{fake_bin}:{os.environ['PATH']}",
        "TEST_DOCKER_LOG": str(docker_log),
        "TEST_EVENT_LOG": str(event_log),
        "TEST_DEMO_PARTNERS_EXISTS": "false",
        "TEST_DEMO_LEADER_EXISTS": "false",
        "TEST_DEMO_WEB_NGINX_EXISTS": "false",
    }

    result = subprocess.run(
        ["bash", str(partners_bundle / "deploy.sh")],  # noqa: S607
        cwd=partners_bundle,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        check=False,
    )

    assert result.returncode == 0, result.stderr

    synced_static_copy = json.loads(static_copy_path.read_text(encoding="utf-8"))
    assert synced_static_copy == runtime_acs
    assert "已同步静态 ACS 副本" in result.stdout

    docker_calls = docker_log.read_text(encoding="utf-8")
    assert "compose -f" in docker_calls
    assert "up -d" in docker_calls
    assert "--force-recreate" not in docker_calls

    events = event_log.read_text(encoding="utf-8")
    assert "wait_healthy partners" in events
