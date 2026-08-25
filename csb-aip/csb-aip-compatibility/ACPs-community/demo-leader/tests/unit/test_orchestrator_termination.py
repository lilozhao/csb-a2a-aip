"""Orchestrator 终止流程回归测试。"""

import sys
from datetime import UTC, datetime, timedelta
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

_CURRENT_DIR = Path(__file__).parent
_TESTS_ROOT = _CURRENT_DIR.parent
_PROJECT_ROOT = _TESTS_ROOT.parent
_LEADER_DIR = _PROJECT_ROOT / "leader"

if str(_LEADER_DIR) not in sys.path:
    sys.path.insert(0, str(_LEADER_DIR))
if str(_PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(_PROJECT_ROOT))

from acps_sdk.aip.aip_base_model import TaskState
from assistant.core.orchestrator import Orchestrator
from assistant.models import (
    ExecutionMode,
    ScenarioRuntime,
    Session,
    UserResult,
    UserResultType,
)
from assistant.models.base import ActiveTaskStatus, now_iso
from assistant.models.task import ActiveTask, PartnerTask


@pytest.mark.asyncio
async def test_terminate_current_task_ignores_missing_partner_endpoint_field():
    """PartnerTask 无 endpoint 字段时不应抛异常。"""
    now = now_iso()
    orchestrator = Orchestrator(
        session_manager=MagicMock(),
        scenario_loader=MagicMock(),
        intent_analyzer=MagicMock(),
        planner=MagicMock(),
        history_compressor=MagicMock(),
    )
    executor = MagicMock()
    executor.cancel_partner = AsyncMock(return_value=(None, None))
    executor.complete_partner = AsyncMock(return_value=(None, None))
    orchestrator._executor = executor
    orchestrator._planner = MagicMock()
    orchestrator._planner._acs_cache = {
        "partner-aic": {"endPoints": [{"url": "https://partner.example/rpc", "transport": "HTTP"}]}
    }

    active_task = ActiveTask(
        active_task_id="task-001",
        created_at=now,
        external_status=ActiveTaskStatus.RUNNING,
        partner_tasks={
            "partner-aic": PartnerTask(
                partnerAic="partner-aic",
                aipTaskId="aip-task-001",
                state=TaskState.Accepted,
            )
        },
    )
    session = Session(
        session_id="test-session-termination",
        mode=ExecutionMode.DIRECT_RPC,
        created_at=now,
        updated_at=now,
        touched_at=now,
        ttl_seconds=3600,
        expires_at=(datetime.now(UTC) + timedelta(hours=1)).isoformat(),
        base_scenario=ScenarioRuntime(
            id="base",
            kind="base",
            version="1.0.0",
            loaded_at=now,
        ),
        user_result=UserResult(
            type=UserResultType.PENDING,
            data_items=[],
            updated_at=now,
        ),
    )

    await orchestrator._terminate_current_task(session, active_task)

    executor.cancel_partner.assert_awaited_once()
