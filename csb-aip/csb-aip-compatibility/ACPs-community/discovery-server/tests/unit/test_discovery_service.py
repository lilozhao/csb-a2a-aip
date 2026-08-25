from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any

import pytest
from acps_sdk.adp import FilterCondition, FilterOperator
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import config as config_module
from app.core.dependencies import ServiceRuntime
from app.discovery import service as discovery_service_module
from app.discovery.exception import ADPError
from app.discovery.schema import DiscoveryFilter, DiscoveryFilters, DiscoveryRequest, DiscoveryResponse, DiscoveryResult

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

pytestmark = pytest.mark.unit


@dataclass(slots=True)
class _ForwarderConfig:
    forwarder_server_enabled: bool
    forwarder_fallback_to_local: bool
    forwarder_server_url: str = "http://forwarder.example.com/acps-adp-v2"
    forwarder_server_timeout: float = 5.0
    forwarder_health_check_interval: int = 60
    forwarder_request_retries: int = 2


@dataclass(slots=True)
class _ForwarderStats:
    total_requests: int
    forwarder_requests: int
    forwarder_success: int
    forwarder_failures: int
    local_fallback: int
    forwarder_success_rate: float
    forwarder_usage_rate: float


@asynccontextmanager
async def _unused_session_factory() -> AsyncGenerator[AsyncSession]:
    yield AsyncSession()


def _build_runtime(mode: str = "cpu") -> ServiceRuntime:
    return ServiceRuntime(
        settings=config_module.Settings(APP_VERSION="9.9.9", DISCOVERY_MODE=mode),
        session_factory=_unused_session_factory,
    )


async def test_get_database_stats_payload_uses_injected_session_and_runtime() -> None:
    class FakeResult:
        def __init__(self, value: int) -> None:
            self._value = value

        def scalar(self) -> int:
            return self._value

    class FakeSession(AsyncSession):
        def __init__(self) -> None:
            self._call_count = 0

        async def execute(self, *args: Any, **kwargs: Any) -> Any:
            await asyncio.sleep(0)
            self._call_count += 1
            return FakeResult(3 if self._call_count == 1 else 7)

    runtime = _build_runtime()

    status_code, payload = await discovery_service_module.get_database_stats_payload(
        session=FakeSession(),
        runtime=runtime,
    )

    assert status_code == 200
    assert payload["status"] == "ok"
    assert payload["data"] == {"agents": 3, "skills": 7}
    assert payload["server_type"] == "cpu"


async def test_get_forwarder_status_payload_refreshes_health(monkeypatch: pytest.MonkeyPatch) -> None:
    config = _ForwarderConfig(
        forwarder_server_enabled=True,
        forwarder_server_url="http://forwarder.example.com/acps-adp-v2",
        forwarder_server_timeout=5.0,
        forwarder_health_check_interval=60,
        forwarder_fallback_to_local=True,
        forwarder_request_retries=2,
    )
    stats = _ForwarderStats(
        total_requests=10,
        forwarder_requests=8,
        forwarder_success=7,
        forwarder_failures=1,
        local_fallback=1,
        forwarder_success_rate=87.5,
        forwarder_usage_rate=80.0,
    )

    async def fake_check_forwarder_health() -> bool:
        await asyncio.sleep(0)
        return True

    monkeypatch.setattr(discovery_service_module, "get_config", lambda: config)
    monkeypatch.setattr(discovery_service_module, "get_stats", lambda: stats)
    monkeypatch.setattr(discovery_service_module, "check_forwarder_health", fake_check_forwarder_health)

    payload = await discovery_service_module.get_forwarder_status_payload()

    assert payload["enabled"] is True
    assert payload["healthy"] is True
    assert payload["status"] == "available"
    assert payload["last_check_time"] is not None
    assert payload["stats"]["forwarder_success"] == 7


