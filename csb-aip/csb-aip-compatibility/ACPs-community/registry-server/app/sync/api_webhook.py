from typing import Annotated, Any

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.model import RoleType, User
from app.core.auth import check_user_role
from app.core.base_exception import PROBLEM_JSON_MEDIA_TYPE
from app.core.db_session import get_session
from app.sync.api_protocol import BAD_REQUEST_RESPONSE, NOT_FOUND_RESPONSE, SERVER_ERROR_RESPONSE
from app.sync.exception import SyncError, SyncErrorCode
from app.sync.schema import WebHookCreate, WebHookListResponse, WebHookResponse, WebHookUpdate
from app.sync.service import (
    create_webhook_async,
    delete_webhook_async,
    get_webhook_async,
    get_webhook_list_async,
    reactivate_webhook_async,
    update_webhook_async,
)

router_webhook = APIRouter()

DbSession = Annotated[AsyncSession, Depends(get_session)]
type MaintenanceUserDep = Annotated[User, Depends(check_user_role([RoleType.STAFF, RoleType.ADMIN]))]


def _problem_response(description: str) -> dict[str, object]:
    return {"description": description, "content": {PROBLEM_JSON_MEDIA_TYPE: {}}}


UNAUTHORIZED_RESPONSE = _problem_response("Authentication required")
FORBIDDEN_RESPONSE = _problem_response("Webhook admin access denied")


def _to_webhook_response(webhook: Any) -> WebHookResponse:
    return WebHookResponse(
        id=webhook.id,
        url=webhook.url,
        types=webhook.types.split(",") if webhook.types else [],
        events=webhook.events.split(",") if webhook.events else [],
        description=webhook.description,
        status=webhook.status,
        failure_count=webhook.failure_count,
        last_triggered_at=webhook.last_triggered_at,
        last_success_at=webhook.last_success_at,
        last_failure_at=webhook.last_failure_at,
        next_retry_at=webhook.next_retry_at,
        created_at=webhook.created_at,
        updated_at=webhook.updated_at,
    )


