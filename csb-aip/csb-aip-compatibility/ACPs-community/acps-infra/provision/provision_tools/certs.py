"""证书管理：封装 acps-cli 证书命令，支持申请/续签/trust-bundle 更新。"""

from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
from typing import TYPE_CHECKING

from .acs import extract_aic
from .utils import SummaryTracker, log_error, log_info

if TYPE_CHECKING:
    from .agent_discover import AgentRecord
    from .config import RuntimeConfig


_TRUST_BUNDLE_FILENAME = "trust-bundle.pem"
_EAB_FILENAME = "eab.json"
_MQ_CERT_FILENAME = (
    os.environ.get("MQ_CLIENT_CERT_FILENAME")
    or os.environ.get("CLIENT_CERT_FILENAME")
    or "client.pem"
)
_MQ_KEY_FILENAME = (
    os.environ.get("MQ_CLIENT_KEY_FILENAME")
    or os.environ.get("CLIENT_KEY_FILENAME")
    or "client.key"
)
_MQ_EAB_FILENAME = "mq-client-eab.json"


def _resolve_cert_filename(usage: str) -> str:
    if usage == "serverAuth":
        return (
            os.environ.get("SERVER_CERT_FILENAME")
            or os.environ.get("AGENT_CERT_FILENAME")
            or "server.pem"
        )
    return (
        os.environ.get("CLIENT_CERT_FILENAME")
        or os.environ.get("AGENT_CERT_FILENAME")
        or "client.pem"
    )


def _resolve_key_filename(usage: str) -> str:
    if usage == "serverAuth":
        return (
            os.environ.get("SERVER_KEY_FILENAME")
            or os.environ.get("AGENT_KEY_FILENAME")
            or "server.key"
        )
    return (
        os.environ.get("CLIENT_KEY_FILENAME")
        or os.environ.get("AGENT_KEY_FILENAME")
        or "client.key"
    )


# ─── CLI 路径解析 ─────────────────────────────────────────────────────────────


def resolve_cert_cli(script_dir: str) -> str | None:
    """查找 acps-cli 可执行文件路径。

    Args:
        script_dir: scripts/ 目录路径，用于搜索本地 venv。

    Returns:
        可执行文件绝对路径；未找到返回 None。
    """
    explicit = os.environ.get("ACPS_CLI", "")
    candidates = [explicit] if explicit else []
    candidates += [
        "acps-cli",
        os.path.join(script_dir, ".venv", "bin", "acps-cli"),
        os.path.join(script_dir, "venv", "bin", "acps-cli"),
        "/opt/venv/bin/acps-cli",
    ]
    for c in candidates:
        if not c:
            continue
        if os.path.sep in c or c.startswith("."):
            normalized = os.path.normpath(c)
            if os.access(normalized, os.X_OK):
                return normalized
        else:
            found = shutil.which(c)
            if found:
                return found
    return None


# ─── 内部工具 ─────────────────────────────────────────────────────────────────


def _run_acps_cli(cmd: list[str], work_dir: str) -> tuple[bool, str]:
    """在指定目录执行 acps-cli 命令。

    Args:
        cmd: 完整命令列表。
        work_dir: 工作目录（acps-cli 会在此写入临时文件）。

    Returns:
        (成功标志, stdout+stderr 合并输出)。
    """
    os.makedirs(work_dir, exist_ok=True)
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            cwd=work_dir,
        )
        combined = (result.stdout + result.stderr).strip()
        return result.returncode == 0, combined
    except FileNotFoundError as exc:
        return False, str(exc)


def _run_acps_cli_without_cwd(cmd: list[str]) -> tuple[bool, str]:
    """执行不依赖工作目录的 acps-cli 命令。"""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        combined = (result.stdout + result.stderr).strip()
        return result.returncode == 0, combined
    except FileNotFoundError as exc:
        return False, str(exc)


