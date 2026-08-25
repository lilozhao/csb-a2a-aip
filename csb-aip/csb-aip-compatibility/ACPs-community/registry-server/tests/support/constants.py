"""共享测试常量。"""

from __future__ import annotations

import os

from sqlalchemy.engine import make_url

DEFAULT_LOGIN_VALUE = "Aa123456!"
ROTATED_LOGIN_VALUE = "Bb123456!"
DEFAULT_TEST_DATABASE_DSN = "".join(
    (
        "postgresql+asyncpg://",
        "registry",
        ":",
        "registry",
        "@localhost:5432/agent_registry_test",
    )
)


def _resolve_test_database_dsn() -> str:
    """返回测试专用数据库 DSN，并拒绝指向开发库。"""

    dsn = os.getenv("TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_DSN).strip()
    database_name = make_url(dsn).database

    if not database_name:
        raise RuntimeError("TEST_DATABASE_URL must include a database name")

    if database_name == "agent_registry":
        raise RuntimeError(
            "TEST_DATABASE_URL must not point to development database 'agent_registry'; "
            "use a dedicated test database such as 'agent_registry_test'"
        )

    return dsn


TEST_DATABASE_DSN = _resolve_test_database_dsn()
