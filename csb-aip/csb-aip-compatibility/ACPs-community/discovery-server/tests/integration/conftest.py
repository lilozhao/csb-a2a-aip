from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import TYPE_CHECKING

import pytest
import pytest_asyncio
from dotenv import dotenv_values
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app import main as app_main
from app.core import config as config_module
from app.core.database import build_async_engine_options, get_async_session
from app.core.dependencies import ServiceRuntime, get_service_runtime
from tests._seed_support import build_default_test_database_url, reseed_test_database, resolve_test_database_url

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

    from fastapi import FastAPI


_INTEGRATION_WEBHOOK_SECRET = "integration" + "-secret"
INTEGRATION_TESTS_DIR = Path(__file__).resolve().parent
PROJECT_ROOT = Path(__file__).resolve().parents[2]
DOTENV_VALUES = dotenv_values(PROJECT_ROOT / ".env")
DEFAULT_TEST_DATABASE_URL = build_default_test_database_url()


def _resolve_integration_mode() -> str:
    mode = (os.getenv("DISCOVERY_TEST_MODE") or os.getenv("DISCOVERY_MODE") or "cpu").strip().lower()
    return mode or "cpu"


def _resolve_test_database_url() -> str:
    return resolve_test_database_url(PROJECT_ROOT)


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """为 integration 目录下未显式标注的测试补齐 integration marker。"""

    for item in items:
        item_path = Path(str(item.path)).resolve()
        if item_path != INTEGRATION_TESTS_DIR and INTEGRATION_TESTS_DIR not in item_path.parents:
            continue
        if item.get_closest_marker("integration") is None:
            item.add_marker(pytest.mark.integration)


@pytest.fixture
def test_database_url() -> str:
    database_url = _resolve_test_database_url()
    os.environ["TEST_DATABASE_URL"] = database_url
    return database_url


@pytest.fixture(scope="session", autouse=True)
def prepare_integration_seed_data() -> None:
    """在 integration 套件启动前自动重建测试样本数据。"""

    try:
        reseed_test_database(
            project_root=PROJECT_ROOT,
            database_url=_resolve_test_database_url(),
            mode=_resolve_integration_mode(),
        )
    except RuntimeError as exc:
        pytest.fail(str(exc))


@pytest.fixture
def integration_settings(test_database_url: str) -> config_module.Settings:
    integration_mode = _resolve_integration_mode()

    return config_module.Settings(
        APP_ENV="testing",
        DATABASE_URL=test_database_url,
        DISCOVERY_MODE=integration_mode,
        DSP_AUTO_START=False,
        EMBEDDING_MODEL_PATH=os.getenv("DISCOVERY_TEST_EMBEDDING_MODEL_PATH", os.getenv("EMBEDDING_MODEL_PATH", "")),
        EMBEDDING_DEVICES=os.getenv("DISCOVERY_TEST_EMBEDDING_DEVICES", os.getenv("EMBEDDING_DEVICES", "cpu")),
        EMBEDDING_API_KEY=os.getenv(
            "DISCOVERY_TEST_EMBEDDING_API_KEY",
            os.getenv("EMBEDDING_API_KEY", "integration-test-key"),
        ),
        EMBEDDING_BASE_URL=os.getenv("DISCOVERY_TEST_EMBEDDING_BASE_URL", "http://127.0.0.1:9/v1"),
        EMBEDDING_MODEL_NAME=os.getenv("DISCOVERY_TEST_EMBEDDING_MODEL_NAME", "integration-test-model"),
        DISCOVERY_LLM_API_KEY=os.getenv(
            "DISCOVERY_TEST_DISCOVERY_LLM_API_KEY",
            os.getenv("DISCOVERY_LLM_API_KEY", "integration-test-key"),
        ),
        DISCOVERY_LLM_BASE_URL=os.getenv("DISCOVERY_TEST_DISCOVERY_LLM_BASE_URL", "http://127.0.0.1:9/v1"),
        DISCOVERY_LLM_MODEL_NAME=os.getenv(
            "DISCOVERY_TEST_DISCOVERY_LLM_MODEL_NAME",
            "integration-test-discovery-model",
        ),
        RERANKER_URL=os.getenv("DISCOVERY_TEST_RERANKER_URL", ""),
        DSP_BASE_URL="https://registry.example.com/acps-dsp-v2",
        DSP_WEBHOOK_SECRET=_INTEGRATION_WEBHOOK_SECRET,
        DSP_WEBHOOK_RECEIVE_URL="https://discovery.example.com/admin/dsp/webhooks/receive",
        FORWARDER_SERVER_ENABLED=False,
        FORWARDER_SERVER_URL="",
        POLLING_SERVER_URL="",
    )


@pytest_asyncio.fixture
async def test_session_factory(
    integration_settings: config_module.Settings,
) -> AsyncGenerator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(
        integration_settings.DATABASE_URL,
        **build_async_engine_options(integration_settings),
    )
    session_factory = async_sessionmaker(bind=engine, expire_on_commit=False)
    try:
        yield session_factory
    finally:
        await engine.dispose()


