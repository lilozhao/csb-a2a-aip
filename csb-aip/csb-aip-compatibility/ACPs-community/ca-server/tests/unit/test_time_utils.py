"""测试时间工具函数（app.common.time_utils）。"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.common.time_utils import (
    BEIJING_TZ,
    beijing_end_of_day,
    beijing_now,
    days_until_expiry,
    format_datetime,
    is_expired,
)


class TestBeijingNow:
    def test_returns_aware_datetime(self) -> None:
        result = beijing_now()
        assert result.tzinfo is not None

    def test_has_beijing_offset(self) -> None:
        result = beijing_now()
        offset = result.utcoffset()
        assert offset is not None
        assert offset == timedelta(hours=8)

    def test_returns_current_time(self) -> None:
        before = datetime.now(BEIJING_TZ)
        result = beijing_now()
        after = datetime.now(BEIJING_TZ)
        assert before <= result <= after


class TestBeijingEndOfDay:
    def test_hour_is_23(self) -> None:
        result = beijing_end_of_day()
        assert result.hour == 23

    def test_minute_is_59(self) -> None:
        result = beijing_end_of_day()
        assert result.minute == 59

    def test_second_is_59(self) -> None:
        result = beijing_end_of_day()
        assert result.second == 59

    def test_microsecond_is_0(self) -> None:
        result = beijing_end_of_day()
        assert result.microsecond == 0

    def test_is_aware(self) -> None:
        result = beijing_end_of_day()
        assert result.tzinfo is not None


class TestFormatDatetime:
    def test_aware_datetime_formatted(self) -> None:
        dt = datetime(2024, 1, 15, 10, 30, 0, tzinfo=BEIJING_TZ)
        result = format_datetime(dt)
        assert "2024-01-15" in result
        assert "10:30:00" in result

    def test_naive_datetime_gets_beijing_tz(self) -> None:
        naive_dt = datetime(2024, 6, 1, 12, 0, 0)  # noqa: DTZ001
        result = format_datetime(naive_dt)
        # 应包含 +08 时区标记
        assert "+08" in result

    def test_utc_datetime_converted_to_beijing(self) -> None:
        utc_dt = datetime(2024, 1, 1, 0, 0, 0, tzinfo=UTC)
        result = format_datetime(utc_dt)
        # UTC 00:00 → Beijing 08:00
        assert "08:00:00" in result

    def test_returns_string(self) -> None:
        dt = datetime(2024, 1, 1, tzinfo=BEIJING_TZ)
        result = format_datetime(dt)
        assert isinstance(result, str)


class TestIsExpired:
    def test_past_datetime_is_expired(self) -> None:
        past = datetime.now(BEIJING_TZ) - timedelta(days=1)
        assert is_expired(past) is True

    def test_future_datetime_is_not_expired(self) -> None:
        future = datetime.now(BEIJING_TZ) + timedelta(days=1)
        assert is_expired(future) is False

    def test_exact_now_boundary(self) -> None:
        # 接近当前时间的测试（过去 1 秒算过期）
        just_past = datetime.now(BEIJING_TZ) - timedelta(seconds=1)
        assert is_expired(just_past) is True


class TestDaysUntilExpiry:
    def test_future_date_positive(self) -> None:
        future = datetime.now(BEIJING_TZ) + timedelta(days=30)
        result = days_until_expiry(future)
        assert result >= 29  # 考虑 1 天的容差

    def test_past_date_negative(self) -> None:
        past = datetime.now(BEIJING_TZ) - timedelta(days=5)
        result = days_until_expiry(past)
        assert result <= -5

    def test_tomorrow_is_positive(self) -> None:
        tomorrow = datetime.now(BEIJING_TZ) + timedelta(days=1, hours=1)
        result = days_until_expiry(tomorrow)
        assert result >= 1

    def test_yesterday_is_negative(self) -> None:
        yesterday = datetime.now(BEIJING_TZ) - timedelta(days=1, hours=1)
        result = days_until_expiry(yesterday)
        assert result <= -2
