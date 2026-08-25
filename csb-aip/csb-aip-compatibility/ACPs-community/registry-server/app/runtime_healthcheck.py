"""容器运行时的双 listener 健康检查。"""

from __future__ import annotations

import http.client
import socket

from app.core.config import settings

PUBLIC_HEALTH_HOST = "127.0.0.1"
SOCKET_TIMEOUT_SECONDS = 5


def _mtls_listener_enabled() -> bool:
    """返回当前健康检查是否应校验 9002。"""
    return settings.enable_mtls_listener


def _check_public_listener() -> None:
    """验证 public listener 的 HTTP 健康检查。"""
    connection = http.client.HTTPConnection(
        PUBLIC_HEALTH_HOST,
        settings.uvicorn_port,
        timeout=SOCKET_TIMEOUT_SECONDS,
    )
    try:
        connection.request("GET", "/health")
        response = connection.getresponse()
        if response.status >= 400:
            raise OSError(f"Public listener health check failed with status {response.status}")
        response.read()
    finally:
        connection.close()


def _check_mtls_listener() -> None:
    """验证 mTLS listener 至少已完成端口绑定。"""
    with socket.create_connection(
        (PUBLIC_HEALTH_HOST, settings.mtls_port),
        timeout=SOCKET_TIMEOUT_SECONDS,
    ):
        return


def main() -> int:
    """执行双 listener 健康检查。"""
    try:
        _check_public_listener()
        if _mtls_listener_enabled():
            _check_mtls_listener()
    except OSError:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