@pytest.fixture
def service_runtime(
    integration_settings: config_module.Settings,
    test_session_factory: async_sessionmaker[AsyncSession],
) -> ServiceRuntime:
    @asynccontextmanager
    async def session_factory() -> AsyncGenerator[AsyncSession]:
        async with test_session_factory() as session:
            yield session

    return ServiceRuntime(settings=integration_settings, session_factory=session_factory)


@pytest_asyncio.fixture
async def integration_app(
    monkeypatch: pytest.MonkeyPatch,
    service_runtime: ServiceRuntime,
    test_session_factory: async_sessionmaker[AsyncSession],
) -> AsyncGenerator[FastAPI]:
    async def override_get_async_session() -> AsyncGenerator[AsyncSession]:
        async with test_session_factory() as session:
            yield session

    async def fake_check_database_ready() -> bool:
        async with test_session_factory() as session:
            await session.execute(text("SELECT 1"))
        return True

    app = app_main.app
    had_runtime_services = hasattr(app.state, "runtime_services")
    original_runtime_services = getattr(app.state, "runtime_services", None)
    app.state.runtime_services = SimpleNamespace(
        snapshot=lambda: {
            "semantic_matcher": {"running": False, "last_error": None},
            "dsp_sync": {"running": False, "last_error": None},
            "forwarder_health_check": {"running": False, "last_error": None},
            "available_agents_polling": {"running": False, "last_error": None},
            "total_active_agents": 0,
            "available_agents_count": 0,
        }
    )
    app.dependency_overrides[get_service_runtime] = lambda: service_runtime
    app.dependency_overrides[get_async_session] = override_get_async_session
    monkeypatch.setattr(app_main, "check_database_ready", fake_check_database_ready)

    try:
        yield app
    finally:
        app.dependency_overrides.clear()
        if had_runtime_services:
            app.state.runtime_services = original_runtime_services
        elif hasattr(app.state, "runtime_services"):
            delattr(app.state, "runtime_services")


@pytest_asyncio.fixture
async def client(integration_app: FastAPI) -> AsyncGenerator[AsyncClient]:
    async with AsyncClient(
        transport=ASGITransport(app=integration_app),
        base_url="http://testserver",
    ) as async_client:
        yield async_client


@pytest_asyncio.fixture
async def seeded_database_counts(
    test_session_factory: async_sessionmaker[AsyncSession],
    prepare_integration_seed_data: None,
) -> dict[str, int]:
    del prepare_integration_seed_data

    async def load_counts() -> dict[str, int]:
        async with test_session_factory() as session:
            agents = int((await session.execute(text("SELECT COUNT(*) FROM agents"))).scalar_one())
            skills = int((await session.execute(text("SELECT COUNT(*) FROM skills"))).scalar_one())
        return {"agents": agents, "skills": skills}

    counts = await load_counts()
    if counts["agents"] == 0 or counts["skills"] == 0:
        reseed_test_database(
            project_root=PROJECT_ROOT,
            database_url=_resolve_test_database_url(),
            mode=_resolve_integration_mode(),
        )
        counts = await load_counts()

    if counts["agents"] == 0 or counts["skills"] == 0:
        pytest.fail("测试数据库在自动 reseed 后仍缺少 Agent/Skill 数据。")

    return counts


@pytest_asyncio.fixture
async def available_agents_runtime_rows(
    test_session_factory: async_sessionmaker[AsyncSession],
    seeded_database_counts: dict[str, int],
) -> AsyncGenerator[list[str]]:
    del seeded_database_counts

    original_rows: list[dict[str, object]] = []
    async with test_session_factory() as session:
        original_rows = [
            dict(row)
            for row in (
                await session.execute(
                    text("SELECT aic, is_available, checked_at FROM available_agents_runtime ORDER BY aic")
                )
            ).mappings()
        ]
        aics = [row[0] for row in (await session.execute(text("SELECT aic FROM agents ORDER BY aic LIMIT 3"))).all()]
        if len(aics) < 2:
            pytest.fail("测试数据库在自动 reseed 后仍缺少足够的 Agent 数据。")

        await session.execute(text("TRUNCATE TABLE available_agents_runtime"))
        for index, aic in enumerate(aics):
            await session.execute(
                text(
                    """
                    INSERT INTO available_agents_runtime (aic, is_available, checked_at)
                    VALUES (:aic, :is_available, NOW())
                    """
                ),
                {"aic": aic, "is_available": index < 2},
            )
        await session.commit()

    try:
        yield aics
    finally:
        async with test_session_factory() as session:
            await session.execute(text("TRUNCATE TABLE available_agents_runtime"))
            for row in original_rows:
                await session.execute(
                    text(
                        "INSERT INTO available_agents_runtime (aic, is_available, checked_at) "
                        "VALUES (:aic, :is_available, :checked_at)"
                    ),
                    row,
                )
            await session.commit()
