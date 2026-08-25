"""
Webhook服务模块

处理来自Registry Server的webhook通知，并管理webhook注册。
"""

from __future__ import annotations

import hashlib
import hmac
from typing import TYPE_CHECKING, Any, cast

import httpx
from fastapi import HTTPException, status
from sqlalchemy import text
from sqlmodel import delete

from app.core.dependencies import ServiceRuntime, get_service_runtime
from app.core.logging_config import get_logger
from app.sync.client import get_dsp_client
from app.sync.exception import SyncOperationError

from .model import Agent, DSPState, WebhookCreate, WebhookNotification, WebhookResponse

if TYPE_CHECKING:
    from collections.abc import Mapping

    from sqlalchemy.engine import CursorResult
    from sqlalchemy.ext.asyncio import AsyncSession

logger = get_logger(__name__)

TRUNCATE_AVAILABLE_AGENTS_RUNTIME_SQL = text("TRUNCATE TABLE available_agents_runtime")


def _resolve_runtime(runtime: ServiceRuntime | None = None) -> ServiceRuntime:
    return runtime if runtime is not None else get_service_runtime()


def verify_webhook_signature(secret: str, timestamp: str, payload: str, signature: str) -> bool:
    """
    验证webhook签名

    Args:
        secret: 签名密钥
        timestamp: 时间戳
        payload: 请求体
        signature: 签名

    Returns:
        签名是否有效
    """
    try:
        # 构建签名字符串
        message = f"{timestamp}.{payload}"

        # 计算HMAC-SHA256签名
        expected_signature = hmac.new(secret.encode("utf-8"), message.encode("utf-8"), hashlib.sha256).hexdigest()

        # 比较签名
        return hmac.compare_digest(f"sha256={expected_signature}", signature)
    except (AttributeError, TypeError, ValueError) as exc:
        logger.error("验证 webhook 签名失败", error=str(exc))
        return False


async def process_webhook_notification(notification: WebhookNotification) -> None:
    """
    处理webhook通知

    Args:
        notification: webhook通知数据
    """
    logger.info("收到 webhook 通知", webhook_event=notification.event)

    # 统一使用一个 handler 处理所有事件
    await handle_webhook_event(notification.event, notification.data)


async def handle_webhook_event(event_type: str, data: Mapping[str, object]) -> None:
    """
    统一处理所有webhook事件

    Args:
        event_type: 事件类型
        data: 事件数据
    """
    try:
        logger.info("处理 webhook 事件", event_type=event_type, data=data)

        # 触发 DSP 同步
        client = get_dsp_client()
        await client.sync_once()
    except SyncOperationError as exc:
        logger.error("处理 webhook 事件失败", event_type=event_type, error=str(exc))


async def reset_sync_client_state() -> None:
    """重置内存中的 DSP 同步状态。"""

    client = get_dsp_client()
    if client.state is None:
        client.state = await DSPState.load_from_db()

    client.state.last_seq = None
    client.state.object_versions.clear()
    client.state.needs_snapshot = True
    client.state.last_sync_time = None


async def hard_reset_sync_state(
    *,
    session: AsyncSession | None = None,
    runtime: ServiceRuntime | None = None,
) -> int:
    """清空 Agent 数据、运行时可用性快照并重置 DSP 同步状态。"""

    await reset_sync_client_state()

    if session is not None:
        await session.execute(TRUNCATE_AVAILABLE_AGENTS_RUNTIME_SQL)
        delete_stmt = delete(Agent)
        result = cast("CursorResult[Any]", await session.execute(delete_stmt))
        return int(result.rowcount or 0)

    async with _resolve_runtime(runtime).session_factory() as owned_session, owned_session.begin():
        await owned_session.execute(TRUNCATE_AVAILABLE_AGENTS_RUNTIME_SQL)
        delete_stmt = delete(Agent)
        result = cast("CursorResult[Any]", await owned_session.execute(delete_stmt))
        return int(result.rowcount or 0)


async def register_webhook_with_registry(
    webhook_data: WebhookCreate,
    *,
    runtime: ServiceRuntime | None = None,
    authorization_header: str | None = None,
) -> WebhookResponse:
    """
    向Registry Server注册webhook

    Args:
        webhook_data: webhook创建数据

    Returns:
        注册结果
    """
    try:
        if not authorization_header or not authorization_header.startswith("Bearer "):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="缺少 Registry webhook 注册所需的 Bearer token",
            )

        client = get_dsp_client()
        registry_url = client.registry_base_url
        resolved_runtime = _resolve_runtime(runtime)
        target_url = webhook_data.url.strip() or resolved_runtime.settings.DSP_WEBHOOK_RECEIVE_URL.strip()

        if not target_url:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="缺少 webhook 回调地址：请在请求中提供 url 或配置 DSP_WEBHOOK_RECEIVE_URL",
            )

        # 构建注册请求
        register_data = {
            "url": target_url,
            "secret": webhook_data.secret,
            "types": webhook_data.types,
            "events": webhook_data.events,
            "description": webhook_data.description or "Discovery Server自动注册的webhook",
        }
        # 发送注册请求
        async with httpx.AsyncClient() as http_client:
            response = await http_client.post(
                f"{registry_url}/webhooks",  # 添加正确的API路径
                json=register_data,
                headers={"Authorization": authorization_header},
                timeout=30.0,
            )

            if response.status_code == 201:
                result = response.json()
                logger.info("成功向 Registry 注册 webhook", webhook_id=result.get("id"))
                return WebhookResponse(**result)
            logger.error(
                "向 Registry 注册 webhook 失败",
                status_code=response.status_code,
                response_text=response.text,
            )
            raise HTTPException(
                status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
                detail=f"向Registry注册webhook失败: {response.text}",
            )

    except HTTPException:
        raise
    except httpx.HTTPError as exc:
        logger.error("注册 webhook 时网络请求失败", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"注册webhook失败: {exc!s}",
        ) from exc
    except (TypeError, ValueError) as exc:
        logger.error("注册 webhook 时响应解析失败", error=str(exc))
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"注册webhook失败: {exc!s}",
        ) from exc
