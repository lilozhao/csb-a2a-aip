"""单元测试共享 fixtures。"""

from collections.abc import AsyncGenerator

import pytest
from httpx import ASGITransport, AsyncClient

from app import main as app_main


@pytest.fixture
async def main_app_client() -> AsyncGenerator[AsyncClient]:
    """创建供单元/contract 测试使用的进程内 HTTP 客户端。"""

    async with AsyncClient(transport=ASGITransport(app=app_main.app), base_url="http://test") as unit_client:
        yield unit_client
