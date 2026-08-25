"""
Partner Agent 多进程启动入口

每个 partner agent 独立运行在自己的端口上，使用各自 config.toml 中的配置。
支持可选的 mTLS（服务端 HTTPS + 客户端证书验证）。

用法：
    # 启动所有 online 目录下的 partner（每个独立端口）
    python -m partners.main

    # 仅启动指定 partner
    python -m partners.main beijing_food
"""

import multiprocessing
import signal
import sys
import tomllib
from collections.abc import AsyncGenerator
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import structlog
from fastapi import FastAPI, HTTPException

try:
    from partners.generic_runner import GenericRunner
    from partners.group_handler import GroupHandler
    from partners.utils import (
        CONFIG_FILENAME,
        build_client_ssl_context,
        build_uvicorn_ssl_kwargs,
        check_process_health,
        discover_agents,
        read_agent_port,
        terminate_processes,
        validate_ports,
    )
except ImportError:
    from .generic_runner import GenericRunner
    from .group_handler import GroupHandler
    from .utils import (
        CONFIG_FILENAME,
        build_client_ssl_context,
        build_uvicorn_ssl_kwargs,
        check_process_health,
        discover_agents,
        read_agent_port,
        terminate_processes,
        validate_ports,
    )

from acps_sdk.aip.aip_group_model import RabbitMQRequest, RabbitMQResponse
from acps_sdk.aip.aip_rpc_model import RpcRequest, RpcResponse

logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# 单 Agent 的 FastAPI 应用工厂
# ---------------------------------------------------------------------------


def create_agent_app(agent_name: str, agent_path: str) -> FastAPI:
    """为单个 partner agent 创建 FastAPI 应用实例。"""

    runner: GenericRunner | None = None
    group_handler: GroupHandler | None = None

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncGenerator[None]:
        nonlocal runner, group_handler
        config_path = Path(agent_path) / CONFIG_FILENAME
        with config_path.open("rb") as f:
            config = tomllib.load(f)
        server_cfg = config.get("server", {})
        rabbitmq_cfg = config.get("rabbitmq", {})
        mq_ssl_context = build_client_ssl_context(agent_path, server_cfg)
        runner = GenericRunner(agent_name, agent_path)
        group_handler = GroupHandler(
            agent_name,
            runner,
            rabbitmq_config=rabbitmq_cfg,
            ssl_context=mq_ssl_context,
        )
        await group_handler.start()
        logger.info("Agent loaded", agent=agent_name)
        yield
        if group_handler:
            await group_handler.shutdown()
        logger.info("Agent shutdown complete", agent=agent_name)

    app = FastAPI(lifespan=lifespan, title=f"Partner: {agent_name}")

    # ---- RPC 端点 ----
    @app.post("/rpc", response_model=RpcResponse)
    async def rpc_endpoint(request: RpcRequest) -> RpcResponse:
        if runner is None:
            raise HTTPException(status_code=503, detail="Runner not ready")
        return await runner.dispatch(request)

    @app.post("/group/rpc", response_model=RabbitMQResponse)
    async def group_rpc_endpoint(request: RabbitMQRequest) -> RabbitMQResponse:
        """群组模式 RPC 端点，用于处理群组邀请（joinGroup）请求"""
        if group_handler is None:
            raise HTTPException(status_code=503, detail="Group handler not ready")
        return await group_handler.handle_group_rpc(request)

    @app.get("/health")
    async def health_check() -> dict[str, Any]:
        return {
            "agent": agent_name,
            "status": "online",
            "tasks": {
                "active": len(runner.tasks) if runner is not None else 0,
            },
            "groups": {
                "active": len(group_handler.active_groups) if group_handler else 0,
            },
        }

    return app


# ---------------------------------------------------------------------------
# 单 Agent 进程入口
# ---------------------------------------------------------------------------


def run_agent_process(agent_name: str, agent_path: str) -> None:
    """在独立进程中启动单个 partner agent 的 uvicorn 服务。"""
    import uvicorn

    config_path = Path(agent_path) / CONFIG_FILENAME
    with config_path.open("rb") as f:
        config = tomllib.load(f)

    server_cfg = config.get("server", {})
    host = server_cfg.get("host", "0.0.0.0")
    port = server_cfg.get("port", 9021)

    app = create_agent_app(agent_name, agent_path)

    # 构建 uvicorn SSL 参数（如果启用 TLS）
    ssl_kwargs = build_uvicorn_ssl_kwargs(agent_path, server_cfg)

    protocol = "https" if ssl_kwargs else "http"
    mtls_cfg = server_cfg.get("mtls", {})
    verify_info = ""
    if ssl_kwargs and mtls_cfg.get("verify_client", False):
        verify_info = ", client-cert=required"
    logger.info(
        "Starting agent",
        agent=agent_name,
        protocol=protocol,
        host=host,
        port=port,
        verify_info=verify_info,
    )

    uvicorn_kwargs = {
        "host": host,
        "port": port,
        "log_level": config.get("log", {}).get("level", "info").lower(),
        **ssl_kwargs,
    }

    uvicorn.run(app, **uvicorn_kwargs)


# ---------------------------------------------------------------------------
# 主入口：发现所有 agent 并启动各自进程
# ---------------------------------------------------------------------------


def _spawn_processes(agents: dict[str, str]) -> dict[str, multiprocessing.Process]:
    """为每个 agent 启动独立子进程。"""
    processes: dict[str, multiprocessing.Process] = {}
    for name, path in agents.items():
        p = multiprocessing.Process(
            target=run_agent_process,
            args=(name, path),
            name=f"partner-{name}",
            daemon=True,
        )
        p.start()
        processes[name] = p
        logger.info("Process started", agent=name, pid=p.pid)
    return processes


def _wait_and_monitor(processes: dict[str, multiprocessing.Process]) -> None:
    """监控所有子进程，任一异常退出则终止全部。"""
    import time

    def shutdown_all(signum: int | None = None, frame: object = None) -> None:
        logger.info("Shutting down all partner processes...")
        terminate_processes(processes)

    signal.signal(signal.SIGTERM, shutdown_all)
    signal.signal(signal.SIGINT, shutdown_all)

    try:
        while True:
            check_process_health(processes, shutdown_all)
            time.sleep(1)
    except KeyboardInterrupt:
        shutdown_all()
        raise SystemExit(0) from None


def main() -> None:
    filter_names = sys.argv[1:] if len(sys.argv) > 1 else None
    agents = discover_agents(filter_names)

    if not agents:
        logger.error("No agents found in online directory")
        sys.exit(1)

    validate_ports(agents)

    logger.info("Discovered agents", count=len(agents), agents=list(agents.keys()))
    for name, path in agents.items():
        logger.info("Agent config", agent=name, port=read_agent_port(path))

    processes = _spawn_processes(agents)
    _wait_and_monitor(processes)


if __name__ == "__main__":
    main()
