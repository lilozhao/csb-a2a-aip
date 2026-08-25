"""argparse CLI 入口：子命令分发与完整流程编排。"""

from __future__ import annotations

import argparse
import json
import os
import sys

from .agent_discover import (
    AgentRecord,
    discover_agents,
    resolve_default_leader_dir,
    resolve_default_partners_dir,
    select_agents,
)
from .certs import process_cert, resolve_cert_cli, update_trust_bundle
from .clean import run_clean_flow
from .config import (
    RuntimeConfig,
    derive_ca_trust_bundle_url,
    derive_registry_health_url,
)
from .discovery import (
    trigger_sync,
    query,
    verify_semantic_query,
    wait_for_query_state,
)
from .acs import extract_aic, has_skills
from .registry import (
    ensure_acps_cli_login,
    ensure_registry_login,
    resolve_acps_cli,
    run_register_flow,
    sync_metadata_for_cert_action,
)
from .status import show_status
from .utils import (
    SummaryTracker,
    ToolError,
    log_error,
    log_info,
    log_warn,
    probe_http_endpoint,
)

# ─── 默认值 ───────────────────────────────────────────────────────────────────

_DEFAULT_APPROVAL_COMMENTS = "通过 provision.sh 自动审批"
_DEFAULT_DISCOVERY_WAIT_TIMEOUT = int(
    os.environ.get("DISCOVERY_WAIT_TIMEOUT_SECONDS", "120")
)
_DEFAULT_DISCOVERY_WAIT_INTERVAL = int(
    os.environ.get("DISCOVERY_WAIT_INTERVAL_SECONDS", "5")
)


# ─── 上下文 ───────────────────────────────────────────────────────────────────


class Context:
    """命令执行上下文，封装全局参数和已解析的工具路径。

    Attributes:
        script_dir: provision_tools 包所在的 provision/ 目录。
        cfg: 运行时配置。
        container_mode: 是否在容器内运行。
        acps_cli: acps-cli 可执行路径（可能为 None）。
        ca_work_dir: acps-cli 证书子命令工作目录。
        leader_dir: leader 根目录。
        partners_dir: partners/online 目录。
    """

    def __init__(self, args: argparse.Namespace) -> None:
        self.script_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        self.container_mode = (
            os.environ.get("CONTAINER_MODE", "false").lower() == "true"
        )

        conf_path = (
            args.conf
            or os.environ.get("PROVISION_CONF")
            or os.path.join(self.script_dir, "provision.conf")
        )
        self.cfg = RuntimeConfig(
            conf_path=conf_path, container_mode=self.container_mode
        )

        self.acps_cli = resolve_acps_cli(self.script_dir) or resolve_cert_cli(
            self.script_dir
        )
        self.reg_cli = self.acps_cli
        self.reg_admin_cli = self.acps_cli
        self.ca_cli = self.acps_cli

        # ca-data 工作目录
        ca_work_dir = os.environ.get("CA_WORK_DIR", "")
        if not ca_work_dir:
            ca_work_dir = (
                "/app/ca-data"
                if self.container_mode
                else os.path.join(self.script_dir, ".ca-data")
            )
        self.ca_work_dir = ca_work_dir.rstrip("/")

        # agent 目录
        self.leader_dir = os.environ.get("LEADER_DIR") or resolve_default_leader_dir(
            self.script_dir, self.container_mode
        )
        self.partners_dir = os.environ.get(
            "PARTNERS_DIR"
        ) or resolve_default_partners_dir(self.script_dir, self.container_mode)

    def require_registry_cli(self) -> tuple[str, str]:
        """返回 registry/admin 复用的 acps-cli 路径，缺失时抛出 SystemExit。"""
        if not self.reg_cli or not self.reg_admin_cli:
            log_error("未找到 acps-cli，请安装 acps-cli 或设置 ACPS_CLI 环境变量")
            raise SystemExit(1)
        return self.reg_cli, self.reg_admin_cli

    def require_ca_cli(self) -> str:
        """返回 cert 子命令复用的 acps-cli 路径，缺失时抛出 SystemExit。"""
        if not self.ca_cli:
            log_error("未找到 acps-cli，请安装 acps-cli 或设置 ACPS_CLI 环境变量")
            raise SystemExit(1)
        return self.ca_cli

    def require_conf(self, command: str) -> None:
        """确保 conf 文件存在，否则抛出 SystemExit。"""
        if not os.path.isfile(self.cfg.conf_path):
            log_error(f"{command} 需要配置文件: {self.cfg.conf_path}")
            raise SystemExit(1)

    def discover_and_select(
        self, requested_names: list[str], tracker: SummaryTracker
    ) -> list[AgentRecord]:
        """发现并选择 agent，结果为空时提前退出。"""
        records = discover_agents(self.leader_dir, self.partners_dir)
        if not records:
            log_warn("未发现任何可处理的 agent")
            raise SystemExit(0)
        selected = select_agents(records, requested_names, tracker.add_skip)
        if not selected:
            log_warn("没有可处理的 agent")
            raise SystemExit(0)
        return selected


