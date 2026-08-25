from enum import StrEnum
from typing import Any

from app.core.base_exception import AppError


class SyncErrorCode(StrEnum):
    """同步模块错误枚举"""

    CHANGELOG_CREATE_FAILED = "CHANGELOG_CREATE_FAILED"
    GLOBAL_SEQ_GENERATE_FAILED = "GLOBAL_SEQ_GENERATE_FAILED"
    SNAPSHOT_CREATE_FAILED = "SNAPSHOT_CREATE_FAILED"
    SNAPSHOT_NOT_FOUND = "SNAPSHOT_NOT_FOUND"
    SNAPSHOT_EXPIRED = "SNAPSHOT_EXPIRED"
    SNAPSHOT_CHUNK_NOT_FOUND = "SNAPSHOT_CHUNK_NOT_FOUND"
    SNAPSHOT_TABLE_CREATE_FAILED = "SNAPSHOT_TABLE_CREATE_FAILED"
    SNAPSHOT_TABLE_DROP_FAILED = "SNAPSHOT_TABLE_DROP_FAILED"
    SNAPSHOT_DATA_QUERY_FAILED = "SNAPSHOT_DATA_QUERY_FAILED"
    CHANGES_QUERY_FAILED = "CHANGES_QUERY_FAILED"
    RETENTION_WINDOW_EXCEEDED = "RETENTION_WINDOW_EXCEEDED"
    INVALID_CHUNK_INDEX = "INVALID_CHUNK_INDEX"
    INVALID_SNAPSHOT_PARAMS = "INVALID_SNAPSHOT_PARAMS"

    # WebHook相关错误
    WEBHOOK_CREATE_FAILED = "WEBHOOK_CREATE_FAILED"
    WEBHOOK_NOT_FOUND = "WEBHOOK_NOT_FOUND"
    WEBHOOK_UPDATE_FAILED = "WEBHOOK_UPDATE_FAILED"
    WEBHOOK_DELETE_FAILED = "WEBHOOK_DELETE_FAILED"
    WEBHOOK_QUERY_FAILED = "WEBHOOK_QUERY_FAILED"
    WEBHOOK_REACTIVATE_FAILED = "WEBHOOK_REACTIVATE_FAILED"
    WEBHOOK_INVALID_TYPES = "WEBHOOK_INVALID_TYPES"
    WEBHOOK_INVALID_EVENTS = "WEBHOOK_INVALID_EVENTS"
    WEBHOOK_NOTIFICATION_FAILED = "WEBHOOK_NOTIFICATION_FAILED"
    WEBHOOK_SIGNATURE_FAILED = "WEBHOOK_SIGNATURE_FAILED"
    WEBHOOK_STATUS_UPDATE_FAILED = "WEBHOOK_STATUS_UPDATE_FAILED"


class SyncError(AppError):
    """同步模块异常类。"""

    def __init__(
        self,
        *,
        status_code: int = 400,
        code: str | SyncErrorCode | None = None,
        title: str | None = None,
        detail: str | None = None,
        input_params: dict[str, Any] | None = None,
        error_name: str | SyncErrorCode | None = None,
        error_msg: str | None = None,
    ) -> None:
        resolved_code = str(code or error_name or "SYNC_ERROR")
        resolved_detail = detail or error_msg or "An error occurred with sync operation"
        super().__init__(
            code=resolved_code,
            title=title,
            detail=resolved_detail,
            status_code=status_code,
            type_=f"urn:acps:error:sync:{resolved_code.lower()}",
            extensions={
                "error_group": "sync",
                "input_params": input_params or {},
            },
        )
