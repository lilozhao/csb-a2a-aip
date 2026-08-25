"""Shared FastAPI dependencies."""

from __future__ import annotations

from collections.abc import Callable

from fastapi import HTTPException, Request, status

from app.core.config import Settings
from app.core.validation import validate_aic_format, validate_group_id_format
from app.services.authz import AuthorizationService
from app.services.group_acl import GroupAclService


def get_settings(request: Request) -> Settings:
    return request.app.state.settings  # type: ignore[no-any-return]


def get_authz_service(request: Request) -> AuthorizationService:
    return request.app.state.authz_service  # type: ignore[no-any-return]


def get_group_acl_service(request: Request) -> GroupAclService:
    return request.app.state.group_acl_service  # type: ignore[no-any-return]


def require_listener_port(
    expected_port_getter: Callable[[Settings], int],
) -> Callable[[Request], None]:
    """Ensure a route is only reachable through the intended listener."""

    def _dependency(request: Request) -> None:
        settings = get_settings(request)
        server = request.scope.get("server")
        if not isinstance(server, tuple) or len(server) != 2:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)
        if int(server[1]) != expected_port_getter(settings):
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)

    return _dependency


def require_client_aic(request: Request) -> str:
    """Resolve the caller AIC from the peer certificate common name."""

    common_name = getattr(request.state, "peer_common_name", None)
    if not isinstance(common_name, str) or not validate_aic_format(common_name):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="valid client certificate common name required",
        )
    return common_name


def validate_group_path(leader_aic: str, group_id: str, member_aic: str | None = None) -> None:
    """Validate path parameters shared across group ACL routes."""

    if not validate_aic_format(leader_aic):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="invalid leader AIC",
        )
    if member_aic is not None and not validate_aic_format(member_aic):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="invalid member AIC",
        )
    if not validate_group_id_format(group_id):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            detail="invalid group-id",
        )
