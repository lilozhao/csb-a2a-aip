"""sync/service.py 中 snapshot 相关分支的单元测试。"""

from __future__ import annotations

from datetime import timedelta
from typing import cast

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.sync import service as sync_service
from app.sync.exception import SyncError, SyncErrorCode
from app.sync.model import Snapshot
from app.utils.utils import get_beijing_time

pytestmark = pytest.mark.unit


def _build_snapshot(
    snapshot_id: str = "snap_test",
    *,
    chunk_total: int = 2,
    expired: bool = False,
) -> Snapshot:
    expire_at = get_beijing_time() + timedelta(hours=1)
    if expired:
        expire_at = get_beijing_time() - timedelta(seconds=1)

    return Snapshot(
        id=snapshot_id,
        types="acs",
        seq=42,
        chunk_total=chunk_total,
        object_count=3,
        from_seq=7,
        expire_at=expire_at,
    )


class DummySnapshotQuery:
    def __init__(
        self,
        *,
        first_result: object | None = None,
        all_results: list[object] | None = None,
    ) -> None:
        self.first_result = first_result
        self.all_results = list(all_results or [])

    def filter(self, *args: object, **kwargs: object) -> DummySnapshotQuery:
        del args, kwargs
        return self

    def first(self) -> object | None:
        return self.first_result

    def all(self) -> list[object]:
        return list(self.all_results)


class DummySnapshotDb:
    def __init__(
        self,
        *,
        first_result: object | None = None,
        all_results: list[object] | None = None,
        query_error: Exception | None = None,
        execute_side_effects: list[object] | None = None,
    ) -> None:
        self.first_result = first_result
        self.all_results = list(all_results or [])
        self.query_error = query_error
        self.execute_side_effects = list(execute_side_effects or [])
        self.added: list[object] = []
        self.flushed = False
        self.execute_calls = 0

    def query(self, model: object) -> DummySnapshotQuery:
        del model
        if self.query_error is not None:
            raise self.query_error
        return DummySnapshotQuery(first_result=self.first_result, all_results=self.all_results)

    def execute(self, *args: object, **kwargs: object) -> object | None:
        del args, kwargs
        self.execute_calls += 1
        if not self.execute_side_effects:
            return None

        effect = self.execute_side_effects.pop(0)
        if isinstance(effect, Exception):
            raise effect
        return effect

    def add(self, item: object) -> None:
        self.added.append(item)

    def flush(self) -> None:
        self.flushed = True


def _as_session(db: DummySnapshotDb) -> Session:
    return cast("Session", db)


def test_build_snapshot_table_name_strips_snap_prefix() -> None:
    assert sync_service._build_snapshot_table_name("snap_abcd1234") == "snapshot_abcd1234"


def test_build_snapshot_query_filters_include_from_seq_and_activity_constraints() -> None:
    where_clause, params = sync_service._build_snapshot_query_filters(["acs"], from_seq=123)

    assert "a.acs IS NOT NULL AND a.aic IS NOT NULL" in where_clause
    assert "a.acs_last_seq > :from_seq" in where_clause
    assert "a.is_active = true AND a.is_deleted = false" in where_clause
    assert params == {"from_seq": 123}


def test_build_snapshot_model_keeps_joined_types_and_from_seq() -> None:
    snapshot = sync_service._build_snapshot_model(
        snapshot_id="snap_model",
        types=["acs", "agent"],
        current_seq=88,
        chunk_total=3,
        object_count=9,
        from_seq=55,
    )

    assert snapshot.id == "snap_model"
    assert snapshot.types == "acs,agent"
    assert snapshot.seq == 88
    assert snapshot.chunk_total == 3
    assert snapshot.object_count == 9
    assert snapshot.from_seq == 55
    assert snapshot.is_deleted is False
    assert snapshot.created_at == snapshot.last_access_at
    assert snapshot.expire_at > snapshot.created_at


