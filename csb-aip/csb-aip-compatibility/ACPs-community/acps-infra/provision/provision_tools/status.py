"""状态展示：显示 agent 本地文件状态与 registry 远程状态。"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

from .acs import extract_aic
from .utils import extract_json_field

if TYPE_CHECKING:
    from .agent_discover import AgentRecord
    from .config import RuntimeConfig


_TRUST_BUNDLE_FILENAME = "trust-bundle.pem"


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


def show_status(
    records: list[AgentRecord],
    cfg: RuntimeConfig,
    reg_cli: str | None = None,
    reg_admin_cli: str | None = None,
) -> None:
    """打印每个 agent 的本地状态，以及（若可用）registry 远程状态。

    Args:
        records: 待查询的 AgentRecord 列表。
        cfg: 运行时配置。
        reg_cli: acps-cli 可执行路径（可选；为 None 时跳过 registry 查询）。
        reg_admin_cli: acps-cli 可执行路径（可选，兼容旧签名保留）。
    """
    registry_available = False

    if reg_cli and reg_admin_cli:
        try:
            from .registry import _login, _run_cli
        except Exception:
            reg_cli = None  # 令后续跳过 registry 查询

    with cfg.runtime_conf_path() as conf_path:
        if reg_cli and reg_admin_cli:
            try:
                if _login(conf_path, reg_cli, reg_admin_cli):  # type: ignore[possibly-undefined]
                    registry_available = True
            except Exception:
                pass

        for record in records:
            cert_exists = os.path.isfile(
                os.path.join(record.cert_dir, _resolve_cert_filename(record.usage))
            )
            key_exists = os.path.isfile(
                os.path.join(record.cert_dir, _resolve_key_filename(record.usage))
            )
            trust_exists = os.path.isfile(
                os.path.join(record.cert_dir, _TRUST_BUNDLE_FILENAME)
            )
            local_aic = extract_aic(record.acs_json_path)

            print(f"[{record.name}]")
            print(f"  acs: {record.acs_json_path}")
            print(f"  local_aic: {local_aic or '<empty>'}")
            print(f"  cert: {cert_exists}")
            print(f"  key: {key_exists}")
            print(f"  trust_bundle: {trust_exists}")

            if registry_available and reg_cli:
                from .registry import _run_cli

                ok, check_out = _run_cli(
                    [
                        reg_cli,
                        "--config",
                        conf_path,
                        "check",
                        "--acs-file",
                        record.acs_json_path,
                        "--json",
                    ]
                )
                if ok:
                    check_status = extract_json_field(check_out, "status")
                    check_aic = extract_json_field(check_out, "aic")
                    print(f"  registry: {check_status}")
                    print(f"  registry_aic: {check_aic or '<empty>'}")
                else:
                    print("  registry: error")
