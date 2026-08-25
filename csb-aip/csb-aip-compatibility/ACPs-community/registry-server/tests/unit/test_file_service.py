"""针对 file/service.py 的单元测试。

覆盖：FileService.mark_file_as_permanent、delete_file、
read_file_content、cleanup_temp_files（异常分支）。
save_uploaded_file 因依赖 asyncio + xattr 的复杂性在此通过 monkeypatch 覆盖。
"""

from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.file.service import FileService

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# 针对 read_file_content 的测试
# ---------------------------------------------------------------------------


class TestReadFileContent:
    def test_reads_existing_file(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))
        file = tmp_path / "test.txt"
        file.write_bytes(b"hello world")

        content = FileService.read_file_content("test.txt")
        assert content == b"hello world"

    def test_raises_for_missing_file(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))

        with pytest.raises(FileNotFoundError):
            FileService.read_file_content("nonexistent.txt")

    def test_rejects_path_traversal(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))
        outside_file = tmp_path.parent / "outside.txt"
        outside_file.write_bytes(b"outside")

        with pytest.raises(PermissionError, match="outside upload base path"):
            FileService.read_file_content("../outside.txt")


# ---------------------------------------------------------------------------
# 针对 delete_file 的测试
# ---------------------------------------------------------------------------


class TestDeleteFile:
    def test_deletes_existing_file(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))
        file = tmp_path / "to_delete.txt"
        file.write_bytes(b"data")
        assert file.exists()

        FileService.delete_file("to_delete.txt")
        assert not file.exists()

    def test_no_error_when_file_missing(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))
        # 不应抛出异常
        FileService.delete_file("ghost_file.txt")

    def test_rejects_path_traversal(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))
        outside_file = tmp_path.parent / "outside-delete.txt"
        outside_file.write_bytes(b"data")

        with pytest.raises(PermissionError, match="outside upload base path"):
            FileService.delete_file("../outside-delete.txt")

        assert outside_file.exists()


# ---------------------------------------------------------------------------
# 针对 mark_file_as_permanent 的测试
# ---------------------------------------------------------------------------


class TestMarkFileAsPermanent:
    def test_calls_removexattr(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))
        file = tmp_path / "perm.txt"
        file.write_bytes(b"data")

        removed: list[tuple[str, str]] = []

        def mock_removexattr(path: str, attr: str) -> None:
            removed.append((path, attr))

        with patch("app.file.service.xattr.removexattr", mock_removexattr):
            FileService.mark_file_as_permanent("perm.txt")

        assert len(removed) == 1
        assert removed[0][1] == "user.temp"

    def test_xattr_exception_is_suppressed(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))
        file = tmp_path / "perm2.txt"
        file.write_bytes(b"data")

        def mock_removexattr(path: str, attr: str) -> None:
            raise OSError("xattr not supported")

        with patch("app.file.service.xattr.removexattr", mock_removexattr):
            # 不应传播异常
            FileService.mark_file_as_permanent("perm2.txt")


# ---------------------------------------------------------------------------
# 针对 cleanup_temp_files 的测试
# ---------------------------------------------------------------------------


class TestCleanupTempFiles:
    def test_deletes_old_temp_files(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """模拟旧的临时文件应被删除。"""
        import time

        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))

        old_file = tmp_path / "old_temp.txt"
        old_file.write_bytes(b"old data")
        # 设置修改时间为 2 天前
        old_mtime = time.time() - 2 * 86400
        import os

        os.utime(str(old_file), (old_mtime, old_mtime))

        def mock_getxattr(path: str, attr: str) -> bytes:
            return b"true"

        with patch("app.file.service.xattr.getxattr", mock_getxattr):
            count = FileService.cleanup_temp_files()

        assert count == 1
        assert not old_file.exists()

    def test_does_not_delete_new_temp_files(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """新建的临时文件不应被删除。"""
        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))

        new_file = tmp_path / "new_temp.txt"
        new_file.write_bytes(b"new data")

        def mock_getxattr(path: str, attr: str) -> bytes:
            return b"true"

        with patch("app.file.service.xattr.getxattr", mock_getxattr):
            count = FileService.cleanup_temp_files()

        assert count == 0
        assert new_file.exists()

    def test_does_not_delete_permanent_files(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        """永久文件（无 xattr）不应被删除。"""
        import os
        import time

        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))

        perm_file = tmp_path / "perm.txt"
        perm_file.write_bytes(b"permanent data")
        old_mtime = time.time() - 2 * 86400
        os.utime(str(perm_file), (old_mtime, old_mtime))

        def mock_getxattr(path: str, attr: str) -> bytes:
            raise OSError("no xattr")

        with patch("app.file.service.xattr.getxattr", mock_getxattr):
            count = FileService.cleanup_temp_files()

        assert count == 0
        assert perm_file.exists()


# ---------------------------------------------------------------------------
# 针对 save_uploaded_file（异步）的测试
# ---------------------------------------------------------------------------


class TestSaveUploadedFile:
    async def test_saves_file_and_returns_relative_path(self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setattr("app.file.service.settings", MagicMock(upload_base_path=str(tmp_path)))

        # 创建模拟 UploadFile
        mock_upload = AsyncMock()
        mock_upload.filename = "photo.jpg"
        mock_upload.read = AsyncMock(return_value=b"binary-image-data")

        # 让 xattr 调用不报错
        with (
            patch("app.file.service.xattr.setxattr", return_value=None),
        ):
            relative_path = await FileService.save_uploaded_file(mock_upload)

        assert relative_path.endswith(".jpg")
        full_path = tmp_path / relative_path
        assert full_path.exists()
        assert full_path.read_bytes() == b"binary-image-data"
