"""app/core/base_model.py 单元测试。"""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID

from app.core.base_model import (
    AuditMixin,
    SoftDeleteMixin,
    TimestampMixin,
    UUIDMixin,
    _aware_datetime_type,
)


class TestAwareDatetimeType:
    """测试 _aware_datetime_type 辅助函数。"""

    def test_returns_sa_datetime(self) -> None:
        from sqlalchemy import DateTime as SADateTime

        result = _aware_datetime_type()
        assert isinstance(result, SADateTime)

    def test_timezone_is_true(self) -> None:
        from sqlalchemy import DateTime as SADateTime

        result = _aware_datetime_type()
        assert isinstance(result, SADateTime)
        assert result.timezone is True


class TestUUIDMixin:
    """测试 UUIDMixin。"""

    def test_id_is_uuid(self) -> None:
        obj = UUIDMixin()
        assert isinstance(obj.id, UUID)

    def test_id_is_generated_by_default(self) -> None:
        a = UUIDMixin()
        b = UUIDMixin()
        assert a.id != b.id

    def test_id_can_be_overridden(self) -> None:
        fixed_id = UUID("00000000-0000-7000-8000-000000000001")
        obj = UUIDMixin(id=fixed_id)
        assert obj.id == fixed_id


class TestTimestampMixin:
    """测试 TimestampMixin。"""

    def test_created_at_is_datetime(self) -> None:
        obj = TimestampMixin()
        assert isinstance(obj.created_at, datetime)

    def test_updated_at_is_datetime(self) -> None:
        obj = TimestampMixin()
        assert isinstance(obj.updated_at, datetime)

    def test_timestamps_are_aware(self) -> None:
        obj = TimestampMixin()
        assert obj.created_at.tzinfo is not None
        assert obj.updated_at.tzinfo is not None

    def test_two_instances_get_independent_timestamps(self) -> None:
        a = TimestampMixin()
        b = TimestampMixin()
        # 各自独立生成，不是同一对象
        assert a.created_at is not b.created_at

    def test_timestamps_can_be_overridden(self) -> None:
        fixed = datetime(2025, 1, 1, 0, 0, 0, tzinfo=UTC)
        obj = TimestampMixin(created_at=fixed, updated_at=fixed)
        assert obj.created_at == fixed
        assert obj.updated_at == fixed


class TestSoftDeleteMixin:
    """测试 SoftDeleteMixin。"""

    def test_deleted_at_defaults_to_none(self) -> None:
        obj = SoftDeleteMixin()
        assert obj.deleted_at is None

    def test_deleted_at_can_be_set(self) -> None:
        ts = datetime(2025, 6, 1, 12, 0, 0, tzinfo=UTC)
        obj = SoftDeleteMixin(deleted_at=ts)
        assert obj.deleted_at == ts


class TestAuditMixin:
    """测试 AuditMixin（组合 TimestampMixin + SoftDeleteMixin）。"""

    def test_has_all_audit_fields(self) -> None:
        obj = AuditMixin()
        assert hasattr(obj, "created_at")
        assert hasattr(obj, "updated_at")
        assert hasattr(obj, "deleted_at")

    def test_deleted_at_defaults_none(self) -> None:
        obj = AuditMixin()
        assert obj.deleted_at is None

    def test_timestamps_are_aware(self) -> None:
        obj = AuditMixin()
        assert obj.created_at.tzinfo is not None
        assert obj.updated_at.tzinfo is not None

    def test_can_mark_as_deleted(self) -> None:
        ts = datetime(2025, 1, 1, tzinfo=UTC)
        obj = AuditMixin(deleted_at=ts)
        assert obj.deleted_at == ts
