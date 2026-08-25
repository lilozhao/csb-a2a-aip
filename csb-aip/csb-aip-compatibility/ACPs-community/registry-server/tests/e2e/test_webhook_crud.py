"""黑盒 E2E：通过真实 HTTP 入口验证 webhook CRUD 主路径。"""

import pytest

from app.account.model import RoleType
from tests.support.constants import DEFAULT_LOGIN_VALUE
from tests.support.database import create_user
from tests.support.http import response_json_string_map

pytestmark = pytest.mark.e2e


def _auth_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


async def _login(client, *, username: str, password: str) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": password},
    )
    assert response.status_code == 200
    return response_json_string_map(response)


async def test_webhook_crud_round_trip(client, db_session, e2e_run_id: str) -> None:
    staff = await create_user(
        db_session,
        username=f"webhook-staff-{e2e_run_id}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="Webhook Staff",
    )
    await db_session.commit()

    staff_tokens = await _login(client, username=staff.username or "", password=DEFAULT_LOGIN_VALUE)
    headers = _auth_headers(staff_tokens["access_token"])

    callback_url = f"https://example.invalid/acps-e2e/{e2e_run_id}"
    create_payload = {
        "url": callback_url,
        "secret": "e2e-secret",
        "types": ["acs"],
        "events": ["data_change"],
        "description": f"e2e-{e2e_run_id}",
    }

    create_response = await client.post("/acps-dsp-v2/webhooks", headers=headers, json=create_payload)
    assert create_response.status_code == 201

    created = create_response.json()
    webhook_id = created["id"]
    assert created["url"] == callback_url
    assert created["types"] == ["acs"]
    assert created["events"] == ["data_change"]

    get_response = await client.get(f"/acps-dsp-v2/webhooks/{webhook_id}", headers=headers)
    assert get_response.status_code == 200
    assert get_response.json()["id"] == webhook_id

    update_response = await client.put(
        f"/acps-dsp-v2/webhooks/{webhook_id}",
        headers=headers,
        json={
            "events": ["service_healthy"],
            "description": f"e2e-updated-{e2e_run_id}",
        },
    )
    assert update_response.status_code == 200

    updated = update_response.json()
    assert updated["id"] == webhook_id
    assert updated["events"] == ["service_healthy"]
    assert updated["description"] == f"e2e-updated-{e2e_run_id}"

    delete_response = await client.delete(f"/acps-dsp-v2/webhooks/{webhook_id}", headers=headers)
    assert delete_response.status_code == 204
