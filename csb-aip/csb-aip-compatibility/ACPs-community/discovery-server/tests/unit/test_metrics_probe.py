from __future__ import annotations

import pytest
from fastapi import FastAPI, Request

from app import main as app_main
from app.core import health_probe as health_probe_module

pytestmark = pytest.mark.unit


class _FakeRuntimeServices:
    def snapshot(self) -> dict[str, object]:
        return {
            "semantic_matcher": {"running": True, "last_error": None},
            "dsp_sync": {"running": False, "last_error": None},
            "forwarder_health_check": {"running": True, "last_error": None},
            "available_agents_polling": {"running": False, "last_error": None},
            "total_active_agents": 7,
            "available_agents_count": 5,
        }


def test_build_health_status_returns_ok_payload() -> None:
    assert health_probe_module.build_health_status() == {"status": "ok"}


def test_build_metrics_payload_includes_base_gauges() -> None:
    app = FastAPI()

    payload = health_probe_module.build_metrics_payload(app, database_ready=True)

    assert "discovery_server_up 1" in payload
    assert "discovery_server_database_ready 1" in payload


def test_build_metrics_payload_includes_runtime_gauges() -> None:
    app = FastAPI()
    app.state.runtime_services = _FakeRuntimeServices()

    payload = health_probe_module.build_metrics_payload(app, database_ready=False)

    assert "discovery_server_database_ready 0" in payload
    assert "discovery_server_semantic_matcher_running 1" in payload
    assert "discovery_server_dsp_sync_running 0" in payload
    assert "discovery_server_total_active_agents 7" in payload
    assert "discovery_server_available_agents_count 5" in payload


async def test_metrics_returns_prometheus_payload(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_check_database_ready() -> bool:
        return True

    app = FastAPI()
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/metrics",
        "headers": [],
        "app": app,
    }
    request = Request(scope)

    monkeypatch.setattr(app_main, "check_database_ready", fake_check_database_ready)

    response = await app_main.metrics(request)

    assert response.status_code == 200
    assert response.media_type == health_probe_module.PROMETHEUS_CONTENT_TYPE
    assert b"discovery_server_up 1" in response.body


async def test_health_returns_ok_payload() -> None:
    assert await app_main.health() == {"status": "ok"}
