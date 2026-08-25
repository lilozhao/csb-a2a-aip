from types import SimpleNamespace
from typing import Literal, cast

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.sync import service as sync_service
from app.sync.exception import SyncError, SyncErrorCode
from app.sync.model import Snapshot, WebHook
from app.utils.utils import get_beijing_time

pytestmark = pytest.mark.unit


class DummyDb:
    def __init__(self) -> None:
        self.added: list[object] = []
        self.deleted: list[object] = []
        self.flushed = False
        self.committed = False
        self.rolled_back = False
        self.snapshot: Snapshot | None = None

    def add(self, item: object) -> None:
        self.added.append(item)

    def delete(self, item: object) -> None:
        self.deleted.append(item)

    def flush(self) -> None:
        self.flushed = True

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True


class DummyScalarResult:
    def __init__(self, value: object) -> None:
        self.value = value

    def scalar(self) -> object:
        return self.value


class DummyRowsResult:
    def __init__(self, rows: list[object]) -> None:
        self.rows = rows

    def fetchall(self) -> list[object]:
        return self.rows


class DummyQuery:
    def __init__(self, result: object | None) -> None:
        self.result = result

    def filter(self, *args: object, **kwargs: object) -> DummyQuery:
        del args, kwargs
        return self

    def first(self) -> object | None:
        return self.result


class DummySessionContext:
    def __init__(self, db: DummyDb) -> None:
        self.db = db

    def __enter__(self) -> DummyDb:
        return self.db

    def __exit__(self, exc_type: object, exc: object, tb: object) -> Literal[False]:
        if exc_type is None:
            self.db.commit()
        else:
            self.db.rollback()
        return False


class DummyQueryAll:
    def __init__(self, results: list[object]) -> None:
        self.results = results

    def filter(self, *args: object, **kwargs: object) -> DummyQueryAll:
        del args, kwargs
        return self

    def all(self) -> list[object]:
        return self.results


def _as_session(db: DummyDb) -> Session:
    return cast("Session", db)


def _as_async_session(session: object) -> AsyncSession:
    return cast("AsyncSession", session)


def test_create_webhook_flushes_without_commit() -> None:
    db = DummyDb()

    webhook = sync_service.create_webhook(
        db=_as_session(db),
        url="https://example.com/hook",
        secret="secret",
        types=["acs"],
        events=["data_change"],
        description="demo",
    )

    assert webhook.url == "https://example.com/hook"
    assert webhook.types == "acs"
    assert webhook.events == "data_change"
    assert db.flushed is True
    assert db.committed is False


def test_update_webhook_flushes_without_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    db = DummyDb()
    webhook = WebHook(id="wh_1", url="https://old.example/hook", secret="old", types="acs", events="data_change")

    monkeypatch.setattr(sync_service, "get_webhook", lambda *args, **kwargs: webhook)

    updated = sync_service.update_webhook(
        db=_as_session(db),
        webhook_id="wh_1",
        url="https://new.example/hook",
        secret="new",
        types=["acs"],
        events=["service_healthy"],
        description="updated",
    )

    assert updated is webhook
    assert webhook.url == "https://new.example/hook"
    assert webhook.secret == "new"
    assert webhook.events == "service_healthy"
    assert webhook.description == "updated"
    assert db.flushed is True
    assert db.committed is False


def test_delete_webhook_flushes_without_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    db = DummyDb()
    webhook = WebHook(id="wh_1", url="https://example.com/hook", secret="secret", types="acs", events="data_change")

    monkeypatch.setattr(sync_service, "get_webhook", lambda *args, **kwargs: webhook)

    result = sync_service.delete_webhook(_as_session(db), "wh_1")

    assert result is True
    assert db.deleted == [webhook]
    assert db.flushed is True
    assert db.committed is False


def test_reactivate_webhook_flushes_without_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    db = DummyDb()
    webhook = WebHook(
        id="wh_1",
        url="https://example.com/hook",
        secret="secret",
        types="acs",
        events="data_change",
        status="failed",
        failure_count=3,
        last_failure_reason="boom",
    )

    monkeypatch.setattr(sync_service, "get_webhook", lambda *args, **kwargs: webhook)

    reactivated = sync_service.reactivate_webhook(_as_session(db), "wh_1")

    assert reactivated is webhook
    assert webhook.status == "active"
    assert webhook.failure_count == 0
    assert webhook.last_failure_reason is None
    assert db.flushed is True
    assert db.committed is False


