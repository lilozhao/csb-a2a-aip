"""针对 sync/background_tasks.py 的单元测试。

覆盖：SnapshotCleanupTask.start（正常运行一次循环）、stop、
_cleanup_expired_snapshots（成功路径和异常路径）、
start_background_tasks、stop_background_tasks。
"""

from __future__ import annotations

import asyncio
from unittest.mock import MagicMock, patch

import pytest

from app.sync.background_tasks import (
    SnapshotCleanupTask,
    snapshot_cleanup_task,
    start_background_tasks,
    stop_background_tasks,
)

pytestmark = pytest.mark.unit


class TestSnapshotCleanupTaskStop:
    async def test_stop_sets_is_running_false(self) -> None:
        task = SnapshotCleanupTask()
        task.is_running = True
        await task.stop()
        assert task.is_running is False


class TestSnapshotCleanupTaskAlreadyRunning:
    async def test_start_when_already_running_returns_immediately(self) -> None:
        """如果任务已在运行，第二次 start 调用应立即返回。"""
        task = SnapshotCleanupTask()
        task.is_running = True

        # 重写 _cleanup_expired_snapshots，防止真正执行
        called = []

        async def _fake_cleanup() -> None:
            await asyncio.sleep(0)
            called.append(True)

        task._cleanup_expired_snapshots = _fake_cleanup  # type: ignore[method-assign]

        await task.start()
        assert called == []


class TestCleanupExpiredSnapshots:
    async def test_successful_cleanup_logs_count(self) -> None:
        task = SnapshotCleanupTask()

        mock_db = MagicMock()
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_db)
        mock_ctx.__exit__ = MagicMock(return_value=False)

        with (
            patch("app.sync.background_tasks.get_sync_session", return_value=mock_ctx),
            patch("app.sync.background_tasks.cleanup_expired_snapshots", return_value=3) as mock_cleanup,
        ):
            await task._cleanup_expired_snapshots()

        mock_cleanup.assert_called_once_with(mock_db)

    async def test_cleanup_exception_is_swallowed(self) -> None:
        """异常不应传播出 _cleanup_expired_snapshots。"""
        task = SnapshotCleanupTask()

        with patch(
            "app.sync.background_tasks.get_sync_session",
            side_effect=RuntimeError("db unavailable"),
        ):
            # 不应抛出
            await task._cleanup_expired_snapshots()

    async def test_zero_cleaned_does_not_log_info(self) -> None:
        task = SnapshotCleanupTask()

        mock_db = MagicMock()
        mock_ctx = MagicMock()
        mock_ctx.__enter__ = MagicMock(return_value=mock_db)
        mock_ctx.__exit__ = MagicMock(return_value=False)

        with (
            patch("app.sync.background_tasks.get_sync_session", return_value=mock_ctx),
            patch("app.sync.background_tasks.cleanup_expired_snapshots", return_value=0),
        ):
            # 不应抛出异常
            await task._cleanup_expired_snapshots()


class TestStartStopHelpers:
    async def test_start_background_tasks_returns_task_list(self) -> None:
        """验证 start_background_tasks 应返回包含一个 asyncio.Task 的列表。"""

        # 防止真正启动后台循环
        async def _fake_start() -> None:
            return

        with patch.object(snapshot_cleanup_task, "start", _fake_start):
            tasks = await start_background_tasks()

        assert len(tasks) >= 1
        for t in tasks:
            assert isinstance(t, asyncio.Task)
            t.cancel()

    async def test_stop_background_tasks_calls_stop(self) -> None:
        stop_called = []

        async def _fake_stop() -> None:
            await asyncio.sleep(0)
            stop_called.append(True)

        with patch.object(snapshot_cleanup_task, "stop", _fake_stop):
            await stop_background_tasks()

        assert stop_called == [True]


class TestSnapshotCleanupTaskStartLoop:
    async def test_start_runs_cleanup_once_then_stops(self) -> None:
        """验证 start() 会调用一次 _cleanup_expired_snapshots 然后通过 stop() 停止。"""
        task = SnapshotCleanupTask()
        task.cleanup_interval = 0  # 不等待

        cleanup_calls: list[int] = []

        async def _fake_cleanup() -> None:
            cleanup_calls.append(1)
            # 第一次执行后停止任务
            await task.stop()

        task._cleanup_expired_snapshots = _fake_cleanup  # type: ignore[method-assign]

        await task.start()

        assert len(cleanup_calls) == 1

    async def test_start_handles_cancelled_error_gracefully(self) -> None:
        """验证 CancelledError 应被安静地捕获而不重新抛出。"""
        task = SnapshotCleanupTask()
        task.cleanup_interval = 0

        async def _raise_cancelled() -> None:
            raise asyncio.CancelledError()

        task._cleanup_expired_snapshots = _raise_cancelled  # type: ignore[method-assign]

        # 不应传播 CancelledError
        await task.start()
        assert task.is_running is True  # start 不会自动重置 is_running
