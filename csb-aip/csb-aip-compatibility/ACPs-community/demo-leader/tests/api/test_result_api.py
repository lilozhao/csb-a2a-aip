"""/result API 响应视图的定向回归测试。"""

import os
import sys

_current_dir = os.path.dirname(os.path.abspath(__file__))
_tests_root = os.path.dirname(_current_dir)
_project_root = os.path.dirname(_tests_root)
_leader_dir = os.path.join(_project_root, "leader")
if _leader_dir not in sys.path:
    sys.path.insert(0, _leader_dir)
if _project_root not in sys.path:
    sys.path.insert(0, _project_root)

import pytest
from acps_sdk.aip.aip_group_runtime import normalize_group_id
from assistant.api import routes
from assistant.models import ExecutionMode
from httpx import AsyncClient


class _FakeGroupManager:
    def __init__(self, group_id: str | None) -> None:
        self._group_id = group_id

    def get_group_id(self, session_id: str) -> str | None:
        return self._group_id


def test_session_to_leader_result_exposes_group_id_from_group_manager(
    session_manager,
    scenario_loader,
    monkeypatch,
) -> None:
    """group 模式结果视图应暴露 GroupManager 持有的 groupId。"""
    session = session_manager.create_session(
        mode=ExecutionMode.GROUP,
        base_scenario=scenario_loader.base_scenario,
    )
    expected_group_id = "group-sess-regression"

    monkeypatch.setattr(routes, "_get_group_manager", lambda: _FakeGroupManager(expected_group_id))

    leader_result = routes._session_to_leader_result(session)

    assert leader_result.group_id == expected_group_id
    assert session.group_id == expected_group_id


@pytest.mark.asyncio
async def test_result_api_serializes_group_id_as_group_id_alias(
    client: AsyncClient,
    session_manager,
    scenario_loader,
    monkeypatch,
) -> None:
    """/result HTTP 响应应以 groupId 别名暴露群组 ID。"""
    session = session_manager.create_session(
        mode=ExecutionMode.GROUP,
        base_scenario=scenario_loader.base_scenario,
    )
    expected_group_id = "group-sess-http-alias"

    monkeypatch.setattr(routes, "_get_group_manager", lambda: _FakeGroupManager(expected_group_id))

    response = await client.get(f"/api/v1/result/{session.session_id}")

    assert response.status_code == 200
    result = response.json()["result"]
    assert result["groupId"] == expected_group_id
    assert "group_id" not in result


@pytest.mark.asyncio
async def test_result_api_derives_group_id_without_runtime_mapping(
    client: AsyncClient,
    session_manager,
    scenario_loader,
) -> None:
    """/result 在 group 运行态尚未回写时也应暴露稳定 groupId。"""
    session = session_manager.create_session(
        mode=ExecutionMode.GROUP,
        base_scenario=scenario_loader.base_scenario,
    )

    response = await client.get(f"/api/v1/result/{session.session_id}")

    assert response.status_code == 200
    result = response.json()["result"]
    assert result["groupId"] == normalize_group_id(f"group-{session.session_id}")
