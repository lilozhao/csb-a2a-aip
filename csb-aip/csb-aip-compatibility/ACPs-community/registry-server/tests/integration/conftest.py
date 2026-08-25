"""集成测试共享 fixtures。"""

from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app import main as app_main
from app.core.db_session import AsyncSessionLocal
from tests.support.database import reset_database_state


@pytest.fixture(autouse=True)
async def isolated_database() -> AsyncGenerator[None]:
    """在每个集成测试前后清理真实数据库。"""

    await reset_database_state()
    yield
    await reset_database_state()


@pytest.fixture
async def client() -> AsyncGenerator[AsyncClient]:
    """创建命中主应用的进程内 HTTP 客户端。"""

    async with AsyncClient(transport=ASGITransport(app=app_main.app), base_url="http://test") as integration_client:
        yield integration_client


@pytest.fixture
async def mtls_client() -> AsyncGenerator[AsyncClient]:
    """创建命中 mTLS 平面的进程内 HTTP 客户端。"""

    async with AsyncClient(
        transport=ASGITransport(app=app_main.mtls_app), base_url="http://test-mtls"
    ) as integration_client:
        yield integration_client


@pytest.fixture
async def blocked_mtls_client() -> AsyncGenerator[AsyncClient]:
    """创建使用非白名单来源 IP 的 mTLS 平面进程内 HTTP 客户端。"""

    async with AsyncClient(
        transport=ASGITransport(
            app=app_main.mtls_app,
            client=("203.0.113.10", 4321),
            raise_app_exceptions=False,
        ),
        base_url="http://test-mtls",
    ) as integration_client:
        yield integration_client


@pytest.fixture
async def db_session() -> AsyncGenerator[AsyncSession]:
    """提供真实数据库会话供测试数据准备使用。"""

    async with AsyncSessionLocal() as session:
        yield session
