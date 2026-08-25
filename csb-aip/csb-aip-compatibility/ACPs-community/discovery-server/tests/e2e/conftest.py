from __future__ import annotations

import asyncio
import os
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import suppress
from pathlib import Path
from typing import TYPE_CHECKING

import asyncpg  # type: ignore[import-untyped]
import pytest
from dotenv import dotenv_values
from httpx import Client, HTTPError

from tests._seed_support import (
    build_default_test_database_url,
    normalize_mode,
    reseed_test_database,
    resolve_test_database_url,
)

if TYPE_CHECKING:
    from collections.abc import Generator

PROJECT_ROOT = Path(__file__).resolve().parents[2]
E2E_TESTS_DIR = PROJECT_ROOT / "tests" / "e2e"
DOTENV_VALUES = dotenv_values(PROJECT_ROOT / ".env")
DEFAULT_TEST_DATABASE_URL = build_default_test_database_url()
DEFAULT_E2E_MODE = "cpu"
TEST_SERVER_HOST = "127.0.0.1"
TEST_SERVER_STARTUP_TIMEOUT_SECONDS = 30.0
FILTERED_PROVIDER_ORGANIZATION_ENV = "DISCOVERY_E2E_FILTERED_ORGANIZATION"


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """为 e2e 目录下未显式标注的测试补齐 e2e marker。"""

    for item in items:
        item_path = Path(str(item.path)).resolve()
        if item_path != E2E_TESTS_DIR and E2E_TESTS_DIR not in item_path.parents:
            continue
        if item.get_closest_marker("e2e") is None:
            item.add_marker(pytest.mark.e2e)


def _find_free_port() -> int:
    """查找一个可用的本地 TCP 端口。"""

    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind((TEST_SERVER_HOST, 0))
        return int(sock.getsockname()[1])


def _resolve_env_or_dotenv(name: str, default: str = "") -> str:
    """优先读取环境变量，其次回退到项目 .env。"""

    env_value = os.getenv(name, "").strip()
    if env_value:
        return env_value

    dotenv_value = str(DOTENV_VALUES.get(name) or "").strip()
    if dotenv_value:
        return dotenv_value

    return default


def _resolve_configured_base_url() -> str:
    """解析显式注入的 e2e 基础地址。"""

    return (_resolve_env_or_dotenv("TEST_E2E_BASE_URL") or _resolve_env_or_dotenv("DISCOVERY_E2E_BASE_URL")).rstrip("/")


@pytest.fixture(scope="session", autouse=True)
def prepare_e2e_seed_data() -> None:
    """在 e2e 套件启动前自动重建测试样本数据。"""

    try:
        reseed_test_database(
            project_root=PROJECT_ROOT,
            database_url=resolve_test_database_url(PROJECT_ROOT),
            mode=normalize_mode(_resolve_env_or_dotenv("DISCOVERY_E2E_MODE", DEFAULT_E2E_MODE)),
        )
    except RuntimeError as exc:
        pytest.fail(str(exc))


def _to_asyncpg_database_url(database_url: str) -> str:
    """将 SQLAlchemy 风格 PostgreSQL URL 转为 asyncpg 可用形式。"""

    if database_url.startswith("postgresql+asyncpg://"):
        return database_url.replace("postgresql+asyncpg://", "postgresql://", 1)
    if database_url.startswith("postgresql://"):
        return database_url
    raise ValueError("TEST_DATABASE_URL 必须是 asyncpg 或 PostgreSQL URL")


def _build_startup_error(message: str, log_path: Path) -> RuntimeError:
    """拼接临时 e2e 实例启动失败信息。"""

    log_output = log_path.read_text(encoding="utf-8", errors="replace").strip()
    if log_output:
        return RuntimeError(f"{message}\n\n临时实例日志：\n{log_output}")
    return RuntimeError(message)


