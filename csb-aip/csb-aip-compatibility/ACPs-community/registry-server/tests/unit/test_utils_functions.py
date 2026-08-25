"""针对 utils/utils.py 的单元测试。

覆盖：parse_boolean_string（全部分支）、utc_to_beijing（aware/naive）、
beijing_to_utc（aware/naive）、sha256（空字符串与正常字符串）。
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta, timezone

import pytest

from app.utils.utils import (
    BEIJING_TIMEZONE,
    beijing_to_utc,
    get_beijing_time,
    parse_boolean_string,
    sha256,
    utc_to_beijing,
)

pytestmark = pytest.mark.unit


class TestParseBooleanString:
    def test_none_returns_none(self) -> None:
        assert parse_boolean_string(None) is None

    def test_empty_string_returns_none(self) -> None:
        assert parse_boolean_string("") is None

    @pytest.mark.parametrize("value", ["true", "True", "TRUE", "1", "yes", "YES", "t", "T"])
    def test_truthy_values(self, value: str) -> None:
        assert parse_boolean_string(value) is True

    @pytest.mark.parametrize("value", ["false", "False", "FALSE", "0", "no", "NO", "f", "F"])
    def test_falsy_values(self, value: str) -> None:
        assert parse_boolean_string(value) is False

    def test_unknown_string_returns_none(self) -> None:
        assert parse_boolean_string("maybe") is None

    def test_whitespace_not_handled(self) -> None:
        # 空格字符串不在 None/"" 范围内，也不匹配 true/false，应返回 None
        assert parse_boolean_string("  ") is None


class TestUtcToBeijing:
    def test_aware_utc_datetime_converts_correctly(self) -> None:
        dt_utc = datetime(2024, 1, 1, 0, 0, 0, tzinfo=UTC)
        result = utc_to_beijing(dt_utc)
        assert result.tzinfo == BEIJING_TIMEZONE
        # 北京时间 UTC+8，即 08:00
        assert result.hour == 8

    def test_naive_datetime_assumed_utc(self) -> None:
        dt_naive = datetime(2024, 1, 1, 0, 0, 0, tzinfo=UTC)
        result = utc_to_beijing(dt_naive)
        assert result.tzinfo == BEIJING_TIMEZONE
        assert result.hour == 8

    def test_other_timezone_converted_correctly(self) -> None:
        # 例如 UTC+5 时区的 03:00，会换算为北京时间 06:00
        tz_plus5 = timezone(timedelta(hours=5))
        dt = datetime(2024, 1, 1, 3, 0, 0, tzinfo=tz_plus5)
        result = utc_to_beijing(dt)
        assert result.tzinfo == BEIJING_TIMEZONE
        # 例如 UTC-5 与北京时间相差 13 小时，因此会换算到 06:00
        # dt 为 UTC 2023-12-31 22:00 → 北京 2024-01-01 06:00
        assert result.hour == 6


class TestBeijingToUtc:
    def test_aware_beijing_datetime_converts_correctly(self) -> None:
        dt_bj = datetime(2024, 1, 1, 8, 0, 0, tzinfo=BEIJING_TIMEZONE)
        result = beijing_to_utc(dt_bj)
        assert result.tzinfo == UTC
        assert result.hour == 0

    def test_naive_datetime_assumed_beijing(self) -> None:
        dt_naive = datetime(2024, 1, 1, 8, 0, 0, tzinfo=BEIJING_TIMEZONE)
        result = beijing_to_utc(dt_naive)
        assert result.tzinfo == UTC
        assert result.hour == 0

    def test_inverse_of_utc_to_beijing(self) -> None:
        dt_utc = datetime(2024, 6, 15, 12, 30, 0, tzinfo=UTC)
        result = beijing_to_utc(utc_to_beijing(dt_utc))
        assert result.replace(tzinfo=UTC) == dt_utc.replace(tzinfo=UTC)


class TestGetBeijingTime:
    def test_returns_aware_datetime_with_beijing_tzinfo(self) -> None:
        result = get_beijing_time()
        assert result.tzinfo is not None
        assert result.utcoffset() == timedelta(hours=8)


class TestSha256:
    def test_empty_string_returns_empty(self) -> None:
        assert sha256("") == ""

    def test_known_hash(self) -> None:
        # "hello" 的 SHA-256 已知值
        result = sha256("hello")
        assert result == "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"

    def test_different_inputs_different_hashes(self) -> None:
        assert sha256("abc") != sha256("xyz")

    def test_returns_64_char_hex_string(self) -> None:
        result = sha256("test input")
        assert len(result) == 64
        assert all(c in "0123456789abcdef" for c in result)
