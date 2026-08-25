"""针对 file/api.py route handler 边界的单元测试。"""

from __future__ import annotations

from io import BytesIO
from types import SimpleNamespace
from typing import TYPE_CHECKING, cast
from unittest.mock import AsyncMock

import pytest
from fastapi import UploadFile

from app.file import api as file_api
from app.file import service as file_service_module
from app.file.exception import (
    FileAccessDeniedError,
    FileCleanupFailedError,
    FileDeleteFailedError,
    FileReadFailedError,
    FileUploadFailedError,
    StoredFileNotFoundError,
)

if TYPE_CHECKING:
    from app.account.model import User

pytestmark = pytest.mark.unit

CURRENT_USER = cast("User", SimpleNamespace(id="user-1", username="tester"))


def _upload_file(filename: str, content: bytes = b"demo") -> UploadFile:
    return UploadFile(filename=filename, file=BytesIO(content))


async def test_upload_file_returns_relative_path(monkeypatch: pytest.MonkeyPatch) -> None:
    save_uploaded_file = AsyncMock(return_value="uploads/demo.txt")
    monkeypatch.setattr(file_service_module.FileService, "save_uploaded_file", save_uploaded_file)

    response = await file_api.upload_file(_upload_file("demo.txt"), current_user=CURRENT_USER)

    assert response.orig_name == "demo.txt"
    assert response.file_path == "uploads/demo.txt"


async def test_upload_file_wraps_os_error(monkeypatch: pytest.MonkeyPatch) -> None:
    save_uploaded_file = AsyncMock(side_effect=OSError("disk full"))
    monkeypatch.setattr(file_service_module.FileService, "save_uploaded_file", save_uploaded_file)

    with pytest.raises(FileUploadFailedError) as exc_info:
        await file_api.upload_file(_upload_file("broken.txt"), current_user=CURRENT_USER)

    assert exc_info.value.extensions["input_params"] == {"filename": "broken.txt"}


async def test_upload_multiple_files_returns_all_results(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_save(uploaded_file: UploadFile) -> str:
        return f"uploads/{uploaded_file.filename}"

    monkeypatch.setattr(file_service_module.FileService, "save_uploaded_file", fake_save)

    responses = await file_api.upload_multiple_files(
        [_upload_file("first.txt"), _upload_file("second.txt")],
        current_user=CURRENT_USER,
    )

    assert [(item.orig_name, item.file_path) for item in responses] == [
        ("first.txt", "uploads/first.txt"),
        ("second.txt", "uploads/second.txt"),
    ]


async def test_upload_multiple_files_wraps_os_error_with_all_filenames(monkeypatch: pytest.MonkeyPatch) -> None:
    calls = 0

    async def fake_save(uploaded_file: UploadFile) -> str:
        nonlocal calls
        calls += 1
        if calls == 2:
            raise OSError("disk full")
        return f"uploads/{uploaded_file.filename}"

    monkeypatch.setattr(file_service_module.FileService, "save_uploaded_file", fake_save)
    files = [_upload_file("first.txt"), _upload_file("second.txt")]

    with pytest.raises(FileUploadFailedError) as exc_info:
        await file_api.upload_multiple_files(files, current_user=CURRENT_USER)

    assert exc_info.value.extensions["input_params"] == {"filenames": ["first.txt", "second.txt"]}


async def test_delete_file_converts_permission_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_permission_error(file_path: str) -> None:
        del file_path
        raise PermissionError("outside upload base path")

    monkeypatch.setattr(file_service_module.FileService, "delete_file", raise_permission_error)

    with pytest.raises(FileAccessDeniedError) as exc_info:
        await file_api.delete_file("../secret.txt", current_user=CURRENT_USER)

    assert exc_info.value.extensions["input_params"] == {"file_path": "../secret.txt"}


async def test_delete_file_converts_os_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_os_error(file_path: str) -> None:
        del file_path
        raise OSError("unlink failed")

    monkeypatch.setattr(file_service_module.FileService, "delete_file", raise_os_error)

    with pytest.raises(FileDeleteFailedError) as exc_info:
        await file_api.delete_file("demo.txt", current_user=CURRENT_USER)

    assert exc_info.value.extensions["input_params"] == {"file_path": "demo.txt"}


async def test_cleanup_temp_files_returns_success_message(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(file_service_module.FileService, "cleanup_temp_files", lambda: 3)

    response = await file_api.cleanup_temp_files(current_user=CURRENT_USER)

    assert response.status == "success"
    assert response.message == "Cleaned up 3 temporary files"


async def test_cleanup_temp_files_wraps_os_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_os_error() -> int:
        raise OSError("scan failed")

    monkeypatch.setattr(file_service_module.FileService, "cleanup_temp_files", raise_os_error)

    with pytest.raises(FileCleanupFailedError):
        await file_api.cleanup_temp_files(current_user=CURRENT_USER)


async def test_get_file_content_uses_guessed_text_mime_type(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(file_service_module.FileService, "read_file_content", lambda _path: b"hello")

    response = await file_api.get_file_content("demo.txt", current_user=CURRENT_USER)

    assert response.body == b"hello"
    assert response.media_type == "text/plain"


async def test_get_file_content_falls_back_to_octet_stream(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(file_service_module.FileService, "read_file_content", lambda _path: b"binary")

    response = await file_api.get_file_content("demo.unknownext", current_user=CURRENT_USER)

    assert response.body == b"binary"
    assert response.media_type == "application/octet-stream"


async def test_get_file_content_converts_permission_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_permission_error(file_path: str) -> bytes:
        del file_path
        raise PermissionError("outside upload base path")

    monkeypatch.setattr(file_service_module.FileService, "read_file_content", raise_permission_error)

    with pytest.raises(FileAccessDeniedError):
        await file_api.get_file_content("../secret.txt", current_user=CURRENT_USER)


async def test_get_file_content_converts_missing_file(monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_missing_file(file_path: str) -> bytes:
        del file_path
        raise FileNotFoundError("missing")

    monkeypatch.setattr(file_service_module.FileService, "read_file_content", raise_missing_file)

    with pytest.raises(StoredFileNotFoundError):
        await file_api.get_file_content("missing.txt", current_user=CURRENT_USER)


async def test_get_file_content_converts_os_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def raise_os_error(file_path: str) -> bytes:
        del file_path
        raise OSError("io failed")

    monkeypatch.setattr(file_service_module.FileService, "read_file_content", raise_os_error)

    with pytest.raises(FileReadFailedError):
        await file_api.get_file_content("broken.txt", current_user=CURRENT_USER)