def test_validate_snapshot_chunk_request_raises_not_found() -> None:
    with pytest.raises(SyncError) as exc_info:
        sync_service._validate_snapshot_chunk_request(None, "snap_missing", 0)

    assert exc_info.value.error_name == SyncErrorCode.SNAPSHOT_NOT_FOUND


def test_validate_snapshot_chunk_request_raises_expired() -> None:
    with pytest.raises(SyncError) as exc_info:
        sync_service._validate_snapshot_chunk_request(_build_snapshot(expired=True), "snap_expired", 0)

    assert exc_info.value.error_name == SyncErrorCode.SNAPSHOT_EXPIRED


def test_validate_snapshot_chunk_request_raises_invalid_index() -> None:
    with pytest.raises(SyncError) as exc_info:
        sync_service._validate_snapshot_chunk_request(_build_snapshot(chunk_total=2), "snap_test", 2)

    assert exc_info.value.error_name == SyncErrorCode.INVALID_CHUNK_INDEX


def test_delete_snapshot_returns_true_when_snapshot_missing() -> None:
    db = DummySnapshotDb(first_result=None)

    result = sync_service.delete_snapshot(db=_as_session(db), snapshot_id="snap_missing")

    assert result is True
    assert db.flushed is False
    assert db.added == []


def test_delete_snapshot_ignores_drop_table_errors_and_marks_snapshot_deleted() -> None:
    snapshot = _build_snapshot()
    db = DummySnapshotDb(first_result=snapshot, execute_side_effects=[SQLAlchemyError("drop failed")])

    result = sync_service.delete_snapshot(db=_as_session(db), snapshot_id=snapshot.id)

    assert result is True
    assert snapshot.is_deleted is True
    assert db.added == [snapshot]
    assert db.flushed is True
    assert db.execute_calls == 1


def test_cleanup_expired_snapshots_continues_after_drop_failures() -> None:
    failed_snapshot = _build_snapshot("snap_failed", expired=True)
    cleaned_snapshot = _build_snapshot("snap_cleaned", expired=True)
    db = DummySnapshotDb(
        all_results=[failed_snapshot, cleaned_snapshot],
        execute_side_effects=[SQLAlchemyError("drop failed"), None],
    )

    cleaned_count = sync_service.cleanup_expired_snapshots(_as_session(db))

    assert cleaned_count == 1
    assert failed_snapshot.is_deleted is False
    assert cleaned_snapshot.is_deleted is True
    assert db.added == [cleaned_snapshot]
    assert db.flushed is True


def test_cleanup_expired_snapshots_returns_zero_without_flush_when_empty() -> None:
    db = DummySnapshotDb(all_results=[])

    cleaned_count = sync_service.cleanup_expired_snapshots(_as_session(db))

    assert cleaned_count == 0
    assert db.flushed is False


def test_cleanup_expired_snapshots_wraps_query_errors() -> None:
    db = DummySnapshotDb(query_error=SQLAlchemyError("query failed"))

    with pytest.raises(SyncError) as exc_info:
        sync_service.cleanup_expired_snapshots(_as_session(db))

    assert exc_info.value.error_name == SyncErrorCode.SNAPSHOT_TABLE_DROP_FAILED


def test_get_snapshot_info_raises_not_found_for_missing_snapshot() -> None:
    db = DummySnapshotDb(first_result=None)

    with pytest.raises(SyncError) as exc_info:
        sync_service.get_snapshot_info(_as_session(db), "snap_missing")

    assert exc_info.value.error_name == SyncErrorCode.SNAPSHOT_NOT_FOUND


def test_create_snapshot_wraps_create_table_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    db = DummySnapshotDb(execute_side_effects=[SQLAlchemyError("create failed")])

    monkeypatch.setattr(sync_service, "generate_snapshot_id", lambda: "snap_broken")
    monkeypatch.setattr(sync_service, "get_current_max_seq", lambda _db: 77)

    with pytest.raises(SyncError) as exc_info:
        sync_service.create_snapshot(db=_as_session(db), types=["acs"], limit=100)

    assert exc_info.value.error_name == SyncErrorCode.SNAPSHOT_CREATE_FAILED
