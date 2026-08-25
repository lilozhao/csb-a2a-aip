from collections.abc import Callable
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, cast

import pytest
from fastapi import Response, status
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.sync import api as sync_api
from app.sync import api_admin, api_protocol, api_webhook
from app.sync.exception import SyncError, SyncErrorCode
from app.sync.schema import Envelope, WebHookCreate

if TYPE_CHECKING:
    from app.account.model import User

pytestmark = pytest.mark.unit


class DummyAsyncSession:
    def __init__(self) -> None:
        self.operations: list[str] = []

    async def commit(self) -> None:
        self.operations.append("commit")

    async def run_sync(self, fn: Callable[[str], object]) -> object:
        self.operations.append("run_sync")
        return fn("sync-session")


def _as_async_session(db: DummyAsyncSession) -> AsyncSession:
    return cast("AsyncSession", db)


def _sample_snapshot() -> SimpleNamespace:
    return SimpleNamespace(
        id="snap_test",
        seq=7,
        chunk_total=1,
        object_count=1,
    )


def _sample_envelope() -> Envelope:
    return Envelope(
        seq=7,
        ts=datetime.now(UTC),
        op="upsert",
        type="acs",
        id="aic-sync-1",
        version=1,
        payload={"name": "sync"},
    )


def _find_route(router: object, path: str, method: str) -> APIRoute:
    for route in cast("Any", router).routes:
        if isinstance(route, APIRoute) and route.path == path and method in route.methods:
            return route

    raise AssertionError(f"Route {method} {path} not found")


def _dependency_names(route: APIRoute) -> set[str]:
    return {dependency.call.__name__ for dependency in route.dependant.dependencies if dependency.call is not None}


def _maintenance_user() -> User:
    return cast("User", SimpleNamespace(id="staff-user"))


async def test_create_snapshot_api_commits_before_return(monkeypatch: pytest.MonkeyPatch) -> None:
    db = DummyAsyncSession()

    async def fake_create_snapshot_async(
        session: object, types: list[str], limit: int, from_seq: int | None
    ) -> tuple[SimpleNamespace, list[Envelope]]:
        assert session is db
        assert types == ["acs"]
        assert limit == 1
        assert from_seq is None
        assert db.operations == []
        return _sample_snapshot(), [_sample_envelope()]

    monkeypatch.setattr(api_protocol, "create_snapshot_async", fake_create_snapshot_async)

    response = Response()
    result = await api_protocol.get_snapshot_api(response=response, db=_as_async_session(db), types="acs", limit=1)

    assert db.operations == ["commit"]
    assert response.headers["X-Snapshot-Id"] == "snap_test"
    assert result.headers["X-Snapshot-Id"] == "snap_test"


async def test_get_snapshot_chunk_api_commits_before_return(monkeypatch: pytest.MonkeyPatch) -> None:
    db = DummyAsyncSession()

    async def fake_get_snapshot_chunk_async(
        session: object, snapshot_id: str, chunk_index: int, limit: int
    ) -> tuple[SimpleNamespace, list[Envelope]]:
        assert session is db
        assert snapshot_id == "snap_test"
        assert chunk_index == 0
        assert limit == 1
        assert db.operations == []
        return _sample_snapshot(), [_sample_envelope()]

    monkeypatch.setattr(api_protocol, "get_snapshot_chunk_async", fake_get_snapshot_chunk_async)

    response = Response()
    result = await api_protocol.get_snapshot_api(
        response=response, db=_as_async_session(db), id="snap_test", chunk=0, limit=1
    )

    assert db.operations == ["commit"]
    assert response.headers["X-Snapshot-Chunk-Index"] == "0"
    assert result.headers["X-Snapshot-Id"] == "snap_test"


