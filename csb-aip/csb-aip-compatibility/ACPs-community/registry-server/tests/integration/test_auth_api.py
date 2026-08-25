"""真实数据库集成测试：username/password auth 核心链路。"""

from __future__ import annotations

import uuid

import pytest

from tests.support.constants import DEFAULT_LOGIN_VALUE

pytestmark = pytest.mark.integration


def _auth_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


async def test_username_password_auth_flow_supports_login_refresh_and_logout(client) -> None:
    username = f"auth-user-{uuid.uuid4().hex[:8]}"
    email = f"{username}@example.com"

    register_response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": DEFAULT_LOGIN_VALUE,
            "email": email,
            "name": "Auth User",
        },
    )
    assert register_response.status_code == 200
    registered_tokens = register_response.json()
    assert registered_tokens["token_type"] == "bearer"
    assert registered_tokens["refresh_token"]

    login_response = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": DEFAULT_LOGIN_VALUE},
    )
    assert login_response.status_code == 200
    login_tokens = login_response.json()
    assert login_tokens["access_token"]
    assert login_tokens["refresh_token"]

    refresh_response = await client.post(
        "/api/v1/auth/refresh-token",
        json={"refresh_token": login_tokens["refresh_token"]},
    )
    assert refresh_response.status_code == 200
    refreshed_tokens = refresh_response.json()
    assert refreshed_tokens["token_type"] == "bearer"
    assert refreshed_tokens["access_token"]
    assert refreshed_tokens["refresh_token"]

    logout_response = await client.post(
        "/api/v1/auth/logout",
        headers=_auth_headers(refreshed_tokens["access_token"]),
    )
    assert logout_response.status_code == 200
    assert logout_response.json() == {"success": True, "message": "Successfully logged out"}

    revoked_refresh_response = await client.post(
        "/api/v1/auth/refresh-token",
        json={"refresh_token": refreshed_tokens["refresh_token"]},
    )
    assert revoked_refresh_response.status_code == 401
    assert revoked_refresh_response.json()["error_name"] == "INVALID_REFRESH_TOKEN"


async def test_register_requires_credential_pair(client) -> None:
    response = await client.post(
        "/api/v1/auth/register",
        json={"name": "No Credentials", "email": f"nocreds-{uuid.uuid4().hex[:8]}@example.com"},
    )

    assert response.status_code == 400
    assert response.json()["detail"] == "Either username/password or phone/verify_code must be provided"


async def test_logout_without_authentication_is_still_successful(client) -> None:
    response = await client.post("/api/v1/auth/logout")

    assert response.status_code == 200
    assert response.json() == {"success": True, "message": "Successfully logged out"}
