"""黑盒 E2E：Agent 禁用与启用流。"""

from __future__ import annotations

import pytest

from app.account.model import RoleType
from tests.support.constants import DEFAULT_LOGIN_VALUE
from tests.support.database import create_user
from tests.support.http import response_json_string_map

pytestmark = pytest.mark.e2e


def _auth_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


async def _register_user(client, *, username: str, password: str, name: str) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": password,
            "name": name,
            "email": f"{username}@example.com",
        },
    )
    assert response.status_code == 200
    return response_json_string_map(response)


async def _login(client, *, username: str, password: str) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": password},
    )
    assert response.status_code == 200
    return response_json_string_map(response)


async def test_agent_disable_enable_changes_public_visibility(client, db_session, e2e_run_id: str) -> None:
    staff = await create_user(
        db_session,
        username=f"disable-staff-{e2e_run_id}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="Disable Staff",
    )
    await db_session.commit()

    owner_tokens = await _register_user(
        client,
        username=f"disable-owner-{e2e_run_id}",
        password=DEFAULT_LOGIN_VALUE,
        name="Disable Owner",
    )
    staff_tokens = await _login(client, username=staff.username or "", password=DEFAULT_LOGIN_VALUE)

    create_response = await client.post(
        "/api/v1/agent/client",
        headers=_auth_headers(owner_tokens["access_token"]),
        json={"name": f"Disable Agent {e2e_run_id}", "version": "1.0.0"},
    )
    assert create_response.status_code == 200
    agent_id = create_response.json()["id"]

    submit_response = await client.post(
        f"/api/v1/agent/client/{agent_id}/submit",
        headers=_auth_headers(owner_tokens["access_token"]),
    )
    assert submit_response.status_code == 200

    approve_response = await client.post(
        f"/api/v1/agent/staff/{agent_id}/process",
        headers=_auth_headers(staff_tokens["access_token"]),
        json={"approve": True, "comments": "approved for disable flow"},
    )
    assert approve_response.status_code == 200

    recent_before_disable = await client.get("/api/v1/agent/public/recent", params={"limit": 10})
    assert recent_before_disable.status_code == 200
    before_ids = {item["id"] for item in recent_before_disable.json()["items"]}
    assert agent_id in before_ids

    disable_response = await client.post(
        f"/api/v1/agent/staff/{agent_id}/disable",
        headers=_auth_headers(staff_tokens["access_token"]),
    )
    assert disable_response.status_code == 200
    assert disable_response.json()["is_disabled"] is True
    assert disable_response.json()["is_active"] is False

    staff_detail = await client.get(
        f"/api/v1/agent/staff/{agent_id}",
        headers=_auth_headers(staff_tokens["access_token"]),
    )
    assert staff_detail.status_code == 200
    assert staff_detail.json()["is_disabled"] is True

    recent_after_disable = await client.get("/api/v1/agent/public/recent", params={"limit": 10})
    assert recent_after_disable.status_code == 200
    disabled_ids = {item["id"] for item in recent_after_disable.json()["items"]}
    assert agent_id not in disabled_ids

    enable_response = await client.post(
        f"/api/v1/agent/staff/{agent_id}/enable",
        headers=_auth_headers(staff_tokens["access_token"]),
    )
    assert enable_response.status_code == 200
    assert enable_response.json()["is_disabled"] is False
    assert enable_response.json()["is_active"] is True

    recent_after_enable = await client.get("/api/v1/agent/public/recent", params={"limit": 10})
    assert recent_after_enable.status_code == 200
    enabled_ids = {item["id"] for item in recent_after_enable.json()["items"]}
    assert agent_id in enabled_ids