# ─── 前置检查 ─────────────────────────────────────────────────────────────────


def _validate_setup_prerequisites(ctx: Context, check_discovery: bool = True) -> None:
    """检查 setup 前置依赖服务的可达性。

    Args:
        ctx: 命令上下文。
        check_discovery: 是否检查 Discovery 网关。

    Raises:
        SystemExit: 任一检查失败时退出。
    """
    registry_url = ctx.cfg.registry_api_base_url()
    ca_url = ctx.cfg.ca_server_base_url()

    if not registry_url:
        log_error("conf 缺少 REGISTRY_API_BASE_URL")
        raise SystemExit(1)
    if not ca_url:
        log_error("conf 缺少 CA_SERVER_BASE_URL")
        raise SystemExit(1)

    log_info("检查 setup 前置依赖：Registry / CA 网关可达性")
    try:
        probe_http_endpoint(
            derive_registry_health_url(registry_url), "Registry Health", {200, 403}
        )
        probe_http_endpoint(
            derive_ca_trust_bundle_url(ca_url), "CA Trust Bundle", {200}
        )
    except ToolError as exc:
        log_error(str(exc))
        log_error("setup 前置依赖检查失败，请先修复上游 Registry / CA 部署状态")
        raise SystemExit(1)

    if check_discovery:
        discovery_url = ctx.cfg.discovery_gateway_url()
        log_info("检查 Discovery 网关可达性")
        try:
            probe_http_endpoint(
                f"{discovery_url}/health", "Discovery Health", {200, 404}
            )
        except ToolError as exc:
            log_warn(f"Discovery 网关暂不可达，将在同步阶段重试: {exc}")


# ─── 子命令实现 ───────────────────────────────────────────────────────────────


def cmd_setup(ctx: Context, args: argparse.Namespace) -> int:
    """注册 + 审批 + 证书 + discovery 同步验证（完整四服务 happy path）。"""
    ctx.require_conf("setup")
    reg_cli, _ = ctx.require_registry_cli()
    ca_cli = ctx.require_ca_cli()

    tracker = SummaryTracker()
    selected = ctx.discover_and_select(list(args.agents), tracker)

    _validate_setup_prerequisites(ctx, check_discovery=True)

    log_info("开始执行完整流程：注册 → 审批 → 证书 → Discovery 验证")

    with ctx.cfg.runtime_conf_path() as conf_path:
        if not ensure_registry_login(conf_path, reg_cli, tracker):
            tracker.print_summary()
            return tracker.exit_code or 1

        # Step 1: 注册/审批
        if not run_register_flow(
            records=selected,
            conf_path=conf_path,
            acps_cli=reg_cli,
            recreate=args.recreate,
            approval_comments=args.approval_comments,
            tracker=tracker,
        ):
            tracker.print_summary()
            return tracker.exit_code or 1

        # Step 2: 证书申请
        for record in selected:
            process_cert(
                action="issue",
                record=record,
                conf_path=conf_path,
                acps_cli=ca_cli,
                ca_work_dir=ctx.ca_work_dir,
                tracker=tracker,
            )

    # Step 3: Discovery DSP 同步
    discovery_url = ctx.cfg.discovery_gateway_url()
    log_info(f"触发 Discovery DSP 数据同步，网关: {discovery_url}")
    try:
        trigger_sync(discovery_url)
    except ToolError as exc:
        log_error(f"Discovery DSP 同步失败: {exc}")
        tracker.add_failure("discovery(DSP同步失败)")
        tracker.print_summary()
        return tracker.exit_code

    # Step 4: DB 过滤查询验证（取 leader 或第一个 agent 的 AIC）
    first_aic = ""
    for record in selected:
        if not has_skills(record.acs_json_path):
            continue
        aic = extract_aic(record.acs_json_path)
        if aic:
            first_aic = aic
            break

    if not first_aic:
        for record in selected:
            aic = extract_aic(record.acs_json_path)
            if aic:
                first_aic = aic
                break

    if first_aic:
        log_info(f"验证 discovery 过滤查询（AIC: {first_aic}）")
        try:
            wait_for_query_state(
                gateway_url=discovery_url,
                aic=first_aic,
                expected_active=True,
                timeout_seconds=_DEFAULT_DISCOVERY_WAIT_TIMEOUT,
                interval_seconds=_DEFAULT_DISCOVERY_WAIT_INTERVAL,
            )
            log_info("Discovery 过滤查询验证通过")
            tracker.add_success()
        except ToolError as exc:
            log_error(f"Discovery 过滤查询验证失败: {exc}")
            tracker.add_failure("discovery(过滤查询失败)")
    else:
        log_warn("未找到可用 AIC，跳过 discovery 过滤查询验证")

    # Step 5: 语义查询验证（失败仅告警）
    log_info("执行 Discovery 语义查询验证（依赖 LLM，失败为告警）")
    warnings = verify_semantic_query(discovery_url)
    for w in warnings:
        log_warn(f"Discovery 语义查询告警: {w}")
    if not warnings:
        log_info("Discovery 语义查询验证通过")

    tracker.print_summary()
    return tracker.exit_code


