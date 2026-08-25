from enum import StrEnum
from typing import Any

from app.core.base_exception import AppError


class FileErrorCode(StrEnum):
    """文件模块错误码。"""

    FILE_UPLOAD_FAILED = "FILE_UPLOAD_FAILED"
    FILE_DELETE_FAILED = "FILE_DELETE_FAILED"
    FILE_CLEANUP_FAILED = "FILE_CLEANUP_FAILED"
    FILE_READ_FAILED = "FILE_READ_FAILED"
    FILE_NOT_FOUND = "FILE_NOT_FOUND"
    FILE_ACCESS_DENIED = "FILE_ACCESS_DENIED"


class FileError(AppError):
    """文件相关异常的基类。"""

    def __init__(
        self,
        *,
        code: FileErrorCode,
        title: str,
        detail: str,
        status_code: int,
        input_params: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(
            code=code,
            title=title,
            detail=detail,
            status_code=status_code,
            type_=f"urn:acps:error:file:{code.lower()}",
            extensions={
                "error_group": "file",
                "input_params": input_params or {},
            },
        )


class FileUploadFailedError(FileError):
    """上传操作失败时抛出的异常。"""

    def __init__(self, *, detail: str, input_params: dict[str, Any]) -> None:
        super().__init__(
            code=FileErrorCode.FILE_UPLOAD_FAILED,
            title="File upload failed",
            detail=detail,
            status_code=500,
            input_params=input_params,
        )


class FileDeleteFailedError(FileError):
    """删除操作失败时抛出的异常。"""

    def __init__(self, *, file_path: str, detail: str) -> None:
        super().__init__(
            code=FileErrorCode.FILE_DELETE_FAILED,
            title="File delete failed",
            detail=detail,
            status_code=500,
            input_params={"file_path": file_path},
        )


class FileCleanupFailedError(FileError):
    """临时文件清理失败时抛出的异常。"""

    def __init__(self, *, detail: str) -> None:
        super().__init__(
            code=FileErrorCode.FILE_CLEANUP_FAILED,
            title="File cleanup failed",
            detail=detail,
            status_code=500,
        )


class StoredFileNotFoundError(FileError):
    """找不到已存储文件时抛出的异常。"""

    def __init__(self, *, file_path: str, detail: str) -> None:
        super().__init__(
            code=FileErrorCode.FILE_NOT_FOUND,
            title="File not found",
            detail=detail,
            status_code=404,
            input_params={"file_path": file_path},
        )


class FileAccessDeniedError(FileError):
    """访问超出允许范围的文件路径时抛出的异常。"""

    def __init__(self, *, file_path: str, detail: str) -> None:
        super().__init__(
            code=FileErrorCode.FILE_ACCESS_DENIED,
            title="File access denied",
            detail=detail,
            status_code=403,
            input_params={"file_path": file_path},
        )


class FileReadFailedError(FileError):
    """文件内容读取失败时抛出的异常。"""

    def __init__(self, *, file_path: str, detail: str) -> None:
        super().__init__(
            code=FileErrorCode.FILE_READ_FAILED,
            title="File read failed",
            detail=detail,
            status_code=500,
            input_params={"file_path": file_path},
        )
