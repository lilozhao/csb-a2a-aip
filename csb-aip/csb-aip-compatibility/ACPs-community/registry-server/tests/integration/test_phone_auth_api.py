"""真实数据库集成测试：phone auth 业务链。"""

import uuid

import pytest

from tests.support.constants import DEFAULT_LOGIN_VALUE, ROTATED_LOGIN_VALUE
from tests.support.http import response_json_string_field

pytestmark = pytest.mark.integration


def _auth_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


async def _request_code(client, phone: str) -> str:
    response = await client.post("/api/v1/auth/verify-code", json={"phone": phone})
    assert response.status_code == 200
    return response_json_string_field(response, "code")


async def test_phone_registration_login_update_phone_and_reset_password(client) -> None:
    username = f"phone-user-{uuid.uuid4().hex[:8]}"
    original_phone = f"138{uuid.uuid4().int % 10**8:08d}"
    new_phone = f"139{uuid.uuid4().int % 10**8:08d}"

    register_code = await _request_code(client, original_phone)
    register_response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": DEFAULT_LOGIN_VALUE,
            "phone": original_phone,
            "verify_code": register_code,
            "name": "Phone User",
        },
    )
    assert register_response.status_code == 200
    assert "access_token" in register_response.json()

    login_phone_code = await _request_code(client, original_phone)
    login_phone_response = await client.post(
        "/api/v1/auth/login-phone",
        json={"phone": original_phone, "verify_code": login_phone_code},
    )
    assert login_phone_response.status_code == 200
    active_token = login_phone_response.json()["access_token"]

    update_phone_code = await _request_code(client, new_phone)
    update_phone_response = await client.put(
        "/api/v1/account/me/phone",
        headers=_auth_headers(active_token),
        json={"new_phone": new_phone, "verify_code": update_phone_code},
    )
    assert update_phone_response.status_code == 200
    assert update_phone_response.json()["success"] is True

    me_response = await client.get("/api/v1/account/me", headers=_auth_headers(active_token))
    assert me_response.status_code == 200
    assert me_response.json()["phone"] == new_phone

    old_phone_code = await _request_code(client, original_phone)
    old_phone_login = await client.post(
        "/api/v1/auth/login-phone",
        json={"phone": original_phone, "verify_code": old_phone_code},
    )
    assert old_phone_login.status_code == 401
    assert old_phone_login.json()["error_name"] == "INVALID_CREDENTIALS"

    reset_code = await _request_code(client, new_phone)
    reset_response = await client.post(
        "/api/v1/auth/reset-password",
        json={"phone": new_phone, "verify_code": reset_code, "new_password": ROTATED_LOGIN_VALUE},
    )
    assert reset_response.status_code == 200
    assert reset_response.json()["message"] == "Password reset successfully"

    old_password_login = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": DEFAULT_LOGIN_VALUE},
    )
    assert old_password_login.status_code == 401
    assert old_password_login.json()["error_name"] == "INVALID_CREDENTIALS"

    new_password_login = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": ROTATED_LOGIN_VALUE},
    )
    assert new_password_login.status_code == 200


async def test_phone_login_rejects_reused_verification_code(client) -> None:
    username = f"reuse-phone-{uuid.uuid4().hex[:8]}"
    phone = f"137{uuid.uuid4().int % 10**8:08d}"

    register_code = await _request_code(client, phone)
    register_response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": DEFAULT_LOGIN_VALUE,
            "phone": phone,
            "verify_code": register_code,
            "name": "Reuse Phone User",
        },
    )
    assert register_response.status_code == 200

    login_code = await _request_code(client, phone)
    first_login = await client.post(
        "/api/v1/auth/login-phone",
        json={"phone": phone, "verify_code": login_code},
    )
    assert first_login.status_code == 200

    second_login = await client.post(
        "/api/v1/auth/login-phone",
        json={"phone": phone, "verify_code": login_code},
    )
    assert second_login.status_code == 401
    assert second_login.json()["error_name"] == "INVALID_VERIFICATION_CODE"


async def test_phone_registration_allows_phone_only_payload(client) -> None:
    phone = f"136{uuid.uuid4().int % 10**8:08d}"

    register_code = await _request_code(client, phone)
    register_response = await client.post(
        "/api/v1/auth/register",
        json={
            "phone": phone,
            "verify_code": register_code,
            "name": "Phone Only User",
        },
    )
    assert register_response.status_code == 200
    assert "access_token" in register_response.json()

    phone_login_code = await _request_code(client, phone)
    phone_login_response = await client.post(
        "/api/v1/auth/login-phone",
        json={"phone": phone, "verify_code": phone_login_code},
    )
    assert phone_login_response.status_code == 200
