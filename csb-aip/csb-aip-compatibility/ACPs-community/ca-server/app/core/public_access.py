"""公开读取接口的缓存与限流辅助。"""

from __future__ import annotations

import math
import time
from collections import defaultdict, deque
from threading import Lock

from fastapi import Depends, Request

from app.core.base_exception import AppError
from app.core.config import Settings, get_settings


class PublicReadRateLimiter:
    """简单的进程内公开读取限流器。"""

    def __init__(self) -> None:
        self._events: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def reset(self) -> None:
        """清空所有限流状态。"""
        with self._lock:
            self._events.clear()

    def allow(self, key: str, *, limit: int, window_seconds: int) -> tuple[bool, int]:
        """判断是否允许当前请求，并返回建议重试秒数。"""
        now = time.monotonic()
        with self._lock:
            events = self._events[key]
            while events and now - events[0] >= window_seconds:
                events.popleft()

            if len(events) >= limit:
                retry_after = max(1, math.ceil(window_seconds - (now - events[0])))
                return False, retry_after

            events.append(now)
            return True, 0


PUBLIC_READ_RATE_LIMITER = PublicReadRateLimiter()


def _get_client_ip(request: Request) -> str:
    """提取客户端 IP，用于公开读取限流。"""
    client_host = request.client.host if request.client else "unknown"
    if client_host == "testclient":
        return "127.0.0.1"
    return client_host


def limit_public_read_access(
    request: Request,
    settings: Settings = Depends(get_settings),
) -> None:
    """对公开读取接口施加基础限流。"""
    limit = settings.public_read_rate_limit_requests
    if limit <= 0:
        return

    allowed, retry_after = PUBLIC_READ_RATE_LIMITER.allow(
        _get_client_ip(request),
        limit=limit,
        window_seconds=settings.public_read_rate_limit_window_seconds,
    )
    if allowed:
        return

    raise AppError(
        code="RATE_LIMITED",
        title="Too many requests",
        detail="Public read request limit exceeded. Please retry later.",
        status_code=429,
        extensions={"retry_after": max(retry_after, settings.public_read_retry_after_seconds)},
    )
