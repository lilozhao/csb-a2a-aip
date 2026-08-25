import asyncio
import uuid
from types import SimpleNamespace
from typing import Any, cast

import pytest

from app.agent import service as agent_service
from app.agent.model import ApprovalStatus
from app.agent.schema import AgentFilters

pytestmark = pytest.mark.unit


class DummyAsyncScalarResult:
    def __init__(self, items: list[object]) -> None:
        self.items = items

    def all(self) -> list[object]:
        return self.items


class DummyAsyncResult:
    def __init__(
        self,
        *,
        single: object | None = None,
        items: list[object] | None = None,
        scalar: int | None = None,
    ) -> None:
        self.single = single
        self.items = items or []
        self.scalar = scalar

    def scalar_one_or_none(self) -> object | None:
        return self.single

    def scalar_one(self) -> int:
        assert self.scalar is not None
        return self.scalar

    def scalars(self) -> DummyAsyncScalarResult:
        return DummyAsyncScalarResult(self.items)


class RecordingAsyncSession:
    def __init__(self, results: list[DummyAsyncResult]) -> None:
        self.results = results
        self.statements: list[Any] = []

    async def execute(self, statement: Any) -> DummyAsyncResult:
        await asyncio.sleep(0)
        self.statements.append(statement)
        return self.results.pop(0)


async def test_get_agent_async_applies_joinedload_when_requested() -> None:
    agent_id = uuid.uuid4()
    agent = SimpleNamespace(id=agent_id)
    session = RecordingAsyncSession([DummyAsyncResult(single=agent)])

    result = await agent_service.get_agent_async(
        cast("Any", session),
        agent_id=agent.id,
        with_users=True,
        raise_exception=True,
    )

    assert result is not None
    assert result.id == agent.id
    assert len(session.statements) == 1
    assert len(session.statements[0]._with_options) == 2


async def test_get_agents_async_returns_items_and_total_with_user_loads() -> None:
    agent = SimpleNamespace(id=uuid.uuid4(), approval_status=ApprovalStatus.APPROVED)
    session = RecordingAsyncSession(
        [
            DummyAsyncResult(items=[agent]),
            DummyAsyncResult(scalar=1),
        ]
    )

    items, total = await agent_service.get_agents_async(
        cast("Any", session),
        AgentFilters(
            page_num=1,
            page_size=10,
            statuses=[ApprovalStatus.APPROVED],
            with_users=True,
        ),
    )

    assert len(items) == 1
    assert items[0].id == agent.id
    assert total == 1
    assert len(session.statements) == 2
    assert len(session.statements[0]._with_options) == 2


async def test_get_recent_agents_async_returns_items() -> None:
    agent = SimpleNamespace(id=uuid.uuid4(), approval_status=ApprovalStatus.APPROVED)
    session = RecordingAsyncSession([DummyAsyncResult(items=[agent])])

    items = await agent_service.get_recent_agents_async(cast("Any", session), limit=5, with_users=False)

    assert len(items) == 1
    assert items[0].id == agent.id
    assert len(session.statements) == 1
