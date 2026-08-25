"""服务健康与运行时状态输出。"""

from __future__ import annotations

from typing import TYPE_CHECKING

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from app.core.base_exception import CoreErrorCode, build_problem_details
from app.core.config import settings
from app.core.database import get_async_session_context
from app.core.lifespan import get_runtime_services_snapshot

if TYPE_CHECKING:
    from fastapi import FastAPI

PROMETHEUS_CONTENT_TYPE = "text/plain; version=0.0.4; charset=utf-8"


def build_root_status(app: FastAPI) -> dict[str, object]:
    """构造根健康探针返回体。"""

    payload: dict[str, object] = {
        "status": "healthy",
        "service": settings.APP_NAME,
        "version": settings.APP_VERSION,
        "description": settings.APP_DESC,
    }

    runtime = get_runtime_services_snapshot(app)
    if runtime is not None:
        payload["runtime"] = runtime

    return payload


def build_health_status() -> dict[str, str]:
    """构造轻量级存活探针返回体。"""

    return {"status": "ok"}


async def check_database_ready() -> bool:
    """检查数据库是否可用于就绪探针。"""

    try:
        async with get_async_session_context() as session:
            await session.execute(text("SELECT 1"))
    except SQLAlchemyError:
        return False
    return True


def build_ready_status(is_ready: bool) -> tuple[int, dict[str, object]]:
    """构造 `/ready` 返回体。"""

    if is_ready:
        return 200, {"status": "ready"}

    return 503, build_problem_details(
        status=503,
        title="Service not ready",
        detail="Database connectivity check failed",
        type_="urn:acps:error:operations:service-not-ready",
        extensions={"error_name": CoreErrorCode.SERVICE_NOT_READY},
    )


def build_metrics_payload(app: FastAPI, *, database_ready: bool) -> str:
    """构造 Prometheus 文本格式的最小指标集。"""

    lines = [
        "# HELP discovery_server_up Discovery server process status.",
        "# TYPE discovery_server_up gauge",
        "discovery_server_up 1",
        "# HELP discovery_server_database_ready Database readiness status.",
        "# TYPE discovery_server_database_ready gauge",
        f"discovery_server_database_ready {1 if database_ready else 0}",
    ]

    runtime = get_runtime_services_snapshot(app)
    if runtime is None:
        return "\n".join(lines) + "\n"

    service_metrics = {
        "semantic_matcher": "discovery_server_semantic_matcher_running",
        "dsp_sync": "discovery_server_dsp_sync_running",
        "forwarder_health_check": "discovery_server_forwarder_health_check_running",
        "available_agents_polling": "discovery_server_available_agents_polling_running",
    }

    for runtime_key, metric_name in service_metrics.items():
        runtime_value = runtime.get(runtime_key)
        if isinstance(runtime_value, dict):
            lines.extend(
                [
                    f"# HELP {metric_name} Runtime background service status.",
                    f"# TYPE {metric_name} gauge",
                    f"{metric_name} {1 if runtime_value.get('running') else 0}",
                ]
            )

    numeric_metrics = {
        "discovery_server_total_active_agents": runtime.get("total_active_agents", 0),
        "discovery_server_available_agents_count": runtime.get("available_agents_count", 0),
    }
    for metric_name, value in numeric_metrics.items():
        metric_value = value if isinstance(value, int | float) else 0
        lines.extend(
            [
                f"# HELP {metric_name} Runtime agent availability count.",
                f"# TYPE {metric_name} gauge",
                f"{metric_name} {int(metric_value)}",
            ]
        )

    return "\n".join(lines) + "\n"
