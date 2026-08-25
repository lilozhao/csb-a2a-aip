"""OpenTelemetry 初始化。"""

from typing import TYPE_CHECKING

import structlog
from fastapi import FastAPI

from app.core.db_session import async_engine

if TYPE_CHECKING:
    from app.core.config import Settings

logger = structlog.get_logger(__name__)


def init_otel(settings: Settings, app: FastAPI) -> None:
    """在显式启用时初始化 OpenTelemetry。"""
    if not settings.otel_enabled:
        logger.debug("已禁用 OpenTelemetry", enabled=settings.otel_enabled)
        return

    from opentelemetry import trace
    from opentelemetry.exporter.otlp.proto.grpc.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor

    resource = Resource.create(
        {
            "service.name": settings.otel_service_name,
            "service.version": settings.project_version,
        }
    )
    provider = TracerProvider(resource=resource)

    exporter = OTLPSpanExporter(endpoint=settings.otel_endpoint)
    provider.add_span_processor(BatchSpanProcessor(exporter))
    trace.set_tracer_provider(provider)
    logger.info("已初始化 OTel TracerProvider", endpoint=settings.otel_endpoint)

    try:
        from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

        FastAPIInstrumentor().instrument_app(app)
        logger.info("已启用 FastAPI instrumentation")
    except Exception as exc:
        logger.warning("初始化 FastAPI instrumentation 失败", error=str(exc))

    try:
        from opentelemetry.instrumentation.sqlalchemy import SQLAlchemyInstrumentor

        SQLAlchemyInstrumentor().instrument(engine=async_engine.sync_engine)
        logger.info("已启用 SQLAlchemy instrumentation")
    except Exception as exc:
        logger.warning("初始化 SQLAlchemy instrumentation 失败", error=str(exc))
