"""真实数据库集成测试：webhook 主路径。"""

import uuid

import pytest

from app.account.model import RoleType
from app.sync.exception import SyncErrorCode
from app.sync.model import WebHook
from tests.support.constants import DEFAULT_LOGIN_VALUE
from tests.support.database import create_user
from tests.support.http import response_json_string_map

pytestmark = pytest.mark.integration


def _auth_headers(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


async def _login(client, *, username: str, password: str) -> dict[str, str]:
    response = await client.post(
        "/api/v1/auth/login",
        data={"username": username, "password": password},
    )
    assert response.status_code == 200
    return response_json_string_map(response)


async def test_webhook_crud_round_trip_persists_in_database(client, db_session) -> None:
    staff = await create_user(
        db_session,
        username=f"sync-staff-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="Sync Staff",
    )
    await db_session.commit()

    staff_tokens = await _login(client, username=staff.username or "", password=DEFAULT_LOGIN_VALUE)
    headers = _auth_headers(staff_tokens["access_token"])

    payload = {
        "url": "https://cb.example/hook",
        "secret": "sec",
        "types": ["acs"],
        "events": ["data_change"],
        "description": "desc",
    }

    create_response = await client.post("/acps-dsp-v2/webhooks", headers=headers, json=payload)
    assert create_response.status_code == 201

    created = create_response.json()
    webhook_id = created["id"]
    assert created["url"] == payload["url"]
    assert created["types"] == ["acs"]
    assert created["events"] == ["data_change"]

    db_session.expire_all()
    created_webhook = await db_session.get(WebHook, webhook_id)
    assert created_webhook is not None
    assert created_webhook.secret == "sec"
    assert created_webhook.types == "acs"

    update_response = await client.put(
        f"/acps-dsp-v2/webhooks/{webhook_id}",
        headers=headers,
        json={
            "events": ["service_healthy"],
            "description": "updated",
        },
    )
    assert update_response.status_code == 200
    assert update_response.json()["events"] == ["service_healthy"]

    db_session.expire_all()
    updated_webhook = await db_session.get(WebHook, webhook_id)
    assert updated_webhook is not None
    assert updated_webhook.events == "service_healthy"
    assert updated_webhook.description == "updated"

    list_response = await client.get(
        "/acps-dsp-v2/webhooks",
        headers=headers,
        params={"status_filter": "active"},
    )
    assert list_response.status_code == 200
    assert list_response.json()["total"] == 1
    assert list_response.json()["items"][0]["id"] == webhook_id

    delete_response = await client.delete(f"/acps-dsp-v2/webhooks/{webhook_id}", headers=headers)
    assert delete_response.status_code == 204

    db_session.expire_all()
    deleted_webhook = await db_session.get(WebHook, webhook_id)
    assert deleted_webhook is None


async def test_reactivate_failed_webhook_resets_runtime_fields(client, db_session) -> None:
    staff = await create_user(
        db_session,
        username=f"sync-staff-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="Sync Staff",
    )
    webhook = WebHook(
        id="wh_failed",
        url="https://cb.example/failure",
        secret="sec",
        types="acs",
        events="data_change",
        description="failed",
        status="failed",
        failure_count=3,
        last_failure_reason="timeout",
    )
    db_session.add(webhook)
    await db_session.commit()

    staff_tokens = await _login(client, username=staff.username or "", password=DEFAULT_LOGIN_VALUE)
    reactivate_response = await client.post(
        "/acps-dsp-v2/webhooks/wh_failed/reactivate",
        headers=_auth_headers(staff_tokens["access_token"]),
    )
    assert reactivate_response.status_code == 200

    db_session.expire_all()
    refreshed = await db_session.get(WebHook, "wh_failed")
    assert refreshed is not None
    assert refreshed.status == "active"
    assert refreshed.failure_count == 0
    assert refreshed.last_failure_reason is None


async def test_sync_management_routes_require_maintenance_role(client, db_session) -> None:
    client_user = await create_user(
        db_session,
        username=f"sync-client-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.CLIENT,),
        name="Sync Client",
    )
    staff_user = await create_user(
        db_session,
        username=f"sync-staff-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="Sync Staff",
    )
    await db_session.commit()

    client_tokens = await _login(client, username=client_user.username or "", password=DEFAULT_LOGIN_VALUE)
    staff_tokens = await _login(client, username=staff_user.username or "", password=DEFAULT_LOGIN_VALUE)
    webhook_payload = {
        "url": "https://cb.example/protected",
        "secret": "sec",
        "types": ["acs"],
        "events": ["data_change"],
    }

    unauthenticated_webhook = await client.post("/acps-dsp-v2/webhooks", json=webhook_payload)
    assert unauthenticated_webhook.status_code == 401

    client_webhook = await client.post(
        "/acps-dsp-v2/webhooks",
        headers=_auth_headers(client_tokens["access_token"]),
        json=webhook_payload,
    )
    assert client_webhook.status_code == 403

    unauthenticated_admin = await client.get("/acps-dsp-v2/admin/changelogs")
    assert unauthenticated_admin.status_code == 401

    client_admin = await client.get(
        "/acps-dsp-v2/admin/changelogs",
        headers=_auth_headers(client_tokens["access_token"]),
    )
    assert client_admin.status_code == 403

    staff_admin = await client.get(
        "/acps-dsp-v2/admin/changelogs",
        headers=_auth_headers(staff_tokens["access_token"]),
    )
    assert staff_admin.status_code == 200


async def test_create_webhook_rejects_invalid_types(client, db_session) -> None:
    staff = await create_user(
        db_session,
        username=f"sync-staff-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="Sync Staff",
    )
    await db_session.commit()

    staff_tokens = await _login(client, username=staff.username or "", password=DEFAULT_LOGIN_VALUE)
    response = await client.post(
        "/acps-dsp-v2/webhooks",
        headers=_auth_headers(staff_tokens["access_token"]),
        json={
            "url": "https://cb.example/hook",
            "secret": "sec",
            "types": ["acs", "profile"],
            "events": ["data_change"],
        },
    )

    assert response.status_code == 400
    assert response.json()["error_name"] == SyncErrorCode.WEBHOOK_INVALID_TYPES.value


async def test_create_webhook_rejects_invalid_events(client, db_session) -> None:
    staff = await create_user(
        db_session,
        username=f"sync-staff-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="Sync Staff",
    )
    await db_session.commit()

    staff_tokens = await _login(client, username=staff.username or "", password=DEFAULT_LOGIN_VALUE)
    response = await client.post(
        "/acps-dsp-v2/webhooks",
        headers=_auth_headers(staff_tokens["access_token"]),
        json={
            "url": "https://cb.example/hook",
            "secret": "sec",
            "types": ["acs"],
            "events": ["data_change", "unsupported_event"],
        },
    )

    assert response.status_code == 400
    assert response.json()["error_name"] == SyncErrorCode.WEBHOOK_INVALID_EVENTS.value


async def test_update_webhook_rejects_invalid_events(client, db_session) -> None:
    staff = await create_user(
        db_session,
        username=f"sync-staff-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="Sync Staff",
    )
    webhook = WebHook(
        id="wh_invalid_update",
        url="https://cb.example/update",
        secret="sec",
        types="acs",
        events="data_change",
        description="invalid-update",
    )
    db_session.add(webhook)
    await db_session.commit()

    staff_tokens = await _login(client, username=staff.username or "", password=DEFAULT_LOGIN_VALUE)
    response = await client.put(
        "/acps-dsp-v2/webhooks/wh_invalid_update",
        headers=_auth_headers(staff_tokens["access_token"]),
        json={"events": ["service_healthy", "bad_event"]},
    )

    assert response.status_code == 400
    assert response.json()["error_name"] == SyncErrorCode.WEBHOOK_INVALID_EVENTS.value