def cmd_register(ctx: Context, args: argparse.Namespace) -> int:
    """仅注册 + 审批（不申请证书）。"""
    ctx.require_conf("register")
    reg_cli, _ = ctx.require_registry_cli()

    tracker = SummaryTracker()
    selected = ctx.discover_and_select(list(args.agents), tracker)

    with ctx.cfg.runtime_conf_path() as conf_path:
        if not ensure_registry_login(conf_path, reg_cli, tracker):
            tracker.print_summary()
            return tracker.exit_code or 1

        if not run_register_flow(
            records=selected,
            conf_path=conf_path,
            acps_cli=reg_cli,
            recreate=args.recreate,
            approval_comments=args.approval_comments,
            tracker=tracker,
        ):
            tracker.print_summary()
            return tracker.exit_code or 1

    tracker.print_summary()
    return tracker.exit_code


def cmd_certs(ctx: Context, args: argparse.Namespace) -> int:
    """证书管理：new / renew / trust-bundle。"""
    ctx.require_conf("certs")
    ca_cli = ctx.require_ca_cli()

    tracker = SummaryTracker()
    selected = ctx.discover_and_select(list(args.agents), tracker)

    action = args.cert_action

    if action == "trust-bundle":
        update_trust_bundle(
            records=selected,
            cfg=ctx.cfg,
            acps_cli=ca_cli,
            ca_work_dir=ctx.ca_work_dir,
            tracker=tracker,
        )
    else:
        ca_action = "issue" if action == "new" else "renew"
        reg_cli = ctx.reg_cli

        if not reg_cli:
            log_error("证书申请需要 acps-cli，请安装 acps-cli 或设置 ACPS_CLI 环境变量")
            return 1

        with ctx.cfg.runtime_conf_path() as conf_path:
            if not ensure_acps_cli_login(conf_path, reg_cli, tracker):
                tracker.print_summary()
                return tracker.exit_code or 1

            for record in selected:
                if action == "renew":
                    sync_metadata_for_cert_action(
                        record=record,
                        conf_path=conf_path,
                        acps_cli=reg_cli,
                        tracker=tracker,
                    )
                process_cert(
                    action=ca_action,
                    record=record,
                    conf_path=conf_path,
                    acps_cli=ca_cli,
                    ca_work_dir=ctx.ca_work_dir,
                    tracker=tracker,
                )

    tracker.print_summary()
    return tracker.exit_code


def cmd_discovery_sync(ctx: Context, args: argparse.Namespace) -> int:
    """仅触发 Discovery DSP 数据同步。"""
    discovery_url = ctx.cfg.discovery_gateway_url()
    log_info(f"触发 Discovery DSP 数据同步，网关: {discovery_url}")
    try:
        trigger_sync(discovery_url)
        log_info("Discovery DSP 同步成功")
        return 0
    except ToolError as exc:
        log_error(str(exc))
        return 1


def cmd_discovery_query(ctx: Context, args: argparse.Namespace) -> int:
    """通用 discovery API 查询，原样输出 JSON 结果（供调用者自行检查）。"""

    discovery_url = ctx.cfg.discovery_gateway_url()

    try:
        payload = json.loads(args.payload)
    except json.JSONDecodeError as exc:
        log_error(f"--payload 不是合法 JSON: {exc}")
        return 1

    try:
        result = query(discovery_url, payload)
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except ToolError as exc:
        log_error(str(exc))
        return 1


def cmd_clean(ctx: Context, args: argparse.Namespace) -> int:
    """删除 registry 记录并清理本地证书/AIC。"""
    ctx.require_conf("clean")
    reg_cli, reg_admin_cli = ctx.require_registry_cli()

    tracker = SummaryTracker()
    selected = ctx.discover_and_select(list(args.agents), tracker)

    run_clean_flow(
        records=selected,
        cfg=ctx.cfg,
        reg_cli=reg_cli,
        reg_admin_cli=reg_admin_cli,
        tracker=tracker,
    )
    tracker.print_summary()
    return tracker.exit_code


