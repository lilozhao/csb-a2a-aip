"""Registry 注册/审批流程：封装 acps-cli 调用。"""

from __future__ import annotations

import os
import shutil
import subprocess
from typing import TYPE_CHECKING

from .acs import extract_aic
from .utils import SummaryTracker, extract_json_field, log_error, log_info, log_warn

if TYPE_CHECKING:
    from .agent_discover import AgentRecord


# ─── CLI 路径解析 ─────────────────────────────────────────────────────────────


def resolve_acps_cli(script_dir: str) -> str | None:
    """查找 acps-cli 可执行文件路径。

    Args:
        script_dir: scripts/ 目录路径，用于搜索本地 venv。

    Returns:
        可执行文件绝对路径；未找到返回 None。
    """
    explicit = os.environ.get("ACPS_CLI", "")
    candidates = [explicit] if explicit else []
    candidates += [
        "acps-cli",  # PATH
        os.path.join(script_dir, ".venv", "bin", "acps-cli"),
        os.path.join(script_dir, "venv", "bin", "acps-cli"),
        "/opt/venv/bin/acps-cli",
    ]
    for candidate in candidates:
        if not candidate:
            continue
        if os.path.sep in candidate or candidate.startswith("."):
            if os.access(candidate, os.X_OK):
                return candidate
        else:
            found = shutil.which(candidate)
            if found:
                return found
    return None


# ─── 内部工具 ─────────────────────────────────────────────────────────────────


def _run_cli(cmd: list[str]) -> tuple[bool, str]:
    """执行 CLI 命令，返回 (成功标志, stdout 输出)。"""
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
        if result.returncode == 0:
            return True, result.stdout.strip()
        combined = (result.stdout + result.stderr).strip()
        return False, combined
    except FileNotFoundError as exc:
        return False, str(exc)


def _login(conf_path: str, acps_cli: str) -> bool:
    """确保 acps-cli 的用户和管理员账号已登录。

    Args:
        conf_path: CLI conf 文件路径。
        acps_cli: acps-cli 可执行路径。

    Returns:
        登录是否成功。
    """
    ok1, _ = _run_cli([acps_cli, "--config", conf_path, "auth", "login", "--json"])
    ok2, _ = _run_cli(
        [acps_cli, "--config", conf_path, "admin", "auth", "login", "--json"]
    )
    return ok1 and ok2


def ensure_acps_cli_login(
    conf_path: str,
    acps_cli: str,
    tracker: SummaryTracker | None = None,
) -> bool:
    """确保 acps-cli 用户账号已登录。"""
    ok, _ = _run_cli([acps_cli, "--config", conf_path, "auth", "login", "--json"])
    if ok:
        return True

    log_error("registry 用户账号检查失败")
    if tracker is not None:
        tracker.add_failure("registry(用户账号检查失败)")
    return False


def ensure_registry_login(
    conf_path: str,
    acps_cli: str,
    tracker: SummaryTracker | None = None,
) -> bool:
    """确保 acps-cli 的用户和管理员账号均已登录。"""
    if _login(conf_path, acps_cli):
        return True

    log_error("registry 账号检查失败")
    if tracker is not None:
        tracker.add_failure("registry(账号检查失败)")
    return False


# ─── 主流程 ───────────────────────────────────────────────────────────────────


def run_register_flow(
    records: list[AgentRecord],
    conf_path: str,
    acps_cli: str,
    recreate: bool,
    approval_comments: str,
    tracker: SummaryTracker,
) -> bool:
    """执行 agent 注册/审批完整流程。

        流程：agent check → agent save(draft) → admin registry agent enable(if disabled) →
            agent submit(pending) → admin registry review approve → agent sync（写回 AIC）。

    Args:
        records: 待处理的 AgentRecord 列表。
        conf_path: CLI conf 文件路径。
        acps_cli: acps-cli 路径。
        recreate: 是否先删除已有记录重新注册。
        approval_comments: 审批备注文字。
        tracker: 汇总计数器。

    Returns:
        执行完成返回 True（各 agent 的成败通过 tracker 记录）。
    """
    for record in records:
        _register_one(
            record=record,
            conf_path=conf_path,
            acps_cli=acps_cli,
            recreate=recreate,
            approval_comments=approval_comments,
            tracker=tracker,
        )

    return True