def test_update_webhook_status_uses_isolated_session(monkeypatch: pytest.MonkeyPatch) -> None:
    status_db = DummyDb()
    webhook = WebHook(
        id="wh_1",
        url="https://example.com/hook",
        secret="secret",
        types="acs",
        events="data_change",
        status="failed",
        failure_count=3,
        last_failure_reason="boom",
    )

    status_db.query = lambda model: DummyQuery(webhook)  # type: ignore[attr-defined]
    monkeypatch.setattr(sync_service, "get_sync_session", lambda: DummySessionContext(status_db))

    sync_service.update_webhook_status("wh_1", success=True)

    assert webhook.status == "active"
    assert webhook.failure_count == 0
    assert webhook.last_failure_reason is None
    assert status_db.committed is True
    assert status_db.rolled_back is False


def test_trigger_webhooks_uses_isolated_session(monkeypatch: pytest.MonkeyPatch) -> None:
    webhook_db = DummyDb()
    webhook = WebHook(
        id="wh_1",
        url="https://example.com/hook",
        secret="secret",
        types="acs",
        events="data_change",
        status="active",
    )
    notifications: list[str] = []
    status_updates: list[tuple[str, bool, str | None]] = []

    webhook_db.query = lambda model: DummyQueryAll([webhook])  # type: ignore[attr-defined]
    webhook_db.expunge_all = lambda: notifications.append("expunged")  # type: ignore[attr-defined]
    monkeypatch.setattr(sync_service, "get_sync_session", lambda: DummySessionContext(webhook_db))
    monkeypatch.setattr(sync_service, "send_webhook_notification", lambda *args, **kwargs: True)
    monkeypatch.setattr(
        sync_service,
        "update_webhook_status",
        lambda webhook_id, success, failure_reason=None: status_updates.append((webhook_id, success, failure_reason)),
    )

    sync_service.trigger_webhooks(
        event="data_change",
        event_data={"type": "acs", "current_seq": 1},
        data_types=["acs"],
    )

    assert notifications == ["expunged"]
    assert status_updates == [("wh_1", True, None)]


