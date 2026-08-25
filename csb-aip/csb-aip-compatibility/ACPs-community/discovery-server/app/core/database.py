"""
数据库配置与会话管理。

此模块为 Agent Discovery Server 提供 SQLModel/SQLAlchemy 的数据库引擎、
会话管理以及数据库工具函数。
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

from sqlalchemy.engine import make_url
from sqlalchemy.exc import ArgumentError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import Settings, settings

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

ENGINE_FUTURE_MODE = True


def build_database_url_summary(database_url: str) -> str:
    """构造不会泄露凭据的数据库 DSN 摘要。"""

    try:
        parsed = make_url(database_url)
    except ArgumentError:
        return "invalid-database-url"

    summary = f"{parsed.drivername}://"
    if parsed.host:
        summary += parsed.host
        if parsed.port is not None:
            summary += f":{parsed.port}"

    if parsed.database:
        summary += f"/{parsed.database}"

    return summary


def build_async_engine_options(database_settings: Settings) -> dict[str, object]:
    """根据 Settings 构造异步引擎参数。"""

    return {
        "echo": database_settings.DATABASE_OUTPUT_SQL,
        "future": ENGINE_FUTURE_MODE,
        "pool_size": database_settings.DATABASE_POOL_SIZE,
        "max_overflow": database_settings.DATABASE_MAX_OVERFLOW,
        "pool_timeout": database_settings.DATABASE_POOL_TIMEOUT,
        "pool_recycle": database_settings.DATABASE_POOL_RECYCLE,
        "pool_pre_ping": database_settings.DATABASE_POOL_PRE_PING,
    }


# 为数据库操作创建异步引擎
async_engine = create_async_engine(
    settings.DATABASE_URL,
    **build_async_engine_options(settings),
)

# Create async session factory
AsyncSessionLocal = async_sessionmaker(
    bind=async_engine,
    expire_on_commit=False,
)


@asynccontextmanager
async def get_async_session_context() -> AsyncGenerator[AsyncSession]:
    """获取可通过 async with 使用的异步数据库会话。"""

    async with AsyncSessionLocal() as session:
        try:
            yield session
        finally:
            await session.close()


async def get_async_session() -> AsyncGenerator[AsyncSession]:
    """
    获取异步数据库会话的依赖（生成器）。

    Yields:
        AsyncSession: 异步数据库会话
    """
    async with get_async_session_context() as session:
        yield session


async def close_db() -> None:
    """关闭数据库连接。"""
    await async_engine.dispose()
