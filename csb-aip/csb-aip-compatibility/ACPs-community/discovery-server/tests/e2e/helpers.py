from __future__ import annotations

import os
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    import httpx


def get_base_url() -> str:
    base_url = os.getenv("TEST_E2E_BASE_URL", "").strip()
    if not base_url:
        base_url = os.getenv("DISCOVERY_E2E_BASE_URL", "").strip()
    if not base_url:
        raise RuntimeError("e2e 基础地址尚未准备好，请检查 tests/e2e/conftest.py 的启动逻辑。")
    return base_url.rstrip("/")


def get_expected_mode() -> str:
    return (os.getenv("DISCOVERY_E2E_MODE") or "cpu").strip().lower() or "cpu"


def get_filtered_provider_organization() -> str:
    organization = os.getenv("DISCOVERY_E2E_FILTERED_ORGANIZATION", "").strip()
    if not organization:
        raise RuntimeError("filtered 黑盒测试的 provider organization 尚未准备好，请检查 tests/e2e/conftest.py。")
    return organization


def ensure_seeded_stats(client: httpx.Client) -> dict[str, int]:
    response = client.get("/acps-adp-v2/stats")
    if response.status_code != 200:
        pytest.fail(f"/acps-adp-v2/stats 返回 {response.status_code}，无法确认 seed 数据是否就绪。")

    payload = response.json()
    agents = int(payload["data"]["agents"])
    skills = int(payload["data"]["skills"])
    if agents == 0 or skills == 0:
        pytest.fail("端到端测试在自动 reseed 后仍未看到 Agent/Skill 数据，请检查 tests/e2e/conftest.py。")

    return {"agents": agents, "skills": skills}
