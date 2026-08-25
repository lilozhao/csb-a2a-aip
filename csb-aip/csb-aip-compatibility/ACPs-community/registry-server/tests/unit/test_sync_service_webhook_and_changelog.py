"""针对 sync/service.py 中 changelog 与 webhook 分支的单元测试。"""

from __future__ import annotations

from collections.abc import Sequence
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, Literal, cast
from unittest.mock import AsyncMock

import httpx
import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.sync import service as sync_service
from app.sync.exception import SyncError, SyncErrorCode
from app.sync.model import WebHook
from app.utils.utils import sha256

pytestmark = pytest.mark.unit


class DummyScalarOneResult:
    def __init__(self, value: object) -> None:
        self.value = value

    def scalar_one(self) -> object:
        return self.value


class RecordingQuery:
    def __init__(
        self,
        *,
        scalar_value: object | None = None,
        all_value: Sequence[object] | None = None,
        delete_value: int = 0,
        count_value: int = 0,
        first_value: object | None = None,
    ) -> None:
        self.scalar_value = scalar_value
        self.all_value = list(all_value or [])
        self.delete_value = delete_value
        self.count_value = count_value
        self.first_value = first_value
        self.filter_args: list[tuple[object, ...]] = []

    def filter(self, *args: object, **kwargs: object) -> RecordingQuery:
        del kwargs
        self.filter_args.append(args)
        return self

    def order_by(self, *args: object, **kwargs: object) -> RecordingQuery:
        del args, kwargs
        return self

    def offset(self, value: int) -> RecordingQuery:
        del value
        return self

    def limit(self, value: int) -> RecordingQuery:
        del value
        return self

    def scalar(self) -> object | None:
        return self.scalar_value

    def all(self) -> list[object]:
        return list(self.all_value)

    def delete(self, synchronize_session: bool = False) -> int:
        del synchronize_session
        return self.delete_value

    def count(self) -> int:
        return self.count_value

    def first(self) -> object | None:
        return self.first_value


def _as_session(db: object) -> Session:
    return cast("Session", db)


def _as_async_session(session: object) -> AsyncSession:
    return cast("AsyncSession", session)


class QueryDb:
    def __init__(self, queries: list[RecordingQuery]) -> None:
        self.queries = list(queries)
        self.added: list[object] = []

    def query(self, model: object) -> RecordingQuery:
        del model
        if not self.queries:
            raise AssertionError("Unexpected query() call")
        return self.queries.pop(0)

    def execute(self, statement: object) -> DummyScalarOneResult:
        del statement
        return DummyScalarOneResult(42)

    def add(self, item: object) -> None:
        self.added.append(item)


class StatusDb:
    def __init__(self, webhook: WebHook | None) -> None:
        self.webhook = webhook
        self.added: list[object] = []
        self.committed = False
        self.rolled_back = False

    def query(self, model: object) -> RecordingQuery:
        del model
        return RecordingQuery(first_value=self.webhook)

    def add(self, item: object) -> None:
        self.added.append(item)

    def commit(self) -> None:
        self.committed = True

    def rollback(self) -> None:
        self.rolled_back = True


class SessionContext:
    def __init__(self, db: StatusDb) -> None:
        self.db = db

    def __enter__(self) -> StatusDb:
        return self.db

    def __exit__(self, exc_type: object, exc: object, tb: object) -> Literal[False]:
        del exc, tb
        if exc_type is None:
            self.db.commit()
        else:
            self.db.rollback()
        return False


def _build_webhook(*, failure_count: int = 0, status: str = "active") -> WebHook:
    return WebHook(
        id="wh_sync",
        url="https://example.com/webhook",
        secret="secret",
        types="acs",
        events="data_change,retention_cleanup",
        status=status,
        failure_count=failure_count,
    )


def test_generate_next_seq_returns_scalar_value() -> None:
    db = QueryDb([])

    seq = sync_service.generate_next_seq(_as_session(db))

    assert seq == 42


def test_generate_next_seq_wraps_sqlalchemy_error() -> None:
    class FailingDb:
        def execute(self, statement: object) -> DummyScalarOneResult:
            del statement
            raise SQLAlchemyError("boom")

    with pytest.raises(SyncError) as exc_info:
        sync_service.generate_next_seq(_as_session(FailingDb()))

    assert exc_info.value.error_name == SyncErrorCode.GLOBAL_SEQ_GENERATE_FAILED


