from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import pytest

from app.core import database as database_module
from app.sync.model import DSPState

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

pytestmark = pytest.mark.unit


class _FakeResult:
    def __init__(
        self,
        *,
        rows: list[tuple[str, int, int]] | None = None,
        scalar_one_value: object | None = None,
    ) -> None:
        self._rows = rows or []
        self._scalar_one_value = scalar_one_value

    def all(self) -> list[tuple[str, int, int]]:
        return list(self._rows)

    def scalar_one(self) -> object:
        return self._scalar_one_value


class _FakeSession:
    def __init__(self, results: list[_FakeResult]) -> None:
        self._results = results

    async def execute(self, statement: object) -> _FakeResult:
        del statement
        await asyncio.sleep(0)
        if not self._results:
            raise AssertionError("unexpected execute call")
        return self._results.pop(0)


def _patch_session_context(monkeypatch: pytest.MonkeyPatch, results: list[_FakeResult]) -> None:
    @asynccontextmanager
    async def fake_session_context() -> AsyncIterator[_FakeSession]:
        yield _FakeSession(list(results))

    monkeypatch.setattr(database_module, "get_async_session_context", fake_session_context)


async def test_load_from_db_restores_versions_from_existing_agents(monkeypatch: pytest.MonkeyPatch) -> None:
    _patch_session_context(
        monkeypatch,
        [
            _FakeResult(
                rows=[
                    ("demo.agent.1", 3, 11),
                    ("demo.agent.2", 7, 19),
                ]
            )
        ],
    )

    state = await DSPState.load_from_db()

    assert state.last_seq == 19
    assert state.object_versions == {"acs": {"demo.agent.1": 3, "demo.agent.2": 7}}
    assert state.needs_snapshot is False


async def test_load_from_db_requires_snapshot_when_indexed_skills_missing(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _patch_session_context(
        monkeypatch,
        [
            _FakeResult(
                rows=[
                    ("demo.agent.1", 3, 11),
                    ("demo.agent.2", 7, 19),
                ]
            ),
            _FakeResult(scalar_one_value=0),
        ],
    )

    state = await DSPState.load_from_db(require_indexed_skills=True)

    assert state.last_seq == 19
    assert state.object_versions == {"acs": {"demo.agent.1": 3, "demo.agent.2": 7}}
    assert state.needs_snapshot is True
