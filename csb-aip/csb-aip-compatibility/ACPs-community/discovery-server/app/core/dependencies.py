"""service 层运行时依赖提供器。"""

from __future__ import annotations

from collections.abc import Callable
from contextlib import AbstractAsyncContextManager
from dataclasses import dataclass

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import Settings, settings
from app.core.database import get_async_session_context

SessionContextFactory = Callable[[], AbstractAsyncContextManager[AsyncSession]]


@dataclass(frozen=True)
class ServiceRuntime:
    """封装 service 层可注入的运行时依赖。"""

    settings: Settings
    session_factory: SessionContextFactory


def get_service_runtime() -> ServiceRuntime:
    """返回默认的 service 运行时依赖。"""

    return ServiceRuntime(settings=settings, session_factory=get_async_session_context)
