from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    from httpx import AsyncClient

pytestmark = pytest.mark.integration


async def test_root_health_and_ready_endpoints_report_service_status(client: AsyncClient) -> None:
    root_response = await client.get("/")
    health_response = await client.get("/health")
    ready_response = await client.get("/ready")

    assert root_response.status_code == 200
    assert health_response.status_code == 200
    assert ready_response.status_code == 200

    root_payload = root_response.json()
    assert root_payload["status"] == "healthy"
    assert root_payload["service"]
    assert root_payload["version"]
    assert "runtime" in root_payload

    assert health_response.json() == {"status": "ok"}
    assert ready_response.json() == {"status": "ready"}


async def test_metrics_endpoint_exposes_prometheus_payload(client: AsyncClient) -> None:
    response = await client.get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain; version=0.0.4")
    assert "discovery_server_up 1" in response.text
    assert "discovery_server_database_ready 1" in response.text
    assert "discovery_server_semantic_matcher_running 0" in response.text
