"""清理流程：删除 registry 记录并清理本地证书文件。"""

from __future__ import annotations

from typing import TYPE_CHECKING

from .acs import clear_state
from .utils import SummaryTracker, log_info, log_warn

if TYPE_CHECKING:
    from .agent_discover import AgentRecord
    from .config import RuntimeConfig


def run_clean_flow(
    records: list[AgentRecord],
    cfg: RuntimeConfig,
    reg_cli: str,
    reg_admin_cli: str,
    tracker: SummaryTracker,
) -> bool:
    """删除 registry 中的 agent 记录并清理本地证书/AIC 状态。

    Args:
        records: 待清理的 AgentRecord 列表。
        cfg: 运行时配置。
        reg_cli: acps-cli 可执行路径。
        reg_admin_cli: acps-cli 可执行路径（用于登录验证，兼容旧签名保留）。
        tracker: 汇总计数器。

    Returns:
        账号登录失败时返回 False，否则返回 True。
    """
    from .registry import _login, _run_cli  # 复用内部工具

    with cfg.runtime_conf_path() as conf_path:
        if not _login(conf_path, reg_cli, reg_admin_cli):
            log_warn("registry 账号检查失败，仅执行本地清理")
            # 不阻塞本地清理

        for record in records:
            ok, out = _run_cli(
                [
                    reg_cli,
                    "--config",
                    conf_path,
                    "delete",
                    "--acs-file",
                    record.acs_json_path,
                    "--json",
                ]
            )
            if ok:
                log_info(f"[{record.name}] registry 记录已删除或原本不存在")
            else:
                log_warn(f"[{record.name}] registry 删除失败，继续清理本地文件")

            clear_state(record.acs_json_path, record.cert_dir)
            tracker.add_success()

    return True
