"""OpenTelemetry 分布式追踪配置。

通过 OTEL_EXPORTER_OTLP_ENDPOINT 环境变量控制是否启用追踪导出：
- 未设置：仅在本地记录 span（NoopTracerProvider 以外的默认 SDK provider），不导出
- 已设置：使用 OTLP HTTP 协议导出至指定 Collector 地址

structlog 集成：通过 add_otel_trace_context 处理器将 trace_id / span_id 注入日志。
"""

from __future__ import annotations

import os
from collections.abc import MutableMapping
from typing import Any

import structlog
from fastapi import FastAPI

logger = structlog.get_logger()

_TRACING_CONFIGURED = False
_HTTPX_INSTRUMENTED = False


def add_otel_trace_context(
    _logger: Any, _method: str, event_dict: MutableMapping[str, Any]
) -> MutableMapping[str, Any]:
    """structlog 处理器：将当前 OTel trace_id / span_id 注入日志事件。"""
    try:
        from opentelemetry import trace

        span = trace.get_current_span()
        ctx = span.get_span_context()
        if ctx.is_valid:
            event_dict["trace_id"] = format(ctx.trace_id, "032x")
            event_dict["span_id"] = format(ctx.span_id, "016x")
    except ImportError:
        pass
    return event_dict


def setup_tracing(
    app: FastAPI,
    *,
    service_name: str = "mq-auth-server",
    listener_name: str | None = None,
) -> None:
    """初始化 OpenTelemetry 追踪并绑定到指定 FastAPI app。

    Args:
        app: 需要注入 tracing middleware 的 FastAPI 应用。
        service_name: 服务名称，写入 OTel 资源属性 `service.name`。
        listener_name: 当前 listener 名称，用于日志标识。
    """
    global _HTTPX_INSTRUMENTED, _TRACING_CONFIGURED

    try:
        from opentelemetry import trace
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor
        from opentelemetry.instrumentation.httpx import HTTPXClientInstrumentor
        from opentelemetry.sdk.resources import SERVICE_NAME, Resource
        from opentelemetry.sdk.trace import TracerProvider
        from opentelemetry.sdk.trace.export import BatchSpanProcessor
    except ImportError:
        logger.warning(
            "otel_import_failed",
            reason="opentelemetry 依赖未安装，追踪功能已跳过",
            listener=listener_name,
        )
        return

    if not _TRACING_CONFIGURED:
        resource = Resource.create({SERVICE_NAME: service_name})
        provider = TracerProvider(resource=resource)

        endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT")
        if endpoint:
            try:
                from opentelemetry.exporter.otlp.proto.http.trace_exporter import (
                    OTLPSpanExporter,
                )

                exporter = OTLPSpanExporter(endpoint=f"{endpoint.rstrip('/')}/v1/traces")
                provider.add_span_processor(BatchSpanProcessor(exporter))
                logger.info(
                    "otel_tracing_enabled",
                    endpoint=endpoint,
                    service=service_name,
                    listener=listener_name,
                )
            except ImportError:
                logger.warning(
                    "otel_otlp_exporter_missing",
                    reason="opentelemetry-exporter-otlp-proto-http 未安装",
                    listener=listener_name,
                )
        else:
            logger.debug(
                "otel_tracing_no_exporter",
                reason="OTEL_EXPORTER_OTLP_ENDPOINT 未配置，span 不导出",
                listener=listener_name,
            )

        trace.set_tracer_provider(provider)
        _TRACING_CONFIGURED = True

    FastAPIInstrumentor.instrument_app(app)

    if not _HTTPX_INSTRUMENTED:
        HTTPXClientInstrumentor().instrument()
        _HTTPX_INSTRUMENTED = True

    logger.debug(
        "otel_listener_instrumented",
        listener=listener_name,
        app_title=app.title,
    )
