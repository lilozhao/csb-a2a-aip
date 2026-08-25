"""FastAPI 全局异常处理器注册。"""

from __future__ import annotations

from typing import TYPE_CHECKING, cast

from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse

from app.core.base_exception import (
    PROBLEM_JSON_MEDIA_TYPE,
    AppBaseError,
    CoreErrorCode,
    build_problem_details,
    normalize_validation_errors,
)
from app.core.logging_config import get_logger
from app.discovery.exception import ADPError
from app.discovery.schema import DiscoveryResponse, ErrorDetail

if TYPE_CHECKING:
    from fastapi import FastAPI, Request

logger = get_logger(__name__)


def adp_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """处理 ADP 协议异常并保持现有响应格式。"""

    adp_exc = cast("ADPError", exc)
    err: ErrorDetail = adp_exc.error_data
    http_status = err.code // 100
    if http_status not in (307, 400, 401, 429, 500):
        http_status = 500
    error_response = DiscoveryResponse.failure(
        code=err.code,
        message=err.message,
        data=err.data,
    )
    logger.warning(
        "Handled ADP exception",
        method=request.method,
        url=str(request.url),
        error=str(adp_exc),
        code=err.code,
    )
    return JSONResponse(status_code=http_status, content=error_response.to_dict())


def app_base_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """处理项目级业务异常。"""

    app_exc = cast("AppBaseError", exc)
    logger.warning("Handled application exception", method=request.method, url=str(request.url), error=str(app_exc))
    return JSONResponse(
        status_code=app_exc.status_code,
        content=app_exc.to_problem_details(),
        media_type=PROBLEM_JSON_MEDIA_TYPE,
    )


def validation_exception_handler(_request: Request, exc: Exception) -> JSONResponse:
    """处理请求校验异常。"""

    validation_exc = cast("RequestValidationError", exc)
    return JSONResponse(
        status_code=422,
        content=build_problem_details(
            status=422,
            title="Request validation failed",
            detail="Request body, query, or path parameters failed validation.",
            type_="urn:acps:error:validation:request-validation-failed",
            extensions={
                "error_name": CoreErrorCode.VALIDATION_FAILED,
                "errors": normalize_validation_errors(validation_exc.errors()),
            },
        ),
        media_type=PROBLEM_JSON_MEDIA_TYPE,
    )


def universal_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """处理兜底未捕获异常。"""

    logger.exception("Unhandled exception", method=request.method, url=str(request.url))
    return JSONResponse(
        status_code=500,
        content=build_problem_details(
            status=500,
            title="Internal server error",
            detail="An unexpected server error occurred.",
            type_="urn:acps:error:application:internal-server-error",
            extensions={"error_name": CoreErrorCode.INTERNAL_SERVER_ERROR},
        ),
        media_type=PROBLEM_JSON_MEDIA_TYPE,
    )


def register_exception_handlers(app: FastAPI) -> None:
    """注册 discovery-server 的全局异常处理器。"""

    app.add_exception_handler(ADPError, adp_exception_handler)
    app.add_exception_handler(AppBaseError, app_base_exception_handler)
    app.add_exception_handler(RequestValidationError, validation_exception_handler)
    app.add_exception_handler(Exception, universal_exception_handler)