def _extract_pem_blocks(pem_text: str) -> list[str]:
    """提取 PEM 证书块并标准化换行。"""
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


def _resolve_local_ca_chain_path(cert_dir: str) -> str | None:
    """尝试从当前交付/开发目录拓扑中定位本地 CA 链文件。"""
    explicit = os.environ.get("ACPS_CA_CHAIN_PATH") or os.environ.get("CA_CHAIN_PATH")
    candidates: list[Path] = []
    if explicit:
        candidates.append(Path(explicit))

    resolved_cert_dir = Path(cert_dir).resolve()
    candidates.append(resolved_cert_dir / "ca-server" / "certs" / "ca-chain.pem")
    for parent in resolved_cert_dir.parents:
        candidates.append(parent / "ca-server" / "certs" / "ca-chain.pem")

    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None


def _expand_trust_bundle_with_local_chain(
    trust_bundle_path: str, cert_dir: str
) -> None:
    """把本地 ca-chain.pem 合并进 trust bundle，补齐 Intermediate CA。"""
    chain_path = _resolve_local_ca_chain_path(cert_dir)
    if not chain_path or not os.path.isfile(trust_bundle_path):
        return

    with open(chain_path, encoding="utf-8") as f:
        chain_text = f.read()
    with open(trust_bundle_path, encoding="utf-8") as f:
        trust_text = f.read()

    merged_blocks: list[str] = []
    seen_blocks: set[str] = set()
    for pem_text in (chain_text, trust_text):
        for block in _extract_pem_blocks(pem_text):
            if block in seen_blocks:
                continue
            seen_blocks.add(block)
            merged_blocks.append(block)

    merged_text = "".join(merged_blocks)
    if not merged_text or merged_text == trust_text:
        return

    with open(trust_bundle_path, "w", encoding="utf-8") as f:
        f.write(merged_text)

    log_info(f"已合并本地 ca-chain.pem 到 trust-bundle: {chain_path}")


def _issue_certificate(
    *,
    name: str,
    action: str,
    usage: str,
    conf_path: str,
    acps_cli: str,
    cert_dir: str,
    aic: str,
    ca_work_dir: str,
    cert_filename: str,
    key_filename: str,
    eab_filename: str,
    failure_label: str,
) -> tuple[bool, str]:
    dest_cert = os.path.join(cert_dir, cert_filename)
    dest_key = os.path.join(cert_dir, key_filename)
    dest_trust = os.path.join(cert_dir, _TRUST_BUNDLE_FILENAME)
    eab_file = os.path.join(cert_dir, eab_filename)
    agent_ca_work_dir = os.path.join(ca_work_dir, f"{aic}-{usage}")

    get_eab_cmd = [
        acps_cli,
        "--config",
        conf_path,
        "cert",
        "eab",
        "fetch",
        "--aic",
        aic,
        "--output",
        eab_file,
        "--json",
    ]
    log_info(f"[{name}] 获取 EAB 凭证")
    ok, output = _run_acps_cli_without_cwd(get_eab_cmd)

    for line in output.splitlines():
        print(f"    {line}")

    if not ok:
        log_error(f"[{name}] 获取 EAB 凭证失败")
        return False, failure_label

    cmd = [
        acps_cli,
        "--config",
        conf_path,
        "cert",
        action,
        "--aic",
        aic,
        "--eab-file",
        eab_file,
        "--usage",
        usage,
        "--cert-path",
        dest_cert,
        "--key-path",
        dest_key,
        "--trust-bundle-path",
        dest_trust,
    ]
    log_info(f"[{name}] 获取证书 ({action}, usage={usage})")
    ok, output = _run_acps_cli(cmd, agent_ca_work_dir)

    for line in output.splitlines():
        print(f"    {line}")

    if not ok:
        log_error(f"[{name}] acps-cli 证书命令执行失败")
        return False, failure_label

    _expand_trust_bundle_with_local_chain(dest_trust, cert_dir)

    return True, ""


