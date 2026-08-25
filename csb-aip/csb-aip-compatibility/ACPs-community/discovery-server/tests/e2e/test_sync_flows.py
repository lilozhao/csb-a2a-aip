from __future__ import annotations

import json

import httpx
import pytest

from tests.e2e.helpers import get_base_url

pytestmark = pytest.mark.e2e


def test_dsp_status_and_reset_endpoints_work_as_black_box() -> None:
    with httpx.Client(base_url=get_base_url(), timeout=5.0) as client:
        status_response = client.get("/admin/dsp/status")
        reset_response = client.post("/admin/dsp/reset")
        status_after_reset_response = client.get("/admin/dsp/status")

    assert status_response.status_code == 200
    status_payload = status_response.json()
    assert "is_running" in status_payload
    assert "needs_snapshot" in status_payload
    assert "registry_url" in status_payload

    assert reset_response.status_code == 200
    assert reset_response.json()["message"] == "DSP 同步状态重置成功"

    assert status_after_reset_response.status_code == 200
    assert status_after_reset_response.json()["needs_snapshot"] is True


def test_webhook_receive_endpoint_rejects_invalid_signature() -> None:
    body = json.dumps(
        {
            "webhook_id": "wh_e2e_invalid",
            "event": "data_change",
            "timestamp": "2026-04-30T10:00:00Z",
            "data": {"type": "acs", "id": "agent.1"},
        }
    )

    with httpx.Client(base_url=get_base_url(), timeout=5.0) as client:
        response = client.post(
            "/admin/dsp/webhooks/receive",
            content=body,
            headers={
                "content-type": "application/json",
                "X-Webhook-ID": "wh_e2e_invalid",
                "X-Webhook-Signature": "sha256=invalid",
                "X-Webhook-Timestamp": "1746007200",
            },
        )

    assert response.status_code == 401
    assert response.json()["detail"] == "Invalid signature"