def cmd_status(ctx: Context, args: argparse.Namespace) -> int:
    """查看 agent 本地状态与 registry 远程状态。"""
    tracker = SummaryTracker()
    selected = ctx.discover_and_select(list(args.agents), tracker)

    show_status(
        records=selected,
        cfg=ctx.cfg,
        reg_cli=ctx.reg_cli,
        reg_admin_cli=ctx.reg_admin_cli,
    )
    return 0


# ─── argparse 构建 ────────────────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="provision",
        description="demo-apps Provision 配置工具（registry / CA / discovery）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
示例:
    provision setup                        # 完整四服务 happy path
    provision setup --recreate leader      # 重建指定 agent
    provision register                     # 仅注册/审批
    provision certs new                    # 申请新证书
    provision certs renew                  # 续签证书
    provision certs trust-bundle           # 更新 trust bundle
    provision discovery-sync               # 仅触发 DSP 同步
    provision discovery-query --payload '{"type":"filtered","query":"","limit":5}'
    provision clean                        # 清理所有记录
    provision status                       # 查看状态
""",
    )
    parser.add_argument("--conf", metavar="PATH", help="指定 conf 文件路径")
    parser.add_argument(
        "--approval-comments",
        default=_DEFAULT_APPROVAL_COMMENTS,
        metavar="TEXT",
        help=f"审批备注（默认: {_DEFAULT_APPROVAL_COMMENTS}）",
    )

    sub = parser.add_subparsers(dest="command", title="命令")
    sub.required = True

    # setup
    p_setup = sub.add_parser(
        "setup", help="注册 + 审批 + 证书 + discovery 验证（完整）"
    )
    p_setup.add_argument(
        "--recreate", action="store_true", help="先删除已有记录再重新注册"
    )
    p_setup.add_argument(
        "agents", nargs="*", metavar="AGENT", help="仅处理指定 agent；默认处理全部"
    )

    # register
    p_register = sub.add_parser("register", help="仅注册 + 审批（不申请证书）")
    p_register.add_argument("--recreate", action="store_true")
    p_register.add_argument("agents", nargs="*", metavar="AGENT")

    # certs
    p_certs = sub.add_parser("certs", help="证书管理")
    p_certs.add_argument(
        "cert_action",
        choices=["new", "renew", "trust-bundle"],
        metavar="ACTION",
        help="new | renew | trust-bundle",
    )
    p_certs.add_argument("agents", nargs="*", metavar="AGENT")

    # certs 别名
    for alias in ("new", "renew", "trust-bundle"):
        p_alias = sub.add_parser(alias, help=f"certs {alias} 的别名")
        p_alias.add_argument("agents", nargs="*", metavar="AGENT")

    # discovery-sync
    sub.add_parser("discovery-sync", help="仅触发 Discovery DSP 数据同步")

    # discovery-query
    p_dq = sub.add_parser(
        "discovery-query", help="通用 discovery API 查询（返回原始 JSON）"
    )
    p_dq.add_argument(
        "--payload",
        required=True,
        metavar="JSON",
        help="符合 ADP discover API 格式的查询 payload",
    )

    # clean
    p_clean = sub.add_parser("clean", help="删除 registry 记录并清理本地证书")
    p_clean.add_argument("agents", nargs="*", metavar="AGENT")

    # status
    p_status = sub.add_parser("status", help="查看本地与 registry 状态")
    p_status.add_argument("agents", nargs="*", metavar="AGENT")

    return parser


# ─── 入口 ─────────────────────────────────────────────────────────────────────


def main(argv: list[str] | None = None) -> int:
    """CLI 主入口。

    Args:
        argv: 命令行参数列表；None 时使用 sys.argv[1:]。

    Returns:
        进程退出码。
    """
    parser = _build_parser()
    args = parser.parse_args(argv)

    # 处理别名：new / renew / trust-bundle → certs <action>
    if args.command in ("new", "renew", "trust-bundle"):
        args.cert_action = args.command
        args.command = "certs"

    # 为 certs/register/setup 补充缺省的 approval_comments
    if not hasattr(args, "approval_comments"):
        args.approval_comments = _DEFAULT_APPROVAL_COMMENTS

    ctx = Context(args)

    dispatch = {
        "setup": cmd_setup,
        "register": cmd_register,
        "certs": cmd_certs,
        "discovery-sync": cmd_discovery_sync,
        "discovery-query": cmd_discovery_query,
        "clean": cmd_clean,
        "status": cmd_status,
    }

    handler = dispatch.get(args.command)
    if handler is None:
        log_error(f"未知命令: {args.command}")
        return 1

    try:
        return handler(ctx, args)
    except SystemExit as exc:
        return int(exc.code) if exc.code is not None else 0
    except KeyboardInterrupt:
        return 130
