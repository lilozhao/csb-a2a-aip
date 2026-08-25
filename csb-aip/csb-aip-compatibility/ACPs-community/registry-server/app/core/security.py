"""安全中间件与请求上下文注册。"""

import asyncio
import inspect
import uuid
from collections.abc import Awaitable, Callable
from string import hexdigits

import structlog
from fastapi import FastAPI, Request
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import JSONResponse, Response

from app.core.base_exception import PROBLEM_JSON_MEDIA_TYPE, build_problem_details
from app.core.config import settings

asyncio.iscoroutinefunction = inspect.iscoroutinefunction  # type: ignore[assignment]

SECURITY_HEADERS = {
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
}
PRODUCTION_SECURITY_HEADERS = {
    "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
    "Strict-Transport-Security": "max-age=31536000",
}
HEX_DIGITS = frozenset(hexdigits)
type TraceContext = tuple[str, str]
type HttpMiddleware = Callable[[Request, RequestResponseEndpoint], Awaitable[Response]]

EMPTY_TRACE_CONTEXT: TraceContext = ("", "")
limiter = Limiter(key_func=lambda request: get_remote_address(request) or "unknown")


def apply_security_headers(response: Response) -> None:
    """为 HTTP 响应附加基础安全头。"""
    for header_name, header_value in SECURITY_HEADERS.items():
        response.headers.setdefault(header_name, header_value)
    if settings.app_env == "production":
        for header_name, header_value in PRODUCTION_SECURITY_HEADERS.items():
            response.headers.setdefault(header_name, header_value)


def _is_hex_segment(value: str, *, expected_length: int) -> bool:
    """校验 traceparent 片段是否为指定长度的十六进制字符串。"""
    return len(value) == expected_length and all(character in HEX_DIGITS for character in value)


def extract_trace_context(traceparent: str | None) -> TraceContext:
    """从 traceparent 请求头中提取 W3C trace context 标识。"""
    if not traceparent:
        return EMPTY_TRACE_CONTEXT

    parts = traceparent.strip().split("-")
    if len(parts) != 4:
        return EMPTY_TRACE_CONTEXT

    version, trace_id, span_id, trace_flags = parts
    if version.lower() == "ff":
        return EMPTY_TRACE_CONTEXT
    if not _is_hex_segment(version, expected_length=2):
        return EMPTY_TRACE_CONTEXT
    if not _is_hex_segment(trace_id, expected_length=32) or trace_id == "0" * 32:
        return EMPTY_TRACE_CONTEXT
    if not _is_hex_segment(span_id, expected_length=16) or span_id == "0" * 16:
        return EMPTY_TRACE_CONTEXT
    if not _is_hex_segment(trace_flags, expected_length=2):
        return EMPTY_TRACE_CONTEXT
    return trace_id.lower(), span_id.lower()


def rate_limit_exceeded_handler(request: Request, exc: RateLimitExceeded) -> Response:
    """为限流违规返回 Problem Details 响应。"""
    del request
    return JSONResponse(
        status_code=429,
        content=build_problem_details(
            status=429,
            title="Too many requests",
            detail=str(exc.detail),
            type_="urn:acps:error:security:rate-limit-exceeded",
            extensions={"error_name": "RATE_LIMIT_EXCEEDED"},
        ),
        media_type=PROBLEM_JSON_MEDIA_TYPE,
    )


async def _request_context_middleware(request: Request, call_next: RequestResponseEndpoint) -> Response:
    """将请求上下文绑定到 structlog，并附加响应头。"""
    request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())
    trace_id, span_id = extract_trace_context(request.headers.get("traceparent"))
    structlog.contextvars.clear_contextvars()
    structlog.contextvars.bind_contextvars(request_id=request_id, trace_id=trace_id, span_id=span_id)
    request.state.request_id = request_id
    request.state.trace_id = trace_id
    request.state.span_id = span_id

    try:
        response = await call_next(request)
    finally:
        structlog.contextvars.clear_contextvars()

    response.headers["X-Request-ID"] = request_id
    apply_security_headers(response)
    return response


def register_security_middleware(app: FastAPI, atr_ip_restriction_middleware: HttpMiddleware | None = None) -> None:
    """注册 ATR IP 限制、限流和请求上下文中间件。"""
    limiter.enabled = settings.rate_limit_enabled and settings.app_env != "testing"
    app.state.limiter = limiter
    app.add_exception_handler(RateLimitExceeded, rate_limit_exceeded_handler)  # type: ignore[arg-type]
    if limiter.enabled:
        app.add_middleware(SlowAPIMiddleware)
    if atr_ip_restriction_middleware is not None:
        app.middleware("http")(atr_ip_restriction_middleware)
    app.middleware("http")(_request_context_middleware)
