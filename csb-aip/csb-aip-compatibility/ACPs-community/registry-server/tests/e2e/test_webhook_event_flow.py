"""黑盒 E2E：业务变化触发 webhook 推送。"""

from __future__ import annotations

import asyncio
import json
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from typing import Any, TypedDict, cast

import pytest

from app.account.model import RoleType
from tests.support.constants import DEFAULT_LOGIN_VALUE
from tests.support.database import create_agent_with_change_log, create_user
from tests.support.http import response_json_string_map

pytestmark = pytest.mark.e2e


class RecordedWebhookRequest(TypedDict):
    path: str
    headers: dict[str, str]
    body: dict[str, Any]


def _auth_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


async def _login(client, *, username: str, password: str) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": password},
    )
    assert response.status_code == 200
    return response_json_string_map(response)


class _WebhookRecorder:
    def __init__(self) -> None:
        self.requests: list[RecordedWebhookRequest] = []
        recorder = self

        class Handler(BaseHTTPRequestHandler):
            def do_POST(self) -> None:
                content_length = int(self.headers.get("Content-Length", "0"))
                body = self.rfile.read(content_length).decode("utf-8")
                recorder.requests.append(
                    {
                        "path": self.path,
                        "headers": dict(self.headers.items()),
                        "body": cast("dict[str, Any]", json.loads(body)),
                    }
                )
                self.send_response(204)
                self.end_headers()

            def log_message(self, message_format: str, *args: object) -> None:
                del message_format, args

        self.server = HTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    @property
    def url(self) -> str:
        return f"http://127.0.0.1:{self.server.server_port}/callback"

    def start(self) -> None:
        self.thread.start()

    def close(self) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)


async def test_business_change_triggers_webhook_callback(client, db_session, e2e_run_id: str) -> None:
    recorder = _WebhookRecorder()
    recorder.start()

    try:
        staff = await create_user(
            db_session,
            username=f"webhook-staff-{e2e_run_id}",
            password=DEFAULT_LOGIN_VALUE,
            roles=(RoleType.STAFF,),
            name="Webhook Staff",
        )
        owner = await create_user(
            db_session,
            username=f"webhook-owner-{e2e_run_id}",
            password=DEFAULT_LOGIN_VALUE,
            name="Webhook Owner",
        )
        agent = await create_agent_with_change_log(
            db_session,
            aic=f"1.2.156.10197.1.301.{e2e_run_id}0001",
            name=f"Webhook Agent {e2e_run_id}",
            created_by=owner,
            end_points=[{"url": "https://webhook-agent.example.com", "transport": "JSONRPC", "security": []}],
        )
        await db_session.commit()

        staff_tokens = await _login(client, username=staff.username or "", password=DEFAULT_LOGIN_VALUE)
        headers = _auth_headers(staff_tokens["access_token"])

        create_response = await client.post(
            "/acps-dsp-v2/webhooks",
            headers=headers,
            json={
                "url": recorder.url,
                "secret": "e2e-secret",
                "types": ["acs"],
                "events": ["data_change"],
                "description": f"e2e-webhook-{e2e_run_id}",
            },
        )
        assert create_response.status_code == 201

        disable_response = await client.post(f"/api/v1/agent/staff/{agent.id}/disable", headers=headers)
        assert disable_response.status_code == 200
        assert disable_response.json()["is_disabled"] is True

        for _ in range(48):
            if recorder.requests:
                break
            await asyncio.sleep(0.25)

        assert len(recorder.requests) == 1
        recorded = recorder.requests[0]
        body = recorded["body"]
        headers = recorded["headers"]
        assert body["event"] == "data_change"
        assert body["data"]["type"] == "acs"
        assert "current_seq" in body["data"]
        assert headers["X-Webhook-ID"]
        assert headers["X-Webhook-Signature"].startswith("sha256=")
        assert headers["X-Webhook-Timestamp"]
    finally:
        recorder.close()
