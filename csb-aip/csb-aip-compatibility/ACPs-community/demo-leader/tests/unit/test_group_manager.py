import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock, MagicMock

from leader.assistant.core.group_manager import (
    GROUP_CREATION_RETRY_DELAY_SECONDS,
    GroupConfig,
    GroupManager,
    RabbitMQConfig,
)


async def test_create_group_for_session_retries_transient_creation_failure(
    monkeypatch,
) -> None:
    """首次建组失败后应等待重连窗口并重试。"""
    manager = GroupManager(
        leader_aic="leader-aic",
        rabbitmq_config=RabbitMQConfig(),
        group_config=GroupConfig(max_retry_count=2),
    )
    manager._started = True

    created_session = SimpleNamespace(group_id="group-session-1")
    group_leader = MagicMock()
    group_leader.create_group_session = AsyncMock(side_effect=[RuntimeError("transient mq failure"), created_session])
    manager._group_leader = group_leader

    created_task = MagicMock()
    created_task.done.return_value = False

    def fake_create_task(coro):
        coro.close()
        return created_task

    sleep_delays: list[float] = []

    async def fake_sleep(delay: float) -> None:
        sleep_delays.append(delay)

    monkeypatch.setattr(asyncio, "create_task", fake_create_task)
    monkeypatch.setattr(asyncio, "sleep", fake_sleep)

    group_id = await manager.create_group_for_session("sess-1")

    assert group_id == "group-session-1"
    assert manager.get_group_id("sess-1") == "group-session-1"
    assert group_leader.create_group_session.await_count == 2
    assert sleep_delays == [GROUP_CREATION_RETRY_DELAY_SECONDS]
    assert manager._status_monitor_task is created_task
