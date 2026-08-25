from __future__ import annotations

import asyncio

import pytest

from app.core import lifespan as lifespan_module
from app.core.config import settings
from app.sync.exception import SyncOperationError

pytestmark = pytest.mark.unit


def test_start_forwarder_health_check_marks_runtime_running(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()
    called = False

    monkeypatch.setattr(settings, "FORWARDER_SERVER_ENABLED", True)
    monkeypatch.setattr(settings, "FORWARDER_SERVER_URL", "http://localhost:9006")

    def fake_start() -> None:
        nonlocal called
        called = True

    monkeypatch.setattr(lifespan_module, "start_health_check_task", fake_start)

    coordinator._start_forwarder_health_check()

    assert called is True
    assert coordinator.runtime_state.forwarder_health_check.running is True
    assert coordinator.runtime_state.forwarder_health_check.last_error is None


def test_start_forwarder_health_check_records_runtime_error(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()

    monkeypatch.setattr(settings, "FORWARDER_SERVER_ENABLED", True)
    monkeypatch.setattr(settings, "FORWARDER_SERVER_URL", "http://localhost:9006")

    def fake_start() -> None:
        raise RuntimeError("forwarder unavailable")

    monkeypatch.setattr(lifespan_module, "start_health_check_task", fake_start)

    coordinator._start_forwarder_health_check()

    assert coordinator.runtime_state.forwarder_health_check.running is False
    assert coordinator.runtime_state.forwarder_health_check.last_error == "forwarder unavailable"


def test_start_forwarder_health_check_skips_when_forwarder_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()

    monkeypatch.setattr(settings, "FORWARDER_SERVER_ENABLED", False)
    monkeypatch.setattr(settings, "FORWARDER_SERVER_URL", "")

    def fake_start() -> None:
        raise AssertionError("forwarder health check should not start")

    monkeypatch.setattr(lifespan_module, "start_health_check_task", fake_start)

    coordinator._start_forwarder_health_check()

    assert coordinator.runtime_state.forwarder_health_check.running is False
    assert coordinator.runtime_state.forwarder_health_check.last_error is None


def test_start_available_agents_polling_skips_when_url_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()

    monkeypatch.setattr(settings, "POLLING_SERVER_URL", "")

    def fake_create_task(*args: object, **kwargs: object) -> None:
        raise AssertionError("polling task should not start")

    monkeypatch.setattr(asyncio, "create_task", fake_create_task)

    coordinator._start_available_agents_polling()

    assert coordinator.runtime_state.available_agents_polling.running is False
    assert coordinator.runtime_state.available_agents_polling.last_error is None


async def test_stop_forwarder_health_check_marks_runtime_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()
    coordinator.runtime_state.forwarder_health_check.running = True
    called = False

    async def fake_stop() -> None:
        await asyncio.sleep(0)
        nonlocal called
        called = True

    monkeypatch.setattr(lifespan_module, "stop_health_check_task", fake_stop)

    await coordinator._stop_forwarder_health_check()

    assert called is True
    assert coordinator.runtime_state.forwarder_health_check.running is False
    assert coordinator.runtime_state.forwarder_health_check.last_error is None


async def test_stop_forwarder_health_check_records_error(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()
    coordinator.runtime_state.forwarder_health_check.running = True

    async def fake_stop() -> None:
        await asyncio.sleep(0)
        raise RuntimeError("stop failed")

    monkeypatch.setattr(lifespan_module, "stop_health_check_task", fake_stop)

    await coordinator._stop_forwarder_health_check()

    assert coordinator.runtime_state.forwarder_health_check.running is True
    assert coordinator.runtime_state.forwarder_health_check.last_error == "stop failed"


async def test_start_dsp_sync_marks_runtime_running(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()
    called = False

    monkeypatch.setattr(settings, "DSP_AUTO_START", True)
    monkeypatch.setattr(settings, "DSP_BASE_URL", "http://localhost:9001/acps-dsp-v2")

    async def fake_start() -> None:
        await asyncio.sleep(0)
        nonlocal called
        called = True

    monkeypatch.setattr(lifespan_module, "start_dsp_sync", fake_start)

    await coordinator._start_dsp_sync()

    assert called is True
    assert coordinator.runtime_state.dsp_sync.running is True
    assert coordinator.runtime_state.dsp_sync.last_error is None


async def test_start_dsp_sync_skips_when_auto_start_disabled(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()

    monkeypatch.setattr(settings, "DSP_AUTO_START", False)

    async def fake_start() -> None:
        raise AssertionError("DSP auto-start 已禁用时不应启动后台同步")

    monkeypatch.setattr(lifespan_module, "start_dsp_sync", fake_start)

    await coordinator._start_dsp_sync()

    assert coordinator.runtime_state.dsp_sync.running is False
    assert coordinator.runtime_state.dsp_sync.last_error is None


async def test_start_dsp_sync_skips_when_base_url_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()

    monkeypatch.setattr(settings, "DSP_AUTO_START", True)
    monkeypatch.setattr(settings, "DSP_BASE_URL", "")

    async def fake_start() -> None:
        raise AssertionError("DSP_BASE_URL 为空时不应启动后台同步")

    monkeypatch.setattr(lifespan_module, "start_dsp_sync", fake_start)

    await coordinator._start_dsp_sync()

    assert coordinator.runtime_state.dsp_sync.running is False
    assert coordinator.runtime_state.dsp_sync.last_error is None


async def test_start_dsp_sync_records_sync_exception(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()

    monkeypatch.setattr(settings, "DSP_AUTO_START", True)
    monkeypatch.setattr(settings, "DSP_BASE_URL", "http://localhost:9001/acps-dsp-v2")

    async def fake_start() -> None:
        await asyncio.sleep(0)
        raise SyncOperationError(error_msg="registry unavailable")

    monkeypatch.setattr(lifespan_module, "start_dsp_sync", fake_start)

    await coordinator._start_dsp_sync()

    assert coordinator.runtime_state.dsp_sync.running is False
    assert coordinator.runtime_state.dsp_sync.last_error == "registry unavailable"


async def test_stop_dsp_sync_marks_runtime_stopped(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()
    coordinator.runtime_state.dsp_sync.running = True
    called = False

    async def fake_stop() -> None:
        await asyncio.sleep(0)
        nonlocal called
        called = True

    monkeypatch.setattr(lifespan_module, "stop_dsp_sync", fake_stop)

    await coordinator._stop_dsp_sync()

    assert called is True
    assert coordinator.runtime_state.dsp_sync.running is False
    assert coordinator.runtime_state.dsp_sync.last_error is None


async def test_stop_dsp_sync_records_error(monkeypatch: pytest.MonkeyPatch) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()
    coordinator.runtime_state.dsp_sync.running = True

    async def fake_stop() -> None:
        await asyncio.sleep(0)
        raise RuntimeError("stop failed")

    monkeypatch.setattr(lifespan_module, "stop_dsp_sync", fake_stop)

    await coordinator._stop_dsp_sync()

    assert coordinator.runtime_state.dsp_sync.running is True
    assert coordinator.runtime_state.dsp_sync.last_error == "stop failed"


def test_start_semantic_matcher_skips_gpu_matcher_in_testing_without_local_gpu_config(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    coordinator = lifespan_module.RuntimeCoordinator()

    monkeypatch.setattr(settings, "APP_ENV", "testing")
    monkeypatch.setattr(settings, "DISCOVERY_MODE", "gpu")
    monkeypatch.setattr(settings, "EMBEDDING_MODEL_PATH", "")
    monkeypatch.setattr(settings, "EMBEDDING_DEVICES", "")

    def fake_matcher(*args: object, **kwargs: object) -> None:
        raise AssertionError("测试态 GPU 缺省配置不应实例化本地 matcher")

    monkeypatch.setattr(lifespan_module, "SemanticAgentMatcher", fake_matcher)

    coordinator._start_semantic_matcher()

    assert coordinator.runtime_state.semantic_matcher.running is False
    assert coordinator.runtime_state.semantic_matcher.last_error is None