@router_webhook.post(
    "/webhooks",
    status_code=status.HTTP_201_CREATED,
    summary="创建 WebHook",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_400_BAD_REQUEST: BAD_REQUEST_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def create_webhook_api(
    webhook_data: WebHookCreate,
    db: DbSession,
    _maintenance_user: MaintenanceUserDep,
) -> WebHookResponse:
    """创建新的WebHook"""
    try:
        supported_types = ["acs"]
        invalid_types = [item for item in webhook_data.types if item not in supported_types]
        if invalid_types:
            raise SyncError(
                status_code=status.HTTP_400_BAD_REQUEST,
                error_name=SyncErrorCode.WEBHOOK_INVALID_TYPES,
                error_msg=f"Unsupported data types: {invalid_types}. Supported types: {supported_types}",
                input_params={
                    "types": webhook_data.types,
                    "invalid_types": invalid_types,
                },
            )

        supported_events = [
            "data_change",
            "retention_cleanup",
            "service_maintenance",
            "service_healthy",
        ]
        invalid_events = [item for item in webhook_data.events if item not in supported_events]
        if invalid_events:
            raise SyncError(
                status_code=status.HTTP_400_BAD_REQUEST,
                error_name=SyncErrorCode.WEBHOOK_INVALID_EVENTS,
                error_msg=f"Unsupported event types: {invalid_events}. Supported events: {supported_events}",
                input_params={
                    "events": webhook_data.events,
                    "invalid_events": invalid_events,
                },
            )

        webhook = await create_webhook_async(
            session=db,
            url=webhook_data.url,
            secret=webhook_data.secret,
            types=webhook_data.types,
            events=webhook_data.events,
            description=webhook_data.description,
        )

        return _to_webhook_response(webhook)

    except SyncError:
        raise


@router_webhook.get(
    "/webhooks/{id}",
    status_code=status.HTTP_200_OK,
    summary="获取 WebHook 详情",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def get_webhook_api(id: str, db: DbSession, _maintenance_user: MaintenanceUserDep) -> WebHookResponse:  # noqa: A002
    """获取指定WebHook的信息"""
    try:
        webhook = await get_webhook_async(db, webhook_id=id)
        return _to_webhook_response(webhook)

    except SyncError:
        raise


@router_webhook.put(
    "/webhooks/{id}",
    status_code=status.HTTP_200_OK,
    summary="更新 WebHook",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_400_BAD_REQUEST: BAD_REQUEST_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def update_webhook_api(
    id: str,  # noqa: A002
    webhook_update: WebHookUpdate,
    db: DbSession,
    _maintenance_user: MaintenanceUserDep,
) -> WebHookResponse:
    """更新指定WebHook的配置"""
    try:
        if webhook_update.types is not None:
            supported_types = ["acs"]
            invalid_types = [item for item in webhook_update.types if item not in supported_types]
            if invalid_types:
                raise SyncError(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    error_name=SyncErrorCode.WEBHOOK_INVALID_TYPES,
                    error_msg=f"Unsupported data types: {invalid_types}. Supported types: {supported_types}",
                    input_params={
                        "types": webhook_update.types,
                        "invalid_types": invalid_types,
                    },
                )

        if webhook_update.events is not None:
            supported_events = [
                "data_change",
                "retention_cleanup",
                "service_maintenance",
                "service_healthy",
            ]
            invalid_events = [item for item in webhook_update.events if item not in supported_events]
            if invalid_events:
                raise SyncError(
                    status_code=status.HTTP_400_BAD_REQUEST,
                    error_name=SyncErrorCode.WEBHOOK_INVALID_EVENTS,
                    error_msg=f"Unsupported event types: {invalid_events}. Supported events: {supported_events}",
                    input_params={
                        "events": webhook_update.events,
                        "invalid_events": invalid_events,
                    },
                )

        webhook = await update_webhook_async(
            session=db,
            webhook_id=id,
            url=webhook_update.url,
            secret=webhook_update.secret,
            types=webhook_update.types,
            events=webhook_update.events,
            description=webhook_update.description,
        )

        return _to_webhook_response(webhook)

    except SyncError:
        raise


@router_webhook.delete(
    "/webhooks/{id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除 WebHook",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def delete_webhook_api(id: str, db: DbSession, _maintenance_user: MaintenanceUserDep) -> Response:  # noqa: A002
    """删除指定的WebHook"""
    try:
        success = await delete_webhook_async(db, webhook_id=id)
        if success:
            return Response(status_code=status.HTTP_204_NO_CONTENT)
        raise SyncError(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            error_name=SyncErrorCode.WEBHOOK_DELETE_FAILED,
            error_msg=f"Failed to delete webhook {id}",
            input_params={"id": id},
        )

    except SyncError:
        raise


@router_webhook.post(
    "/webhooks/{id}/reactivate",
    status_code=status.HTTP_200_OK,
    summary="重新激活 WebHook",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def reactivate_webhook_api(id: str, db: DbSession, _maintenance_user: MaintenanceUserDep) -> WebHookResponse:  # noqa: A002
    """重新激活失败的WebHook"""
    try:
        webhook = await reactivate_webhook_async(db, webhook_id=id)
        return _to_webhook_response(webhook)

    except SyncError:
        raise


@router_webhook.get(
    "/webhooks",
    status_code=status.HTTP_200_OK,
    summary="获取 WebHook 列表",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def list_webhooks_api(
    db: DbSession,
    _maintenance_user: MaintenanceUserDep,
    page_num: Annotated[int, Query(description="页码")] = 1,
    page_size: Annotated[int, Query(description="每页数量")] = 10,
    status_filter: Annotated[str | None, Query(description="状态过滤")] = None,
) -> WebHookListResponse:
    """获取WebHook列表"""
    try:
        webhooks, total = await get_webhook_list_async(
            session=db,
            page_num=page_num,
            page_size=page_size,
            status_filter=status_filter,
        )

        return WebHookListResponse(
            items=[_to_webhook_response(webhook) for webhook in webhooks],
            total=total,
            page_num=page_num,
            page_size=page_size,
            pages=(total + page_size - 1) // page_size,
        )

    except SyncError:
        raise
