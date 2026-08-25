"""黑盒 E2E：Agent 驳回后修改并重提。"""

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


async def test_agent_rejection_revision_and_resubmission_flow(client, db_session, e2e_run_id: str) -> None:
    staff = await create_user(
        db_session,
        username=f"reject-staff-{e2e_run_id}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="Review Staff",
    )
    await db_session.commit()

    client_tokens = await _register_user(
        client,
        username=f"reject-owner-{e2e_run_id}",
        password=DEFAULT_LOGIN_VALUE,
        name="Reject Owner",
    )
    staff_tokens = await _login(client, username=staff.username or "", password=DEFAULT_LOGIN_VALUE)

    create_response = await client.post(
        "/api/v1/agent/client",
        headers=_auth_headers(client_tokens["access_token"]),
        json={"name": f"Rejected Agent {e2e_run_id}", "version": "1.0.0", "description": "initial"},
    )
    assert create_response.status_code == 200
    agent_id = create_response.json()["id"]

    submit_response = await client.post(
        f"/api/v1/agent/client/{agent_id}/submit",
        headers=_auth_headers(client_tokens["access_token"]),
    )
    assert submit_response.status_code == 200
    assert submit_response.json()["approval_status"] == "PENDING"

    reject_response = await client.post(
        f"/api/v1/agent/staff/{agent_id}/process",
        headers=_auth_headers(staff_tokens["access_token"]),
        json={"approve": False, "comments": "need revision"},
    )
    assert reject_response.status_code == 200
    assert reject_response.json()["approval_status"] == "REJECTED"

    public_response = await client.get(f"/api/v1/agent/public/{agent_id}")
    assert public_response.status_code == 404

    owner_detail = await client.get(
        f"/api/v1/agent/client/{agent_id}",
        headers=_auth_headers(client_tokens["access_token"]),
    )
    assert owner_detail.status_code == 200
    assert owner_detail.json()["approval_status"] == "REJECTED"

    update_response = await client.put(
        f"/api/v1/agent/client/{agent_id}",
        headers=_auth_headers(client_tokens["access_token"]),
        json={"description": "revised after rejection"},
    )
    assert update_response.status_code == 200
    assert update_response.json()["description"] == "revised after rejection"

    resubmit_response = await client.post(
        f"/api/v1/agent/client/{agent_id}/submit",
        headers=_auth_headers(client_tokens["access_token"]),
    )
    assert resubmit_response.status_code == 200
    assert resubmit_response.json()["approval_status"] == "PENDING"

    approve_response = await client.post(
        f"/api/v1/agent/staff/{agent_id}/process",
        headers=_auth_headers(staff_tokens["access_token"]),
        json={"approve": True, "comments": "approved after revision"},
    )
    assert approve_response.status_code == 200
    assert approve_response.json()["approval_status"] == "APPROVED"

    final_public = await client.get(f"/api/v1/agent/public/{agent_id}")
    assert final_public.status_code == 200
    assert final_public.json()["approval_status"] == "APPROVED"
