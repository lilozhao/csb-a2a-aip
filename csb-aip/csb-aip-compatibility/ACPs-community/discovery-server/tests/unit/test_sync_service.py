from __future__ import annotations

import asyncio
import hashlib
import hmac
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import TYPE_CHECKING, Any

import httpx
import pytest
from fastapi import HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import config as config_module
from app.core.dependencies import ServiceRuntime
from app.sync import service as sync_service_module
from app.sync.model import DSPState, WebhookCreate, WebhookNotification

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator
    from types import TracebackType

pytestmark = pytest.mark.unit


_DEFAULT_REGISTRY_WEBHOOK_SECRET = "registry" + "-secret"
_SIGNATURE_TEST_SECRET = "test" + "-secret"


class _FakeDSPClient:
    def __init__(
        self,
        *,
        state: DSPState | None = None,
        registry_base_url: str = "https://registry.example.com",
    ) -> None:
        self.state = state
        self.registry_base_url = registry_base_url

    async def sync_once(self) -> None:
        await asyncio.sleep(0)


@asynccontextmanager
async def _unused_session_factory() -> AsyncGenerator[AsyncSession]:
    yield AsyncSession()


async def test_hard_reset_sync_state_clears_state_and_deletes_agents(monkeypatch: pytest.MonkeyPatch) -> None:
    client = _FakeDSPClient(
        state=DSPState(
            last_seq=42,
            object_versions={"acs": {"demo.agent": 1}},
            last_sync_time=datetime.now(UTC),
            needs_snapshot=False,
        )
    )

    class FakeResult:
        rowcount = 5

    class FakeTransaction:
        async def __aenter__(self) -> None:
            return None

        async def __aexit__(
            self,
            exc_type: type[BaseException] | None,
            exc: BaseException | None,
            tb: TracebackType | None,
        ) -> None:
            return None

    class FakeSession(AsyncSession):
        def __init__(self) -> None:
            self.statements: list[str] = []

        def begin(self) -> Any:
            return FakeTransaction()

        async def execute(self, *args: Any, **kwargs: Any) -> Any:
            await asyncio.sleep(0)
            if args:
                self.statements.append(str(args[0]))
            return FakeResult()

    monkeypatch.setattr(sync_service_module, "get_dsp_client", lambda: client)

    fake_session = FakeSession()
    deleted_count = await sync_service_module.hard_reset_sync_state(session=fake_session)

    assert deleted_count == 5
    assert client.state is not None
    assert client.state.last_seq is None
    assert client.state.object_versions == {}
    assert client.state.needs_snapshot is True
    assert client.state.last_sync_time is None
    assert any("TRUNCATE TABLE available_agents_runtime" in stmt for stmt in fake_session.statements)
    assert any(
        "delete from agent" in stmt.lower() or "delete from agents" in stmt.lower() for stmt in fake_session.statements
    )


async def test_process_webhook_notification_triggers_sync(monkeypatch: pytest.MonkeyPatch) -> None:
    class FakeClient:
        def __init__(self) -> None:
            self.sync_once_called = False

        async def sync_once(self) -> None:
            await asyncio.sleep(0)
            self.sync_once_called = True

    client = FakeClient()
    notification = WebhookNotification(
        webhook_id="wh_123",
        event="data_change",
        timestamp="2026-05-01T00:00:00Z",
        data={"agent_id": "demo.agent", "version": 2},
    )

    monkeypatch.setattr(sync_service_module, "get_dsp_client", lambda: client)

    await sync_service_module.process_webhook_notification(notification)

    assert client.sync_once_called is True


async def test_register_webhook_with_registry_uses_injected_runtime(monkeypatch: pytest.MonkeyPatch) -> None:
    created_at = datetime.now(UTC)
    captured_request: dict[str, object] = {}

    class FakeResponse:
        status_code = 201

        def json(self) -> dict[str, object]:
            return {
                "id": "wh_123",
                "url": "https://discovery.example.com/admin/dsp/webhooks/receive",
                "types": ["acs"],
                "events": ["data_change"],
                "description": "Discovery Server自动注册的webhook",
                "status": "active",
                "failure_count": 0,
                "last_triggered_at": None,
                "last_success_at": None,
                "last_failure_at": None,
                "next_retry_at": None,
                "created_at": created_at,
                "updated_at": created_at,
            }

    class FakeAsyncClient:
        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(
            self,
            exc_type: type[BaseException] | None,
            exc: BaseException | None,
            tb: TracebackType | None,
        ) -> None:
            return None

        async def post(self, url: str, json: dict[str, object], **kwargs: object) -> FakeResponse:
            await asyncio.sleep(0)
            captured_request.update({"url": url, "json": json, **kwargs})
            return FakeResponse()

    runtime = ServiceRuntime(
        settings=config_module.Settings(
            DSP_WEBHOOK_RECEIVE_URL="https://discovery.example.com/admin/dsp/webhooks/receive"
        ),
        session_factory=_unused_session_factory,
    )
    webhook_data = WebhookCreate(
        url="https://cli-provided.example.com/admin/dsp/webhooks/receive",
        secret=_DEFAULT_REGISTRY_WEBHOOK_SECRET,
        types=["acs"],
        events=["data_change"],
    )

    monkeypatch.setattr(sync_service_module, "get_dsp_client", lambda: _FakeDSPClient())
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    response = await sync_service_module.register_webhook_with_registry(
        webhook_data,
        runtime=runtime,
        authorization_header="Bearer admin-token",
    )

    assert response.url == "https://discovery.example.com/admin/dsp/webhooks/receive"
    assert captured_request == {
        "url": "https://registry.example.com/webhooks",
        "json": {
            "url": "https://cli-provided.example.com/admin/dsp/webhooks/receive",
            "secret": _DEFAULT_REGISTRY_WEBHOOK_SECRET,
            "types": ["acs"],
            "events": ["data_change"],
            "description": "Discovery Server自动注册的webhook",
        },
        "headers": {"Authorization": "Bearer admin-token"},
        "timeout": 30.0,
    }


