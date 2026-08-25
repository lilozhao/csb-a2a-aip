from __future__ import annotations

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from typing import Any, cast
from unittest.mock import AsyncMock, Mock

import pytest
from acps_sdk.aip.aip_base_model import (
    TaskCommand,
    TaskCommandType,
    TaskResult,
    TaskState,
    TaskStatus,
)
from aiormq.exceptions import AMQPError

from partners.group_handler import GroupHandler


class _DummyRunner:
    def __init__(self) -> None:
        self.acs = {"aic": "partner-aic"}
        self.tasks: dict[str, object] = {}
        self.on_start = AsyncMock()
        self._state_change_callback: Any = None

    def set_state_change_callback(self, callback: Any) -> None:
        self._state_change_callback = callback


async def _yield_control() -> None:
    future = asyncio.get_running_loop().create_future()
    future.set_result(None)
    await future


def _build_task_result(task_id: str) -> TaskResult:
    now = datetime.now(UTC).isoformat()
    return TaskResult(
        id="result-1",
        sentAt=now,
        senderRole="partner",
        senderId="partner-aic",
        taskId=task_id,
        groupId="group-new",
        sessionId="sess-new",
        status=TaskStatus(
            state=TaskState.Accepted,
            stateChangedAt=now,
        ),
    )


@pytest.mark.asyncio
async def test_task_command_prefers_command_group_id_over_sender_match() -> None:
    runner = _DummyRunner()
    runner.on_start.return_value = _build_task_result("task-1")

    handler = GroupHandler("test-agent", cast("Any", runner))
    handler._group_clients = {
        "group-old": cast("Any", SimpleNamespace(is_joined=True)),
        "group-new": cast("Any", SimpleNamespace(is_joined=True)),
    }
    handler._find_group_for_sender = Mock(return_value="group-old")  # type: ignore[method-assign]
    handler._broadcast_task_update = AsyncMock()  # type: ignore[method-assign]

    command = TaskCommand(
        id="cmd-1",
        sentAt=datetime.now(UTC).isoformat(),
        senderRole="leader",
        senderId="leader-aic",
        command=TaskCommandType.Start,
        taskId="task-1",
        groupId="group-new",
        sessionId="sess-new",
    )

    await handler._on_task_command(command, is_mentioned=True)

    assert handler._task_group_map["task-1"] == "group-new"
    handler._find_group_for_sender.assert_not_called()
    handler._broadcast_task_update.assert_awaited_once()
    await_args = handler._broadcast_task_update.await_args
    assert await_args is not None
    assert await_args.args[1] == "group-new"


@pytest.mark.asyncio
async def test_start_retries_shared_inbox_until_rabbitmq_recovers(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = _DummyRunner()
    handler = GroupHandler("test-agent", cast("Any", runner))

    attempts = {"count": 0}
    real_sleep = asyncio.sleep

    class _FakeClient:
        def __init__(self, **_: object) -> None:
            self.connection = object()
            self.closed = False
            created_clients.append(self)

        async def connect(self) -> None:
            await _yield_control()
            attempts["count"] += 1
            if attempts["count"] == 1:
                raise AMQPError("broker not ready")

        async def start_inbox_consuming(self, _handler: object) -> None:
            await _yield_control()

        async def close(self) -> None:
            await _yield_control()
            self.closed = True

    created_clients: list[_FakeClient] = []

    async def _fast_sleep(_: float) -> None:
        await real_sleep(0)

    monkeypatch.setattr("partners.group_handler.GroupPartnerMqClient", _FakeClient)
    monkeypatch.setattr("partners.group_handler.asyncio.sleep", _fast_sleep)

    await handler.start()

    retry_task = handler._shared_mq_retry_task
    assert retry_task is not None
    await asyncio.wait_for(retry_task, timeout=1)

    assert attempts["count"] == 2
    assert created_clients[0].closed is True
    assert cast("Any", handler._shared_mq_client) is created_clients[1]
    assert handler._shared_mq_retry_task is None

    await handler.shutdown()


@pytest.mark.asyncio
async def test_shutdown_cancels_pending_shared_inbox_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = _DummyRunner()
    handler = GroupHandler("test-agent", cast("Any", runner))

    class _AlwaysFailClient:
        def __init__(self, **_: object) -> None:
            self.connection = object()

        async def connect(self) -> None:
            await _yield_control()
            raise OSError("still unavailable")

        async def start_inbox_consuming(self, _handler: object) -> None:
            await _yield_control()

        async def close(self) -> None:
            await _yield_control()

    gate = asyncio.Event()

    async def _blocking_sleep(_: float) -> None:
        await gate.wait()

    monkeypatch.setattr("partners.group_handler.GroupPartnerMqClient", _AlwaysFailClient)
    monkeypatch.setattr("partners.group_handler.asyncio.sleep", _blocking_sleep)

    await handler.start()

    retry_task = handler._shared_mq_retry_task
    assert retry_task is not None

    await handler.shutdown()

    assert retry_task.cancelled() is True
    assert handler._shared_mq_client is None
    assert handler._shared_mq_retry_task is None


@pytest.mark.asyncio
async def test_inbox_invitation_replaces_stale_client_with_dedicated_connection() -> None:
    runner = _DummyRunner()
    handler = GroupHandler("test-agent", cast("Any", runner))

    stale_client = cast("Any", SimpleNamespace(is_joined=False, close=AsyncMock()))
    new_client = cast(
        "Any",
        SimpleNamespace(
            set_command_handler=Mock(),
            set_task_result_handler=Mock(),
            set_mgmt_command_handler=Mock(),
            set_disconnect_handler=Mock(),
            join_group_from_invitation=AsyncMock(return_value=True),
        ),
    )
    create_group_client = Mock(return_value=new_client)

    handler._group_clients["group-1"] = stale_client
    handler._create_group_client = create_group_client  # type: ignore[method-assign]

    invitation = cast("Any", SimpleNamespace(group=SimpleNamespace(groupId="group-1")))

    await handler._handle_inbox_invitation(invitation)

    stale_client.close.assert_awaited_once()
    create_group_client.assert_called_once_with(use_shared_connection=False)
    new_client.set_disconnect_handler.assert_called_once_with(handler._on_group_client_disconnected)
    new_client.join_group_from_invitation.assert_awaited_once_with(invitation)
    assert handler._group_clients["group-1"] is new_client


def test_disconnect_callback_removes_group_state() -> None:
    runner = _DummyRunner()
    handler = GroupHandler("test-agent", cast("Any", runner))

    client = cast("Any", SimpleNamespace())
    handler._group_clients = {
        "group-1": client,
        "group-2": cast("Any", SimpleNamespace()),
    }
    handler._task_group_map = {
        "task-1": "group-1",
        "task-2": "group-2",
    }

    handler._on_group_client_disconnected(client, "group-1")

    assert "group-1" not in handler._group_clients
    assert handler._task_group_map == {"task-2": "group-2"}


def test_create_group_client_disables_robust_reconnect_for_group_sessions(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    runner = _DummyRunner()
    handler = GroupHandler("test-agent", cast("Any", runner))
    created_kwargs: dict[str, object] = {}

    class _FakeClient:
        def __init__(self, **kwargs: object) -> None:
            created_kwargs.update(kwargs)
            self.connection = kwargs.get("connection")

    monkeypatch.setattr("partners.group_handler.GroupPartnerMqClient", _FakeClient)

    handler._create_group_client(use_shared_connection=False)

    assert created_kwargs["robust_connection"] is False
