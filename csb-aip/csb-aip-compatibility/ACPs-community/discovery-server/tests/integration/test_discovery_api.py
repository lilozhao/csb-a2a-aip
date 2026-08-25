from __future__ import annotations

import asyncio
from typing import TYPE_CHECKING

import pytest

from app.discovery import discovery_api as discovery_api_module
from app.discovery.schema import DiscoveryRequest, DiscoveryResponse, DiscoveryResult

if TYPE_CHECKING:
    from httpx import AsyncClient

    from app.core.dependencies import ServiceRuntime

pytestmark = pytest.mark.integration


async def test_discovery_health_endpoint_reflects_runtime_mode(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    service_runtime: ServiceRuntime,
) -> None:
    monkeypatch.setattr(service_runtime.settings, "DISCOVERY_MODE", "gpu")

    response = await client.get("/acps-adp-v2/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "healthy"
    assert payload["mode"] == "gpu"
    assert payload["forwarderHealthy"] is False


async def test_stats_endpoint_reports_seeded_counts(
    client: AsyncClient,
    seeded_database_counts: dict[str, int],
    service_runtime: ServiceRuntime,
) -> None:
    response = await client.get("/acps-adp-v2/stats")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["data"]["agents"] == seeded_database_counts["agents"]
    assert payload["data"]["skills"] == seeded_database_counts["skills"]
    assert payload["server_type"] == service_runtime.settings.DISCOVERY_MODE


async def test_available_agents_count_endpoint_reports_cached_rows(
    client: AsyncClient,
    available_agents_runtime_rows: list[str],
) -> None:
    response = await client.get("/acps-adp-v2/available-agents-count")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "ok"
    assert payload["data"]["total_active_agents"] == len(available_agents_runtime_rows)
    assert payload["data"]["available_agents"] == 2
    assert payload["data"]["available_aics"] == available_agents_runtime_rows[:2]


async def test_forwarder_status_endpoint_reports_not_configured(client: AsyncClient) -> None:
    response = await client.get("/acps-adp-v2/forwarder-status")

    assert response.status_code == 200
    payload = response.json()
    assert payload["enabled"] is False
    assert payload["healthy"] is False
    assert payload["status"] == "not_configured"


async def test_filtered_discover_endpoint_returns_seeded_skill(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_discover_request(
        request: DiscoveryRequest,
        *,
        runtime: object | None = None,
    ) -> DiscoveryResponse:
        del runtime
        await asyncio.sleep(0)
        assert request.type == "filtered"
        return DiscoveryResponse.success(
            result=DiscoveryResult(
                acsMap={"agent.filtered.1": {"aic": "agent.filtered.1"}},
                agents=[
                    {
                        "group": "filtered",
                        "agentSkills": [
                            {
                                "aic": "agent.filtered.1",
                                "skillId": "beijing_catering.traditional-food-recommendation",
                                "ranking": 1,
                                "memo": "Filtered query result",
                            }
                        ],
                    }
                ],
                routes=[],
            )
        )

    monkeypatch.setattr(discovery_api_module, "discover_request", fake_discover_request)

    response = await client.post(
        "/acps-adp-v2/discover",
        json={
            "type": "filtered",
            "limit": 5,
            "filter": {
                "conditions": [
                    {
                        "field": "skills.id",
                        "op": "eq",
                        "value": "beijing_catering.traditional-food-recommendation",
                    }
                ]
            },
        },
    )

    assert response.status_code == 200
    payload = response.json()
    agent_group = payload["result"]["agents"][0]
    agent_skill = agent_group["agentSkills"][0]
    assert agent_group["group"] == "filtered"
    assert agent_skill["skillId"] == "beijing_catering.traditional-food-recommendation"
    assert agent_skill["aic"] in payload["result"]["acsMap"]


async def test_trending_discover_endpoint_returns_ranked_results(
    client: AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def fake_discover_request(
        request: DiscoveryRequest,
        *,
        runtime: object | None = None,
    ) -> DiscoveryResponse:
        del runtime
        await asyncio.sleep(0)
        assert request.type == "trending"
        return DiscoveryResponse.success(
            result=DiscoveryResult(
                acsMap={
                    "agent.trending.1": {"aic": "agent.trending.1"},
                    "agent.trending.2": {"aic": "agent.trending.2"},
                },
                agents=[
                    {
                        "group": "trending",
                        "agentSkills": [
                            {
                                "aic": "agent.trending.1",
                                "skillId": "skill.trending.1",
                                "ranking": 1,
                                "memo": "trending",
                            },
                            {
                                "aic": "agent.trending.2",
                                "skillId": "skill.trending.2",
                                "ranking": 2,
                                "memo": "trending",
                            },
                        ],
                    }
                ],
                routes=[],
            )
        )

    monkeypatch.setattr(discovery_api_module, "discover_request", fake_discover_request)

    response = await client.post(
        "/acps-adp-v2/discover",
        json={
            "type": "trending",
            "limit": 3,
        },
    )

    assert response.status_code == 200
    payload = response.json()
    agent_group = payload["result"]["agents"][0]
    assert agent_group["group"] == "trending"
    assert 1 <= len(agent_group["agentSkills"]) <= 3
    for item in agent_group["agentSkills"]:
        assert item["aic"] in payload["result"]["acsMap"]
        assert item["ranking"] >= 1
