"""CA Server 管理面与内部服务认证依赖。"""

from __future__ import annotations

import secrets
from collections.abc import Sequence

from fastapi import Depends, Header

from app.core.base_exception import AppError
from app.core.config import Settings, get_settings


def _missing_token_error(scope_name: str) -> AppError:
    """返回认证配置缺失错误。"""
    return AppError(
        code="AUTHENTICATION_NOT_CONFIGURED",
        title="Authentication not configured",
        detail=f"{scope_name} authentication is not configured.",
        status_code=503,
    )


def _invalid_token_error() -> AppError:
    """返回 Bearer token 校验失败错误。"""
    return AppError(
        code="AUTHENTICATION_FAILED",
        title="Authentication failed",
        detail="Missing or invalid bearer token.",
        status_code=401,
    )


def _extract_bearer_token(authorization: str | None) -> str | None:
    """从 Authorization 头提取 Bearer token。"""
    if not authorization:
        return None

    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token.strip():
        return None

    return token.strip()


def _authenticate_bearer_token(
    authorization: str | None,
    expected_tokens: Sequence[str],
    *,
    scope_name: str,
) -> None:
    """校验 Authorization 头中的 Bearer token。"""
    configured_tokens = [token for token in expected_tokens if token]
    if not configured_tokens:
        raise _missing_token_error(scope_name)

    provided_token = _extract_bearer_token(authorization)
    if provided_token is None:
        raise _invalid_token_error()

    if not any(secrets.compare_digest(provided_token, configured_token) for configured_token in configured_tokens):
        raise _invalid_token_error()


async def require_internal_service_auth(
    authorization: str | None = Header(default=None, alias="Authorization"),
    settings: Settings = Depends(get_settings),
) -> None:
    """要求调用方提供内部服务 Bearer token。"""
    _authenticate_bearer_token(
        authorization,
        [
            settings.ca_server_internal_api_token,
            settings.registry_server_internal_api_token,
        ],
        scope_name="Internal service",
    )


async def require_admin_auth(
    authorization: str | None = Header(default=None, alias="Authorization"),
    settings: Settings = Depends(get_settings),
) -> None:
    """要求调用方提供管理员 Bearer token。"""
    _authenticate_bearer_token(
        authorization,
        [settings.ca_server_admin_api_token],
        scope_name="Admin",
    )


async def require_admin_or_internal_auth(
    authorization: str | None = Header(default=None, alias="Authorization"),
    settings: Settings = Depends(get_settings),
) -> None:
    """允许管理员或内部服务 Bearer token。"""
    _authenticate_bearer_token(
        authorization,
        [
            settings.ca_server_admin_api_token,
            settings.ca_server_internal_api_token,
            settings.registry_server_internal_api_token,
        ],
        scope_name="Admin or internal service",
    )
