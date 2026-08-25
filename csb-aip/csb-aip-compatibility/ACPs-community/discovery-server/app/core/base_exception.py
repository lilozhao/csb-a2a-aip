"""项目级异常基座与 Problem Details 工具。"""

from __future__ import annotations

from enum import StrEnum
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Sequence

PROBLEM_JSON_MEDIA_TYPE = "application/problem+json"


class CoreErrorCode(StrEnum):
    """核心模块错误码。"""

    INTERNAL_SERVER_ERROR = "INTERNAL_SERVER_ERROR"
    SERVICE_NOT_READY = "SERVICE_NOT_READY"
    VALIDATION_FAILED = "VALIDATION_FAILED"


def _default_error_title(code: str) -> str:
    """根据错误码生成默认标题。"""

    return code.replace("_", " ").title()


def build_problem_details(
    *,
    status: int,
    title: str,
    detail: str,
    type_: str,
    extensions: dict[str, object] | None = None,
) -> dict[str, object]:
    """构造符合 RFC 9457 的响应载荷。"""

    payload: dict[str, object] = {
        "type": type_,
        "status": status,
        "title": title,
        "detail": detail,
    }
    if extensions:
        payload.update(extensions)
    return payload


def _to_json_safe(value: Any) -> object:
    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, dict):
        return {str(key): _to_json_safe(item) for key, item in value.items()}
    if isinstance(value, list | tuple | set):
        return [_to_json_safe(item) for item in value]
    return str(value)


def normalize_validation_errors(errors: Sequence[Any]) -> list[dict[str, object]]:
    """将校验错误载荷转换为 JSON-safe 结构。"""

    normalized_errors: list[dict[str, object]] = []
    for error in errors:
        if isinstance(error, dict):
            normalized_errors.append({str(key): _to_json_safe(value) for key, value in error.items()})
            continue
        normalized_errors.append({"detail": _to_json_safe(error)})
    return normalized_errors


class AppBaseError(Exception):
    """项目级业务异常基类（兼容旧构造参数）。"""

    def __init__(
        self,
        status_code: int = 400,
        error_group: str = "base",
        error_name: str = "unknown_error",
        error_msg: str = "An error occurred",
        input_params: dict[str, Any] | None = None,
    ) -> None:
        self.status_code = status_code
        self.error_group = error_group
        self.error_name = error_name
        self.error_msg = error_msg
        self.input_params = input_params or {}
        self.type = f"urn:acps:error:{error_group}:{error_name.lower().replace('_', '-')}"
        super().__init__(self.error_msg)

    @property
    def title(self) -> str:
        """返回用于 Problem Details 的标题。"""

        return _default_error_title(self.error_name)

    @property
    def detail(self) -> str:
        """返回用于 Problem Details 的详细描述。"""

        return self.error_msg

    def to_problem_details(self) -> dict[str, object]:
        """将异常转换为符合 RFC 9457 的响应载荷。"""

        return build_problem_details(
            status=self.status_code,
            title=self.title,
            detail=self.detail,
            type_=self.type,
            extensions={
                "error_name": self.error_name,
                "error_group": self.error_group,
                "input_params": self.input_params,
            },
        )
