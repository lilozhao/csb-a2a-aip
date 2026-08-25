"""Agent 目录发现与记录选择。"""

from __future__ import annotations

import os
from collections.abc import Callable
from dataclasses import dataclass

from .utils import log_warn

# ─── AgentRecord ──────────────────────────────────────────────────────────────


@dataclass(frozen=True)
class AgentRecord:
    """代表一个可操作的 agent 的文件系统记录。

    Attributes:
        name: agent 名称（如 "leader" / "beijing_food"）。
        acs_json_path: acs.json 文件的绝对路径。
        cert_dir: 证书目录的绝对路径。
        config_file: 可选的 config.toml 路径（partner 专用）。
        usage: 证书 EKU 用途（clientAuth / serverAuth）。
    """

    name: str
    acs_json_path: str
    cert_dir: str
    config_file: str = ""
    usage: str = "clientAuth"


# ─── 目录自动发现 ──────────────────────────────────────────────────────────────


def resolve_default_leader_dir(script_dir: str, container_mode: bool) -> str:
    """推断 leader 根目录。

    Args:
        script_dir: provision.sh 所在目录（或包含 provision_tools/ 的目录）。
        container_mode: 是否在容器内运行。

    Returns:
        leader 目录路径。
    """
    if container_mode:
        return "/app/leader"

    candidates = [
        os.path.join(script_dir, "leader"),
        os.path.join(script_dir, "..", "..", "demo-leader", "leader"),
        os.path.join(script_dir, "..", "..", "demo-leader"),
        os.path.join(script_dir, "..", "leader", "leader"),
        os.path.join(script_dir, "..", "leader"),
    ]
    for c in candidates:
        if os.path.isdir(c):
            return os.path.abspath(c)
    return os.path.join(script_dir, "leader")


def resolve_default_partners_dir(script_dir: str, container_mode: bool) -> str:
    """推断 partners/online 目录。

    Args:
        script_dir: provision.sh 所在目录。
        container_mode: 是否在容器内运行。

    Returns:
        partners/online 目录路径。
    """
    if container_mode:
        return "/app/partners/online"

    candidates = [
        os.path.join(script_dir, "partners", "online"),
        os.path.join(script_dir, "..", "..", "demo-partner", "partners", "online"),
        os.path.join(script_dir, "..", "partners", "partners", "online"),
        os.path.join(script_dir, "..", "partners", "online"),
    ]
    for c in candidates:
        if os.path.isdir(c):
            return os.path.abspath(c)
    return os.path.join(script_dir, "partners", "online")


def discover_agents(leader_dir: str, partners_dir: str) -> list[AgentRecord]:
    """扫描文件系统，发现所有可操作的 agent。

    Args:
        leader_dir: leader 根目录（含 atr/acs.json）。
        partners_dir: partners/online 目录。

    Returns:
        AgentRecord 列表。leader 排在首位（如存在），其后为按名称排序的 partner。
    """
    records: list[AgentRecord] = []

    leader_acs = os.path.join(leader_dir, "atr", "acs.json")
    if os.path.isfile(leader_acs):
        records.append(
            AgentRecord(
                name="leader",
                acs_json_path=os.path.abspath(leader_acs),
                cert_dir=os.path.abspath(os.path.join(leader_dir, "atr")),
                config_file="",
                usage="clientAuth",
            )
        )

    if os.path.isdir(partners_dir):
        for entry in sorted(os.listdir(partners_dir)):
            partner_dir = os.path.join(partners_dir, entry)
            if not os.path.isdir(partner_dir):
                continue
            acs_json = os.path.join(partner_dir, "acs.json")
            if os.path.isfile(acs_json):
                config_toml = os.path.join(partner_dir, "config.toml")
                records.append(
                    AgentRecord(
                        name=entry,
                        acs_json_path=os.path.abspath(acs_json),
                        cert_dir=os.path.abspath(partner_dir),
                        config_file=(
                            os.path.abspath(config_toml)
                            if os.path.isfile(config_toml)
                            else ""
                        ),
                        usage="serverAuth",
                    )
                )

    return records


def select_agents(
    records: list[AgentRecord],
    requested_names: list[str],
    tracker_add_skip: Callable[[], None] | None = None,
) -> list[AgentRecord]:
    """根据名称列表过滤 agent 记录。

    Args:
        records: discover_agents() 返回的完整列表。
        requested_names: 用户指定的 agent 名称列表；空列表表示选全部。
        tracker_add_skip: 可选的 SummaryTracker.add_skip 回调，未发现 agent 时调用。

    Returns:
        匹配到的 AgentRecord 列表；保留原始顺序。
    """
    if not requested_names:
        return list(records)

    name_map = {r.name: r for r in records}
    selected: list[AgentRecord] = []
    for name in requested_names:
        if name in name_map:
            selected.append(name_map[name])
        else:
            log_warn(f"未发现 agent: {name}")
            if callable(tracker_add_skip):
                tracker_add_skip()

    return selected
