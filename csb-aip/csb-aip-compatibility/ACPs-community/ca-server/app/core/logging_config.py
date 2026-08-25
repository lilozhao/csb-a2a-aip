"""日志配置：structlog 双模式（开发 Console / 生产 JSON）。

通过 setup_logging(level, log_format) 初始化全局日志。
开发环境使用 ConsoleRenderer（可读文本），生产环境使用 JSONRenderer（结构化 JSON）。
日志格式由 settings.log_format 控制（"json" / "console"）。
"""

import logging

import structlog
from structlog.types import EventDict, WrappedLogger


def _ensure_request_context(_logger: WrappedLogger, _method: str, event_dict: EventDict) -> EventDict:
    """为日志事件补齐请求上下文字段"""
    event_dict.setdefault("request_id", "")
    event_dict.setdefault("trace_id", "")
    event_dict.setdefault("span_id", "")
    return event_dict


def setup_logging(level: str = "INFO", log_format: str = "json") -> None:
    """初始化全局日志配置（structlog stdlib 集成）。

    Args:
        level: 日志级别字符串，如 "INFO"、"DEBUG"。
        log_format: 格式类型，"json" 使用结构化 JSON，其他值使用 Console 渲染。
    """
    shared_processors: list[structlog.types.Processor] = [
        structlog.contextvars.merge_contextvars,
        _ensure_request_context,
        structlog.stdlib.add_log_level,
        structlog.stdlib.add_logger_name,
        structlog.processors.TimeStamper(fmt="iso"),
    ]

    use_json_renderer = log_format == "json"
    processors: list[structlog.types.Processor] = [
        *shared_processors,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.StackInfoRenderer(),
    ]
    if use_json_renderer:
        processors.append(structlog.processors.format_exc_info)
    processors.append(structlog.stdlib.ProcessorFormatter.wrap_for_formatter)

    structlog.configure(
        processors=processors,
        wrapper_class=structlog.stdlib.BoundLogger,
        context_class=dict,
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    render_processor: structlog.types.Processor = (
        structlog.processors.JSONRenderer() if use_json_renderer else structlog.dev.ConsoleRenderer()
    )

    formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
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
