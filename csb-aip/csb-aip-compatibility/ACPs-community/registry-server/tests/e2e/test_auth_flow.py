"""黑盒 E2E：认证主流程。"""

import pytest

from tests.support.constants import DEFAULT_LOGIN_VALUE
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


async def test_register_and_read_current_user_profile(client, e2e_run_id: str) -> None:
    username = f"e2e-user-{e2e_run_id}"
    password = DEFAULT_LOGIN_VALUE
    token_data = await _register_user(client, username=username, password=password, name="E2E User")

    response = await client.get("/api/v1/account/me", headers=_auth_headers(token_data["access_token"]))

    assert response.status_code == 200
    payload = response.json()
    assert payload["username"] == username
    assert payload["name"] == "E2E User"
    assert payload["roles"] == ["CLIENT"]
    assert payload["is_active"] is True


async def test_login_refresh_and_logout_lifecycle(client, e2e_run_id: str) -> None:
    username = f"e2e-login-{e2e_run_id}"
    password = DEFAULT_LOGIN_VALUE
    await _register_user(client, username=username, password=password, name="Lifecycle User")

    login_response = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": password},
    )
    assert login_response.status_code == 200
    login_payload = login_response.json()

    refresh_response = await client.post(
        "/api/v1/auth/refresh-token",
        json={"refresh_token": login_payload["refresh_token"]},
    )
    assert refresh_response.status_code == 200
    refreshed = refresh_response.json()

    logout_response = await client.post(
        "/api/v1/auth/logout",
        headers=_auth_headers(refreshed["access_token"]),
    )
    assert logout_response.status_code == 200
    assert logout_response.json()["success"] is True

    me_response = await client.get("/api/v1/account/me", headers=_auth_headers(refreshed["access_token"]))
    assert me_response.status_code == 401
