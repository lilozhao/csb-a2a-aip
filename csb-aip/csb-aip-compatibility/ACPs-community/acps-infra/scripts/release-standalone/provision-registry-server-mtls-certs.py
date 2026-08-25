#!/usr/bin/env python3
"""Provision ACPs certificates for registry-server 9002 mTLS listener.

流程：
1. 根据 standalone 发布参数生成 registry-server `9002` 服务 ACS 与 probe 客户端 ACS。
2. 在 ACPs Registry 中同步这两份 ACS，支持已审批记录自动 delete -> recreate。
3. 通过 CA Server 申请 `serverAuth` 服务端证书与 `clientAuth` probe 证书，
   写入 registry-server 运行时目录下的 certs/。
"""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path

TEXT_PLAIN = "text/plain"
APPLICATION_JSON = "application/json"


@dataclass(frozen=True)
class RegistrationSpec:
    name: str
    acs_path: Path
    cleanup_paths: tuple[Path, ...] = ()


@dataclass(frozen=True)
class RegistrationResult:
    name: str
    agent_id: str
    aic: str


@dataclass(frozen=True)
class CertificateSpec:
    name: str
    acs_path: Path
    usage: str
    cert_path: Path
    key_path: Path


class ProvisionError(RuntimeError):
    """证书申请过程中不可恢复的错误。"""


def log(message: str) -> None:
    print(f"[registry-9002-certs] {message}")


def resolve_cli(name: str, candidates: list[str]) -> str:
    for candidate in candidates:
        if not candidate:
            continue
        if os.path.sep in candidate or candidate.startswith("."):
            path = Path(candidate)
            if path.is_file() and os.access(path, os.X_OK):
                return str(path)
            continue
        resolved = shutil.which(candidate)
        if resolved:
            return resolved
    raise ProvisionError(f"未找到可执行文件: {name}")


def run_command(cmd: list[str], *, cwd: Path | None = None) -> str:
    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    output = (result.stdout + result.stderr).strip()
    if result.returncode != 0:
        raise ProvisionError(f"命令失败: {' '.join(cmd)}\n{output}")
    if output:
        log(output)
    return output


def run_cli(cmd: list[str], *, cwd: Path | None = None) -> tuple[bool, str]:
    result = subprocess.run(
        cmd,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
    )
    output = (result.stdout + result.stderr).strip()
    return result.returncode == 0, output


def is_approved_update_conflict(output: str) -> bool:
    upper_output = output.upper()
    return "APPROVED" in upper_output and "CANNOT BE UPDATED" in upper_output


def load_json_output(output: str) -> dict[str, object]:
    text = output.strip()
    if not text:
        return {}
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        for line in reversed(text.splitlines()):
            line = line.strip()
            if not line:
                continue
            try:
                return json.loads(line)
            except json.JSONDecodeError:
                continue
    raise ProvisionError(f"无法解析 JSON 输出:\n{output}")


def run_json_command(cmd: list[str], *, cwd: Path | None = None) -> dict[str, object]:
    return load_json_output(run_command(cmd, cwd=cwd))


def extract_aic(acs_path: Path) -> str:
    payload = json.loads(acs_path.read_text(encoding="utf-8"))
    aic = str(payload.get("aic") or "").strip()
    if not aic:
        raise ProvisionError(f"ACS 尚未写回 AIC: {acs_path}")
    return aic


def ensure_registry_login(conf_path: Path, acps_cli: str) -> None:
    run_command([acps_cli, "--config", str(conf_path), "auth", "login", "--json"])
    run_command(
        [acps_cli, "--config", str(conf_path), "admin", "auth", "login", "--json"]
    )


def current_timestamp() -> str:
    beijing = timezone(timedelta(hours=8))
    return datetime.now(tz=beijing).replace(microsecond=0).isoformat()


def format_host_for_url(host: str) -> str:
    if ":" in host and not host.startswith("["):
        return f"[{host}]"
    return host


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for value in values:
        cleaned = value.strip()
        if not cleaned or cleaned in seen:
            continue
        seen.add(cleaned)
        result.append(cleaned)
    return result


