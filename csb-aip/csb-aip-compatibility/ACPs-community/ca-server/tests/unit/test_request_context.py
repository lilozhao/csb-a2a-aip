"""测试请求上下文中的 traceparent 提取。"""

from app.main import _extract_trace_context


def test_extract_trace_context_returns_ids_for_valid_traceparent() -> None:
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    assert _extract_trace_context(traceparent) == (
        "4bf92f3577b34da6a3ce929d0e0e4736",
        "00f067aa0ba902b7",
    )


def test_extract_trace_context_returns_empty_for_short_traceparent() -> None:
    assert _extract_trace_context("00-short") == ("", "")


def test_extract_trace_context_returns_empty_for_invalid_version() -> None:
    traceparent = "ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    assert _extract_trace_context(traceparent) == ("", "")
