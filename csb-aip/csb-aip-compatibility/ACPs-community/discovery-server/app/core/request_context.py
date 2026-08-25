"""请求上下文绑定。"""

from collections.abc import Awaitable, Callable
from string import hexdigits
from uuid import uuid4

import structlog
from fastapi import Request, Response

REQUEST_ID_HEADER = "X-Request-ID"
EMPTY_TRACE_CONTEXT: tuple[str, str] = ("", "")

CallNext = Callable[[Request], Awaitable[Response]]


def _is_hex_segment(value: str, *, expected_length: int) -> bool:
    """校验 traceparent 片段是否为指定长度的十六进制字符串。"""

    return len(value) == expected_length and all(character in hexdigits for character in value)


def extract_trace_context(traceparent: str | None) -> tuple[str, str]:
    """从 W3C traceparent 请求头中提取 trace_id 和 span_id。"""

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


async def request_context_middleware(request: Request, call_next: CallNext) -> Response:
    """为每个请求绑定 request/trace 上下文，并回写到响应头。"""

    request_id = request.headers.get(REQUEST_ID_HEADER) or uuid4().hex
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

    response.headers.setdefault(REQUEST_ID_HEADER, request_id)
    return response
