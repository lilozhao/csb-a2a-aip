from __future__ import annotations

from types import SimpleNamespace

import pytest

from app import main as app_main
from app.core import config as config_module
from app.core import database as database_module

pytestmark = pytest.mark.unit


def _build_test_database_url() -> str:
    return "postgresql+asyncpg://reader:" + "unit-test-placeholder" + "@db.internal:5432/agent_discovery"


def test_build_database_url_summary_redacts_credentials() -> None:
    summary = database_module.build_database_url_summary(_build_test_database_url())

    assert summary == "postgresql+asyncpg://db.internal:5432/agent_discovery"


def test_build_database_url_summary_hides_invalid_url_contents() -> None:
    summary = database_module.build_database_url_summary("not a valid database url")

    assert summary == "invalid-database-url"


def test_build_async_engine_options_uses_settings_values() -> None:
    local_settings = config_module.Settings(
        DATABASE_POOL_SIZE=7,
        DATABASE_MAX_OVERFLOW=3,
        DATABASE_POOL_TIMEOUT=12.5,
        DATABASE_POOL_RECYCLE=600,
        DATABASE_POOL_PRE_PING=False,
        DATABASE_OUTPUT_SQL=True,
    )

    assert database_module.build_async_engine_options(local_settings) == {
        "echo": True,
        "future": database_module.ENGINE_FUTURE_MODE,
        "pool_size": 7,
        "max_overflow": 3,
        "pool_timeout": 12.5,
        "pool_recycle": 600,
        "pool_pre_ping": False,
    }


def test_run_logs_summarized_database_url(monkeypatch: pytest.MonkeyPatch) -> None:
    log_records: list[tuple[str, dict[str, object]]] = []

    class _Logger:
        def info(self, event: str, **kwargs: object) -> None:
            log_records.append((event, kwargs))

    test_database_url = _build_test_database_url()

    monkeypatch.setattr(app_main, "logger", _Logger())
    monkeypatch.setattr(config_module.settings, "DATABASE_URL", test_database_url)
    monkeypatch.setattr(app_main, "uvicorn", SimpleNamespace(run=lambda *args, **kwargs: None))

    app_main.run()

    database_log = next(kwargs for event, kwargs in log_records if event == "数据库连接")
    assert database_log["database_url"] == "postgresql+asyncpg://db.internal:5432/agent_discovery"
    assert all(test_database_url not in str(kwargs) for _, kwargs in log_records)