def test_create_change_log_uses_generated_seq_and_adds_record(monkeypatch: pytest.MonkeyPatch) -> None:
    db = QueryDb([])
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)

    monkeypatch.setattr(sync_service, "generate_next_seq", lambda current_db: 77)
    monkeypatch.setattr(sync_service, "get_beijing_time", lambda: fixed_time)

    change_log = sync_service.create_change_log(
        _as_session(db),
        data_type="acs",
        object_id="agent-1",
        version=2,
        payload={"aic": "agent-1"},
    )

    assert change_log.seq == 77
    assert change_log.ts == fixed_time
    assert change_log.type == "acs"
    assert change_log.id == "agent-1"
    assert db.added == [change_log]


def test_update_agent_with_changelog_updates_sync_fields_and_creates_changelog(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    changelog_calls: list[dict[str, object]] = []
    agent = cast(
        "Any",
        SimpleNamespace(
            id="agent-id",
            aic="aic-001",
            acs_hash="old-hash",
            acs_version=2,
            acs_last_seq=10,
            name="old-name",
            updated_at=None,
        ),
    )
    agent_data = {"acs": {"aic": "aic-001", "active": True}, "name": "new-name"}

    def fake_create_change_log(**kwargs: object) -> SimpleNamespace:
        changelog_calls.append(dict(kwargs))
        return SimpleNamespace(seq=99)

    monkeypatch.setattr(sync_service, "generate_next_seq", lambda db: 99)
    monkeypatch.setattr(sync_service, "get_beijing_time", lambda: fixed_time)
    monkeypatch.setattr(sync_service, "create_change_log", fake_create_change_log)

    result = sync_service.update_agent_with_changelog(_as_session(QueryDb([])), agent, agent_data)

    assert result is agent
    assert agent.acs_version == 3
    assert agent.acs_last_seq == 99
    assert agent.name == "new-name"
    assert agent.updated_at == fixed_time
    assert agent.acs_hash != "old-hash"
    assert len(changelog_calls) == 1
    assert changelog_calls[0]["data_type"] == "acs"
    assert changelog_calls[0]["object_id"] == "aic-001"
    assert changelog_calls[0]["version"] == 3
    assert changelog_calls[0]["payload"] == {"aic": "aic-001", "active": True}
    assert changelog_calls[0]["op"] == "upsert"
    assert changelog_calls[0]["seq"] == 99


def test_update_agent_with_changelog_skips_sync_when_acs_unchanged(monkeypatch: pytest.MonkeyPatch) -> None:
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    agent = cast(
        "Any",
        SimpleNamespace(
            id="agent-id",
            aic="aic-001",
            acs_hash=sha256('{"active": true}'),
            acs_version=2,
            acs_last_seq=10,
            description="old",
            updated_at=None,
        ),
    )
    create_change_log = []

    monkeypatch.setattr(sync_service, "get_beijing_time", lambda: fixed_time)
    monkeypatch.setattr(
        sync_service,
        "create_change_log",
        lambda **kwargs: create_change_log.append(kwargs),
    )

    result = sync_service.update_agent_with_changelog(
        _as_session(QueryDb([])),
        agent,
        {"acs": '{"active": true}', "description": "new"},
    )

    assert result is agent
    assert agent.acs_version == 2
    assert agent.acs_last_seq == 10
    assert agent.description == "new"
    assert agent.updated_at == fixed_time
    assert create_change_log == []


@pytest.mark.asyncio
async def test_update_agent_with_changelog_async_updates_sync_fields(monkeypatch: pytest.MonkeyPatch) -> None:
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    create_change_log_async = AsyncMock(return_value=SimpleNamespace(seq=55))
    agent = cast(
        "Any",
        SimpleNamespace(
            id="agent-id",
            aic="aic-async-001",
            acs_hash=None,
            acs_version=0,
            acs_last_seq=None,
            name="old-name",
            updated_at=None,
        ),
    )

    monkeypatch.setattr(sync_service, "generate_next_seq_async", AsyncMock(return_value=55))
    monkeypatch.setattr(sync_service, "create_change_log_async", create_change_log_async)
    monkeypatch.setattr(sync_service, "get_beijing_time", lambda: fixed_time)

    result = await sync_service.update_agent_with_changelog_async(
        session=_as_async_session(SimpleNamespace()),
        agent=agent,
        agent_data={"acs": {"aic": "aic-async-001", "active": True}, "name": "new-name"},
    )

    assert result is agent
    assert agent.acs_version == 1
    assert agent.acs_last_seq == 55
    assert agent.name == "new-name"
    assert agent.updated_at == fixed_time
    create_change_log_async.assert_awaited_once()


@pytest.mark.asyncio
async def test_update_agent_with_changelog_async_skips_sync_without_aic(monkeypatch: pytest.MonkeyPatch) -> None:
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)
    create_change_log_async = AsyncMock()
    agent = cast(
        "Any",
        SimpleNamespace(
            id="agent-id",
            aic=None,
            acs_hash=None,
            acs_version=None,
            acs_last_seq=None,
            description="old-description",
            updated_at=None,
        ),
    )

    monkeypatch.setattr(sync_service, "generate_next_seq_async", AsyncMock(return_value=88))
    monkeypatch.setattr(sync_service, "create_change_log_async", create_change_log_async)
    monkeypatch.setattr(sync_service, "get_beijing_time", lambda: fixed_time)

    result = await sync_service.update_agent_with_changelog_async(
        session=_as_async_session(SimpleNamespace()),
        agent=agent,
        agent_data={"acs": {"active": False}, "description": "new-description"},
    )

    assert result is agent
    assert agent.acs_version == 1
    assert agent.acs_last_seq == 88
    assert agent.description == "new-description"
    assert agent.updated_at == fixed_time
    create_change_log_async.assert_not_awaited()