async def test_local_discover_filtered_translates_filter_and_builds_single_group(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    captured: dict[str, object] = {}

    async def fake_filter_agents_async(*, filters: object, limit: int) -> tuple[list[dict[str, object]], float]:
        await asyncio.sleep(0)
        captured["filters"] = filters
        captured["limit"] = limit
        return (
            [
                {
                    "acs": {"aic": "agent.filtered.1"},
                    "skill_id": "skill.filtered.1",
                    "ranking": 1,
                    "memo": "Filtered query result",
                }
            ],
            12.5,
        )

    monkeypatch.setattr(discovery_service_module.discovery_service, "filter_agents_async", fake_filter_agents_async)

    request = DiscoveryRequest(
        type="filtered",
        limit=3,
        filter=DiscoveryFilter(
            conditions=[
                FilterCondition(
                    field="provider.organization",
                    op=FilterOperator.EQ,
                    value="北京邮电大学",
                )
            ]
        ),
    )

    response = await discovery_service_module.local_discover(request, runtime=_build_runtime())

    translated_filters = captured["filters"]
    assert captured["limit"] == 3
    assert isinstance(translated_filters, DiscoveryFilters)
    assert translated_filters.providerOrganizations == ["北京邮电大学"]
    assert response.result is not None
    assert response.result.agents[0].group == "filtered"
    assert response.result.agents[0].agent_skills[0].aic == "agent.filtered.1"


async def test_local_discover_trending_builds_trending_group(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_discover_agents_trending(*, filters: object, limit: int) -> tuple[list[dict[str, object]], float]:
        await asyncio.sleep(0)
        assert filters is None
        assert limit == 2
        return (
            [
                {
                    "acs": {"aic": "agent.trending.1"},
                    "skill_id": "skill.trending.1",
                    "ranking": 1,
                    "memo": "trending",
                }
            ],
            18.0,
        )

    monkeypatch.setattr(
        discovery_service_module.discovery_service, "discover_agents_trending", fake_discover_agents_trending
    )

    response = await discovery_service_module.local_discover(
        DiscoveryRequest(type="trending", limit=2),
        runtime=_build_runtime(mode="gpu"),
    )

    assert response.result is not None
    assert response.result.agents[0].group == "trending"
    assert response.result.agents[0].agent_skills[0].skill_id == "skill.trending.1"


async def test_local_discover_rejects_exploratory_request_in_cpu_mode() -> None:
    request = DiscoveryRequest(type="exploratory", query="帮我拆解北京旅行计划")

    with pytest.raises(ADPError) as exc_info:
        await discovery_service_module.local_discover(request, runtime=_build_runtime(mode="cpu"))

    assert exc_info.value.error_data.code == 40005
    assert exc_info.value.error_data.message == "UnsupportedQueryType"


async def test_discover_request_returns_forwarder_payload_when_available(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = DiscoveryResponse.success(result=DiscoveryResult(acsMap={}, agents=[], routes=[]))
    recorded_calls: list[dict[str, bool]] = []

    async def fake_forward_to_forwarder(_request: DiscoveryRequest) -> DiscoveryResponse:
        await asyncio.sleep(0)
        return expected

    async def fake_local_discover(_request: DiscoveryRequest, *, runtime: object = None) -> DiscoveryResponse:
        raise AssertionError("forwarder 命中时不应回退本地")

    monkeypatch.setattr(
        discovery_service_module,
        "get_config",
        lambda: _ForwarderConfig(forwarder_server_enabled=True, forwarder_fallback_to_local=True),
    )
    monkeypatch.setattr(discovery_service_module, "get_forwarder_health_status", lambda: True)
    monkeypatch.setattr(discovery_service_module, "forward_to_forwarder", fake_forward_to_forwarder)
    monkeypatch.setattr(discovery_service_module, "local_discover", fake_local_discover)
    monkeypatch.setattr(discovery_service_module, "record_request", lambda **kwargs: recorded_calls.append(kwargs))

    response = await discovery_service_module.discover_request(
        DiscoveryRequest(query="北京美食"),
        runtime=_build_runtime(),
    )

    assert response == expected
    assert recorded_calls == [{"used_forwarder": True, "success": True}]


async def test_discover_request_falls_back_to_local_when_forwarder_returns_none(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = DiscoveryResponse.success(
        result=DiscoveryResult(
            acsMap={"agent.local.1": {"aic": "agent.local.1"}},
            agents=[],
            routes=[],
        )
    )
    recorded_calls: list[dict[str, bool]] = []

    async def fake_forward_to_forwarder(_request: DiscoveryRequest) -> None:
        await asyncio.sleep(0)
        return

    async def fake_local_discover(_request: DiscoveryRequest, *, runtime: object = None) -> DiscoveryResponse:
        await asyncio.sleep(0)
        assert runtime is not None
        return expected

    monkeypatch.setattr(
        discovery_service_module,
        "get_config",
        lambda: _ForwarderConfig(forwarder_server_enabled=True, forwarder_fallback_to_local=True),
    )
    monkeypatch.setattr(discovery_service_module, "get_forwarder_health_status", lambda: True)
    monkeypatch.setattr(discovery_service_module, "forward_to_forwarder", fake_forward_to_forwarder)
    monkeypatch.setattr(discovery_service_module, "local_discover", fake_local_discover)
    monkeypatch.setattr(discovery_service_module, "record_request", lambda **kwargs: recorded_calls.append(kwargs))

    response = await discovery_service_module.discover_request(
        DiscoveryRequest(query="北京交通"),
        runtime=_build_runtime(),
    )

    assert response == expected
    assert recorded_calls == [{"used_forwarder": True, "success": False}]


async def test_discover_request_raises_when_forwarder_fails_and_fallback_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded_calls: list[dict[str, bool]] = []

    async def fake_forward_to_forwarder(_request: DiscoveryRequest) -> None:
        await asyncio.sleep(0)
        return

    monkeypatch.setattr(
        discovery_service_module,
        "get_config",
        lambda: _ForwarderConfig(forwarder_server_enabled=True, forwarder_fallback_to_local=False),
    )
    monkeypatch.setattr(discovery_service_module, "get_forwarder_health_status", lambda: True)
    monkeypatch.setattr(discovery_service_module, "forward_to_forwarder", fake_forward_to_forwarder)
    monkeypatch.setattr(discovery_service_module, "record_request", lambda **kwargs: recorded_calls.append(kwargs))

    with pytest.raises(ADPError) as exc_info:
        await discovery_service_module.discover_request(DiscoveryRequest(query="北京酒店"), runtime=_build_runtime())

    assert exc_info.value.error_data.message == "ForwarderUnavailable"
    assert recorded_calls == [{"used_forwarder": True, "success": False}]


async def test_discover_request_falls_back_to_local_when_forwarder_unhealthy(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    expected = DiscoveryResponse.success(
        result=DiscoveryResult(
            acsMap={"agent.local.2": {"aic": "agent.local.2"}},
            agents=[],
            routes=[],
        )
    )
    recorded_calls: list[dict[str, bool]] = []

    async def fake_forward_to_forwarder(_request: DiscoveryRequest) -> DiscoveryResponse:
        raise AssertionError("forwarder unhealthy 时不应发起转发请求")

    async def fake_local_discover(_request: DiscoveryRequest, *, runtime: object = None) -> DiscoveryResponse:
        await asyncio.sleep(0)
        assert runtime is not None
        return expected

    monkeypatch.setattr(
        discovery_service_module,
        "get_config",
        lambda: _ForwarderConfig(forwarder_server_enabled=True, forwarder_fallback_to_local=True),
    )
    monkeypatch.setattr(discovery_service_module, "get_forwarder_health_status", lambda: False)
    monkeypatch.setattr(discovery_service_module, "forward_to_forwarder", fake_forward_to_forwarder)
    monkeypatch.setattr(discovery_service_module, "local_discover", fake_local_discover)
    monkeypatch.setattr(discovery_service_module, "record_request", lambda **kwargs: recorded_calls.append(kwargs))

    response = await discovery_service_module.discover_request(
        DiscoveryRequest(query="上海美食"),
        runtime=_build_runtime(),
    )

    assert response == expected
    assert recorded_calls == [{"used_forwarder": True, "success": False}]


async def test_discover_request_raises_when_forwarder_unhealthy_and_fallback_disabled(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    recorded_calls: list[dict[str, bool]] = []

    async def fake_forward_to_forwarder(_request: DiscoveryRequest) -> DiscoveryResponse:
        raise AssertionError("forwarder unhealthy 时不应发起转发请求")

    async def fake_local_discover(_request: DiscoveryRequest, *, runtime: object = None) -> DiscoveryResponse:
        raise AssertionError("fallback 禁用时不应回退本地处理")

    monkeypatch.setattr(
        discovery_service_module,
        "get_config",
        lambda: _ForwarderConfig(forwarder_server_enabled=True, forwarder_fallback_to_local=False),
    )
    monkeypatch.setattr(discovery_service_module, "get_forwarder_health_status", lambda: False)
    monkeypatch.setattr(discovery_service_module, "forward_to_forwarder", fake_forward_to_forwarder)
    monkeypatch.setattr(discovery_service_module, "local_discover", fake_local_discover)
    monkeypatch.setattr(discovery_service_module, "record_request", lambda **kwargs: recorded_calls.append(kwargs))

    with pytest.raises(ADPError) as exc_info:
        await discovery_service_module.discover_request(DiscoveryRequest(query="上海酒店"), runtime=_build_runtime())

    assert exc_info.value.error_data.message == "ForwarderUnavailable"
    assert recorded_calls == [{"used_forwarder": True, "success": False}]
