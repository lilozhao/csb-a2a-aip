"""
DSP（Data Synchronization Protocol）管理 API。

此模块提供用于监控和管理 DSP 同步服务的 API 端点。
"""

from __future__ import annotations

import json
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from pydantic import BaseModel, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession  # noqa: TC002 - FastAPI resolves dependency annotations at runtime

from app.core.database import get_async_session
from app.core.dependencies import ServiceRuntime, get_service_runtime
from app.core.logging_config import get_logger
from app.discovery.semantic_matcher_holder import get_matcher

from .client import get_dsp_client
from .exception import SyncError, SyncOperationError
from .model import RegistryInfo, WebhookCreate, WebhookNotification, WebhookResponse
from .service import (
    hard_reset_sync_state,
    process_webhook_notification,
    register_webhook_with_registry,
    reset_sync_client_state,
    verify_webhook_signature,
)

router = APIRouter()
logger = get_logger(__name__)


class DSPStatus(BaseModel):
    """DSP 同步状态响应。"""

    is_running: bool
    manual_sync_in_progress: bool = False
    manual_sync_error: str | None = None
    last_seq: int | None
    last_sync_time: datetime | None
    needs_snapshot: bool
    object_count_by_type: dict[str, int]
    sync_interval: int
    registry_url: str


class DSPControlResponse(BaseModel):
    """DSP 控制操作响应。"""

    success: bool
    message: str


class WebhookAckResponse(BaseModel):
    """Webhook 接收确认响应。"""

    status: str
    processed_at: str


@router.get("/status")
async def get_dsp_status() -> DSPStatus:
    """获取当前 DSP 同步状态。"""
    client = get_dsp_client()

    # 如果状态尚未初始化，创建默认状态
    if client.state is None:
        from .model import DSPState

        client.state = await DSPState.load_from_db(require_indexed_skills=get_matcher() is not None)

    # 按类型计算对象数量
    object_count_by_type = {}
    for obj_type, objects in client.state.object_versions.items():
        object_count_by_type[obj_type] = len(objects)

    manual_sync_error_getter = getattr(client, "manual_sync_error", None)
    manual_sync_error = manual_sync_error_getter() if callable(manual_sync_error_getter) else None

    return DSPStatus(
        is_running=client.is_running,
        manual_sync_in_progress=client.sync_task_in_progress(),
        manual_sync_error=manual_sync_error,
        last_seq=client.state.last_seq,
        last_sync_time=client.state.last_sync_time,
        needs_snapshot=client.state.needs_snapshot,
        object_count_by_type=object_count_by_type,
        sync_interval=client.sync_interval,
        registry_url=client.registry_base_url,
    )


@router.post("/start")
async def start_dsp_sync_endpoint() -> DSPControlResponse:
    """启动 DSP 同步服务。"""
    client = get_dsp_client()
    await client.start_background_sync()
    return DSPControlResponse(success=True, message="DSP 同步启动成功")


@router.post("/stop")
async def stop_dsp_sync_endpoint() -> DSPControlResponse:
    """停止 DSP 同步服务。"""
    client = get_dsp_client()
    await client.stop_background_sync()
    return DSPControlResponse(success=True, message="DSP 同步停止成功")


@router.post("/sync")
async def trigger_sync() -> DSPControlResponse:
    """触发手动同步周期。"""
    client = get_dsp_client()
    started = client.trigger_sync_once()
    if started:
        return DSPControlResponse(success=True, message="手动同步已触发")
    return DSPControlResponse(success=True, message="手动同步已在执行中")


@router.post("/reset")
async def reset_sync_state() -> DSPControlResponse:
    """重置内存中的 DSP 同步状态（强制下次同步时进行完整快照，没有清空数据库）。"""
    await reset_sync_client_state()

    return DSPControlResponse(success=True, message="DSP 同步状态重置成功")


@router.post("/hard-reset")
async def hard_reset(
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> DSPControlResponse:
    """硬重置：清空所有 Agent 数据库数据并重置 DSP 同步状态，强制下次进行完整快照同步。"""
    deleted_count = await hard_reset_sync_state(session=session)
    await session.commit()

    return DSPControlResponse(
        success=True,
        message=f"硬重置成功：已清空 {deleted_count} 条Agent记录并重置同步状态，下次同步将进行完整快照",
    )


@router.get("/registry-info")
async def get_registry_info() -> RegistryInfo:
    """获取已连接的注册中心服务器信息。"""
    client = get_dsp_client()
    info = await client.get_registry_info()

    if info is None:
        raise SyncOperationError(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            error_name=SyncError.REGISTRY_UNAVAILABLE,
            error_msg="无法连接到注册中心服务器",
            input_params={"registry_url": client.registry_base_url},
        )

    return info


# Webhook相关端点


@router.post(
    "/webhooks/receive",
    responses={401: {"description": "Invalid signature"}},
)
async def receive_webhook(
    request: Request,
    x_webhook_id: Annotated[str, Header(alias="X-Webhook-ID")],
    x_webhook_signature: Annotated[str, Header(alias="X-Webhook-Signature")],
    x_webhook_timestamp: Annotated[str, Header(alias="X-Webhook-Timestamp")],
    runtime: Annotated[ServiceRuntime, Depends(get_service_runtime)],
) -> WebhookAckResponse:
    """接收来自Registry Server的webhook通知"""
    try:
        # 读取请求体
        body = await request.body()
        payload = body.decode("utf-8")

        # 当前使用服务端配置中的共享密钥进行验签。
        secret = runtime.settings.DSP_WEBHOOK_SECRET

        if not verify_webhook_signature(secret, x_webhook_timestamp, payload, x_webhook_signature):
            logger.warning("Webhook签名验证失败", webhook_id=x_webhook_id)
            raise HTTPException(status_code=401, detail="Invalid signature")

        # 解析通知数据
        notification_data = json.loads(payload)
        notification = WebhookNotification(**notification_data)
        logger.info("收到 webhook 通知", webhook_id=x_webhook_id, notification=notification.model_dump(mode="json"))

        # 异步处理webhook通知
        await process_webhook_notification(notification)

        return WebhookAckResponse(
            status="acknowledged",
            processed_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
        )

    except HTTPException:
        raise
    except (UnicodeDecodeError, json.JSONDecodeError, ValidationError) as exc:
        logger.error("解析 webhook 通知失败", error=str(exc), webhook_id=x_webhook_id)
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"处理webhook通知失败: {exc!s}",
        ) from exc


@router.post("/webhooks/register")
async def register_webhook(
    webhook_data: WebhookCreate,
    request: Request,
    runtime: Annotated[ServiceRuntime, Depends(get_service_runtime)],
) -> WebhookResponse:
    """
    向Registry Server注册webhook

    此端点会向Registry Server发送webhook注册请求，使Discovery Server能够接收数据变更通知。
    """
    authorization_header = request.headers.get("Authorization")
    return await register_webhook_with_registry(
        webhook_data,
        runtime=runtime,
        authorization_header=authorization_header,
    )
