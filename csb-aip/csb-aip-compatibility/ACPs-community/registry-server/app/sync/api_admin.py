from typing import Annotated

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.model import RoleType, User
from app.core.auth import check_user_role
from app.core.base_exception import PROBLEM_JSON_MEDIA_TYPE
from app.core.config import settings
from app.core.db_session import get_session
from app.sync.api_protocol import NOT_FOUND_RESPONSE, SERVER_ERROR_RESPONSE
from app.sync.exception import SyncError
from app.sync.schema import (
    ChangeLogCleanupResponse,
    ChangeLogListResponse,
    RetentionConfigResponse,
    SnapshotCleanupResponse,
    SnapshotInfo,
    SnapshotListResponse,
)
from app.sync.service import (
    cleanup_expired_snapshots_async,
    cleanup_old_changelog_entries_async,
    create_changelog_response,
    get_changelog_list_async,
    get_snapshot_info_async,
    get_snapshot_list_async,
    trigger_retention_cleanup_webhook,
)

router_admin = APIRouter()

DbSession = Annotated[AsyncSession, Depends(get_session)]
type MaintenanceUserDep = Annotated[User, Depends(check_user_role([RoleType.STAFF, RoleType.ADMIN]))]


def _problem_response(description: str) -> dict[str, object]:
    return {"description": description, "content": {PROBLEM_JSON_MEDIA_TYPE: {}}}


UNAUTHORIZED_RESPONSE = _problem_response("Authentication required")
FORBIDDEN_RESPONSE = _problem_response("Sync admin access denied")


@router_admin.get(
    "/admin/changelogs",
    status_code=status.HTTP_200_OK,
    summary="获取变更日志列表",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def list_changelogs(
    db: DbSession,
    _maintenance_user: MaintenanceUserDep,
    page_num: Annotated[int, Query(description="页码")] = 1,
    page_size: Annotated[int, Query(description="每页数量")] = 10,
    object_id: Annotated[str | None, Query(description="对象ID")] = None,
    data_type: Annotated[str | None, Query(description="数据类型")] = None,
) -> ChangeLogListResponse:
    """获取变更日志列表（管理员接口）"""
    try:
        change_logs, total = await get_changelog_list_async(
            session=db,
            page_num=page_num,
            page_size=page_size,
            object_id=object_id,
            data_type=data_type,
        )

        return ChangeLogListResponse(
            items=[create_changelog_response(log) for log in change_logs],
            total=total,
            page_num=page_num,
            page_size=page_size,
            pages=(total + page_size - 1) // page_size,
        )

    except SyncError:
        raise


@router_admin.get(
    "/admin/snapshots",
    status_code=status.HTTP_200_OK,
    summary="获取快照列表",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def list_snapshots_api(
    db: DbSession,
    _maintenance_user: MaintenanceUserDep,
    page_num: Annotated[int, Query(description="页码")] = 1,
    page_size: Annotated[int, Query(description="每页数量")] = 10,
    include_deleted: Annotated[bool, Query(description="是否包含已删除的快照")] = False,
) -> SnapshotListResponse:
    """获取快照列表（管理员接口）"""
    try:
        snapshots, total = await get_snapshot_list_async(
            db,
            page_num=page_num,
            page_size=page_size,
            include_deleted=include_deleted,
        )

        return SnapshotListResponse(
            items=[SnapshotInfo.model_validate(snapshot) for snapshot in snapshots],
            total=total,
            page_num=page_num,
            page_size=page_size,
            pages=(total + page_size - 1) // page_size,
        )

    except SyncError:
        raise


@router_admin.get(
    "/admin/snapshots/{id}",
    status_code=status.HTTP_200_OK,
    summary="获取快照详情",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_404_NOT_FOUND: NOT_FOUND_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def get_snapshot_info_api(id: str, db: DbSession, _maintenance_user: MaintenanceUserDep) -> SnapshotInfo:  # noqa: A002
    """获取快照信息（管理员接口）"""
    try:
        return await get_snapshot_info_async(db, snapshot_id=id)
    except SyncError:
        raise


@router_admin.post(
    "/admin/snapshots/cleanup",
    status_code=status.HTTP_200_OK,
    summary="清理过期快照",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def cleanup_snapshots_api(db: DbSession, _maintenance_user: MaintenanceUserDep) -> SnapshotCleanupResponse:
    """清理过期快照（管理员接口）"""
    try:
        cleaned_count = await cleanup_expired_snapshots_async(db)
        return SnapshotCleanupResponse(cleaned_count=cleaned_count)
    except SyncError:
        raise


@router_admin.post(
    "/admin/changelogs/cleanup",
    status_code=status.HTTP_200_OK,
    summary="清理旧变更日志",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_500_INTERNAL_SERVER_ERROR: SERVER_ERROR_RESPONSE,
    },
)
async def cleanup_changelogs_api(db: DbSession, _maintenance_user: MaintenanceUserDep) -> ChangeLogCleanupResponse:
    """根据retention配置清理旧的ChangeLog记录（管理员接口）"""
    try:
        cleaned_count = await cleanup_old_changelog_entries_async(
            session=db,
            window_hours=settings.dsp_retention_window_hours,
            max_records=settings.dsp_retention_max_records,
        )
        await db.commit()

        if cleaned_count > 0:
            await db.run_sync(
                lambda sync_session: trigger_retention_cleanup_webhook(
                    db=sync_session,
                    cleaned_count=cleaned_count,
                    window_hours=settings.dsp_retention_window_hours,
                    max_records=settings.dsp_retention_max_records,
                )
            )

        return ChangeLogCleanupResponse(
            cleaned_count=cleaned_count,
            retention_config=RetentionConfigResponse(
                window_hours=settings.dsp_retention_window_hours,
                max_records=settings.dsp_retention_max_records,
            ),
        )
    except SyncError:
        raise
