import contextlib
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

import structlog
import xattr
from fastapi import UploadFile

from app.core.config import settings

logger = structlog.get_logger(__name__)

BEIJING_TZ = timezone(timedelta(hours=8))


class FileService:
    """处理文件操作的服务。"""

    @staticmethod
    def _resolve_storage_path(file_path: str) -> Path:
        """将相对路径解析到上传根目录内，拒绝目录穿越。"""
        base_path = Path(settings.upload_base_path).resolve()
        full_path = (base_path / file_path).resolve()

        if full_path != base_path and base_path not in full_path.parents:
            raise PermissionError("Access to path outside upload base path is not allowed")

        return full_path

    @staticmethod
    async def save_uploaded_file(file: UploadFile) -> str:
        """
        保存上传文件，使用 UUID 文件名并保留原始扩展名。

        使用 xattr 将文件标记为临时文件。
        """
        # 从原始文件名提取扩展名
        ext = Path(file.filename or "").suffix

        # 使用 UUID 生成唯一文件名
        unique_filename = f"{uuid.uuid7()}{ext}"

        # 生成用于存储的相对路径
        now = datetime.now(tz=BEIJING_TZ)
        relative_path = Path(now.strftime("%Y/%m")) / unique_filename

        # 生成用于存储的完整路径
        full_path = Path(settings.upload_base_path) / relative_path

        # 确保目标目录存在
        full_path.parent.mkdir(parents=True, exist_ok=True)

        # 保存文件内容
        with full_path.open("wb") as buffer:
            content = await file.read()
            buffer.write(content)

        # 使用 xattr 将文件标记为临时文件
        try:
            xattr.setxattr(str(full_path), "user.temp", b"true")
        except OSError:
            logger.warning("设置 xattr 失败", path=str(full_path))

        return str(relative_path)

    @staticmethod
    def mark_file_as_permanent(file_path: str) -> None:
        """通过移除临时 xattr 将文件标记为永久文件。"""
        full_path = FileService._resolve_storage_path(file_path)

        try:
            xattr.removexattr(str(full_path), "user.temp")
        except OSError:
            logger.warning("移除 xattr 失败", path=str(full_path))

    @staticmethod
    def delete_file(file_path: str) -> None:
        """从文件系统中删除文件。"""
        full_path = FileService._resolve_storage_path(file_path)

        if full_path.exists():
            full_path.unlink()

    @staticmethod
    def cleanup_temp_files() -> int:
        """
        删除超过 1 天的临时文件。

        Returns:
            删除的文件数量。
        """
        count = 0
        one_day_ago = datetime.now(tz=BEIJING_TZ) - timedelta(days=1)

        for full_path in Path(settings.upload_base_path).rglob("*"):
            if not full_path.is_file():
                continue

            with contextlib.suppress(OSError):
                is_temp = xattr.getxattr(str(full_path), "user.temp") == b"true"

                if is_temp:
                    mod_time = datetime.fromtimestamp(full_path.stat().st_mtime, tz=BEIJING_TZ)
                    if mod_time < one_day_ago:
                        full_path.unlink()
                        count += 1

        return count

    @staticmethod
    def read_file_content(file_path: str) -> bytes:
        """
        读取并返回文件内容。

        Args:
            file_path: 文件的相对路径

        Returns:
            文件的字节内容

        Raises:
            FileNotFoundError: 当文件不存在时抛出
        """
        full_path = FileService._resolve_storage_path(file_path)

        if not full_path.exists():
            raise FileNotFoundError(f"File not found: {file_path}")

        return full_path.read_bytes()
