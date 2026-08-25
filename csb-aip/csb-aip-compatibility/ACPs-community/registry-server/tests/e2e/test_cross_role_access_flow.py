"""黑盒 E2E：public/client/staff/admin 跨角色访问边界。"""

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


async def test_cross_role_access_boundaries_for_pending_agent(client, db_session, e2e_run_id: str) -> None:
    staff = await create_user(
        db_session,
        username=f"role-staff-{e2e_run_id}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="Role Staff",
    )
    admin = await create_user(
        db_session,
        username=f"role-admin-{e2e_run_id}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.ADMIN,),
        name="Role Admin",
    )
    await db_session.commit()

    owner_tokens = await _register_user(
        client,
        username=f"role-owner-{e2e_run_id}",
        password=DEFAULT_LOGIN_VALUE,
        name="Role Owner",
    )
    other_client_tokens = await _register_user(
        client,
        username=f"role-other-{e2e_run_id}",
        password=DEFAULT_LOGIN_VALUE,
        name="Role Other",
    )
    staff_tokens = await _login(client, username=staff.username or "", password=DEFAULT_LOGIN_VALUE)
    admin_tokens = await _login(client, username=admin.username or "", password=DEFAULT_LOGIN_VALUE)

    create_response = await client.post(
        "/api/v1/agent/client",
        headers=_auth_headers(owner_tokens["access_token"]),
        json={"name": f"Role Agent {e2e_run_id}", "version": "1.0.0"},
    )
    assert create_response.status_code == 200
    agent_id = create_response.json()["id"]

    submit_response = await client.post(
        f"/api/v1/agent/client/{agent_id}/submit",
        headers=_auth_headers(owner_tokens["access_token"]),
    )
    assert submit_response.status_code == 200
    assert submit_response.json()["approval_status"] == "PENDING"

    public_response = await client.get(f"/api/v1/agent/public/{agent_id}")
    assert public_response.status_code == 404

    owner_detail = await client.get(
        f"/api/v1/agent/client/{agent_id}",
        headers=_auth_headers(owner_tokens["access_token"]),
    )
    assert owner_detail.status_code == 200
    assert owner_detail.json()["approval_status"] == "PENDING"

    other_client_detail = await client.get(
        f"/api/v1/agent/client/{agent_id}",
        headers=_auth_headers(other_client_tokens["access_token"]),
    )
    assert other_client_detail.status_code == 403
    assert other_client_detail.json()["error_name"] == "ACCESS_DENIED_NOT_OWNER"

    wrong_role_detail = await client.get(
        f"/api/v1/agent/client/{agent_id}",
        headers=_auth_headers(staff_tokens["access_token"]),
    )
    assert wrong_role_detail.status_code == 403

    staff_detail = await client.get(
        f"/api/v1/agent/staff/{agent_id}",
        headers=_auth_headers(staff_tokens["access_token"]),
    )
    assert staff_detail.status_code == 200

    admin_detail = await client.get(
        f"/api/v1/agent/staff/{agent_id}",
        headers=_auth_headers(admin_tokens["access_token"]),
    )
    assert admin_detail.status_code == 200
