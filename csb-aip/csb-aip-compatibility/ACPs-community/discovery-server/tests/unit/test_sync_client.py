from __future__ import annotations

import asyncio
from datetime import UTC
from typing import TYPE_CHECKING

import httpx
import pytest

from app.core.config import settings as app_settings
from app.sync import client as sync_client_module
from app.sync.exception import SyncError, SyncOperationError
from app.sync.model import DSPState, Envelope

if TYPE_CHECKING:
    from collections.abc import AsyncGenerator

pytestmark = pytest.mark.unit


async def test_sync_once_updates_last_sync_time_with_utc(monkeypatch: pytest.MonkeyPatch) -> None:
    dsp_client = sync_client_module.DSPClient("http://localhost:9001/acps-dsp-v2")
    dsp_client.state = DSPState(last_seq=0, needs_snapshot=False)
    called = False

    async def fake_sync_changes_continuously() -> None:
        nonlocal called
        await asyncio.sleep(0)
        called = True

    monkeypatch.setattr(dsp_client, "_sync_changes_continuously", fake_sync_changes_continuously)

    await dsp_client.sync_once()

    assert called is True
    assert dsp_client.state.last_sync_time is not None
    assert dsp_client.state.last_sync_time.tzinfo is UTC


async def test_process_changes_response_marks_snapshot_needed_on_410() -> None:
    dsp_client = sync_client_module.DSPClient("http://localhost:9001/acps-dsp-v2")
    dsp_client.state = DSPState(last_seq=123, needs_snapshot=False)
    response = httpx.Response(
        410,
        request=httpx.Request("GET", "http://localhost:9001/acps-dsp-v2/changes"),
    )

    with pytest.raises(SyncOperationError) as exc_info:
        dsp_client._process_changes_response(response, seq=123, types=["acs"])

    assert exc_info.value.error_name == SyncError.RETENTION_WINDOW_EXCEEDED
    assert dsp_client.state.needs_snapshot is True
    assert dsp_client._force_full_snapshot is True


