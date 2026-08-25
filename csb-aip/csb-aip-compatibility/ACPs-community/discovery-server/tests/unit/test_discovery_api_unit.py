from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import config as config_module
from app.core.dependencies import ServiceRuntime
from app.discovery import discovery_api as discovery_api_module
from app.discovery.schema import DiscoveryRequest, DiscoveryResponse, DiscoveryResult

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

pytestmark = pytest.mark.unit


@asynccontextmanager
async def _unused_session_factory() -> AsyncGenerator[AsyncSession]:
    yield AsyncSession()


def _build_runtime() -> ServiceRuntime:
    return ServiceRuntime(
        settings=config_module.Settings(APP_VERSION="9.9.9", DISCOVERY_MODE="cpu"),
        session_factory=_unused_session_factory,
    )


async def test_discover_endpoint_serializes_service_response(monkeypatch: pytest.MonkeyPatch) -> None:
    response_payload = DiscoveryResponse.success(
        result=DiscoveryResult(
            acsMap={"agent.api.1": {"aic": "agent.api.1"}},
            agents=[],
            routes=[],
        )
    )

    async def fake_discover_request(
        request: DiscoveryRequest,
        *,
        runtime: ServiceRuntime | None = None,
    ) -> DiscoveryResponse:
        await asyncio.sleep(0)
        assert request.query == "北京美食"
        assert runtime is not None
        return response_payload

    monkeypatch.setattr(discovery_api_module, "validate_discovery_request", lambda request: None)
    monkeypatch.setattr(discovery_api_module, "discover_request", fake_discover_request)

    response = await discovery_api_module.discover_endpoint(
        DiscoveryRequest(query="北京美食"),
        runtime=_build_runtime(),
    )

    assert response.status_code == 200
    payload = json.loads(bytes(response.body))
    assert payload["result"]["acsMap"]["agent.api.1"]["aic"] == "agent.api.1"


async def test_get_available_agents_count_uses_payload_and_status_code(monkeypatch: pytest.MonkeyPatch) -> None:
    session_marker = AsyncSession()

    async def fake_get_available_agents_count_payload(
        *,
        session: object | None = None,
        runtime: ServiceRuntime | None = None,
    ) -> tuple[int, dict[str, object]]:
        await asyncio.sleep(0)
        assert session is session_marker
        assert runtime is not None
        return 200, {
            "status": "ok",
            "data": {
                "total_active_agents": 5,
                "available_agents": 2,
                "available_aics": ["agent.1", "agent.2"],
                "last_updated": None,
            },
            "server_type": "cpu",
        }

    monkeypatch.setattr(
        discovery_api_module,
        "get_available_agents_count_payload",
        fake_get_available_agents_count_payload,
    )

    response = await discovery_api_module.get_available_agents_count(
        session=session_marker,
        runtime=_build_runtime(),
    )

    assert response.status_code == 200
    payload = json.loads(bytes(response.body))
    assert payload["data"]["available_agents"] == 2
    assert payload["data"]["available_aics"] == ["agent.1", "agent.2"]
