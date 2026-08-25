"""黑盒 E2E：phone auth 端到端流程。"""

import uuid

import pytest

from tests.support.constants import DEFAULT_LOGIN_VALUE, ROTATED_LOGIN_VALUE
from tests.support.http import response_json_string_field

pytestmark = pytest.mark.e2e


def _auth_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


async def _request_code(client, phone: str) -> str:
    response = await client.post("/api/v1/auth/verify-code", json={"phone": phone})
    assert response.status_code == 200
    return response_json_string_field(response, "code")


async def test_phone_auth_end_to_end_flow(client, e2e_run_id: str) -> None:
    username = f"phone-{e2e_run_id}"
    original_phone = f"136{uuid.uuid4().int % 10**8:08d}"
    new_phone = f"135{uuid.uuid4().int % 10**8:08d}"

    register_code = await _request_code(client, original_phone)
    register_response = await client.post(
        "/api/v1/auth/register",
        json={
            "username": username,
            "password": DEFAULT_LOGIN_VALUE,
            "phone": original_phone,
            "verify_code": register_code,
            "name": "Phone E2E User",
        },
    )
    assert register_response.status_code == 200
    assert "access_token" in register_response.json()

    phone_login_code = await _request_code(client, original_phone)
    phone_login_response = await client.post(
        "/api/v1/auth/login-phone",
        json={"phone": original_phone, "verify_code": phone_login_code},
    )
    assert phone_login_response.status_code == 200
    active_token = phone_login_response.json()["access_token"]

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

    reset_code = await _request_code(client, new_phone)
    reset_response = await client.post(
        "/api/v1/auth/reset-password",
        json={"phone": new_phone, "verify_code": reset_code, "new_password": ROTATED_LOGIN_VALUE},
    )
    assert reset_response.status_code == 200

    old_password_login = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": DEFAULT_LOGIN_VALUE},
    )
    assert old_password_login.status_code == 401

    new_password_login = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": ROTATED_LOGIN_VALUE},
    )
    assert new_password_login.status_code == 200

    reused_code_login = await client.post(
        "/api/v1/auth/login-phone",
        json={"phone": new_phone, "verify_code": reset_code},
    )
    assert reused_code_login.status_code == 401
    assert reused_code_login.json()["error_name"] == "INVALID_VERIFICATION_CODE"
