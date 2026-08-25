from enum import StrEnum
from typing import Any

from app.core.base_exception import AppBaseError


class SyncError(StrEnum):
    """
    定义同步相关错误类型常量的类。

    可通过点号访问的方式引用错误类型，例如: SyncError.CONNECTION_FAIL
    """

    CONNECTION_FAIL = "connection_fail"
    REGISTRY_UNAVAILABLE = "registry_unavailable"
    SYNC_FAIL = "sync_fail"
    SNAPSHOT_FAIL = "snapshot_fail"
    CHANGES_FAIL = "changes_fail"
    RETENTION_WINDOW_EXCEEDED = "retention_window_exceeded"
    INVALID_RESPONSE = "invalid_response"
    CLIENT_CONFIG_ERROR = "client_config_error"
    DATABASE_ERROR = "database_error"


class SyncOperationError(AppBaseError):
    """
    与同步（sync）相关的自定义异常类。

    继承自 AppBaseError，但将 error_group 固定为 "sync"。
    """

    def __init__(
        self,
        status_code: int = 400,
        error_name: str | SyncError = SyncError.SYNC_FAIL,
        error_msg: str = "An error occurred with sync operation",
        input_params: dict[str, Any] | None = None,
    ):
        super().__init__(
            status_code=status_code,
            error_group="sync",  # 对所有 SyncException 固定为 "sync"
            error_name=error_name,
            error_msg=error_msg,
            input_params=input_params,
        )
