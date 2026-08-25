"""HTTP 安全响应头中间件。"""

from collections.abc import Awaitable, Callable

from fastapi import Request, Response

from app.core.config import settings

CallNext = Callable[[Request], Awaitable[Response]]


def build_security_headers(app_env: str) -> dict[str, str]:
    """构造当前环境需要附加的安全响应头。"""

    headers = {
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "DENY",
        "Referrer-Policy": "no-referrer",
    }

    if app_env == "production":
        headers["Strict-Transport-Security"] = "max-age=63072000; includeSubDomains"

    return headers


async def security_headers_middleware(request: Request, call_next: CallNext) -> Response:
    """为响应补充最小安全头。"""

    response = await call_next(request)

    for header_name, header_value in build_security_headers(settings.APP_ENV).items():
        response.headers.setdefault(header_name, header_value)

    return response
