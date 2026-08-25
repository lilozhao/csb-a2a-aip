from __future__ import annotations

import httpx
import pytest

from tests.e2e.helpers import (
    ensure_seeded_stats,
    get_base_url,
    get_expected_mode,
    get_filtered_provider_organization,
)

pytestmark = pytest.mark.e2e


def test_ready_metrics_and_stats_endpoints_report_seeded_state() -> None:
    with httpx.Client(base_url=get_base_url(), timeout=5.0) as client:
        ready_response = client.get("/ready")
        metrics_response = client.get("/metrics")
        health_response = client.get("/acps-adp-v2/health")
        seeded_stats = ensure_seeded_stats(client)

    assert ready_response.status_code == 200
    assert ready_response.json() == {"status": "ready"}

    assert metrics_response.status_code == 200
    assert "discovery_server_up 1" in metrics_response.text
    assert "discovery_server_database_ready 1" in metrics_response.text

    assert health_response.status_code == 200
    assert health_response.json()["mode"] == get_expected_mode()
    assert seeded_stats["agents"] > 0
    assert seeded_stats["skills"] > 0


def test_filtered_discover_endpoint_returns_seeded_results() -> None:
    with httpx.Client(base_url=get_base_url(), timeout=5.0) as client:
        ensure_seeded_stats(client)
        response = client.post(
            "/acps-adp-v2/discover",
            json={
                "type": "filtered",
                "limit": 5,
                "filter": {
                    "conditions": [
                        {
                            "field": "provider.organization",
                            "op": "eq",
                            "value": get_filtered_provider_organization(),
                        }
                    ]
                },
            },
        )

    assert response.status_code == 200
    payload = response.json()
    agent_group = payload["result"]["agents"][0]
    assert agent_group["group"] == "filtered"
    assert len(agent_group["agentSkills"]) >= 1
    for item in agent_group["agentSkills"]:
        assert item["aic"] in payload["result"]["acsMap"]


def test_trending_discover_endpoint_returns_ranked_results() -> None:
    with httpx.Client(base_url=get_base_url(), timeout=5.0) as client:
        ensure_seeded_stats(client)
        response = client.post(
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
