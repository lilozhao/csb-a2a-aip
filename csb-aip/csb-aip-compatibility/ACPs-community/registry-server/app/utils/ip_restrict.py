"""IP 访问限制工具。"""

import ipaddress
from collections.abc import Awaitable, Callable

import structlog
from fastapi import Request, status
from starlette.middleware.base import RequestResponseEndpoint
from starlette.responses import JSONResponse, Response

logger = structlog.get_logger(__name__)

type AllowedNetwork = ipaddress.IPv4Network | ipaddress.IPv6Network


def parse_allowed_ips(ip_list_str: str) -> list[AllowedNetwork]:
    """
    解析逗号分隔的IP地址和CIDR网络列表

    Args:
        ip_list_str: 逗号分隔的IP地址字符串，支持单个IP和CIDR网络

    Returns:
        list[AllowedNetwork]: 解析后的网络对象列表
    """
    allowed_networks: list[AllowedNetwork] = []
    if not ip_list_str:
        return allowed_networks

    for ip_str in ip_list_str.split(","):
        ip_str = ip_str.strip()
        if not ip_str:
            continue
        try:
            # 处理单个IP和CIDR网络
            if "/" not in ip_str:
                # 如果没有指定子网，为IPv4添加/32，为IPv6添加/128
                if ":" in ip_str:
                    ip_str += "/128"  # IPv6
                else:
                    ip_str += "/32"  # IPv4
            allowed_networks.append(ipaddress.ip_network(ip_str, strict=False))
        except ValueError as e:
            logger.warning("允许 IP 列表中存在非法 IP 地址或网段", ip_or_network=ip_str, error=str(e))

    return allowed_networks


def create_ip_restriction_middleware(
    allowed_networks: list[AllowedNetwork],
    path_prefix: str,
) -> Callable[[Request, RequestResponseEndpoint], Awaitable[Response]]:
    """
    创建IP限制中间件

    Args:
        allowed_networks: 允许访问的网络列表
        path_prefix: 需要限制的路径前缀

    Returns:
        中间件函数
    """

    def _build_forbidden_response(detail: str) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_403_FORBIDDEN,
            content={"detail": detail},
        )

    def _validate_client_ip(client_ip: str, request_path: str) -> JSONResponse | None:
        try:
            client_ip_obj = ipaddress.ip_address(client_ip)
        except ValueError as error:
            logger.error("客户端 IP 地址非法", client_ip=client_ip, error=str(error))
            return _build_forbidden_response("Access denied: Invalid client IP address")

        allowed = any(client_ip_obj in network for network in allowed_networks)
        if allowed:
            return None

        logger.warning("IP 访问被拒绝", client_ip=client_ip, path=request_path)
        return _build_forbidden_response("Access denied: IP address not allowed")

    async def ip_restriction_middleware(request: Request, call_next: RequestResponseEndpoint) -> Response:
        """中间件函数：基于客户端 IP 限制对特定端点的访问。"""
        if not request.url.path.startswith(path_prefix):
            return await call_next(request)

        client_ip = request.client.host if request.client else None
        if client_ip is None:
            return await call_next(request)

        forbidden_response = _validate_client_ip(client_ip, request.url.path)
        if forbidden_response is not None:
            return forbidden_response

        return await call_next(request)

    return ip_restriction_middleware
