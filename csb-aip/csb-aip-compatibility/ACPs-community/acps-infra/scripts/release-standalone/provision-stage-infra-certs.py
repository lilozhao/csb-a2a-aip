#!/usr/bin/env python3
"""Provision ACPs certificates for stage-infra RabbitMQ, Auth Service, and Redis."""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RegistrationSpec:
    name: str
    acs_path: Path
    cleanup_paths: tuple[Path, ...] = ()


@dataclass(frozen=True)
class CertificateSpec:
    name: str
    acs_path: Path
    usage: str
    cert_path: Path
    key_path: Path


class ProvisionError(RuntimeError):
    """Raised when provisioning cannot continue."""


def log(message: str) -> None:
    print(f"[infra-certs] {message}")


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


def clear_local_state(acs_path: Path, cleanup_paths: tuple[Path, ...]) -> None:
    for path in cleanup_paths:
        try:
            if path.is_dir():
                shutil.rmtree(path)
            elif path.is_file():
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
    acs_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )


def ensure_registry_login(conf_path: Path, acps_cli: str) -> None:
    run_command([acps_cli, "--config", str(conf_path), "auth", "login", "--json"])
    run_command(
        [acps_cli, "--config", str(conf_path), "admin", "auth", "login", "--json"]
    )


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
        run_command(
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


def ensure_registration(
    spec: RegistrationSpec,
    *,
    conf_path: Path,
    acps_cli: str,
    approval_comments: str,
) -> None:
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
        run_json_command(
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

    if current_status == "draft":
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
        current_status = str(submit_out.get("approval_status") or "").lower()

    if current_status == "pending":
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
        current_status = str(approve_out.get("approval_status") or "").lower()

    if current_status != "approved":
        raise ProvisionError(f"{spec.name} 未进入 APPROVED 状态: {current_status}")

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
    if not str(sync_out.get("aic") or "").strip():
        raise ProvisionError(f"{spec.name} agent sync 后仍缺少 AIC")


def extract_pem_blocks(pem_text: str) -> list[str]:
    blocks: list[str] = []
    current: list[str] = []
    in_block = False

    for line in pem_text.splitlines():
        if "-----BEGIN CERTIFICATE-----" in line:
            current = [line]
            in_block = True
            continue

        if not in_block:
            continue

        current.append(line)
        if "-----END CERTIFICATE-----" in line:
            blocks.append("\n".join(current).strip() + "\n")
            current = []
            in_block = False

    return blocks


def resolve_local_ca_chain_path(search_root: Path) -> Path | None:
    explicit = os.environ.get("ACPS_CA_CHAIN_PATH") or os.environ.get("CA_CHAIN_PATH")
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))

    resolved_root = search_root.resolve()
    for parent in (resolved_root, *resolved_root.parents):
        candidates.append(parent / "ca-server" / "certs" / "ca-chain.pem")

    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def merge_ca_bundle_with_local_chain(
    bundle_text: str, search_root: Path
) -> tuple[str, Path | None]:
    chain_path = resolve_local_ca_chain_path(search_root)
    if chain_path is None:
        return bundle_text, None

    chain_text = chain_path.read_text(encoding="utf-8")
    merged_blocks: list[str] = []
    seen_blocks: set[str] = set()
    for pem_text in (chain_text, bundle_text):
        for block in extract_pem_blocks(pem_text):
            if block in seen_blocks:
                continue
            seen_blocks.add(block)
            merged_blocks.append(block)

    merged_text = "".join(merged_blocks)
    if not merged_text:
        return bundle_text, chain_path
    return merged_text, chain_path


def update_trust_bundle(*, conf_path: Path, acps_cli: str, output_path: Path) -> None:
    output_path.parent.mkdir(parents=True, exist_ok=True)
    run_command(
        [
            acps_cli,
            "--config",
            str(conf_path),
            "cert",
            "trust-bundle",
            "update",
            "--output",
            str(output_path),
        ],
        cwd=output_path.parent,
    )


def issue_certificate(
    spec: CertificateSpec,
    *,
    conf_path: Path,
    acps_cli: str,
    trust_bundle_path: Path,
    work_root: Path,
) -> None:
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


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--stage-infra-dir",
        required=True,
        help="Extracted stage-infra runtime directory",
    )
    parser.add_argument("--cli-conf", required=True, help="acps-cli config file")
    parser.add_argument(
        "--approval-comments",
        default="release-standalone stage-infra bootstrap",
        help="Approval comments for infra ACS records",
    )
    return parser