async def test_sync_once_uses_full_snapshot_replace_after_retention(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dsp_client = sync_client_module.DSPClient("http://localhost:9001/acps-dsp-v2")
    dsp_client.state = DSPState(
        last_seq=123,
        needs_snapshot=True,
        object_versions={"acs": {"demo.agent": 1}},
    )
    dsp_client._force_full_snapshot = True
    clear_called = False

    async def fake_clear_local_snapshot_data() -> int:
        nonlocal clear_called
        clear_called = True
        assert dsp_client.state is not None
        dsp_client.state.object_versions.clear()
        return 1

    async def fake_create_snapshot(
        *,
        types: list[str] | None = None,
        from_seq: int | None = None,
        limit: int = 10000,
    ) -> AsyncGenerator[object]:
        assert types == ["acs"]
        assert from_seq is None
        assert limit == app_settings.DSP_SNAPSHOT_CHUNK_SIZE
        assert clear_called is True
        assert dsp_client.state is not None
        dsp_client.state.last_seq = 456
        dsp_client.state.needs_snapshot = False
        if limit < 0:
            yield None

    monkeypatch.setattr(dsp_client, "_clear_local_snapshot_data", fake_clear_local_snapshot_data)
    monkeypatch.setattr(dsp_client, "create_snapshot", fake_create_snapshot)

    await dsp_client.sync_once()

    assert clear_called is True
    assert dsp_client._force_full_snapshot is False
    assert dsp_client.state is not None
    assert dsp_client.state.last_seq == 456
    assert dsp_client.state.object_versions == {}


async def test_sync_changes_continuously_retries_with_snapshot_after_410(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dsp_client = sync_client_module.DSPClient("http://localhost:9001/acps-dsp-v2")
    dsp_client.state = DSPState(last_seq=123, needs_snapshot=False)
    snapshot_retry_called = False

    async def fake_get_changes(*args: object, **kwargs: object) -> AsyncGenerator[object]:
        _ = args, kwargs
        if len(args) < 0:
            yield None
        raise SyncOperationError(
            status_code=409,
            error_name=SyncError.RETENTION_WINDOW_EXCEEDED,
            error_msg="Client fallen behind retention window",
        )

    async def fake_sync_once() -> None:
        nonlocal snapshot_retry_called
        snapshot_retry_called = True
        assert dsp_client.state is not None
        assert dsp_client.state.needs_snapshot is True

    monkeypatch.setattr(dsp_client, "get_changes", fake_get_changes)
    monkeypatch.setattr(dsp_client, "sync_once", fake_sync_once)

    await dsp_client._sync_changes_continuously()

    assert snapshot_retry_called is True
    assert dsp_client._force_full_snapshot is True


async def test_load_state_from_db_forces_full_snapshot_when_snapshot_is_needed(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    dsp_client = sync_client_module.DSPClient("http://localhost:9001/acps-dsp-v2")

    async def fake_load_from_db(*, require_indexed_skills: bool = False) -> DSPState:
        assert require_indexed_skills is False
        await asyncio.sleep(0)
        return DSPState(last_seq=37, needs_snapshot=True)

    monkeypatch.setattr(DSPState, "load_from_db", fake_load_from_db)
    monkeypatch.setattr(sync_client_module, "get_matcher", lambda: None)

    state = await dsp_client._load_state_from_db()

    assert state.last_seq == 37
    assert state.needs_snapshot is True
    assert dsp_client._force_full_snapshot is True


async def test_trigger_sync_once_starts_background_task(monkeypatch: pytest.MonkeyPatch) -> None:
    dsp_client = sync_client_module.DSPClient("http://localhost:9001/acps-dsp-v2")
    started = asyncio.Event()
    release = asyncio.Event()

    async def fake_sync_once() -> None:
        started.set()
        await release.wait()

    monkeypatch.setattr(dsp_client, "sync_once", fake_sync_once)

    assert dsp_client.trigger_sync_once() is True
    await asyncio.wait_for(started.wait(), timeout=1)
    assert dsp_client.sync_task_in_progress() is True
    assert dsp_client.trigger_sync_once() is False

    release.set()
    assert dsp_client._manual_sync_task is not None
    await asyncio.wait_for(dsp_client._manual_sync_task, timeout=1)
    assert dsp_client.sync_task_in_progress() is False


async def test_trigger_sync_once_records_and_clears_manual_sync_error(monkeypatch: pytest.MonkeyPatch) -> None:
    dsp_client = sync_client_module.DSPClient("http://localhost:9001/acps-dsp-v2")

    async def failing_sync_once() -> None:
        await asyncio.sleep(0)
        raise RuntimeError("registry unavailable")

    monkeypatch.setattr(dsp_client, "sync_once", failing_sync_once)

    assert dsp_client.trigger_sync_once() is True
    assert dsp_client._manual_sync_task is not None
    with pytest.raises(RuntimeError, match="registry unavailable"):
        await asyncio.wait_for(dsp_client._manual_sync_task, timeout=1)
    await asyncio.sleep(0)
    assert dsp_client.manual_sync_error() == "registry unavailable"

    async def successful_sync_once() -> None:
        await asyncio.sleep(0)

    monkeypatch.setattr(dsp_client, "sync_once", successful_sync_once)

    assert dsp_client.trigger_sync_once() is True
    assert dsp_client.manual_sync_error() is None
    assert dsp_client._manual_sync_task is not None
    await asyncio.wait_for(dsp_client._manual_sync_task, timeout=1)
    await asyncio.sleep(0)
    assert dsp_client.manual_sync_error() is None


async def test_snapshot_sync_indexes_applied_envelopes_concurrently(monkeypatch: pytest.MonkeyPatch) -> None:
    dsp_client = sync_client_module.DSPClient("http://localhost:9001/acps-dsp-v2")
    dsp_client.state = DSPState(last_seq=None, needs_snapshot=True)
    monkeypatch.setattr(app_settings, "DSP_SEMANTIC_INDEX_CONCURRENCY", 3)

    active_index_tasks = 0
    max_active_index_tasks = 0
    indexed_ids: list[str] = []

    async def fake_clear_local_snapshot_data() -> int:
        assert dsp_client.state is not None
        dsp_client.state.object_versions.clear()
        return 0

    async def fake_create_snapshot(
        *,
        types: list[str] | None = None,
        from_seq: int | None = None,
        limit: int = 10000,
    ) -> AsyncGenerator[Envelope]:
        del types, from_seq, limit
        for seq in range(1, 4):
            yield Envelope(
                seq=seq,
                type="acs",
                id=f"agent.{seq}",
                version=1,
                payload={"aic": f"agent.{seq}", "description": f"agent {seq}"},
            )
        assert dsp_client.state is not None
        dsp_client.state.last_seq = 3
        dsp_client.state.needs_snapshot = False

    async def fake_apply_to_database(envelope: Envelope) -> None:
        await asyncio.sleep(0)
        assert envelope.id.startswith("agent.")

    async def fake_update_search_index(envelope: Envelope) -> None:
        nonlocal active_index_tasks, max_active_index_tasks
        active_index_tasks += 1
        max_active_index_tasks = max(max_active_index_tasks, active_index_tasks)
        await asyncio.sleep(0.05)
        indexed_ids.append(envelope.id)
        active_index_tasks -= 1

    async def fake_log_agent_visibility(*, stage: str, aic: str) -> None:
        await asyncio.sleep(0)
        assert stage == "after_search_index"
        assert aic.startswith("agent.")

    async def fake_log_snapshot_sync_result() -> None:
        await asyncio.sleep(0)

    monkeypatch.setattr(dsp_client, "_clear_local_snapshot_data", fake_clear_local_snapshot_data)
    monkeypatch.setattr(dsp_client, "create_snapshot", fake_create_snapshot)
    monkeypatch.setattr(dsp_client, "_apply_to_database", fake_apply_to_database)
    monkeypatch.setattr(dsp_client, "update_search_index", fake_update_search_index)
    monkeypatch.setattr(dsp_client, "_log_agent_visibility", fake_log_agent_visibility)
    monkeypatch.setattr(dsp_client, "_log_snapshot_sync_result", fake_log_snapshot_sync_result)

    await dsp_client.sync_once()

    assert max_active_index_tasks > 1
    assert sorted(indexed_ids) == ["agent.1", "agent.2", "agent.3"]
    assert dsp_client.state.last_seq == 3
    assert dsp_client.state.needs_snapshot is False
    assert dsp_client.state.last_sync_time is not None


def test_get_dsp_client_raises_when_base_url_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(sync_client_module, "_dsp_client", None)
    monkeypatch.setattr(app_settings, "DSP_BASE_URL", "")

    with pytest.raises(SyncOperationError) as exc_info:
        sync_client_module.get_dsp_client()

    assert exc_info.value.status_code == 503
    assert exc_info.value.error_name == SyncError.CLIENT_CONFIG_ERROR
    assert "DSP_BASE_URL" in exc_info.value.error_msg
