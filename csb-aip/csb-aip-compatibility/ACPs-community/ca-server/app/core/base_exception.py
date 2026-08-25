"""项目级异常基座与全局异常处理器"""

from enum import StrEnum
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

PROBLEM_JSON_MEDIA_TYPE = "application/problem+json"


class CoreErrorCode(StrEnum):
    """核心模块错误码"""

    VALIDATION_FAILED = "VALIDATION_FAILED"


def build_problem_details(
    *,
    status: int,
    title: str,
    detail: str,
    type_: str,
    extensions: dict[str, object] | None = None,
) -> dict[str, object]:
    """构建 RFC 9457 兼容的 Problem Details 响应体"""
    payload: dict[str, object] = {
        "type": type_,
        "status": status,
        "title": title,
        "detail": detail,
    }
    if extensions:
        payload.update(extensions)
    return payload


class AppError(Exception):
    """项目级业务异常基类（RFC 9457 Problem Details）"""

    def __init__(
        self,
        *,
        code: str,
        title: str,
        detail: str,
        status_code: int = 400,
        type_: str | None = None,
        extensions: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.title = title
        self.detail = detail
        self.status_code = status_code
        self.type = type_ or f"urn:acps:error:application:{code.lower().replace('_', '-')}"
        self.extensions = extensions or {}
        super().__init__(detail)

    def to_problem_details(self) -> dict[str, object]:
        """转换为 RFC 9457 兼容响应体"""
        return build_problem_details(
            status=self.status_code,
            title=self.title,
            detail=self.detail,
            type_=self.type,
            # `code` 为对外主字段，`error_name` 保留用于兼容历史客户端。
            extensions={"error_name": self.code, **self.extensions, "code": self.code},
        )

    # ── 向后兼容属性（供已有子类使用，避免大范围改动） ──

    @property
    def error_name(self) -> str:
        return self.code

    @error_name.setter
    def error_name(self, value: str) -> None:
        self.code = value

    @property
    def error_msg(self) -> str:
        return self.detail

    @error_msg.setter
    def error_msg(self, value: str) -> None:
        self.detail = value

    @property
    def input_params(self) -> dict[str, Any]:
        value = self.extensions.get("input_params")
        return value if isinstance(value, dict) else {}

    @input_params.setter
    def input_params(self, value: dict[str, Any]) -> None:
        self.extensions["input_params"] = value


def app_error_handler(_request: Request, exc: AppError) -> JSONResponse:
    """将 AppError 转换为 RFC 9457 Problem Details 响应"""
    headers: dict[str, str] = {}
    retry_after = exc.extensions.get("retry_after")
    if isinstance(retry_after, int | str):
        headers["Retry-After"] = str(retry_after)

    return JSONResponse(
        status_code=exc.status_code,
        content=exc.to_problem_details(),
        media_type=PROBLEM_JSON_MEDIA_TYPE,
        headers=headers,
    )


def validation_error_handler(_request: Request, exc: RequestValidationError) -> JSONResponse:
    """将请求校验错误转换为 RFC 9457 Problem Details 格式"""
    return JSONResponse(
        status_code=422,
        content=build_problem_details(
            status=422,
            title="Request validation failed",
            detail="Request body, query, or path parameters failed validation.",
            type_="urn:acps:error:validation:request-validation-failed",
            extensions={
                "error_name": CoreErrorCode.VALIDATION_FAILED,
                "errors": exc.errors(),
                "code": CoreErrorCode.VALIDATION_FAILED,
            },
        ),
        media_type=PROBLEM_JSON_MEDIA_TYPE,
    )


def register_exception_handlers(app: FastAPI) -> None:
    """注册项目全局异常处理器"""
    app.add_exception_handler(AppError, app_error_handler)  # type: ignore[arg-type]
    app.add_exception_handler(RequestValidationError, validation_error_handler)  # type: ignore[arg-type]
