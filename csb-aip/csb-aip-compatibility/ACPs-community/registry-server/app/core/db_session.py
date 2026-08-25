import os
import threading
from collections.abc import AsyncGenerator, Generator
from contextlib import contextmanager
from typing import Any

from sqlalchemy import create_engine
from sqlalchemy.engine import URL, Engine, make_url
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.orm import Session, declarative_base, sessionmaker

from app.core.config import settings


def _build_engine_kwargs() -> dict[str, Any]:
    """根据运行时配置构建共享的 SQLAlchemy engine 参数。"""
    return {
        "future": True,
        "pool_size": settings.database_pool_size,
        "max_overflow": settings.database_max_overflow,
        "pool_recycle": settings.database_pool_recycle,
        "pool_timeout": settings.database_pool_timeout,
        "pool_pre_ping": True,
        "echo": settings.app_env == "development",
    }


def _build_async_connect_args() -> dict[str, dict[str, str]]:
    """构建带有显式会话时区设置的 asyncpg 连接参数。"""

    return {
        "server_settings": {
            "timezone": settings.database_session_timezone,
        }
    }


def _build_sync_connect_args() -> dict[str, str]:
    """构建带有显式会话时区设置的 psycopg 连接参数。"""

    return {
        "options": f"-c timezone={settings.database_session_timezone}",
    }


def _build_async_database_url() -> URL:
    """将配置中的数据库 URL 规范化为 asyncpg 驱动。"""
    return make_url(settings.database_url).set(drivername="postgresql+asyncpg")


def _build_sync_database_url() -> URL:
    """将配置中的数据库 URL 规范化为 psycopg 驱动。"""
    return make_url(settings.database_url).set(drivername="postgresql+psycopg")


_sync_engine: Engine | None = None
_sync_engine_pid: int | None = None
_sync_session_factory: sessionmaker[Session] | None = None
_sync_engine_lock = threading.Lock()


def get_sync_engine() -> Engine:
    """返回进程内本地的同步 engine。

    同步 engine 采用懒加载方式初始化；如果当前进程 ID 与创建缓存 engine
    的进程 ID 不一致，则会自动重新创建。
    """
    global _sync_engine, _sync_engine_pid, _sync_session_factory

    current_pid = os.getpid()
    if _sync_engine is None or _sync_engine_pid != current_pid:
        with _sync_engine_lock:
            if _sync_engine is None or _sync_engine_pid != current_pid:
                engine = create_engine(
                    _build_sync_database_url(),
                    connect_args=_build_sync_connect_args(),
                    **_build_engine_kwargs(),
                )
                _sync_engine = engine
                _sync_session_factory = sessionmaker(engine, autoflush=False, expire_on_commit=False)
                _sync_engine_pid = current_pid

    if _sync_engine is None:
        raise RuntimeError("Failed to initialize sync engine")

    return _sync_engine


def _get_sync_session_factory() -> sessionmaker[Session]:
    """返回缓存的同步 session factory；必要时先完成初始化。"""
    get_sync_engine()
    if _sync_session_factory is None:
        raise RuntimeError("Sync session factory is not initialized")
    return _sync_session_factory


def close_sync_engine() -> None:
    """释放缓存的同步 engine，并清理进程内 session 状态。"""
    global _sync_engine, _sync_engine_pid, _sync_session_factory

    with _sync_engine_lock:
        if _sync_engine is not None:
            _sync_engine.dispose()
        _sync_engine = None
        _sync_session_factory = None
        _sync_engine_pid = None


async_engine = create_async_engine(
    _build_async_database_url(),
    connect_args=_build_async_connect_args(),
    **_build_engine_kwargs(),
)
AsyncSessionLocal = async_sessionmaker(async_engine, autoflush=False, expire_on_commit=False)

Base = declarative_base()


async def get_session() -> AsyncGenerator[AsyncSession]:
    """提供带有请求级 commit/rollback 处理的异步 session。"""
    async with AsyncSessionLocal() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


@contextmanager
def get_sync_session() -> Generator[Session]:
    """提供带有自动 commit/rollback 处理的同步 session。"""
    session = _get_sync_session_factory()()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