def main() -> int:
    args = build_parser().parse_args()

    stage_infra_dir = Path(args.stage_infra_dir).resolve()
    cli_conf = Path(args.cli_conf).resolve()
    acs_dir = stage_infra_dir / "acs"
    cert_dir = stage_infra_dir / "certs"
    trust_bundle_path = cert_dir / "acps-root-ca.pem"
    work_root = stage_infra_dir / ".ca-data"

    if not stage_infra_dir.is_dir():
        raise ProvisionError(f"stage-infra 目录不存在: {stage_infra_dir}")
    if not cli_conf.is_file():
        raise ProvisionError(f"CLI 配置文件不存在: {cli_conf}")

    acps_cli = resolve_cli("acps-cli", ["acps-cli", "/opt/venv/bin/acps-cli"])

    registrations = [
        RegistrationSpec(
            "rabbitmq",
            acs_dir / "rabbitmq-acs.json",
            cleanup_paths=(
                work_root / "rabbitmq-server",
                work_root / "rabbitmq-client",
                cert_dir / "rabbitmq-server.pem",
                cert_dir / "rabbitmq-server.key",
                cert_dir / "rabbitmq-client.pem",
                cert_dir / "rabbitmq-client.key",
            ),
        ),
        RegistrationSpec(
            "redis",
            acs_dir / "redis-acs.json",
            cleanup_paths=(
                work_root / "redis-server",
                cert_dir / "redis-server.pem",
                cert_dir / "redis-server.key",
            ),
        ),
    ]
    certificates = [
        CertificateSpec(
            "rabbitmq-server",
            acs_dir / "rabbitmq-acs.json",
            "serverAuth",
            cert_dir / "rabbitmq-server.pem",
            cert_dir / "rabbitmq-server.key",
        ),
        CertificateSpec(
            "rabbitmq-client",
            acs_dir / "rabbitmq-acs.json",
            "clientAuth",
            cert_dir / "rabbitmq-client.pem",
            cert_dir / "rabbitmq-client.key",
        ),
        CertificateSpec(
            "redis-server",
            acs_dir / "redis-acs.json",
            "serverAuth",
            cert_dir / "redis-server.pem",
            cert_dir / "redis-server.key",
        ),
    ]

    missing = [
        str(spec.acs_path) for spec in registrations if not spec.acs_path.is_file()
    ]
    if missing:
        raise ProvisionError(f"缺少 stage-infra ACS 模板: {', '.join(missing)}")

    ensure_registry_login(cli_conf, acps_cli)
    for spec in registrations:
        ensure_registration(
            spec,
            conf_path=cli_conf,
            acps_cli=acps_cli,
            approval_comments=args.approval_comments,
        )

    update_trust_bundle(
        conf_path=cli_conf, acps_cli=acps_cli, output_path=trust_bundle_path
    )
    for spec in certificates:
        issue_certificate(
            spec,
            conf_path=cli_conf,
            acps_cli=acps_cli,
            trust_bundle_path=trust_bundle_path,
            work_root=work_root,
        )

    # acps-cli cert issue 内部会调用 cert trust-bundle update，每次 cert issue 完成后都会
    # 用从 CA server 下载的内容（仅含 Root CA）覆盖 trust_bundle_path。
    # 因此，所有 cert issue 全部完成后，才能做最终的 merge，将中间 CA 补入信任包，
    # 确保 redis-cli --tls 等不自动跟随中间 CA 链的工具能正确验证服务端证书。
    bundle_text = trust_bundle_path.read_text(encoding="utf-8")
    merged_text, chain_path = merge_ca_bundle_with_local_chain(bundle_text, cert_dir)
    if chain_path is not None and merged_text != bundle_text:
        trust_bundle_path.write_text(merged_text, encoding="utf-8")
        log(f"已合并本地 ca-chain.pem 到 stage-infra CA bundle: {chain_path}")

    log("stage-infra 证书申请完成")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except ProvisionError as exc:
        print(f"[infra-certs] 错误: {exc}", file=sys.stderr)
        raise SystemExit(1) from exc
