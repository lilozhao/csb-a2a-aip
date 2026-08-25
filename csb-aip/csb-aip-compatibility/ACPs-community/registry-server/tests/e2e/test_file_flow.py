"""黑盒 E2E：文件上传、读取与删除主流程。"""

from urllib.parse import quote

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


async def test_authenticated_user_file_lifecycle(client, e2e_run_id: str) -> None:
    token_data = await _register_user(
        client,
        username=f"file-{e2e_run_id}",
        password=DEFAULT_LOGIN_VALUE,
        name="File Tester",
    )
    headers = _auth_headers(token_data["access_token"])

    upload_response = await client.post(
        "/api/v1/file/upload",
        headers=headers,
        files={"file": ("note.txt", b"hello e2e", "text/plain")},
    )
    assert upload_response.status_code == 200
    upload_payload = upload_response.json()
    assert upload_payload["orig_name"] == "note.txt"
    file_path = upload_payload["file_path"]

    read_response = await client.get(
        f"/api/v1/file/{quote(file_path, safe='/')}",
        headers=headers,
    )
    assert read_response.status_code == 200
    assert read_response.content == b"hello e2e"
    assert read_response.headers["content-type"].startswith("text/plain")

    delete_response = await client.delete(
        f"/api/v1/file/{quote(file_path, safe='/')}",
        headers=headers,
    )
    assert delete_response.status_code == 200
    assert delete_response.json()["status"] == "success"

    read_after_delete_response = await client.get(
        f"/api/v1/file/{quote(file_path, safe='/')}",
        headers=headers,
    )
    assert read_after_delete_response.status_code == 404
    assert read_after_delete_response.json()["error_name"] == "FILE_NOT_FOUND"
