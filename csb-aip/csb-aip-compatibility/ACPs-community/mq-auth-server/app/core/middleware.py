"""请求 ID 中间件：生成或继承 X-Request-ID，注入 structlog 上下文。"""

from __future__ import annotations

import uuid

import structlog
from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

logger = structlog.get_logger()


class RequestIdMiddleware(BaseHTTPMiddleware):
    """每个请求生成或继承 X-Request-ID，绑定到 structlog contextvars。

    - 若请求头携带 X-Request-ID，则沿用（便于上游传递 trace 链路）。
    - 否则生成新的 UUID4。
    - 响应头回写 X-Request-ID，便于调用方日志关联。
    """

    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("X-Request-ID") or str(uuid.uuid4())

        # 清除上一请求的上下文，绑定当前请求 ID
        structlog.contextvars.clear_contextvars()
        structlog.contextvars.bind_contextvars(request_id=request_id)

        response = await call_next(request)
        response.headers["X-Request-ID"] = request_id
        return response
