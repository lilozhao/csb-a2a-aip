from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING, Any

from app.core.base_exception import AppBaseError

if TYPE_CHECKING:
    from acps_sdk.adp import ErrorDetail


class DiscoveryError(StrEnum):
    """
    定义发现相关错误类型常量的类。

    可通过点号访问的方式引用错误类型，例如: DiscoveryError.DISCOVERY_FAIL
    """

    DISCOVERY_FAIL = "discovery_fail"
    DATABASE_ERROR = "database_error"
    ENHANCED_DISCOVERY_FAIL = "enhanced_discovery_fail"


class DiscoveryOperationError(AppBaseError):
    """
    与发现（discovery）相关的自定义异常类。

    继承自 AppBaseError，但将 error_group 固定为 "discovery"。
    """

    def __init__(
        self,
        status_code: int = 400,
        error_name: str | DiscoveryError = DiscoveryError.DISCOVERY_FAIL,
        error_msg: str = "An error occurred with discovery operation",
        input_params: dict[str, Any] | None = None,
    ):
        super().__init__(
            status_code=status_code,
            error_group="discovery",  # 对所有 DiscoveryException 固定为 "discovery"
            error_name=error_name,
            error_msg=error_msg,
            input_params=input_params,
        )


class ADPError(Exception):
    """
    自定义的业务逻辑异常。

    它封装了一个结构化的 ErrorData 对象，以便 API 层可以轻松地
    将其转换为一个标准的错误响应。
    """

    def __init__(self, error_data: ErrorDetail):
        self.error_data = error_data
        # 让异常的默认消息就是 ErrorData 中的消息
        super().__init__(f"[{self.error_data.code}] {self.error_data.message}")
