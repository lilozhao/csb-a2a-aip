from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import TYPE_CHECKING, ClassVar

import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.requests import Request

from app.core import config as config_module
from app.core.dependencies import ServiceRuntime
from app.sync import api as sync_api_module
from app.sync.model import WebhookCreate, WebhookNotification, WebhookResponse

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

pytestmark = pytest.mark.unit


_DEFAULT_WEBHOOK_SECRET = "shared" + "-secret"


@asynccontextmanager
async def _unused_session_factory() -> AsyncGenerator[AsyncSession]:
    yield AsyncSession()


def _build_runtime(secret: str | None = None) -> ServiceRuntime:
    webhook_secret = secret or _DEFAULT_WEBHOOK_SECRET
    return ServiceRuntime(
        settings=config_module.Settings(DSP_WEBHOOK_SECRET=webhook_secret),
        session_factory=_unused_session_factory,
    )


def _build_request(
    body: bytes,
    *,
    path: str = "/admin/dsp/webhooks/receive",
    headers: list[tuple[bytes, bytes]] | None = None,
) -> Request:
    async def receive() -> dict[str, object]:
        await asyncio.sleep(0)
        return {"type": "http.request", "body": body, "more_body": False}

    return Request(
        scope={
            "type": "http",
            "method": "POST",
            "path": path,
            "headers": headers or [],
        },
        receive=receive,
    )


async def test_receive_webhook_rejects_invalid_signature() -> None:
    body = json.dumps(
        {
            "webhook_id": "wh_123",
            "event": "data_change",
            "timestamp": "2026-04-30T10:00:00Z",
            "data": {"type": "acs"},
        }
    ).encode("utf-8")

    with pytest.raises(HTTPException) as exc_info:
        await sync_api_module.receive_webhook(
            request=_build_request(body),
            x_webhook_id="wh_123",
            x_webhook_signature="sha256=invalid",
            x_webhook_timestamp="1746007200",
            runtime=_build_runtime(),
        )

    assert exc_info.value.status_code == 401
    assert exc_info.value.detail == "Invalid signature"


async def test_receive_webhook_returns_acknowledged_for_valid_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    captured_notification: dict[str, object] = {}
    runtime = _build_runtime(secret=None)
    body = json.dumps(
        {
            "webhook_id": "wh_456",
            "event": "data_change",
            "timestamp": "2026-04-30T10:00:00Z",
            "data": {"type": "acs", "id": "agent.1"},
        }
    ).encode("utf-8")
    signature = hmac.new(
        _DEFAULT_WEBHOOK_SECRET.encode(),
        f"1746007200.{body.decode('utf-8')}".encode(),
        hashlib.sha256,
    ).hexdigest()

    async def fake_process_webhook_notification(notification: WebhookNotification) -> None:
        await asyncio.sleep(0)
        captured_notification.update(notification.model_dump())

    monkeypatch.setattr(sync_api_module, "process_webhook_notification", fake_process_webhook_notification)

    response = await sync_api_module.receive_webhook(
        request=_build_request(body),
        x_webhook_id="wh_456",
        x_webhook_signature=f"sha256={signature}",
        x_webhook_timestamp="1746007200",
        runtime=runtime,
    )

    assert response.status == "acknowledged"
    assert captured_notification["webhook_id"] == "wh_456"
    assert captured_notification["data"] == {"type": "acs", "id": "agent.1"}


async def test_register_webhook_endpoint_returns_service_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    expected = WebhookResponse(
        id="wh_789",
        url="https://discovery.example.com/admin/dsp/webhooks/receive",
        types=["acs"],
        events=["data_change"],
        description="demo webhook",
        status="active",
        failure_count=0,
        last_triggered_at=None,
        last_success_at=None,
        last_failure_at=None,
        next_retry_at=None,
        created_at=datetime(2026, 4, 30, 10, 0, tzinfo=UTC),
        updated_at=datetime(2026, 4, 30, 10, 0, tzinfo=UTC),
    )

    async def fake_register_webhook_with_registry(
        webhook_data: WebhookCreate,
        *,
        runtime: ServiceRuntime | None = None,
        authorization_header: str | None = None,
    ) -> WebhookResponse:
        await asyncio.sleep(0)
        assert webhook_data.secret == _DEFAULT_WEBHOOK_SECRET
        assert runtime is not None
        assert authorization_header == "Bearer admin-token"
        return expected

    monkeypatch.setattr(sync_api_module, "register_webhook_with_registry", fake_register_webhook_with_registry)

    response = await sync_api_module.register_webhook(
        WebhookCreate(
            url="https://unused.example.com",
            secret=_DEFAULT_WEBHOOK_SECRET,
            types=["acs"],
            events=["data_change"],
        ),
        request=_build_request(
            b"",
            path="/admin/dsp/webhooks/register",
            headers=[(b"authorization", b"Bearer admin-token")],
        ),
        runtime=_build_runtime(),
    )

    assert response == expected


async def test_hard_reset_endpoint_commits_session(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeSession:
        def __init__(self) -> None:
            self.committed = False

        async def commit(self) -> None:
            await asyncio.sleep(0)
            self.committed = True

    fake_session = FakeSession()

    async def fake_hard_reset_sync_state(*, session: object | None = None, runtime: object | None = None) -> int:
        del runtime
        await asyncio.sleep(0)
        assert session is fake_session
        return 3

    monkeypatch.setattr(sync_api_module, "hard_reset_sync_state", fake_hard_reset_sync_state)

    response = await sync_api_module.hard_reset(session=fake_session)  # type: ignore[arg-type]

    assert response.success is True
    assert "已清空 3 条Agent记录" in response.message
    assert fake_session.committed is True


async def test_trigger_sync_endpoint_starts_background_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.trigger_calls = 0

        def trigger_sync_once(self) -> bool:
            self.trigger_calls += 1
            return True

    fake_client = FakeClient()
    monkeypatch.setattr(sync_api_module, "get_dsp_client", lambda: fake_client)

    response = await sync_api_module.trigger_sync()

    assert response.success is True
    assert response.message == "手动同步已触发"
    assert fake_client.trigger_calls == 1


async def test_trigger_sync_endpoint_reports_existing_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeClient:
        def trigger_sync_once(self) -> bool:
            return False

    monkeypatch.setattr(sync_api_module, "get_dsp_client", FakeClient)

    response = await sync_api_module.trigger_sync()

    assert response.success is True
    assert response.message == "手动同步已在执行中"


async def test_get_dsp_status_keeps_background_running_and_manual_sync_separate(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeState:
        last_seq = 42
        last_sync_time = datetime(2026, 6, 16, 0, 0, tzinfo=UTC)
        needs_snapshot = False
        object_versions: ClassVar[dict[str, dict[str, int]]] = {"acs": {"agent.1": 1}}

    class FakeClient:
        def __init__(self) -> None:
            self.is_running = True
            self.sync_interval = 60
            self.registry_base_url = "https://registry.example.com/acps-dsp-v2"
            self.state = FakeState()

        def sync_task_in_progress(self) -> bool:
            return True

    monkeypatch.setattr(sync_api_module, "get_dsp_client", FakeClient)

    response = await sync_api_module.get_dsp_status()

    assert response.is_running is True
    assert response.manual_sync_in_progress is True
    assert response.object_count_by_type == {"acs": 1}
