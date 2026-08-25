"""Group ACL management routes."""

from __future__ import annotations

from typing import Annotated, Any

import structlog
from fastapi import APIRouter, Depends, Request, Response, status

from app.api.group_problem import GroupApiError
from app.core.validation import validate_aic_format, validate_group_id_format
from app.dependencies import get_group_acl_service
from app.services.group_acl import GroupAclService

logger = structlog.get_logger()

GROUP_PROBLEM_RESPONSES: dict[int | str, dict[str, Any]] = {
    403: {
        "description": "Caller certificate CN does not match the leader route parameter.",
        "content": {
            "application/problem+json": {
                "example": {
                    "type": "about:blank",
                    "status": 403,
                    "code": "LEADER_AIC_MISMATCH",
                    "title": "Forbidden",
                    "detail": "caller AIC must match leader_aic in the route path",
                    "instance": "/groups/{leader_aic}/{group_id}",
                }
            }
        },
    },
    422: {
        "description": "One or more path parameters are invalid.",
        "content": {
            "application/problem+json": {
                "example": {
                    "type": "about:blank",
                    "status": 422,
                    "code": "INVALID_GROUP_ID",
                    "title": "Invalid group ID",
                    "detail": "group_id must contain only allowed characters",
                    "instance": "/groups/{leader_aic}/{group_id}",
                }
            }
        },
    },
}


def require_group_client_aic(request: Request) -> str:
    """Resolve the caller AIC from the peer certificate common name."""

    common_name = getattr(request.state, "peer_common_name", None)
    if not isinstance(common_name, str) or not validate_aic_format(common_name):
        raise GroupApiError(
            status_code=status.HTTP_403_FORBIDDEN,
            code="CLIENT_CERTIFICATE_REQUIRED",
            title="Client certificate required",
            detail="a valid client certificate common name is required",
        )
    return common_name


def validate_group_path(leader_aic: str, group_id: str, member_aic: str | None = None) -> None:
    """Validate Group route path parameters."""

    if not validate_aic_format(leader_aic):
        raise GroupApiError(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            code="INVALID_LEADER_AIC",
            title="Invalid leader AIC",
            detail="leader_aic must be a valid AIC string",
        )
    if member_aic is not None and not validate_aic_format(member_aic):
        raise GroupApiError(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            code="INVALID_MEMBER_AIC",
            title="Invalid member AIC",
            detail="member_aic must be a valid AIC string",
        )
    if not validate_group_id_format(group_id):
        raise GroupApiError(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            code="INVALID_GROUP_ID",
            title="Invalid group ID",
            detail="group_id must contain only allowed characters",
        )


def ensure_group_leader_access(
    *,
    caller_aic: str,
    leader_aic: str,
    action: str,
    group_id: str,
    member_aic: str | None = None,
) -> None:
    """Ensure the caller matches the leader in the route path."""

    if caller_aic == leader_aic:
        return
    logger.warning(
        "group_acl_forbidden",
        action=action,
        caller_aic=caller_aic,
        leader_aic=leader_aic,
        group_id=group_id,
        member_aic=member_aic,
    )
    raise GroupApiError(
        status_code=status.HTTP_403_FORBIDDEN,
        code="LEADER_AIC_MISMATCH",
        title="Forbidden",
        detail="caller AIC must match leader_aic in the route path",
    )


router = APIRouter(
    prefix="/groups",
    tags=["group-acl"],
)


@router.put(
    "/{leader_aic}/{group_id}/members/{member_aic}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="添加群组成员",
    response_description="Group member added successfully.",
    responses=GROUP_PROBLEM_RESPONSES,
)
async def add_group_member(
    leader_aic: str,
    group_id: str,
    member_aic: str,
    caller_aic: Annotated[str, Depends(require_group_client_aic)],
    group_acl_service: Annotated[GroupAclService, Depends(get_group_acl_service)],
) -> Response:
    validate_group_path(leader_aic, group_id, member_aic)
    ensure_group_leader_access(
        caller_aic=caller_aic,
        leader_aic=leader_aic,
        action="add-member",
        group_id=group_id,
        member_aic=member_aic,
    )
    logger.info(
        "group_acl_request",
        action="add-member",
        leader_aic=leader_aic,
        group_id=group_id,
        member_aic=member_aic,
    )
    await group_acl_service.add_member(leader_aic, group_id, member_aic)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{leader_aic}/{group_id}/members/{member_aic}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="移除群组成员",
    response_description="Group member removed successfully.",
    responses=GROUP_PROBLEM_RESPONSES,
)
async def remove_group_member(
    leader_aic: str,
    group_id: str,
    member_aic: str,
    caller_aic: Annotated[str, Depends(require_group_client_aic)],
    group_acl_service: Annotated[GroupAclService, Depends(get_group_acl_service)],
) -> Response:
    validate_group_path(leader_aic, group_id, member_aic)
    ensure_group_leader_access(
        caller_aic=caller_aic,
        leader_aic=leader_aic,
        action="remove-member",
        group_id=group_id,
        member_aic=member_aic,
    )
    logger.info(
        "group_acl_request",
        action="remove-member",
        leader_aic=leader_aic,
        group_id=group_id,
        member_aic=member_aic,
    )
    await group_acl_service.remove_member(leader_aic, group_id, member_aic)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{leader_aic}/{group_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="删除整个群组 ACL",
    response_description="Group ACL deleted successfully.",
    responses=GROUP_PROBLEM_RESPONSES,
)
async def delete_group(
    leader_aic: str,
    group_id: str,
    caller_aic: Annotated[str, Depends(require_group_client_aic)],
    group_acl_service: Annotated[GroupAclService, Depends(get_group_acl_service)],
) -> Response:
    validate_group_path(leader_aic, group_id)
    ensure_group_leader_access(
        caller_aic=caller_aic,
        leader_aic=leader_aic,
        action="delete-group",
        group_id=group_id,
    )
    logger.info(
        "group_acl_request",
        action="delete-group",
        leader_aic=leader_aic,
        group_id=group_id,
    )
    await group_acl_service.delete_group(leader_aic, group_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete(
    "/{leader_aic}/{group_id}/members/{member_aic}/connection",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="断开成员连接",
    response_description="Member connections closed successfully.",
    responses=GROUP_PROBLEM_RESPONSES,
)
async def close_member_connection(
    leader_aic: str,
    group_id: str,
    member_aic: str,
    caller_aic: Annotated[str, Depends(require_group_client_aic)],
    group_acl_service: Annotated[GroupAclService, Depends(get_group_acl_service)],
) -> Response:
    validate_group_path(leader_aic, group_id, member_aic)
    ensure_group_leader_access(
        caller_aic=caller_aic,
        leader_aic=leader_aic,
        action="close-connection",
        group_id=group_id,
        member_aic=member_aic,
    )
    logger.info(
        "group_acl_request",
        action="close-connection",
        leader_aic=leader_aic,
        group_id=group_id,
        member_aic=member_aic,
    )
    await group_acl_service.close_member_connections(leader_aic, member_aic)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