def test_verify_webhook_signature_accepts_matching_hmac() -> None:
    secret = _SIGNATURE_TEST_SECRET
    timestamp = "1745939131"
    payload = '{"event":"data_change"}'
    expected_signature = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.{payload}".encode(),
        hashlib.sha256,
    ).hexdigest()

    assert sync_service_module.verify_webhook_signature(
        secret,
        timestamp,
        payload,
        f"sha256={expected_signature}",
    )


def test_verify_webhook_signature_rejects_invalid_signature() -> None:
    assert not sync_service_module.verify_webhook_signature(
        "test-secret",
        "1745939131",
        '{"event":"data_change"}',
        "sha256=invalid",
    )


async def test_register_webhook_with_registry_raises_when_registry_returns_non_201(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class FakeResponse:
        status_code = 500
        text = "registry failed"

    class FakeAsyncClient:
        async def __aenter__(self) -> FakeAsyncClient:
            return self

        async def __aexit__(
            self,
            exc_type: type[BaseException] | None,
            exc: BaseException | None,
            tb: TracebackType | None,
        ) -> None:
            return None

        async def post(self, url: str, json: dict[str, object], **kwargs: object) -> FakeResponse:
            await asyncio.sleep(0)
            assert url == "https://registry.example.com/webhooks"
            assert json["url"] == "https://cli-provided.example.com/admin/dsp/webhooks/receive"
            assert kwargs["headers"] == {"Authorization": "Bearer admin-token"}
            assert kwargs["timeout"] == pytest.approx(30.0)
            return FakeResponse()

    webhook_data = WebhookCreate(
        url="https://cli-provided.example.com/admin/dsp/webhooks/receive",
        secret=_DEFAULT_REGISTRY_WEBHOOK_SECRET,
        types=["acs"],
        events=["data_change"],
    )

    monkeypatch.setattr(sync_service_module, "get_dsp_client", lambda: _FakeDSPClient())
    monkeypatch.setattr(httpx, "AsyncClient", FakeAsyncClient)

    with pytest.raises(HTTPException) as exc_info:
        await sync_service_module.register_webhook_with_registry(
            webhook_data,
            runtime=ServiceRuntime(
                settings=config_module.Settings(
                    DSP_WEBHOOK_RECEIVE_URL="https://discovery.example.com/admin/dsp/webhooks/receive"
                ),
                session_factory=_unused_session_factory,
            ),
            authorization_header="Bearer admin-token",
        )

    assert exc_info.value.status_code == 500
    assert exc_info.value.detail == "向Registry注册webhook失败: registry failed"


async def test_register_webhook_with_registry_requires_bearer_token() -> None:
    webhook_data = WebhookCreate(
        url="https://cli-provided.example.com/admin/dsp/webhooks/receive",
        secret=_DEFAULT_REGISTRY_WEBHOOK_SECRET,
        types=["acs"],
        events=["data_change"],
    )

    with pytest.raises(HTTPException) as exc_info:
        await sync_service_module.register_webhook_with_registry(
            webhook_data,
            runtime=ServiceRuntime(
                settings=config_module.Settings(
                    DSP_WEBHOOK_RECEIVE_URL="https://discovery.example.com/admin/dsp/webhooks/receive"
                ),
                session_factory=_unused_session_factory,
            ),
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "缺少 Registry webhook 注册所需的 Bearer token"


async def test_register_webhook_with_registry_requires_target_url(monkeypatch: pytest.MonkeyPatch) -> None:
    webhook_data = WebhookCreate(
        url="",
        secret=_DEFAULT_REGISTRY_WEBHOOK_SECRET,
        types=["acs"],
        events=["data_change"],
    )

    monkeypatch.setattr(sync_service_module, "get_dsp_client", lambda: _FakeDSPClient())

    with pytest.raises(HTTPException) as exc_info:
        await sync_service_module.register_webhook_with_registry(
            webhook_data,
            runtime=ServiceRuntime(
                settings=config_module.Settings(DSP_WEBHOOK_RECEIVE_URL=""),
                session_factory=_unused_session_factory,
            ),
            authorization_header="Bearer admin-token",
        )

    assert exc_info.value.status_code == 400
    assert exc_info.value.detail == "缺少 webhook 回调地址：请在请求中提供 url 或配置 DSP_WEBHOOK_RECEIVE_URL"