def _register_one(
    record: AgentRecord,
    conf_path: str,
    acps_cli: str,
    recreate: bool,
    approval_comments: str,
    tracker: SummaryTracker,
) -> None:
    """处理单个 agent 的注册/审批流程。"""
    name = record.name
    acs_path = record.acs_json_path

    def _delete_existing_agent_record() -> None:
        _run_cli(
            [
                acps_cli,
                "--config",
                conf_path,
                "agent",
                "delete",
                "--acs-file",
                acs_path,
                "--json",
            ]
        )

        from .acs import clear_state

        clear_state(acs_path, record.cert_dir)

    if recreate:
        log_info(f"[{name}] 删除已有 registry 记录并清理本地状态")
        _delete_existing_agent_record()

    # 先 upsert 当前 ACS，确保 endpoint / 证书 SAN 等 metadata 真正写入 registry。
    ok, upsert_out = _run_cli(
        [
            acps_cli,
            "--config",
            conf_path,
            "agent",
            "save",
            "--acs-file",
            acs_path,
            "--json",
        ]
    )
    if not ok:
        if (not recreate) and "APPROVED status cannot be updated" in upsert_out:
            log_warn(f"[{name}] 已审批 Agent 不允许直接更新，自动删除并按当前 ACS 重建")
            _delete_existing_agent_record()
            ok, upsert_out = _run_cli(
                [
                    acps_cli,
                    "--config",
                    conf_path,
                    "agent",
                    "save",
                    "--acs-file",
                    acs_path,
                    "--json",
                ]
            )

        if not ok:
            log_error(f"[{name}] 保存 ACS metadata 失败: {upsert_out}")
            tracker.add_failure(f"{name}(注册失败)")
            return

    current_status = (extract_json_field(upsert_out, "approval_status") or "").lower()
    is_disabled = extract_json_field(upsert_out, "is_disabled")
    agent_id = extract_json_field(upsert_out, "agent_id")

    if not current_status or not agent_id:
        ok, check_out = _run_cli(
            [
                acps_cli,
                "--config",
                conf_path,
                "agent",
                "check",
                "--acs-file",
                acs_path,
                "--json",
            ]
        )
        if not ok:
            log_error(f"[{name}] 查询 registry 状态失败: {check_out}")
            tracker.add_failure(f"{name}(状态查询失败)")
            return
        current_status = (
            extract_json_field(check_out, "status") or current_status
        ).lower()
        is_disabled = extract_json_field(check_out, "is_disabled") or is_disabled
        agent_id = extract_json_field(check_out, "agent_id") or agent_id

    if current_status not in ("draft", "pending", "approved"):
        log_error(f"[{name}] 不支持的 registry 状态: {current_status}")
        tracker.add_failure(f"{name}(状态异常)")
        return

    if not agent_id:
        log_error(f"[{name}] 未获取到 agent_id")
        tracker.add_failure(f"{name}(缺少ID)")
        return

    # 恢复 disabled 状态
    if is_disabled == "true":
        log_warn(f"[{name}] 当前处于 disabled 状态，自动恢复为 enabled")
        ok, enable_out = _run_cli(
            [
                acps_cli,
                "--config",
                conf_path,
                "admin",
                "registry",
                "agent",
                "enable",
                "--agent-id",
                agent_id,
                "--json",
            ]
        )
        if not ok or extract_json_field(enable_out, "is_disabled") != "false":
            log_error(f"[{name}] 自动 enable 失败或状态未变更")
            tracker.add_failure(f"{name}(自动启用失败)")
            return

    # 提交审批
    if current_status == "draft":
        ok, submit_out = _run_cli(
            [
                acps_cli,
                "--config",
                conf_path,
                "agent",
                "submit",
                "--agent-id",
                agent_id,
                "--json",
            ]
        )
        if not ok:
            log_error(f"[{name}] 提交审批失败: {submit_out}")
            tracker.add_failure(f"{name}(提交失败)")
            return
        current_status = extract_json_field(submit_out, "approval_status")

    # 管理员审批
    if current_status.upper() == "PENDING":
        ok, approve_out = _run_cli(
            [
                acps_cli,
                "--config",
                conf_path,
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
        if not ok:
            log_error(f"[{name}] 审批失败: {approve_out}")
            tracker.add_failure(f"{name}(审批失败)")
            return
        current_status = extract_json_field(approve_out, "approval_status")

    if current_status.upper() != "APPROVED":
        log_error(f"[{name}] Agent 未进入 APPROVED 状态: {current_status}")
        tracker.add_failure(f"{name}(未审批)")
        return

    # 同步 ACS metadata（写回 AIC）
    ok, sync_out = _run_cli(
        [
            acps_cli,
            "--config",
            conf_path,
            "agent",
            "sync",
            "--acs-file",
            acs_path,
            "--json",
        ]
    )
    if not ok:
        log_error(f"[{name}] ACS metadata 同步失败: {sync_out}")
        tracker.add_failure(f"{name}(ACS同步失败)")
        return

    sync_status = extract_json_field(sync_out, "status")
    sync_aic = extract_json_field(sync_out, "aic")
    log_info(f"[{name}] registry 状态: {sync_status}, AIC: {sync_aic}")
    tracker.add_success()


def sync_metadata_for_cert_action(
    record: AgentRecord,
    conf_path: str,
    acps_cli: str,
    tracker: SummaryTracker,
) -> bool:
    """renew 证书前，检查本地 AIC 是否与 registry 一致，必要时自动同步。

    Args:
        record: 待检查的 AgentRecord。
        conf_path: CLI conf 文件路径。
        acps_cli: acps-cli 路径。
        tracker: 汇总计数器（仅失败时记录）。

    Returns:
        成功或无需同步返回 True，同步失败返回 False。
    """
    name = record.name
    acs_path = record.acs_json_path

    local_aic = extract_aic(acs_path)

    ok, check_out = _run_cli(
        [
            acps_cli,
            "--config",
            conf_path,
            "agent",
            "check",
            "--acs-file",
            acs_path,
            "--json",
        ]
    )
    if not ok:
        return True

    registry_aic = extract_json_field(check_out, "aic")
    if not registry_aic or registry_aic == local_aic:
        return True

    log_warn(
        f"[{name}] 本地 AIC ({local_aic or '<empty>'}) 与 registry AIC "
        f"({registry_aic}) 不一致，自动同步 ACS metadata"
    )

    ok, sync_out = _run_cli(
        [
            acps_cli,
            "--config",
            conf_path,
            "agent",
            "sync",
            "--acs-file",
            acs_path,
            "--json",
        ]
    )
    if not ok:
        log_error(f"[{name}] 自动同步 ACS metadata 失败: {sync_out}")
        tracker.add_failure(f"{name}(ACS同步失败)")
        return False

    sync_status = extract_json_field(sync_out, "status")
    sync_aic = extract_json_field(sync_out, "aic")
    log_info(
        f"[{name}] ACS metadata 已同步，registry 状态: {sync_status}, AIC: {sync_aic}"
    )
    return True
