"""应用日志初始化。"""

import logging

import structlog

from app.core.config import settings

_LOGGING_CONFIGURED = False


def add_observability_context_defaults(
    logger: logging.Logger,
    method_name: str,
    event_dict: structlog.types.EventDict,
) -> structlog.types.EventDict:
    """确保结构化日志中始终包含可观测性上下文字段。"""

    del logger, method_name
    event_dict.setdefault("request_id", "")
    event_dict.setdefault("trace_id", "")
    event_dict.setdefault("span_id", "")
    return event_dict


def _use_console_renderer() -> bool:
    configured_format = settings.LOG_FORMAT.strip().lower()
    if configured_format == "json":
        return False
    if configured_format == "console":
        return True
    return settings.APP_ENV != "production"


def _build_renderer() -> structlog.types.Processor:
    if _use_console_renderer():
        return structlog.dev.ConsoleRenderer()
    return structlog.processors.JSONRenderer()


def configure_logging(logger_name: str | None = None) -> structlog.stdlib.BoundLogger:
    """初始化应用日志并返回目标 logger。"""

    global _LOGGING_CONFIGURED

    if not _LOGGING_CONFIGURED:
        timestamper = structlog.processors.TimeStamper(fmt="iso")
        renderer = _build_renderer()
        shared_processors: list[structlog.types.Processor] = [
            structlog.contextvars.merge_contextvars,
            add_observability_context_defaults,
            structlog.stdlib.add_logger_name,
            structlog.stdlib.add_log_level,
            timestamper,
            structlog.stdlib.PositionalArgumentsFormatter(),
            structlog.processors.StackInfoRenderer(),
        ]

        if not _use_console_renderer():
            shared_processors.append(structlog.processors.format_exc_info)

        formatter = structlog.stdlib.ProcessorFormatter(
            foreign_pre_chain=shared_processors,
            processors=[
                structlog.stdlib.ProcessorFormatter.remove_processors_meta,
                renderer,
            ],
        )

        handler = logging.StreamHandler()
        handler.setFormatter(formatter)

        logging.basicConfig(
            level=settings.APP_LOG_LEVEL.upper(),
            handlers=[handler],
            force=True,
        )

        structlog.configure(
            processors=[*shared_processors, structlog.stdlib.ProcessorFormatter.wrap_for_formatter],
            logger_factory=structlog.stdlib.LoggerFactory(),
            wrapper_class=structlog.stdlib.BoundLogger,
            cache_logger_on_first_use=True,
        )
        _LOGGING_CONFIGURED = True

    return structlog.stdlib.get_logger(logger_name or __name__).bind()


def get_logger(logger_name: str | None = None) -> structlog.stdlib.BoundLogger:
    """返回应用 logger。"""

    return configure_logging(logger_name)