def test_trigger_webhooks_converts_notification_exception_to_failure_status(monkeypatch: pytest.MonkeyPatch) -> None:
    webhook_db = DummyDb()
    webhook = WebHook(
        id="wh_1",
        url="https://example.com/hook",
        secret="secret",
        types="acs",
        events="data_change",
        status="active",
    )
    status_updates: list[tuple[str, bool, str | None]] = []

    webhook_db.query = lambda model: DummyQueryAll([webhook])  # type: ignore[attr-defined]
    webhook_db.expunge_all = lambda: None  # type: ignore[attr-defined]
    monkeypatch.setattr(sync_service, "get_sync_session", lambda: DummySessionContext(webhook_db))

    def raise_notification_error(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise RuntimeError("boom")

    monkeypatch.setattr(sync_service, "send_webhook_notification", raise_notification_error)
    monkeypatch.setattr(
        sync_service,
        "update_webhook_status",
        lambda webhook_id, success, failure_reason=None: status_updates.append((webhook_id, success, failure_reason)),
    )

    sync_service.trigger_webhooks(
        event="data_change",
        event_data={"type": "acs", "current_seq": 1},
        data_types=["acs"],
    )

    assert status_updates == [("wh_1", False, "Exception: boom")]


def test_trigger_data_change_webhook_swallows_current_seq_errors(monkeypatch: pytest.MonkeyPatch) -> None:
    trigger_calls: list[tuple[str, dict[str, object], list[str] | None]] = []
    logged_messages: list[str] = []

    def raise_query_error(_db: object) -> None:
        raise SQLAlchemyError("boom")

    def record_exception(message: str, *args: object, **kwargs: object) -> None:
        del args, kwargs
        logged_messages.append(message)

    monkeypatch.setattr(sync_service, "settings", SimpleNamespace(dsp_webhook_batch_window_seconds=0))
    monkeypatch.setattr(sync_service, "get_current_max_seq", raise_query_error)
    monkeypatch.setattr(sync_service.logger, "exception", record_exception)
    monkeypatch.setattr(
        sync_service,
        "trigger_webhooks",
        lambda event, event_data, data_types=None: trigger_calls.append((event, event_data, data_types)),
    )

    sync_service.trigger_data_change_webhook(_as_session(DummyDb()), ["acs"])

    assert trigger_calls == []
    assert logged_messages == ["触发 data_change WebHook 时出错"]


def test_create_snapshot_flushes_without_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    db = DummyDb()
    row = type(
        "Row",
        (),
        {
            "seq": 11,
            "ts": None,
            "op": "upsert",
            "type": "acs",
            "id": "aic-1",
            "version": 1,
            "payload": {"foo": "bar"},
        },
    )()
    results = [None, DummyScalarResult(1), DummyRowsResult([row])]

    monkeypatch.setattr(sync_service, "generate_snapshot_id", lambda: "snap_test")
    monkeypatch.setattr(sync_service, "get_current_max_seq", lambda _db: 42)
    monkeypatch.setattr(sync_service, "calculate_expire_time", lambda *args, **kwargs: object())

    def fake_execute(*args: object, **kwargs: object) -> object:
        del args, kwargs
        return results.pop(0)

    db.execute = fake_execute  # type: ignore[attr-defined]

    snapshot, envelopes = sync_service.create_snapshot(db=_as_session(db), types=["acs"], limit=100, from_seq=None)

    assert snapshot.id == "snap_test"
    assert snapshot.seq == 42
    assert len(envelopes) == 1
    assert db.flushed is True
    assert db.committed is False


def test_get_snapshot_chunk_flushes_without_commit() -> None:
    db = DummyDb()
    snapshot = Snapshot(
        id="snap_test",
        types="acs",
        seq=42,
        chunk_total=2,
        object_count=1,
        expire_at=get_beijing_time(),
    )
    snapshot.expire_at = get_beijing_time().replace(year=2999)
    db.snapshot = snapshot
    row = type(
        "Row",
        (),
        {
            "seq": 11,
            "ts": None,
            "op": "upsert",
            "type": "acs",
            "id": "aic-1",
            "version": 1,
            "payload": {"foo": "bar"},
        },
    )()

    db.query = lambda model: DummyQuery(db.snapshot)  # type: ignore[attr-defined]
    db.execute = lambda *args, **kwargs: DummyRowsResult([row])  # type: ignore[attr-defined]

    returned_snapshot, envelopes = sync_service.get_snapshot_chunk(
        db=_as_session(db), snapshot_id="snap_test", chunk_index=0
    )

    assert returned_snapshot is snapshot
    assert len(envelopes) == 1
    assert db.flushed is True
    assert db.committed is False


def test_delete_snapshot_flushes_without_commit() -> None:
    db = DummyDb()
    snapshot = Snapshot(
        id="snap_test",
        types="acs",
        seq=42,
        chunk_total=1,
        object_count=1,
        expire_at=get_beijing_time(),
    )
    db.snapshot = snapshot

    db.query = lambda model: DummyQuery(db.snapshot)  # type: ignore[attr-defined]
    db.execute = lambda *args, **kwargs: None  # type: ignore[attr-defined]

    result = sync_service.delete_snapshot(db=_as_session(db), snapshot_id="snap_test")

    assert result is True
    assert snapshot.is_deleted is True
    assert db.flushed is True
    assert db.committed is False


def test_cleanup_expired_snapshots_flushes_without_commit() -> None:
    db = DummyDb()
    expired_snapshot = Snapshot(
        id="snap_test",
        types="acs",
        seq=42,
        chunk_total=1,
        object_count=1,
        expire_at=get_beijing_time(),
    )

    db.query = lambda model: DummyQueryAll([expired_snapshot])  # type: ignore[attr-defined]
    db.execute = lambda *args, **kwargs: None  # type: ignore[attr-defined]

    cleaned_count = sync_service.cleanup_expired_snapshots(_as_session(db))

    assert cleaned_count == 1
    assert expired_snapshot.is_deleted is True
    assert db.flushed is True
    assert db.committed is False


def test_get_snapshot_list_wraps_query_errors() -> None:
    db = DummyDb()

    def raise_query_error(model: object) -> None:
        del model
        raise SQLAlchemyError("boom")

    db.query = raise_query_error  # type: ignore[attr-defined]

    with pytest.raises(SyncError) as exc_info:
        sync_service.get_snapshot_list(db=_as_session(db))

    assert exc_info.value.error_name == SyncErrorCode.SNAPSHOT_DATA_QUERY_FAILED


def test_get_current_max_seq_does_not_swallow_query_errors() -> None:
    db = DummyDb()

    def raise_query_error(model: object) -> None:
        del model
        raise SQLAlchemyError("boom")

    db.query = raise_query_error  # type: ignore[attr-defined]

    with pytest.raises(SQLAlchemyError):
        sync_service.get_current_max_seq(_as_session(db))


@pytest.mark.asyncio
async def test_get_snapshot_list_async_wraps_execute_errors() -> None:
    class FailingAsyncSession:
        async def execute(self, statement: object) -> None:
            del statement
            raise SQLAlchemyError("boom")

    with pytest.raises(SyncError) as exc_info:
        await sync_service.get_snapshot_list_async(session=_as_async_session(FailingAsyncSession()))

    assert exc_info.value.error_name == SyncErrorCode.SNAPSHOT_DATA_QUERY_FAILED


@pytest.mark.asyncio
async def test_get_current_max_seq_async_does_not_swallow_execute_errors() -> None:
    class FailingAsyncSession:
        async def execute(self, statement: object) -> None:
            del statement
            raise SQLAlchemyError("boom")

    with pytest.raises(SQLAlchemyError):
        await sync_service.get_current_max_seq_async(_as_async_session(FailingAsyncSession()))