def _wait_for_test_server(health_url: str, process: subprocess.Popen[str], log_path: Path) -> None:
    """等待临时 e2e 实例通过健康检查。"""

    deadline = time.monotonic() + TEST_SERVER_STARTUP_TIMEOUT_SECONDS

    with Client(timeout=1.0) as client:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise _build_startup_error("discovery-server e2e 临时实例启动失败。", log_path)

            try:
                response = client.get(health_url)
                response.raise_for_status()
                payload = response.json()
                if payload.get("status") == "healthy":
                    return
            except HTTPError:
                time.sleep(1)
            except OSError:
                time.sleep(1)

    if process.poll() is not None:
        raise _build_startup_error("discovery-server e2e 临时实例在健康检查前退出。", log_path)

    raise _build_startup_error(f"等待 discovery-server e2e 临时实例就绪超时：{health_url}", log_path)


def _build_test_server_env(port: int) -> dict[str, str]:
    """构建 e2e 临时实例启动环境。"""

    mode = _resolve_env_or_dotenv("DISCOVERY_E2E_MODE", DEFAULT_E2E_MODE).strip().lower() or DEFAULT_E2E_MODE
    test_database_url = _resolve_env_or_dotenv("TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)

    embedding_api_key = _resolve_env_or_dotenv(
        "DISCOVERY_E2E_EMBEDDING_API_KEY",
        _resolve_env_or_dotenv("EMBEDDING_API_KEY", "e2e-test-key"),
    )
    embedding_base_url = _resolve_env_or_dotenv(
        "DISCOVERY_E2E_EMBEDDING_BASE_URL",
        _resolve_env_or_dotenv("EMBEDDING_BASE_URL", "http://127.0.0.1:9/v1"),
    )
    embedding_model_name = _resolve_env_or_dotenv(
        "DISCOVERY_E2E_EMBEDDING_MODEL_NAME",
        _resolve_env_or_dotenv("EMBEDDING_MODEL_NAME", "e2e-test-model"),
    )
    embedding_model_path = _resolve_env_or_dotenv(
        "DISCOVERY_E2E_EMBEDDING_MODEL_PATH",
        _resolve_env_or_dotenv("EMBEDDING_MODEL_PATH"),
    )
    embedding_devices = _resolve_env_or_dotenv(
        "DISCOVERY_E2E_EMBEDDING_DEVICES",
        _resolve_env_or_dotenv("EMBEDDING_DEVICES", "cpu"),
    )
    reranker_url = _resolve_env_or_dotenv(
        "DISCOVERY_E2E_RERANKER_URL",
        _resolve_env_or_dotenv("RERANKER_URL"),
    )
    discovery_llm_api_key = _resolve_env_or_dotenv(
        "DISCOVERY_E2E_DISCOVERY_LLM_API_KEY",
        _resolve_env_or_dotenv("DISCOVERY_LLM_API_KEY", "e2e-test-key"),
    )
    discovery_llm_base_url = _resolve_env_or_dotenv(
        "DISCOVERY_E2E_DISCOVERY_LLM_BASE_URL",
        _resolve_env_or_dotenv("DISCOVERY_LLM_BASE_URL", "http://127.0.0.1:9/v1"),
    )
    discovery_llm_model_name = _resolve_env_or_dotenv(
        "DISCOVERY_E2E_DISCOVERY_LLM_MODEL_NAME",
        _resolve_env_or_dotenv("DISCOVERY_LLM_MODEL_NAME", "e2e-test-discovery-model"),
    )

    python_path = str(PROJECT_ROOT)
    existing_python_path = os.getenv("PYTHONPATH", "").strip()
    if existing_python_path:
        python_path = f"{python_path}{os.pathsep}{existing_python_path}"

    env = os.environ.copy()
    env.update(
        {
            "APP_ENV": "testing",
            "DATABASE_URL": test_database_url,
            "TEST_DATABASE_URL": test_database_url,
            "DSP_AUTO_START": "false",
            "UVICORN_HOST": TEST_SERVER_HOST,
            "UVICORN_PORT": str(port),
            "DISCOVERY_MODE": mode,
            "DISCOVERY_E2E_MODE": mode,
            "DISCOVERY_LLM_API_KEY": discovery_llm_api_key,
            "DISCOVERY_LLM_BASE_URL": discovery_llm_base_url,
            "DISCOVERY_LLM_MODEL_NAME": discovery_llm_model_name,
            "FORWARDER_SERVER_ENABLED": "false",
            "DSP_BASE_URL": "http://127.0.0.1:9/acps-dsp-v2",
            "POLLING_SERVER_URL": "http://127.0.0.1:9",
            "PYTHONPATH": python_path,
        }
    )

    if mode == "cpu":
        env.update(
            {
                "EMBEDDING_API_KEY": embedding_api_key,
                "EMBEDDING_BASE_URL": embedding_base_url,
                "EMBEDDING_MODEL_NAME": embedding_model_name,
            }
        )
    else:
        env.update(
            {
                "EMBEDDING_MODEL_PATH": embedding_model_path,
                "EMBEDDING_DEVICES": embedding_devices,
                "RERANKER_URL": reranker_url,
            }
        )

    return env


async def _prepare_e2e_available_agents_runtime() -> tuple[list[dict[str, object]], str]:
    """为黑盒 e2e 准备一组确定的 available_agents_runtime 数据并返回原始快照与目标组织。"""

    test_database_url = _resolve_env_or_dotenv("TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)
    connection = await asyncpg.connect(_to_asyncpg_database_url(test_database_url))

    try:

        async def load_filtered_provider_organization() -> str:
            organization = await connection.fetchval(
                """
                SELECT a.acs->'provider'->>'organization' AS organization
                FROM agents a
                JOIN skills s ON s.aic = a.aic
                WHERE a.acs->'provider'->>'organization' IS NOT NULL
                  AND a.acs->'provider'->>'organization' != ''
                  AND (a.acs->>'active')::boolean = true
                  AND ((a.acs->'endPoints' IS NOT NULL
                        AND jsonb_typeof(a.acs->'endPoints') = 'array'
                        AND jsonb_array_length(a.acs->'endPoints') > 0)
                       OR (a.acs->>'webAppUrl' IS NOT NULL AND a.acs->>'webAppUrl' != ''))
                GROUP BY organization
                HAVING COUNT(DISTINCT a.aic) >= 2 AND COUNT(*) >= 2
                ORDER BY COUNT(*) DESC, organization
                LIMIT 1
                """
            )
            return str(organization or "")

        original_rows = [
            dict(row)
            for row in await connection.fetch(
                "SELECT aic, is_available, checked_at FROM available_agents_runtime ORDER BY aic"
            )
        ]
        provider_organization = await load_filtered_provider_organization()
        if not provider_organization:
            reseed_test_database(
                project_root=PROJECT_ROOT,
                database_url=resolve_test_database_url(PROJECT_ROOT),
                mode=normalize_mode(_resolve_env_or_dotenv("DISCOVERY_E2E_MODE", DEFAULT_E2E_MODE)),
            )
            provider_organization = await load_filtered_provider_organization()
        if not provider_organization:
            pytest.fail("黑盒 e2e 在自动 reseed 后仍缺少满足 filtered 查询前提的种子数据。")

        rows = await connection.fetch(
            """
            SELECT aic FROM agents
            WHERE acs->'provider'->>'organization' = $1
            ORDER BY aic LIMIT 3
            """,
            provider_organization,
        )
        aics = [str(row[0]) for row in rows]
        if len(aics) < 2:
            pytest.fail("黑盒 e2e 在自动 reseed 后仍缺少足够的 filtered 查询种子数据。")

        async with connection.transaction():
            await connection.execute("TRUNCATE TABLE available_agents_runtime")
            for index, aic in enumerate(aics):
                await connection.execute(
                    """
                    INSERT INTO available_agents_runtime (aic, is_available, checked_at)
                    VALUES ($1, $2, NOW())
                    """,
                    aic,
                    index < 2,
                )
        return original_rows, str(provider_organization)
    finally:
        await connection.close()


async def _restore_e2e_available_agents_runtime(rows: list[dict[str, object]]) -> None:
    """恢复黑盒 e2e 改写前的 available_agents_runtime 数据。"""

    test_database_url = _resolve_env_or_dotenv("TEST_DATABASE_URL", DEFAULT_TEST_DATABASE_URL)
    connection = await asyncpg.connect(_to_asyncpg_database_url(test_database_url))

    try:
        async with connection.transaction():
            await connection.execute("TRUNCATE TABLE available_agents_runtime")
            for row in rows:
                await connection.execute(
                    """
                    INSERT INTO available_agents_runtime (aic, is_available, checked_at)
                    VALUES ($1, $2, $3)
                    """,
                    row["aic"],
                    row["is_available"],
                    row["checked_at"],
                )
    finally:
        await connection.close()


@pytest.fixture(scope="session", autouse=True)
def prepare_e2e_base_url(prepare_e2e_seed_data: None) -> Generator[None]:
    """为 e2e 测试准备基础地址；缺省时自动拉起临时实例。"""

    del prepare_e2e_seed_data

    original_test_base_url = os.getenv("TEST_E2E_BASE_URL")
    original_discovery_base_url = os.getenv("DISCOVERY_E2E_BASE_URL")

    configured_base_url = _resolve_configured_base_url()
    if configured_base_url:
        os.environ["TEST_E2E_BASE_URL"] = configured_base_url
        os.environ["DISCOVERY_E2E_BASE_URL"] = configured_base_url
        yield
    else:
        port = _find_free_port()
        base_url = f"http://{TEST_SERVER_HOST}:{port}"
        health_url = f"{base_url}/acps-adp-v2/health"
        file_descriptor, log_path_str = tempfile.mkstemp(prefix="discovery-e2e-", suffix=".log")
        os.close(file_descriptor)
        log_path = Path(log_path_str)
        with log_path.open("w+", encoding="utf-8") as log_file:
            process = subprocess.Popen(
                [sys.executable, "-m", "app.main"],
                cwd=PROJECT_ROOT,
                env=_build_test_server_env(port),
                stdout=log_file,
                stderr=subprocess.STDOUT,
                text=True,
            )
            try:
                _wait_for_test_server(health_url, process, log_path)
                os.environ["TEST_E2E_BASE_URL"] = base_url
                os.environ["DISCOVERY_E2E_BASE_URL"] = base_url
                yield
            finally:
                if process.poll() is None:
                    process.terminate()
                    try:
                        process.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        process.kill()
                        process.wait(timeout=10)

        with suppress(FileNotFoundError):
            log_path.unlink()

    if original_test_base_url is None:
        os.environ.pop("TEST_E2E_BASE_URL", None)
    else:
        os.environ["TEST_E2E_BASE_URL"] = original_test_base_url

    if original_discovery_base_url is None:
        os.environ.pop("DISCOVERY_E2E_BASE_URL", None)
    else:
        os.environ["DISCOVERY_E2E_BASE_URL"] = original_discovery_base_url


@pytest.fixture(scope="session", autouse=True)
def prepare_e2e_runtime_rows(prepare_e2e_base_url: None) -> Generator[None]:
    """确保黑盒 e2e 对 filtered 查询所需的可用性数据已准备好。"""

    del prepare_e2e_base_url
    original_filtered_provider_organization = os.getenv(FILTERED_PROVIDER_ORGANIZATION_ENV)
    original_rows, provider_organization = asyncio.run(_prepare_e2e_available_agents_runtime())
    os.environ[FILTERED_PROVIDER_ORGANIZATION_ENV] = provider_organization
    try:
        yield
    finally:
        asyncio.run(_restore_e2e_available_agents_runtime(original_rows))
        if original_filtered_provider_organization is None:
            os.environ.pop(FILTERED_PROVIDER_ORGANIZATION_ENV, None)
        else:
            os.environ[FILTERED_PROVIDER_ORGANIZATION_ENV] = original_filtered_provider_organization
