"""单元测试 fixtures。

使用 InMemoryGroupAclStore 完全隔离 Redis，快速运行。
"""

from __future__ import annotations

import pytest


@pytest.fixture(autouse=True)
def reset_lru_cache() -> None:
    """每个测试前清除 get_settings() 缓存，避免配置状态污染。"""
    from app.core.config import get_settings

    get_settings.cache_clear()
