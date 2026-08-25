"""
数据库会话管理

使用 SQLModel 和 SQLAlchemy 管理数据库连接和会话。
"""

from collections.abc import AsyncGenerator, Generator

import structlog
from sqlalchemy.engine import Engine
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from sqlmodel import Session, SQLModel, create_engine

from app.core.config import settings

logger = structlog.get_logger(__name__)

sql_echo_enabled = settings.uvicorn_log_level.lower() == "debug"

# 创建同步补充路径的数据库引擎
sync_engine = create_engine(
    settings.database_url_sync,
    echo=sql_echo_enabled,
    pool_pre_ping=True,  # 连接前检查连接是否有效
    pool_recycle=3600,  # 连接回收时间（秒）
)

# 兼容现有测试和未迁移调用方对 `engine` 的直接引用。
engine = sync_engine

# 创建请求链路使用的异步数据库引擎。
async_engine_kwargs: dict[str, object] = {
    "echo": sql_echo_enabled,
    "pool_pre_ping": True,
    "pool_recycle": 3600,
}
if settings.app_env == "testing":
    # TestClient 会跨多个 event loop 复用应用；测试环境禁用 async 连接池，避免连接绑定旧 loop。
    async_engine_kwargs["poolclass"] = NullPool

async_engine = create_async_engine(
    settings.database_url_async,
    **async_engine_kwargs,
)
async_session_factory = async_sessionmaker(async_engine, class_=AsyncSession, expire_on_commit=False)


def get_sync_engine() -> Engine:
    """返回同步补充路径使用的数据库引擎"""
    return sync_engine


def create_db_and_tables() -> None:
    """创建数据库表"""
    try:
        SQLModel.metadata.create_all(get_sync_engine())
        logger.info("数据库表创建成功")
    except Exception as e:
        logger.error("创建数据库表失败", error=str(e))
        raise


def get_sync_session() -> Generator[Session]:
    """获取同步补充路径数据库会话"""
    with Session(get_sync_engine()) as session:
        try:
            yield session
            session.commit()
        except Exception:
            session.rollback()
            raise


def get_session() -> Generator[Session]:
    """兼容当前同步调用方的数据库会话依赖"""
    yield from get_sync_session()


async def get_async_session() -> AsyncGenerator[AsyncSession]:
    """获取请求链路使用的异步数据库会话"""
    async with async_session_factory() as session:
        try:
            yield session
            await session.commit()
        except Exception:
            await session.rollback()
            raise


async def close_async_engine() -> None:
    """释放请求链路异步引擎持有的连接池资源"""
    await async_engine.dispose()


def close_sync_engine() -> None:
    """释放同步补充路径引擎持有的连接池资源"""
    get_sync_engine().dispose()


def get_db() -> Generator[Session]:
    """同步数据库会话别名，供 Alembic、脚本与测试使用"""
    yield from get_sync_session()