async def test_cleanup_changelogs_api_commits_before_triggering_webhook(monkeypatch: pytest.MonkeyPatch) -> None:
    db = DummyAsyncSession()
    trigger_calls: list[tuple[object, int, int, int]] = []

    async def fake_cleanup_old_changelog_entries_async(session: object, window_hours: int, max_records: int) -> int:
        assert session is db
        assert db.operations == []
        return 2

    def fake_trigger_retention_cleanup_webhook(
        db: object, cleaned_count: int, window_hours: int, max_records: int
    ) -> None:
        trigger_calls.append((db, cleaned_count, window_hours, max_records))

    monkeypatch.setattr(api_admin, "cleanup_old_changelog_entries_async", fake_cleanup_old_changelog_entries_async)
    monkeypatch.setattr(api_admin, "trigger_retention_cleanup_webhook", fake_trigger_retention_cleanup_webhook)

    result = await api_admin.cleanup_changelogs_api(_as_async_session(db), _maintenance_user())

    assert result.cleaned_count == 2
    assert db.operations == ["commit", "run_sync"]
    assert trigger_calls == [
        (
            "sync-session",
            2,
            settings.dsp_retention_window_hours,
            settings.dsp_retention_max_records,
        )
    ]


async def test_get_info_api_preserves_sync_error(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = SyncError(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        error_name=SyncErrorCode.CHANGES_QUERY_FAILED,
        error_msg="boom",
        input_params={},
    )

    async def fail_max_seq(_db: object) -> None:
        raise expected

    monkeypatch.setattr(api_protocol, "get_current_max_seq_async", fail_max_seq)

    with pytest.raises(SyncError) as exc_info:
        await api_protocol.get_info(_as_async_session(DummyAsyncSession()))

    assert exc_info.value is expected


async def test_list_snapshots_api_preserves_sync_error(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = SyncError(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        error_name=SyncErrorCode.SNAPSHOT_DATA_QUERY_FAILED,
        error_msg="boom",
        input_params={},
    )

    async def fail_list(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise expected

    monkeypatch.setattr(api_admin, "get_snapshot_list_async", fail_list)

    with pytest.raises(SyncError) as exc_info:
        await api_admin.list_snapshots_api(_as_async_session(DummyAsyncSession()), _maintenance_user())

    assert exc_info.value is expected


async def test_cleanup_snapshots_api_preserves_sync_error(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = SyncError(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        error_name=SyncErrorCode.SNAPSHOT_TABLE_DROP_FAILED,
        error_msg="boom",
        input_params={},
    )

    async def fail_cleanup(_db: object) -> None:
        raise expected

    monkeypatch.setattr(api_admin, "cleanup_expired_snapshots_async", fail_cleanup)

    with pytest.raises(SyncError) as exc_info:
        await api_admin.cleanup_snapshots_api(_as_async_session(DummyAsyncSession()), _maintenance_user())

    assert exc_info.value is expected


async def test_cleanup_changelogs_api_preserves_sync_error(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = SyncError(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        error_name=SyncErrorCode.CHANGES_QUERY_FAILED,
        error_msg="boom",
        input_params={},
    )

    async def fail_cleanup(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise expected

    monkeypatch.setattr(api_admin, "cleanup_old_changelog_entries_async", fail_cleanup)

    with pytest.raises(SyncError) as exc_info:
        await api_admin.cleanup_changelogs_api(_as_async_session(DummyAsyncSession()), _maintenance_user())

    assert exc_info.value is expected


async def test_create_webhook_api_preserves_sync_error(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = SyncError(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        error_name=SyncErrorCode.WEBHOOK_CREATE_FAILED,
        error_msg="boom",
        input_params={},
    )

    async def fail_create(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise expected

    monkeypatch.setattr(api_webhook, "create_webhook_async", fail_create)

    with pytest.raises(SyncError) as exc_info:
        await api_webhook.create_webhook_api(
            webhook_data=WebHookCreate(
                url="https://example.com/hook",
                secret="secret",
                types=["acs"],
                events=["data_change"],
                description="demo",
            ),
            db=_as_async_session(DummyAsyncSession()),
            _maintenance_user=_maintenance_user(),
        )

    assert exc_info.value is expected


async def test_list_webhooks_api_preserves_sync_error(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = SyncError(
        status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
        error_name=SyncErrorCode.WEBHOOK_QUERY_FAILED,
        error_msg="boom",
        input_params={},
    )

    async def fail_list(*args: object, **kwargs: object) -> None:
        del args, kwargs
        raise expected

    monkeypatch.setattr(api_webhook, "get_webhook_list_async", fail_list)

    with pytest.raises(SyncError) as exc_info:
        await api_webhook.list_webhooks_api(_as_async_session(DummyAsyncSession()), _maintenance_user())

    assert exc_info.value is expected


def test_sync_api_router_aggregates_protocol_admin_and_webhook_routes() -> None:
    aggregated_paths = {route.path for route in sync_api.router.routes if isinstance(route, APIRoute)}
    child_paths = {route.path for route in api_protocol.router_protocol.routes if isinstance(route, APIRoute)}
    child_paths |= {route.path for route in api_admin.router_admin.routes if isinstance(route, APIRoute)}
    child_paths |= {route.path for route in api_webhook.router_webhook.routes if isinstance(route, APIRoute)}

    assert child_paths <= aggregated_paths
    assert {
        "/info",
        "/changes",
        "/snapshots",
        "/admin/changelogs",
        "/admin/snapshots",
        "/webhooks",
    } <= aggregated_paths


@pytest.mark.parametrize(
    ("router", "path", "method"),
    [
        (api_admin.router_admin, "/admin/changelogs", "GET"),
        (api_admin.router_admin, "/admin/snapshots", "GET"),
        (api_admin.router_admin, "/admin/snapshots/{id}", "GET"),
        (api_admin.router_admin, "/admin/snapshots/cleanup", "POST"),
        (api_admin.router_admin, "/admin/changelogs/cleanup", "POST"),
        (api_webhook.router_webhook, "/webhooks", "POST"),
        (api_webhook.router_webhook, "/webhooks/{id}", "GET"),
        (api_webhook.router_webhook, "/webhooks/{id}", "PUT"),
        (api_webhook.router_webhook, "/webhooks/{id}", "DELETE"),
        (api_webhook.router_webhook, "/webhooks/{id}/reactivate", "POST"),
        (api_webhook.router_webhook, "/webhooks", "GET"),
    ],
)
def test_sync_management_routes_require_maintenance_role(router: object, path: str, method: str) -> None:
    route = _find_route(router, path, method)

    assert _dependency_names(route) == {"get_session", "_check_user_role"}


@pytest.mark.parametrize(
    ("router", "path", "method", "expected_status", "response_codes"),
    [
        (api_admin.router_admin, "/admin/changelogs", "GET", 200, {401, 403, 500}),
        (api_admin.router_admin, "/admin/snapshots", "GET", 200, {401, 403, 500}),
        (api_admin.router_admin, "/admin/snapshots/{id}", "GET", 200, {401, 403, 404, 500}),
        (api_admin.router_admin, "/admin/snapshots/cleanup", "POST", 200, {401, 403, 500}),
        (api_admin.router_admin, "/admin/changelogs/cleanup", "POST", 200, {401, 403, 500}),
        (api_webhook.router_webhook, "/webhooks", "POST", 201, {400, 401, 403, 500}),
        (api_webhook.router_webhook, "/webhooks/{id}", "GET", 200, {401, 403, 404, 500}),
        (api_webhook.router_webhook, "/webhooks/{id}", "PUT", 200, {400, 401, 403, 404, 500}),
        (api_webhook.router_webhook, "/webhooks/{id}", "DELETE", 204, {401, 403, 404, 500}),
        (api_webhook.router_webhook, "/webhooks/{id}/reactivate", "POST", 200, {401, 403, 404, 500}),
        (api_webhook.router_webhook, "/webhooks", "GET", 200, {401, 403, 500}),
    ],
)
def test_sync_admin_and_webhook_routes_declare_contract_metadata(
    router: object, path: str, method: str, expected_status: int, response_codes: set[int]
) -> None:
    route = _find_route(router, path, method)

    assert route.summary
    assert route.status_code == expected_status
    assert response_codes <= set(route.responses)