# ─── 主流程 ───────────────────────────────────────────────────────────────────


def process_cert(
    action: str,
    record: AgentRecord,
    conf_path: str,
    acps_cli: str,
    ca_work_dir: str,
    tracker: SummaryTracker,
) -> None:
    """为单个 agent 申请或续签证书。

    Args:
        action: 证书动作，"issue" 或 "renew"。
        record: 待处理的 AgentRecord。
        conf_path: CLI conf 文件路径。
        acps_cli: acps-cli 可执行路径。
        ca_work_dir: acps-cli 工作目录。
        tracker: 汇总计数器。
    """
    name = record.name
    acs_path = record.acs_json_path
    cert_dir = record.cert_dir

    aic = extract_aic(acs_path)
    if not aic:
        log_error(f"[{name}] ACS 中没有 AIC，无法申请证书")
        tracker.add_failure(f"{name}(缺少AIC)")
        return

    os.makedirs(cert_dir, exist_ok=True)
    ok, failure_label = _issue_certificate(
        name=name,
        action=action,
        usage=record.usage,
        conf_path=conf_path,
        acps_cli=acps_cli,
        cert_dir=cert_dir,
        aic=aic,
        ca_work_dir=ca_work_dir,
        cert_filename=_resolve_cert_filename(record.usage),
        key_filename=_resolve_key_filename(record.usage),
        eab_filename=_EAB_FILENAME,
        failure_label=f"{name}(证书失败)",
    )
    if not ok:
        tracker.add_failure(failure_label)
        return

    needs_mq_client_cert = bool(record.config_file) and record.usage == "serverAuth"
    if needs_mq_client_cert:
        ok, failure_label = _issue_certificate(
            name=f"{name}/mq",
            action=action,
            usage="clientAuth",
            conf_path=conf_path,
            acps_cli=acps_cli,
            cert_dir=cert_dir,
            aic=aic,
            ca_work_dir=ca_work_dir,
            cert_filename=_MQ_CERT_FILENAME,
            key_filename=_MQ_KEY_FILENAME,
            eab_filename=_MQ_EAB_FILENAME,
            failure_label=f"{name}(MQ证书失败)",
        )
        if not ok:
            tracker.add_failure(failure_label)
            return

    tracker.add_success()


def update_trust_bundle(
    records: list[AgentRecord],
    cfg: RuntimeConfig,
    acps_cli: str,
    ca_work_dir: str,
    tracker: SummaryTracker,
) -> None:
    """更新所有 agent 的 trust bundle。

    从 CA 获取最新 trust bundle 并复制到每个 agent 的证书目录。

    Args:
        records: 需要更新 trust bundle 的 AgentRecord 列表。
        cfg: 运行时配置。
        acps_cli: acps-cli 可执行路径。
        ca_work_dir: acps-cli 工作目录。
        tracker: 汇总计数器。
    """
    os.makedirs(ca_work_dir, exist_ok=True)
    temp_trust = os.path.join(ca_work_dir, _TRUST_BUNDLE_FILENAME)

    with cfg.runtime_conf_path() as conf_path:
        cmd = [
            acps_cli,
            "--config",
            conf_path,
            "cert",
            "trust-bundle",
            "update",
            "--output",
            temp_trust,
        ]
        ok, output = _run_acps_cli(cmd, ca_work_dir)

    for line in output.splitlines():
        print(f"    {line}")

    if not ok:
        log_error("trust-bundle 更新失败")
        tracker.add_failure("trust-bundle(更新失败)")
        return

    for record in records:
        os.makedirs(record.cert_dir, exist_ok=True)
        dest = os.path.join(record.cert_dir, _TRUST_BUNDLE_FILENAME)
        shutil.copy2(temp_trust, dest)
        _expand_trust_bundle_with_local_chain(dest, record.cert_dir)
        log_info(f"[{record.name}] trust-bundle 已更新")

    tracker.add_success()
