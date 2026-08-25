from __future__ import annotations

import asyncio
import json
from contextlib import asynccontextmanager
from typing import TYPE_CHECKING

import pytest
from sqlalchemy.exc import OperationalError

from app import main as app_main
from app.core import health_probe as health_probe_module

if TYPE_CHECKING:
    from collections.abc import AsyncIterator

pytestmark = pytest.mark.unit


def test_build_ready_status_returns_ready_payload() -> None:
    status_code, payload = health_probe_module.build_ready_status(True)

    assert status_code == 200
    assert payload == {"status": "ready"}


def test_build_ready_status_returns_not_ready_payload() -> None:
    status_code, payload = health_probe_module.build_ready_status(False)

    assert status_code == 503
    assert payload == {
        "type": "urn:acps:error:operations:service-not-ready",
        "status": 503,
        "title": "Service not ready",
        "detail": "Database connectivity check failed",
        "error_name": "SERVICE_NOT_READY",
    }


async def test_check_database_ready_returns_true_when_query_succeeds(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Session:
        async def execute(self, statement: object) -> None:
            del statement
            await asyncio.sleep(0)

    @asynccontextmanager
    async def fake_session_context() -> AsyncIterator[_Session]:
        yield _Session()

    monkeypatch.setattr(health_probe_module, "get_async_session_context", fake_session_context)

    assert await health_probe_module.check_database_ready() is True


async def test_check_database_ready_returns_false_when_query_fails(monkeypatch: pytest.MonkeyPatch) -> None:
    class _Session:
        async def execute(self, statement: object) -> None:
            del statement
            await asyncio.sleep(0)
            raise OperationalError("SELECT 1", {}, ConnectionError("db down"))

    @asynccontextmanager
    async def fake_session_context() -> AsyncIterator[_Session]:
        yield _Session()

    monkeypatch.setattr(health_probe_module, "get_async_session_context", fake_session_context)

    assert await health_probe_module.check_database_ready() is False


async def test_ready_returns_ready_response(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_check_database_ready() -> bool:
        await asyncio.sleep(0)
        return True

    monkeypatch.setattr(app_main, "check_database_ready", fake_check_database_ready)

    response = await app_main.ready()

    assert response.status_code == 200
    assert response.body == b'{"status":"ready"}'


async def test_ready_returns_not_ready_response(monkeypatch: pytest.MonkeyPatch) -> None:
    async def fake_check_database_ready() -> bool:
        await asyncio.sleep(0)
        return False

    monkeypatch.setattr(app_main, "check_database_ready", fake_check_database_ready)

    response = await app_main.ready()

    assert response.status_code == 503
    assert response.media_type == "application/problem+json"
    assert json.loads(bytes(response.body)) == {
        "type": "urn:acps:error:operations:service-not-ready",
        "status": 503,
        "title": "Service not ready",
        "detail": "Database connectivity check failed",
        "error_name": "SERVICE_NOT_READY",
    }
