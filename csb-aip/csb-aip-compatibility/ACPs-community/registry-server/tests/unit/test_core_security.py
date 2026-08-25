"""针对 core/security.py 的单元测试。

覆盖：apply_security_headers（基本头、production 额外头）、
_is_hex_segment（合法/非法）、extract_trace_context（各边界情况）、
rate_limit_exceeded_handler（返回 429 JSON）。
"""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest
from starlette.responses import Response

from app.core.security import (
    EMPTY_TRACE_CONTEXT,
    _is_hex_segment,
    apply_security_headers,
    extract_trace_context,
    rate_limit_exceeded_handler,
)

pytestmark = pytest.mark.unit


class TestApplySecurityHeaders:
    def test_adds_baseline_headers(self) -> None:
        response = Response()
        with patch("app.core.security.settings") as mock_settings:
            mock_settings.app_env = "development"
            apply_security_headers(response)
        assert response.headers.get("X-Content-Type-Options") == "nosniff"
        assert response.headers.get("X-Frame-Options") == "DENY"
        assert response.headers.get("Referrer-Policy") == "strict-origin-when-cross-origin"

    def test_adds_production_headers_in_production(self) -> None:
        response = Response()
        with patch("app.core.security.settings") as mock_settings:
            mock_settings.app_env = "production"
            apply_security_headers(response)
        assert "Strict-Transport-Security" in response.headers
        assert "Content-Security-Policy" in response.headers

    def test_no_production_headers_in_development(self) -> None:
        response = Response()
        with patch("app.core.security.settings") as mock_settings:
            mock_settings.app_env = "development"
            apply_security_headers(response)
        assert "Strict-Transport-Security" not in response.headers

    def test_does_not_overwrite_existing_headers(self) -> None:
        response = Response()
        response.headers["X-Content-Type-Options"] = "existing-value"
        with patch("app.core.security.settings") as mock_settings:
            mock_settings.app_env = "development"
            apply_security_headers(response)
        # setdefault 不应覆盖已存在的 header
        assert response.headers["X-Content-Type-Options"] == "existing-value"


class TestIsHexSegment:
    def test_valid_hex_segment(self) -> None:
        assert _is_hex_segment("0a1b2c3d", expected_length=8) is True

    def test_wrong_length(self) -> None:
        assert _is_hex_segment("0a1b", expected_length=8) is False

    def test_non_hex_chars(self) -> None:
        assert _is_hex_segment("0g1b2c3d", expected_length=8) is False

    def test_empty_string(self) -> None:
        assert _is_hex_segment("", expected_length=0) is True  # len 0 matches

    def test_uppercase_hex(self) -> None:
        assert _is_hex_segment("ABCDEF12", expected_length=8) is True


class TestExtractTraceContext:
    def _valid_traceparent(
        self,
        trace_id: str | None = None,
        span_id: str | None = None,
    ) -> str:
        t = trace_id or "a" * 32
        s = span_id or "b" * 16
        return f"00-{t}-{s}-01"

    def test_valid_traceparent_returns_ids(self) -> None:
        trace_id = "a" * 32
        span_id = "b" * 16
        result = extract_trace_context(f"00-{trace_id}-{span_id}-01")
        assert result == (trace_id, span_id)

    def test_none_returns_empty(self) -> None:
        assert extract_trace_context(None) == EMPTY_TRACE_CONTEXT

    def test_empty_string_returns_empty(self) -> None:
        assert extract_trace_context("") == EMPTY_TRACE_CONTEXT

    def test_short_traceparent_returns_empty(self) -> None:
        assert extract_trace_context("00-short") == EMPTY_TRACE_CONTEXT

    def test_too_many_parts_returns_empty(self) -> None:
        tp = "00-" + "a" * 32 + "-" + "b" * 16 + "-01-extra"
        assert extract_trace_context(tp) == EMPTY_TRACE_CONTEXT

    def test_version_ff_returns_empty(self) -> None:
        tp = "ff-" + "a" * 32 + "-" + "b" * 16 + "-01"
        assert extract_trace_context(tp) == EMPTY_TRACE_CONTEXT

    def test_all_zero_trace_id_returns_empty(self) -> None:
        tp = "00-" + "0" * 32 + "-" + "b" * 16 + "-01"
        assert extract_trace_context(tp) == EMPTY_TRACE_CONTEXT

    def test_all_zero_span_id_returns_empty(self) -> None:
        tp = "00-" + "a" * 32 + "-" + "0" * 16 + "-01"
        assert extract_trace_context(tp) == EMPTY_TRACE_CONTEXT

    def test_invalid_version_length_returns_empty(self) -> None:
        # version 应为 2 位十六进制字符
        tp = "0-" + "a" * 32 + "-" + "b" * 16 + "-01"
        assert extract_trace_context(tp) == EMPTY_TRACE_CONTEXT

    def test_invalid_trace_id_length_returns_empty(self) -> None:
        tp = "00-" + "a" * 16 + "-" + "b" * 16 + "-01"
        assert extract_trace_context(tp) == EMPTY_TRACE_CONTEXT

    def test_invalid_span_id_length_returns_empty(self) -> None:
        tp = "00-" + "a" * 32 + "-" + "b" * 8 + "-01"
        assert extract_trace_context(tp) == EMPTY_TRACE_CONTEXT


class TestRateLimitExceededHandler:
    async def test_returns_429_json_response(self) -> None:
        from slowapi.errors import RateLimitExceeded

        request = MagicMock()
        exc = MagicMock(spec=RateLimitExceeded)
        exc.detail = "1 per second"

        response = rate_limit_exceeded_handler(request, exc)
        assert response.status_code == 429
        import json

        body = json.loads(bytes(response.body))
        assert body["status"] == 429
        assert "rate" in body["title"].lower() or "too many" in body["title"].lower()
