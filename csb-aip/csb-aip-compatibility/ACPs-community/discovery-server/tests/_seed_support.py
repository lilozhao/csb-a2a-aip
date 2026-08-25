from __future__ import annotations

import multiprocessing
import os
from typing import TYPE_CHECKING

from dotenv import dotenv_values

if TYPE_CHECKING:
    from pathlib import Path


def build_default_test_database_url() -> str:
    """构造本地默认测试数据库 URL。"""

    auth_fragment = os.getenv("DISCOVERY_TEST_DATABASE_AUTH", "discovery")
    return f"postgresql+asyncpg://discovery:{auth_fragment}@localhost:5432/agent_discovery_test"


def resolve_test_database_url(project_root: Path) -> str:
    """解析测试数据库 URL，优先环境变量，其次项目 .env。"""

    env_database_url = os.getenv("TEST_DATABASE_URL", "").strip()
    if env_database_url:
        return env_database_url

    dotenv_database_url = str(dotenv_values(project_root / ".env").get("TEST_DATABASE_URL") or "").strip()
    if dotenv_database_url:
        return dotenv_database_url

    return build_default_test_database_url()


def normalize_mode(mode: str) -> str:
    """规范化 discovery 测试模式。"""

    normalized = mode.strip().lower()
    return normalized or "cpu"


def build_seed_env(*, database_url: str, mode: str) -> dict[str, str]:
    """构造测试态 reseed 所需环境变量。"""

    normalized_mode = normalize_mode(mode)
    env = os.environ.copy()
    env.update(
        {
            "APP_ENV": "testing",
            "DATABASE_URL": database_url,
            "TEST_DATABASE_URL": database_url,
            "DISCOVERY_MODE": normalized_mode,
            # 测试只要求稳定落库，不要求真实 embedding 服务可用。
            "DISCOVERY_LLM_API_KEY": env.get("DISCOVERY_TEST_DISCOVERY_LLM_API_KEY")
            or env.get("DISCOVERY_LLM_API_KEY", "integration-test-key"),
            "DISCOVERY_LLM_BASE_URL": env.get("DISCOVERY_TEST_DISCOVERY_LLM_BASE_URL")
            or env.get("DISCOVERY_LLM_BASE_URL", "http://127.0.0.1:9/v1"),
            "DISCOVERY_LLM_MODEL_NAME": env.get("DISCOVERY_TEST_DISCOVERY_LLM_MODEL_NAME")
            or env.get("DISCOVERY_LLM_MODEL_NAME", "integration-test-discovery-model"),
        }
    )

    if normalized_mode == "gpu":
        env.update(
            {
                "EMBEDDING_MODEL_PATH": "",
                "EMBEDDING_DEVICES": env.get("DISCOVERY_TEST_EMBEDDING_DEVICES") or env.get("EMBEDDING_DEVICES", "cpu"),
                "RERANKER_URL": "",
            }
        )
    else:
        env.update(
            {
                "EMBEDDING_API_KEY": "",
                "EMBEDDING_BASE_URL": "",
                "EMBEDDING_MODEL_NAME": env.get("DISCOVERY_TEST_EMBEDDING_MODEL_NAME")
                or env.get("EMBEDDING_MODEL_NAME", "integration-test-model"),
            }
        )

    return env


def _run_seed_main(
    seed_env: dict[str, str],
    project_root: str,
    result_queue: multiprocessing.queues.Queue[int],
) -> None:
    original_env = os.environ.copy()

    try:
        os.chdir(project_root)
        os.environ.clear()
        os.environ.update(seed_env)

        from scripts import seed as seed_script

        result_queue.put(seed_script.main(["test", "--reset"]))
    finally:
        os.environ.clear()
        os.environ.update(original_env)


def reseed_test_database(*, project_root: Path, database_url: str, mode: str) -> None:
    """使用现有 seed 脚本重建测试数据库样本数据。"""

    seed_env = build_seed_env(database_url=database_url, mode=mode)
    context = multiprocessing.get_context("spawn")
    result_queue: multiprocessing.queues.Queue[int] = context.Queue()
    process = context.Process(target=_run_seed_main, args=(seed_env, str(project_root), result_queue))
    process.start()
    process.join()

    result_code = result_queue.get() if not result_queue.empty() else process.exitcode or 1

    if result_code == 0:
        return

    raise RuntimeError("自动 reseed 测试数据库失败。")