def derive_alt_names(public_host: str) -> tuple[list[str], list[str]]:
    dns_names = ["localhost", "host.docker.internal"]
    ip_names = ["127.0.0.1"]

    try:
        normalized_ip = str(ipaddress.ip_address(public_host))
    except ValueError:
        dns_names.append(public_host)
    else:
        ip_names.append(normalized_ip)

    return unique_strings(dns_names), unique_strings(ip_names)


def load_release_version(registry_dir: Path) -> str:
    version_file = registry_dir / "VERSION"
    if not version_file.is_file():
        return "1.0.0"
    for line in version_file.read_text(encoding="utf-8").splitlines():
        if line.startswith("version="):
            value = line.partition("=")[2].strip()
            if value:
                return value
    return "1.0.0"


def write_json_file(path: Path, payload: dict[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def build_service_acs(
    *,
    public_host: str,
    public_port: int,
    registry_public_base_url: str,
    version: str,
) -> dict[str, object]:
    dns_names, ip_names = derive_alt_names(public_host)
    url_host = format_host_for_url(public_host)

    return {
        "aic": "",
        "active": False,
        "lastModifiedTime": current_timestamp(),
        "protocolVersion": "02.01",
        "name": "registry-server-atr-service",
        "version": version,
        "description": "registry-server 的 ATR mTLS service agent，用于 standalone `9002` listener 服务端证书申请与本体验证平面联调。",
        "provider": {
            "organization": "ACPs",
            "department": "Registry Server",
            "url": registry_public_base_url,
            "license": "Internal",
        },
        "securitySchemes": {
            "mtls": {
                "type": "mutualTLS",
                "description": "ATR entity registration mTLS",
            }
        },
        "endPoints": [
            {
                "url": f"https://{url_host}:{public_port}/acps-atr-v2/entity",
                "transport": "REST",
                "security": [{"mtls": []}],
            }
        ],
        "capabilities": {
            "streaming": False,
            "notification": False,
            "messageQueue": [],
        },
        "defaultInputModes": [TEXT_PLAIN],
        "defaultOutputModes": [TEXT_PLAIN, APPLICATION_JSON],
        "certificate": {
            "altNames": {
                "dns": dns_names,
                "ip": ip_names,
            },
            "requestedValidity": 365,
        },
        "skills": [
            {
                "id": "registry-server.atr-entity-registration",
                "name": "ATR Entity Registration",
                "description": "Accept entity registration requests on the dedicated 9002 mTLS plane.",
                "version": version,
                "tags": ["atr", "registry", "entity"],
                "examples": [
                    "Register an entity under an approved ontology over ATR mTLS."
                ],
                "inputModes": [TEXT_PLAIN],
                "outputModes": [APPLICATION_JSON],
            }
        ],
    }


def build_probe_acs(*, public_host: str, public_port: int) -> dict[str, object]:
    url_host = format_host_for_url(public_host)
    return {
        "aic": "",
        "active": False,
        "protocolVersion": "02.01",
        "lastModifiedTime": current_timestamp(),
        "name": "registry-server 9002 健康探针客户端",
        "description": "registry-server `9002` 健康检查与冒烟测试专用 mTLS 客户端身份。仅用于 `/health` 和探针验证，不参与业务 API 调用。",
        "version": "1.0.0",
        "provider": {
            "organization": "ACPs",
            "department": "Registry Server",
            "url": f"https://{url_host}:{public_port}/health",
            "license": "Internal",
        },
        "securitySchemes": {
            "mtls": {
                "type": "mutualTLS",
                "description": "mTLS probe client identity for registry-server 9002",
            }
        },
        "endPoints": [],
        "certificate": {
            "altNames": {
                "dns": ["registry-server-9002-probe"],
            },
            "requestedValidity": 365,
        },
        "capabilities": {
            "streaming": False,
            "notification": False,
            "messageQueue": [],
        },
        "defaultInputModes": [],
        "defaultOutputModes": [],
        "skills": [],
    }


def clear_local_state(acs_path: Path, cleanup_paths: tuple[Path, ...]) -> None:
    for path in cleanup_paths:
        try:
            if path.is_file():
                path.unlink()
        except OSError:
            pass

    if not acs_path.is_file():
        return

    try:
        payload = json.loads(acs_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return

    payload["aic"] = ""
    write_json_file(acs_path, payload)


def save_registration_metadata(
    spec: RegistrationSpec, *, conf_path: Path, acps_cli: str
) -> dict[str, object]:
    command = [
        acps_cli,
        "--config",
        str(conf_path),
        "agent",
        "save",
        "--acs-file",
        str(spec.acs_path),
        "--json",
    ]

    ok, save_out = run_cli(command)
    if not ok and is_approved_update_conflict(save_out):
        log(f"{spec.name} 已审批且 ACS 发生变化，自动删除并按当前模板重建")
        run_cli(
            [
                acps_cli,
                "--config",
                str(conf_path),
                "agent",
                "delete",
                "--acs-file",
                str(spec.acs_path),
                "--json",
            ]
        )
        clear_local_state(spec.acs_path, spec.cleanup_paths)
        ok, save_out = run_cli(command)

    if not ok:
        raise ProvisionError(f"{spec.name} 保存 ACS metadata 失败: {save_out}")

    return load_json_output(save_out)


def read_registration_status(
    spec: RegistrationSpec,
    *,
    conf_path: Path,
    acps_cli: str,
    payload: dict[str, object],
) -> tuple[str, str, bool]:
    current_status = str(payload.get("approval_status") or "").lower()
    agent_id = str(payload.get("agent_id") or "")
    is_disabled = str(payload.get("is_disabled") or "").lower() == "true"

    if current_status and agent_id:
        return current_status, agent_id, is_disabled

    check_out = run_json_command(
        [
            acps_cli,
            "--config",
            str(conf_path),
            "agent",
            "check",
            "--acs-file",
            str(spec.acs_path),
            "--json",
        ]
    )
    current_status = str(check_out.get("status") or current_status).lower()
    agent_id = str(check_out.get("agent_id") or agent_id)
    is_disabled = str(check_out.get("is_disabled") or "").lower() == "true"
    return current_status, agent_id, is_disabled


def enable_registration_if_needed(
    *, conf_path: Path, acps_cli: str, name: str, agent_id: str
) -> None:
    enable_out = run_json_command(
        [
            acps_cli,
            "--config",
            str(conf_path),
            "admin",
            "registry",
            "agent",
            "enable",
            "--agent-id",
            agent_id,
            "--json",
        ]
    )
    if str(enable_out.get("is_disabled") or "").lower() == "true":
        raise ProvisionError(f"{name} 自动 enable 后仍处于 disabled")


def advance_registration_to_approved(
    *,
    conf_path: Path,
    acps_cli: str,
    name: str,
    agent_id: str,
    current_status: str,
    approval_comments: str,
) -> str:
    status = current_status

    if status == "draft":
        submit_out = run_json_command(
            [
                acps_cli,
                "--config",
                str(conf_path),
                "agent",
                "submit",
                "--agent-id",
                agent_id,
                "--json",
            ]
        )
        status = str(submit_out.get("approval_status") or "").lower()

    if status == "pending":
        approve_out = run_json_command(
            [
                acps_cli,
                "--config",
                str(conf_path),
                "admin",
                "registry",
                "review",
                "approve",
                "--agent-id",
                agent_id,
                "--comments",
                approval_comments,
                "--json",
            ]
        )
        status = str(approve_out.get("approval_status") or "").lower()

    if status != "approved":
        raise ProvisionError(f"{name} 未进入 APPROVED 状态: {status}")

    return status


def ensure_registration(
    spec: RegistrationSpec,
    *,
    conf_path: Path,
    acps_cli: str,
    approval_comments: str,
) -> RegistrationResult:
    log(f"同步 ACS 注册状态: {spec.name}")

    payload = save_registration_metadata(spec, conf_path=conf_path, acps_cli=acps_cli)
    current_status, agent_id, is_disabled = read_registration_status(
        spec,
        conf_path=conf_path,
        acps_cli=acps_cli,
        payload=payload,
    )

    if current_status not in {"draft", "pending", "approved"}:
        raise ProvisionError(
            f"{spec.name} 遇到不支持的 registry 状态: {current_status}"
        )
    if not agent_id:
        raise ProvisionError(f"{spec.name} 未获取到 agent_id")

    if is_disabled:
        enable_registration_if_needed(
            conf_path=conf_path,
            acps_cli=acps_cli,
            name=spec.name,
            agent_id=agent_id,
        )

    advance_registration_to_approved(
        conf_path=conf_path,
        acps_cli=acps_cli,
        name=spec.name,
        agent_id=agent_id,
        current_status=current_status,
        approval_comments=approval_comments,
    )

    sync_out = run_json_command(
        [
            acps_cli,
            "--config",
            str(conf_path),
            "agent",
            "sync",
            "--acs-file",
            str(spec.acs_path),
            "--json",
        ]
    )
    aic = str(sync_out.get("aic") or "").strip()
    if not aic:
        raise ProvisionError(f"{spec.name} agent sync 后仍缺少 AIC")

    return RegistrationResult(name=spec.name, agent_id=agent_id, aic=aic)


def issue_certificate(
    spec: CertificateSpec,
    *,
    conf_path: Path,
    acps_cli: str,
    trust_bundle_path: Path,
    work_root: Path,
) -> None:
    if (
        spec.cert_path.is_file()
        and spec.key_path.is_file()
        and trust_bundle_path.is_file()
    ):
        log(f"复用已有证书: {spec.name}")
        return

    log(f"申请证书: {spec.name} ({spec.usage})")
    spec.cert_path.parent.mkdir(parents=True, exist_ok=True)
    spec.key_path.parent.mkdir(parents=True, exist_ok=True)
    work_dir = work_root / spec.name
    work_dir.mkdir(parents=True, exist_ok=True)
    eab_path = work_dir / "eab.json"

    aic = extract_aic(spec.acs_path)
    run_command(
        [
            acps_cli,
            "--config",
            str(conf_path),
            "cert",
            "eab",
            "fetch",
            "--aic",
            aic,
            "--output",
            str(eab_path),
            "--json",
        ]
    )
    run_command(
        [
            acps_cli,
            "--config",
            str(conf_path),
            "cert",
            "issue",
            "--aic",
            aic,
            "--eab-file",
            str(eab_path),
            "--usage",
            spec.usage,
            "--cert-path",
            str(spec.cert_path),
            "--key-path",
            str(spec.key_path),
            "--trust-bundle-path",
            str(trust_bundle_path),
        ],
        cwd=work_dir,
    )


def write_summary(
    *,
    summary_path: Path,
    service_registration: RegistrationResult,
    probe_registration: RegistrationResult,
    service_acs_path: Path,
    probe_acs_path: Path,
    server_cert_path: Path,
    server_key_path: Path,
    probe_cert_path: Path,
    probe_key_path: Path,
    trust_bundle_path: Path,
    public_host: str,
    public_port: int,
) -> None:
    payload = {
        "service_aic": service_registration.aic,
        "service_agent_id": service_registration.agent_id,
        "probe_aic": probe_registration.aic,
        "probe_agent_id": probe_registration.agent_id,
        "service_acs_file": str(service_acs_path),
        "probe_acs_file": str(probe_acs_path),
        "server_cert_file": str(server_cert_path),
        "server_key_file": str(server_key_path),
        "probe_cert_file": str(probe_cert_path),
        "probe_key_file": str(probe_key_path),
        "trust_bundle_file": str(trust_bundle_path),
        "listener_url": f"https://{format_host_for_url(public_host)}:{public_port}/acps-atr-v2/entity",
    }
    write_json_file(summary_path, payload)
    log(f"已写入 bootstrap 摘要: {summary_path}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--registry-server-dir",
        required=True,
        help="已解压的 registry-server 运行时目录（release bundle 提取后的路径）",
    )
    parser.add_argument("--cli-conf", required=True, help="acps-cli 配置文件路径")
    parser.add_argument(
        "--registry-public-base-url",
        required=True,
        help="registry public plane 对外根地址，例如 http://localhost:9000/registry",
    )
    parser.add_argument(
        "--mtls-public-host",
        required=True,
        help="registry 9002 对外访问主机名或 IP",
    )
    parser.add_argument(
        "--mtls-public-port",
        type=int,
        default=9002,
        help="registry 9002 对外访问端口",
    )
    parser.add_argument(
        "--approval-comments",
        default="release-standalone registry-server 9002 bootstrap",
        help="ACS 审批备注",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()

    registry_dir = Path(args.registry_server_dir).resolve()
    cli_conf = Path(args.cli_conf).resolve()

    if not registry_dir.is_dir():
        raise ProvisionError(f"registry-server 运行时目录不存在: {registry_dir}")
    if not cli_conf.is_file():
        raise ProvisionError(f"CLI 配置文件不存在: {cli_conf}")

    acs_dir = registry_dir / "acs"
    cert_dir = registry_dir / "certs"
    work_root = registry_dir / ".ca-data" / "registry-9002-bootstrap"
    summary_path = work_root / "summary.json"
    version = load_release_version(registry_dir)

    service_acs_path = acs_dir / "registry-server-9002-service-acs.json"
    probe_acs_path = acs_dir / "registry-server-9002-probe-client-acs.json"
    server_cert_path = cert_dir / "server.pem"
    server_key_path = cert_dir / "server.key"
    probe_cert_path = cert_dir / "probe-client.pem"
    probe_key_path = cert_dir / "probe-client.key"
    trust_bundle_path = cert_dir / "trust-bundle.pem"

    write_json_file(
        service_acs_path,
        build_service_acs(
            public_host=args.mtls_public_host,
            public_port=args.mtls_public_port,
            registry_public_base_url=args.registry_public_base_url,
            version=version,
        ),
    )
    write_json_file(
        probe_acs_path,
        build_probe_acs(
            public_host=args.mtls_public_host,
            public_port=args.mtls_public_port,
        ),
    )

    acps_cli = resolve_cli("acps-cli", ["acps-cli", "/opt/venv/bin/acps-cli"])
    ensure_registry_login(cli_conf, acps_cli)

    service_registration = ensure_registration(
        RegistrationSpec(
            "registry-server-9002-service",
            service_acs_path,
            cleanup_paths=(server_cert_path, server_key_path, trust_bundle_path),
        ),
        conf_path=cli_conf,
        acps_cli=acps_cli,
        approval_comments=args.approval_comments,
    )
    probe_registration = ensure_registration(
        RegistrationSpec(
            "registry-server-9002-probe-client",
            probe_acs_path,
            cleanup_paths=(probe_cert_path, probe_key_path),
        ),
        conf_path=cli_conf,
        acps_cli=acps_cli,
        approval_comments=args.approval_comments,
    )

    cert_dir.mkdir(parents=True, exist_ok=True)
    for spec in (
        CertificateSpec(
            "registry-server-9002-service",
            service_acs_path,
            "serverAuth",
            server_cert_path,
            server_key_path,
        ),
        CertificateSpec(
            "registry-server-9002-probe-client",
            probe_acs_path,
            "clientAuth",
            probe_cert_path,
            probe_key_path,
        ),
    ):
        issue_certificate(
            spec,
            conf_path=cli_conf,
            acps_cli=acps_cli,
            trust_bundle_path=trust_bundle_path,
            work_root=work_root,
        )

    write_summary(
        summary_path=summary_path,
        service_registration=service_registration,
        probe_registration=probe_registration,
        service_acs_path=service_acs_path,
        probe_acs_path=probe_acs_path,
        server_cert_path=server_cert_path,
        server_key_path=server_key_path,
        probe_cert_path=probe_cert_path,
        probe_key_path=probe_key_path,
        trust_bundle_path=trust_bundle_path,
        public_host=args.mtls_public_host,
        public_port=args.mtls_public_port,
    )

    log("registry-server 9002 证书目录已就绪:")
    for path in sorted(cert_dir.iterdir()):
        log(f"  {path.name}")

    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProvisionError as exc:
        print(f"[registry-9002-certs] 错误: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
