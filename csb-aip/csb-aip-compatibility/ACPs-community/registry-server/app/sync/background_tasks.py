"""
后台任务：定期清理过期的Snapshot。
TODO: 需要在应用启动时注册此任务，并确保在应用关闭时正确停止。
"""

import asyncio

import structlog

from app.core.config import settings
from app.core.db_session import get_sync_session
from app.sync.service import cleanup_expired_snapshots

logger = structlog.get_logger(__name__)


class SnapshotCleanupTask:
    """定期清理过期Snapshot的后台任务"""

    def __init__(self) -> None:
        self.is_running = False
        self.cleanup_interval = settings.dsp_snapshot_cleanup_interval_hours * 3600  # 转换为秒

    async def start(self) -> None:
        """启动后台清理任务"""
        if self.is_running:
            logger.warning("Snapshot 清理任务已在运行")
            return

        self.is_running = True
        logger.info(
            "开始执行 Snapshot 清理任务",
            interval_hours=settings.dsp_snapshot_cleanup_interval_hours,
        )

        while self.is_running:
            try:
                await self._cleanup_expired_snapshots()
                await asyncio.sleep(self.cleanup_interval)
            except asyncio.CancelledError:
                logger.info("Snapshot 清理任务已取消")
                break
            except Exception as e:
                logger.error("Snapshot 清理任务执行出错", error=str(e))
                # 出错后等待较短时间再重试
                await asyncio.sleep(300)  # 5分钟后重试

    async def stop(self) -> None:
        """停止后台清理任务"""
        self.is_running = False
        logger.info("停止 Snapshot 清理任务")

    async def _cleanup_expired_snapshots(self) -> None:
        """执行清理过期Snapshot的具体逻辑"""
        try:
            with get_sync_session() as db:
                cleaned_count = cleanup_expired_snapshots(db)
                if cleaned_count > 0:
                    logger.info("已清理过期 Snapshot", cleaned_count=cleaned_count)
                else:
                    logger.debug("未发现需要清理的过期 Snapshot")

        except Exception as e:
            logger.error("清理过期 Snapshot 失败", error=str(e))


# 全局任务实例
snapshot_cleanup_task = SnapshotCleanupTask()


async def start_background_tasks() -> list[asyncio.Task[None]]:
    """启动所有后台任务"""
    logger.info("开始启动后台任务")

    cleanup_task = asyncio.create_task(snapshot_cleanup_task.start())
    return [cleanup_task]


async def stop_background_tasks() -> None:
    """停止所有后台任务"""
    logger.info("开始停止后台任务")
    await snapshot_cleanup_task.stop()