def test_get_changes_raises_retention_window_exceeded_when_seq_too_old() -> None:
    db = QueryDb([RecordingQuery(scalar_value=5)])

    with pytest.raises(SyncError) as exc_info:
        sync_service.get_changes(_as_session(db), seq=1, limit=10, types=["acs"])

    assert exc_info.value.error_name == SyncErrorCode.RETENTION_WINDOW_EXCEEDED


def test_get_changes_returns_envelopes_and_next_seq() -> None:
    changes = [
        SimpleNamespace(seq=4, ts=None, op="upsert", type="acs", id="agent-4", version=1, payload={"a": 1}),
        SimpleNamespace(seq=5, ts=None, op="delete", type="acs", id="agent-5", version=2, payload=None),
    ]
    db = QueryDb(
        [
            RecordingQuery(scalar_value=2),
            RecordingQuery(all_value=changes),
        ]
    )

    envelopes, next_seq = sync_service.get_changes(_as_session(db), seq=2, limit=10, types=["acs"])

    assert [envelope.seq for envelope in envelopes] == [4, 5]
    assert next_seq == 5


def test_cleanup_old_changelog_entries_sums_time_and_record_based_deletes() -> None:
    db = QueryDb(
        [
            RecordingQuery(delete_value=2),
            RecordingQuery(count_value=5),
            RecordingQuery(scalar_value=3),
            RecordingQuery(delete_value=1),
        ]
    )

    cleaned = sync_service.cleanup_old_changelog_entries(_as_session(db), window_hours=1, max_records=2)

    assert cleaned == 3


def test_send_webhook_notification_sets_signature_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    webhook = _build_webhook()
    captured: dict[str, object] = {}
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)

    def fake_post(url: str, content: bytes, headers: dict[str, str], timeout: int) -> SimpleNamespace:
        captured.update({"url": url, "content": content, "headers": headers, "timeout": timeout})
        return SimpleNamespace(status_code=204)

    monkeypatch.setattr(sync_service, "get_beijing_time", lambda: fixed_time)
    monkeypatch.setattr(httpx, "post", fake_post)

    result = sync_service.send_webhook_notification(webhook, "data_change", {"type": "acs"})
    captured_headers = cast("dict[str, str]", captured["headers"])

    assert result is True
    assert captured["url"] == webhook.url
    assert captured["timeout"] == 30
    payload = cast("bytes", captured["content"]).decode("utf-8")
    assert captured_headers["X-Webhook-ID"] == webhook.id
    assert captured_headers["X-Webhook-Signature"] == sync_service.generate_webhook_signature(
        webhook.secret,
        int(fixed_time.timestamp()),
        payload,
    )
    assert captured_headers["X-Webhook-Timestamp"] == str(int(fixed_time.timestamp()))


