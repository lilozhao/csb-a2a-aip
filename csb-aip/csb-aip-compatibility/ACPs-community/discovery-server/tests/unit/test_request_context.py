from __future__ import annotations

import asyncio
import logging

import pytest
from fastapi import Request, Response

from app.core import logging_config as logging_config_module
from app.core import request_context as request_context_module

pytestmark = pytest.mark.unit


def test_extract_trace_context_returns_empty_for_missing_header() -> None:
    assert request_context_module.extract_trace_context(None) == ("", "")


def test_extract_trace_context_returns_empty_for_invalid_header() -> None:
    assert request_context_module.extract_trace_context("00-not-a-trace-header") == ("", "")


def test_extract_trace_context_returns_empty_for_short_header() -> None:
    assert request_context_module.extract_trace_context("00-short") == ("", "")


def test_extract_trace_context_returns_trace_and_span_ids() -> None:
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    assert request_context_module.extract_trace_context(traceparent) == (
        "4bf92f3577b34da6a3ce929d0e0e4736",
        "00f067aa0ba902b7",
    )


async def test_request_context_middleware_binds_trace_context() -> None:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/health",
        "headers": [
            (b"x-request-id", b"req-123"),
            (b"traceparent", b"00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"),
        ],
    }
    request = Request(scope)

    async def call_next(_: Request) -> Response:
        await asyncio.sleep(0)
        return Response()

    response = await request_context_module.request_context_middleware(request, call_next)

    assert request.state.request_id == "req-123"
    assert request.state.trace_id == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert request.state.span_id == "00f067aa0ba902b7"
    assert response.headers[request_context_module.REQUEST_ID_HEADER] == "req-123"


def test_add_observability_context_defaults_sets_empty_fields() -> None:
    event_dict = {"event": "hello"}

    result = logging_config_module.add_observability_context_defaults(logging.getLogger("test"), "info", event_dict)

    assert result["request_id"] == ""
    assert result["trace_id"] == ""
    assert result["span_id"] == ""
