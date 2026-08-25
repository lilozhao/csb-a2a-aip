from __future__ import annotations

import httpx
import pytest

from tests.e2e.helpers import get_base_url, get_expected_mode

pytestmark = pytest.mark.e2e


def _get_base_url() -> str:
    return get_base_url()


def test_root_endpoint_reports_service_status() -> None:
    with httpx.Client(base_url=_get_base_url(), timeout=5.0) as client:
        response = client.get("/")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "healthy"
    assert payload["service"]
    assert payload["version"]
    assert payload["description"]
    assert "runtime" in payload


def test_discovery_health_endpoint_reports_healthy() -> None:
    with httpx.Client(base_url=_get_base_url(), timeout=5.0) as client:
        response = client.get("/acps-adp-v2/health")

    assert response.status_code == 200
    payload = response.json()
    assert payload["status"] == "healthy"
    assert payload["service"] == "discovery-unified"
    assert payload["mode"] == get_expected_mode()
    assert "forwarderHealthy" in payload
