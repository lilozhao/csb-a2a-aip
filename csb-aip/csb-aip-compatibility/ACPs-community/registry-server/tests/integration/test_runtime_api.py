"""真实数据库集成测试：运行时公共端点。"""

from __future__ import annotations

import pytest

pytestmark = pytest.mark.integration


async def test_root_returns_discovery_metadata(client) -> None:
    response = await client.get("/")

    assert response.status_code == 200
    assert response.json() == {
        "message": "Welcome to the Agent Internet Backend API",
        "docs_url": "/docs",
        "redoc_url": "/redoc",
    }


async def test_health_returns_ok(client) -> None:
    response = await client.get("/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_ready_returns_ready_when_database_is_available(client) -> None:
    response = await client.get("/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ready"}


async def test_metrics_exposes_prometheus_payload(client) -> None:
    response = await client.get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "# HELP" in response.text
