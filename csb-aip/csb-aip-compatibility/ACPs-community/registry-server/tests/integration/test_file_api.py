"""真实数据库集成测试：file 鉴权与路径安全。"""

import os
import time
import uuid
from pathlib import Path
from urllib.parse import quote

import pytest

from app.account.model import RoleType
from app.core.config import settings
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


async def test_file_content_requires_authentication(client) -> None:
    response = await client.get("/api/v1/file/secured.txt")

    assert response.status_code == 401


async def test_authenticated_user_can_read_file_content(client, db_session) -> None:
    user = await create_user(
        db_session,
        username=f"file-reader-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        name="File Reader",
    )
    await db_session.commit()

    token_data = await _login(client, username=user.username or "", password=DEFAULT_LOGIN_VALUE)
    headers = _auth_headers(token_data["access_token"])

    relative_path = Path("integration") / f"{uuid.uuid4().hex}.txt"
    full_path = Path(settings.upload_base_path) / relative_path
    full_path.parent.mkdir(parents=True, exist_ok=True)
    full_path.write_text("hello integration", encoding="utf-8")

    try:
        response = await client.get(
            f"/api/v1/file/{quote(relative_path.as_posix(), safe='/')}",
            headers=headers,
        )
    finally:
        full_path.unlink(missing_ok=True)

    assert response.status_code == 200
    assert response.content == b"hello integration"
    assert response.headers["content-type"].startswith("text/plain")


async def test_authenticated_user_cannot_traverse_outside_upload_base(client, db_session) -> None:
    user = await create_user(
        db_session,
        username=f"file-guard-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        name="File Guard",
    )
    await db_session.commit()

    token_data = await _login(client, username=user.username or "", password=DEFAULT_LOGIN_VALUE)
    headers = _auth_headers(token_data["access_token"])

    outside_file = Path(settings.upload_base_path).resolve().parent / f"outside-{uuid.uuid4().hex}.txt"
    outside_file.write_text("secret", encoding="utf-8")

    try:
        response = await client.get(
            f"/api/v1/file/{quote(f'../{outside_file.name}', safe='')}",
            headers=headers,
        )
    finally:
        outside_file.unlink(missing_ok=True)

    assert response.status_code == 403
    assert response.json()["error_name"] == "FILE_ACCESS_DENIED"


async def test_authenticated_user_can_upload_and_delete_file(client, db_session) -> None:
    user = await create_user(
        db_session,
        username=f"file-uploader-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        name="File Uploader",
    )
    await db_session.commit()

    token_data = await _login(client, username=user.username or "", password=DEFAULT_LOGIN_VALUE)
    headers = _auth_headers(token_data["access_token"])

    upload_response = await client.post(
        "/api/v1/file/upload",
        headers=headers,
        files={"file": ("demo.txt", b"hello upload", "text/plain")},
    )
    assert upload_response.status_code == 200
    uploaded = upload_response.json()
    assert uploaded["orig_name"] == "demo.txt"

    uploaded_path = Path(settings.upload_base_path) / uploaded["file_path"]
    assert uploaded_path.exists()
    assert uploaded_path.read_bytes() == b"hello upload"

    try:
        delete_response = await client.delete(f"/api/v1/file/{quote(uploaded['file_path'], safe='/')}", headers=headers)
    finally:
        uploaded_path.unlink(missing_ok=True)

    assert delete_response.status_code == 200
    assert delete_response.json()["status"] == "success"
    assert not uploaded_path.exists()


async def test_authenticated_user_can_upload_multiple_files(client, db_session) -> None:
    user = await create_user(
        db_session,
        username=f"multi-uploader-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        name="Multi Uploader",
    )
    await db_session.commit()

    token_data = await _login(client, username=user.username or "", password=DEFAULT_LOGIN_VALUE)
    headers = _auth_headers(token_data["access_token"])

    upload_response = await client.post(
        "/api/v1/file/upload-multiple",
        headers=headers,
        files=[
            ("files", ("one.txt", b"one", "text/plain")),
            ("files", ("two.txt", b"two", "text/plain")),
        ],
    )
    assert upload_response.status_code == 200
    uploaded_items = upload_response.json()
    assert [item["orig_name"] for item in uploaded_items] == ["one.txt", "two.txt"]

    uploaded_paths = [Path(settings.upload_base_path) / item["file_path"] for item in uploaded_items]
    try:
        assert [path.read_bytes() for path in uploaded_paths] == [b"one", b"two"]
    finally:
        for path in uploaded_paths:
            path.unlink(missing_ok=True)


async def test_file_cleanup_requires_maintenance_role(client, db_session) -> None:
    user = await create_user(
        db_session,
        username=f"file-cleanup-client-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        name="File Cleanup Client",
    )
    await db_session.commit()

    token_data = await _login(client, username=user.username or "", password=DEFAULT_LOGIN_VALUE)
    headers = _auth_headers(token_data["access_token"])

    response = await client.post("/api/v1/file/cleanup", headers=headers)

    assert response.status_code == 403
    assert response.json()["error_name"] == "INSUFFICIENT_PERMISSIONS"


async def test_maintenance_user_can_cleanup_temp_files(client, db_session, monkeypatch: pytest.MonkeyPatch) -> None:
    user = await create_user(
        db_session,
        username=f"file-cleanup-staff-{uuid.uuid4().hex[:8]}",
        password=DEFAULT_LOGIN_VALUE,
        roles=(RoleType.STAFF,),
        name="File Cleanup Staff",
    )
    await db_session.commit()

    token_data = await _login(client, username=user.username or "", password=DEFAULT_LOGIN_VALUE)
    headers = _auth_headers(token_data["access_token"])

    temp_upload_root = Path(settings.upload_base_path) / "cleanup-integration" / uuid.uuid4().hex
    temp_upload_root.mkdir(parents=True, exist_ok=True)
    temp_file = temp_upload_root / "old-temp.txt"
    temp_file.write_text("temp", encoding="utf-8")
    old_mtime = time.time() - 2 * 86400
    os.utime(temp_file, (old_mtime, old_mtime))

    def _mock_getxattr(path: str, attr: str) -> bytes:
        if Path(path) == temp_file and attr == "user.temp":
            return b"true"
        raise OSError("no xattr")

    monkeypatch.setattr("app.file.service.xattr.getxattr", _mock_getxattr)

    try:
        response = await client.post("/api/v1/file/cleanup", headers=headers)
    finally:
        temp_file.unlink(missing_ok=True)
        temp_upload_root.rmdir()
        temp_upload_root.parent.rmdir()

    assert response.status_code == 200
    assert response.json()["status"] == "success"
    assert response.json()["message"] == "Cleaned up 1 temporary files"
    assert not temp_file.exists()