def test_send_webhook_notification_skips_duplicate_inflight(monkeypatch: pytest.MonkeyPatch) -> None:
    webhook = _build_webhook()
    post_calls: list[str] = []

    monkeypatch.setattr(sync_service, "_mark_inflight", lambda webhook_id, event: False)
    monkeypatch.setattr(httpx, "post", lambda *args, **kwargs: post_calls.append("post"))

    result = sync_service.send_webhook_notification(webhook, "data_change", {"type": "acs"})

    assert result is True
    assert post_calls == []


def test_send_webhook_notification_returns_false_for_http_failures(monkeypatch: pytest.MonkeyPatch) -> None:
    webhook = _build_webhook()

    def raise_http_error(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise httpx.ConnectError("boom")

    monkeypatch.setattr(httpx, "post", raise_http_error)

    result = sync_service.send_webhook_notification(webhook, "data_change", {"type": "acs"})

    assert result is False


def test_update_webhook_status_marks_webhook_failed_after_threshold(monkeypatch: pytest.MonkeyPatch) -> None:
    webhook = _build_webhook(failure_count=9)
    status_db = StatusDb(webhook)
    fixed_time = datetime(2024, 1, 1, 12, 0, tzinfo=UTC)

    monkeypatch.setattr(sync_service, "get_sync_session", lambda: SessionContext(status_db))
    monkeypatch.setattr(sync_service, "get_beijing_time", lambda: fixed_time)

    sync_service.update_webhook_status("wh_sync", success=False, failure_reason="timeout")

    assert webhook.failure_count == 10
    assert webhook.status == "failed"
    assert webhook.last_failure_reason == "timeout"
    assert webhook.last_failure_at == fixed_time
    assert webhook.next_retry_at is not None
    assert status_db.added == [webhook]
    assert status_db.committed is True


def test_update_webhook_status_returns_when_webhook_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    status_db = StatusDb(None)

    monkeypatch.setattr(sync_service, "get_sync_session", lambda: SessionContext(status_db))

    sync_service.update_webhook_status("missing", success=True)

    assert status_db.added == []
    assert status_db.committed is True


def test_trigger_retention_cleanup_webhook_sends_event_data(monkeypatch: pytest.MonkeyPatch) -> None:
    trigger_calls: list[tuple[str, dict[str, object], list[str]]] = []

    monkeypatch.setattr(sync_service, "get_current_max_seq", lambda db: 9)
    monkeypatch.setattr(sync_service, "get_retention_oldest_seq", lambda db, window_hours, max_records: 4)
    monkeypatch.setattr(
        sync_service,
        "trigger_webhooks",
        lambda event, event_data, data_types=None: trigger_calls.append((event, event_data, data_types or [])),
    )

    sync_service.trigger_retention_cleanup_webhook(
        _as_session(QueryDb([])), cleaned_count=3, window_hours=24, max_records=100
    )

    assert trigger_calls == [
        (
            "retention_cleanup",
            {
                "type": "acs",
                "cleaned_count": 3,
                "window_hours": 24,
                "max_records": 100,
                "current_seq": 9,
                "oldest_seq": 4,
                "cleanup_timestamp": trigger_calls[0][1]["cleanup_timestamp"],
            },
            ["acs"],
        )
    ]


def test_trigger_retention_cleanup_webhook_ignores_zero_cleaned_count(monkeypatch: pytest.MonkeyPatch) -> None:
    trigger_calls: list[tuple[str, dict[str, object], list[str] | None]] = []

    monkeypatch.setattr(
        sync_service,
        "trigger_webhooks",
        lambda event, event_data, data_types=None: trigger_calls.append((event, event_data, data_types)),
    )

    sync_service.trigger_retention_cleanup_webhook(
        _as_session(QueryDb([])), cleaned_count=0, window_hours=24, max_records=100
    )

    assert trigger_calls == []
