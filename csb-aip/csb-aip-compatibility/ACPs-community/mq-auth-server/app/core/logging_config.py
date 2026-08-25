"""日志配置：structlog stdlib 集成，JSON/Console 双模式，含 OTel trace_id 注入。"""

from __future__ import annotations

import logging

import structlog

from app.core.tracing import add_otel_trace_context


def setup_logging(level: str = "INFO", log_format: str = "json") -> None:
    """初始化全局日志配置（structlog stdlib 集成）。

    Args:
        level: 日志级别字符串，如 "INFO"、"DEBUG"。
        log_format: 格式类型，"json" 使用结构化 JSON，其他值使用 Console 渲染。
    """
    structlog.configure(
        processors=[
            structlog.contextvars.merge_contextvars,
            add_otel_trace_context,
            structlog.stdlib.add_log_level,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.TimeStamper(fmt="iso"),
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
    )

    render_processor: structlog.types.Processor = (
        structlog.processors.JSONRenderer() if log_format == "json" else structlog.dev.ConsoleRenderer()
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            render_processor,
        ],
    )

    handler = logging.StreamHandler()
    handler.setFormatter(formatter)

    numeric_level = getattr(logging, level.upper(), logging.INFO)
    root_logger = logging.getLogger()
    root_logger.setLevel(numeric_level)
    root_logger.handlers.clear()
    root_logger.addHandler(handler)
