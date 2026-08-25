"""RabbitMQ HTTP auth backend routes."""

from __future__ import annotations

from typing import Annotated, Any
from urllib.parse import parse_qs

import structlog
from fastapi import APIRouter, Depends, Request
from fastapi.responses import PlainTextResponse

from app.dependencies import get_authz_service
from app.services.authz import AuthDecision, AuthorizationService

logger = structlog.get_logger()

AUTH_DECISION_RESPONSE: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "RabbitMQ auth decision returned as plain text.",
        "content": {
            "text/plain": {
                "examples": {
                    "allow": {"summary": "Allow request", "value": "allow"},
                    "deny": {"summary": "Deny request", "value": "deny"},
                }
            }
        },
    }
}

router = APIRouter(
    prefix="/auth",
    tags=["rabbitmq-auth"],
)


def _read_form_value(data: dict[str, list[str]], key: str) -> str:
    values = data.get(key, [])
    if not values:
        return ""
    return values[-1]


async def _parse_form_payload(request: Request) -> dict[str, list[str]]:
    body = await request.body()
    parsed = parse_qs(body.decode("utf-8"), keep_blank_values=True)
    return {key: value for key, value in parsed.items() if value}


def _log_auth_decision(endpoint: str, decision: AuthDecision, **fields: str) -> None:
    log_fn = logger.debug if decision == AuthDecision.ALLOW else logger.warning
    log_fn("rabbitmq_auth_decision", endpoint=endpoint, decision=decision.value, **fields)


@router.post(
    "/user",
    response_class=PlainTextResponse,
    summary="校验用户身份",
    response_description="Plain text allow/deny decision.",
    responses=AUTH_DECISION_RESPONSE,
)
async def auth_user(
    request: Request,
    authz_service: Annotated[AuthorizationService, Depends(get_authz_service)],
) -> PlainTextResponse:
    form_data = await _parse_form_payload(request)
    username = _read_form_value(form_data, "username")
    decision = await authz_service.check_user(username)
    _log_auth_decision("user", decision, username=username)
    return PlainTextResponse(decision.value)


@router.post(
    "/vhost",
    response_class=PlainTextResponse,
    summary="校验虚拟主机访问权限",
    response_description="Plain text allow/deny decision.",
    responses=AUTH_DECISION_RESPONSE,
)
async def auth_vhost(
    request: Request,
    authz_service: Annotated[AuthorizationService, Depends(get_authz_service)],
) -> PlainTextResponse:
    form_data = await _parse_form_payload(request)
    username = _read_form_value(form_data, "username")
    vhost = _read_form_value(form_data, "vhost")
    decision = await authz_service.check_vhost(username, vhost)
    _log_auth_decision("vhost", decision, username=username, vhost=vhost)
    return PlainTextResponse(decision.value)


@router.post(
    "/resource",
    response_class=PlainTextResponse,
    summary="校验 Exchange 或 Queue 权限",
    response_description="Plain text allow/deny decision.",
    responses=AUTH_DECISION_RESPONSE,
)
async def auth_resource(
    request: Request,
    authz_service: Annotated[AuthorizationService, Depends(get_authz_service)],
) -> PlainTextResponse:
    form_data = await _parse_form_payload(request)
    username = _read_form_value(form_data, "username")
    vhost = _read_form_value(form_data, "vhost")
    resource = _read_form_value(form_data, "resource")
    name = _read_form_value(form_data, "name")
    permission = _read_form_value(form_data, "permission")
    decision = await authz_service.check_resource(
        username=username,
        vhost=vhost,
        resource=resource,
        name=name,
        permission=permission,
    )
    _log_auth_decision(
        "resource",
        decision,
        username=username,
        vhost=vhost,
        resource=resource,
        name=name,
        permission=permission,
    )
    return PlainTextResponse(decision.value)


@router.post(
    "/topic",
    response_class=PlainTextResponse,
    summary="校验 Topic 路由权限",
    response_description="Plain text allow/deny decision.",
    responses=AUTH_DECISION_RESPONSE,
)
async def auth_topic(
    request: Request,
    authz_service: Annotated[AuthorizationService, Depends(get_authz_service)],
) -> PlainTextResponse:
    form_data = await _parse_form_payload(request)
    username = _read_form_value(form_data, "username")
    vhost = _read_form_value(form_data, "vhost")
    resource = _read_form_value(form_data, "resource")
    name = _read_form_value(form_data, "name")
    permission = _read_form_value(form_data, "permission")
    routing_key = _read_form_value(form_data, "routing_key")
    decision = await authz_service.check_topic(
        username=username,
        vhost=vhost,
        resource=resource,
        name=name,
        permission=permission,
        routing_key=routing_key,
    )
    _log_auth_decision(
        "topic",
        decision,
        username=username,
        vhost=vhost,
        resource=resource,
        name=name,
        permission=permission,
        routing_key=routing_key,
    )
    return PlainTextResponse(decision.value)
