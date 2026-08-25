"""
ACME 错误处理中间件

统一处理 ACME 协议相关的异常和错误响应
"""

from collections.abc import Awaitable, Callable
from typing import Any

import structlog
from fastapi import HTTPException, Request
from fastapi.responses import JSONResponse
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.responses import Response

from .exception import AcmeError, AcmeException

logger = structlog.get_logger(__name__)


class ACMEErrorHandler(BaseHTTPMiddleware):
    """ACME 错误处理中间件"""

    ACME_PATH_PREFIX = "/acps-atr-v2/acme"

    async def dispatch(self, request: Request, call_next: Callable[[Request], Awaitable[Response]]) -> Response:
        # 仅处理 ACME 协议路径，避免污染非 ACME 路由的错误契约。
        if not request.url.path.startswith(self.ACME_PATH_PREFIX):
            return await call_next(request)

        try:
            return await call_next(request)
        except AcmeException as e:
            return await self.handle_acme_exception(request, e)
        except HTTPException as e:
            return await self.handle_http_exception(request, e)
        except Exception as e:
            return await self.handle_generic_exception(request, e)

    async def handle_acme_exception(self, request: Request, exc: AcmeException) -> JSONResponse:
        """处理 ACME 协议异常"""
        logger.error("ACME exception", error_name=exc.error_name, error_msg=exc.error_msg)

        error_response = {
            "type": f"urn:ietf:params:acme:error:{exc.error_name}",
            "detail": exc.error_msg,
            "status": exc.status_code,
        }

        # 添加额外的错误信息
        if hasattr(exc, "subproblems") and exc.subproblems:
            error_response["subproblems"] = exc.subproblems

        if hasattr(exc, "identifier") and exc.identifier:
            error_response["identifier"] = exc.identifier

        return JSONResponse(
            status_code=exc.status_code,
            content=error_response,
            headers={
                "Content-Type": "application/problem+json",
                "Cache-Control": "no-store",
            },
        )

    async def handle_http_exception(self, request: Request, exc: HTTPException) -> JSONResponse:
        """处理 HTTP 异常"""
        logger.error("HTTP exception", status_code=exc.status_code, detail=exc.detail)

        # 将 HTTP 异常转换为 ACME 错误格式
        error_name = self._map_http_status_to_acme_error(exc.status_code)

        error_response = {
            "type": f"urn:ietf:params:acme:error:{error_name}",
            "detail": exc.detail,
            "status": exc.status_code,
        }

        return JSONResponse(
            status_code=exc.status_code,
            content=error_response,
            headers={
                "Content-Type": "application/problem+json",
                "Cache-Control": "no-store",
            },
        )

    async def handle_generic_exception(self, request: Request, exc: Exception) -> JSONResponse:
        """处理通用异常"""
        logger.exception("Unhandled exception", exc=str(exc))

        error_response = {
            "type": f"urn:ietf:params:acme:error:{AcmeError.SERVER_INTERNAL}",
            "detail": "Internal server error",
            "status": 500,
        }

        return JSONResponse(
            status_code=500,
            content=error_response,
            headers={
                "Content-Type": "application/problem+json",
                "Cache-Control": "no-store",
            },
        )

    def _map_http_status_to_acme_error(self, status_code: int) -> str:
        """将 HTTP 状态码映射到 ACME 错误类型"""
        mapping = {
            400: AcmeError.MALFORMED,
            401: AcmeError.UNAUTHORIZED,
            403: AcmeError.UNAUTHORIZED,
            404: AcmeError.MALFORMED,
            405: AcmeError.MALFORMED,
            409: AcmeError.MALFORMED,
            415: AcmeError.MALFORMED,
            429: AcmeError.RATE_LIMITED,
            500: AcmeError.SERVER_INTERNAL,
            502: AcmeError.SERVER_INTERNAL,
            503: AcmeError.SERVER_INTERNAL,
            504: AcmeError.SERVER_INTERNAL,
        }

        return mapping.get(status_code, AcmeError.SERVER_INTERNAL)


def create_acme_error_response(error_name: str, detail: str, status_code: int = 400, **kwargs: Any) -> dict[str, Any]:
    """创建标准的 ACME 错误响应"""
    error_response = {
        "type": f"urn:ietf:params:acme:error:{error_name}",
        "detail": detail,
        "status": status_code,
    }

    # 添加额外的字段
    for key, value in kwargs.items():
        if value is not None:
            error_response[key] = value

    return error_response


def validate_request_headers(request: Request) -> None:
    """验证请求头"""
    # 检查 Content-Type
    content_type = request.headers.get("content-type", "")
    if not content_type.startswith("application/jose+json"):
        raise AcmeException(
            status_code=415,
            error_name=AcmeError.MALFORMED,
            error_msg="Content-Type must be application/jose+json",
        )

    # 检查 User-Agent（可选）
    user_agent = request.headers.get("user-agent", "")
    if not user_agent:
        logger.warning("Request without User-Agent header")


def validate_acme_request(request_data: dict[str, Any], required_fields: list[str]) -> None:
    """验证 ACME 请求数据"""
    for field in required_fields:
        if field not in request_data:
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.MALFORMED,
                error_msg=f"Missing required field: {field}",
            )

        if request_data[field] is None or request_data[field] == "":
            raise AcmeException(
                status_code=400,
                error_name=AcmeError.MALFORMED,
                error_msg=f"Field '{field}' cannot be empty",
            )
