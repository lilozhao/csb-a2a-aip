"""RabbitMQ HTTP auth backend decision logic."""

from __future__ import annotations

from enum import StrEnum
from typing import NamedTuple

import structlog

from app.core.validation import validate_aic_format, validate_group_id_format
from app.services.group_acl import GroupAclService

logger = structlog.get_logger()


class AuthDecision(StrEnum):
    """Allowed RabbitMQ HTTP backend decisions."""

    ALLOW = "allow"
    DENY = "deny"
    REFUSE = "refuse"


class GroupExchangeName(NamedTuple):
    leader_aic: str
    group_id: str


class GroupQueueName(NamedTuple):
    leader_aic: str
    group_id: str
    member_aic: str


def _parse_inbox_queue(name: str) -> str | None:
    if not name.startswith("inbox_"):
        return None
    target_aic = name.removeprefix("inbox_")
    if validate_aic_format(target_aic):
        return target_aic
    return None


def _parse_group_exchange(name: str) -> GroupExchangeName | None:
    parts = name.split("_")
    if len(parts) != 3 or parts[0] != "group":
        return None
    leader_aic, group_id = parts[1], parts[2]
    if not validate_aic_format(leader_aic):
        return None
    if not validate_group_id_format(group_id):
        return None
    return GroupExchangeName(leader_aic=leader_aic, group_id=group_id)


def _parse_group_queue(name: str) -> GroupQueueName | None:
    parts = name.split("_")
    if len(parts) != 4 or parts[0] != "group":
        return None
    leader_aic, group_id, member_aic = parts[1], parts[2], parts[3]
    if not validate_aic_format(leader_aic):
        return None
    if not validate_group_id_format(group_id):
        return None
    if not validate_aic_format(member_aic):
        return None
    return GroupQueueName(
        leader_aic=leader_aic,
        group_id=group_id,
        member_aic=member_aic,
    )


class AuthorizationService:
    """Decision engine used by RabbitMQ HTTP auth backend routes."""

    def __init__(self, group_acl_service: GroupAclService) -> None:
        self._group_acl_service = group_acl_service

    @staticmethod
    def _log_decision(scope: str, decision: AuthDecision, **fields: str) -> AuthDecision:
        log_fn = logger.info if decision == AuthDecision.ALLOW else logger.warning
        log_fn("authz_decision", scope=scope, decision=decision.value, **fields)
        return decision

    async def check_user(self, username: str) -> AuthDecision:
        if validate_aic_format(username):
            return self._log_decision("user", AuthDecision.ALLOW, username=username)
        return self._log_decision("user", AuthDecision.DENY, username=username)

    async def check_vhost(self, username: str, vhost: str) -> AuthDecision:
        if not validate_aic_format(username):
            return self._log_decision(
                "vhost",
                AuthDecision.DENY,
                username=username,
                vhost=vhost,
                reason="invalid-aic",
            )
        if vhost == "acps":
            return self._log_decision(
                "vhost",
                AuthDecision.ALLOW,
                username=username,
                vhost=vhost,
            )
        return self._log_decision(
            "vhost",
            AuthDecision.DENY,
            username=username,
            vhost=vhost,
            reason="unsupported-vhost",
        )

    async def check_resource(
        self,
        *,
        username: str,
        vhost: str,
        resource: str,
        name: str,
        permission: str,
    ) -> AuthDecision:
        if not validate_aic_format(username):
            return self._log_decision(
                "resource",
                AuthDecision.DENY,
                username=username,
                resource=resource,
                name=name,
                permission=permission,
                reason="invalid-aic",
            )
        if vhost != "acps":
            return self._log_decision(
                "resource",
                AuthDecision.DENY,
                username=username,
                vhost=vhost,
                resource=resource,
                name=name,
                permission=permission,
                reason="unsupported-vhost",
            )
        if permission not in {"configure", "write", "read"}:
            return self._log_decision(
                "resource",
                AuthDecision.DENY,
                username=username,
                resource=resource,
                name=name,
                permission=permission,
                reason="unsupported-permission",
            )

        if resource == "exchange":
            return await self._check_exchange_permission(username, name, permission)
        if resource == "queue":
            return await self._check_queue_permission(username, name, permission)
        return self._log_decision(
            "resource",
            AuthDecision.DENY,
            username=username,
            resource=resource,
            name=name,
            permission=permission,
            reason="unsupported-resource",
        )

    async def _check_exchange_permission(
        self,
        username: str,
        name: str,
        permission: str,
    ) -> AuthDecision:
        if name == "amq.default":
            return self._log_decision(
                "exchange",
                AuthDecision.DENY,
                username=username,
                name=name,
                permission=permission,
                reason="blocked-default-exchange",
            )
        if name == "inbox.topic":
            return self._log_decision(
                "exchange",
                AuthDecision.ALLOW,
                username=username,
                name=name,
                permission=permission,
            )

        group_exchange = _parse_group_exchange(name)
        if group_exchange is None:
            return self._log_decision(
                "exchange",
                AuthDecision.DENY,
                username=username,
                name=name,
                permission=permission,
                reason="invalid-group-exchange",
            )
        if permission == "configure":
            if group_exchange.leader_aic == username:
                return self._log_decision(
                    "exchange",
                    AuthDecision.ALLOW,
                    username=username,
                    name=name,
                    permission=permission,
                    reason="leader-configure",
                )
            return self._log_decision(
                "exchange",
                AuthDecision.DENY,
                username=username,
                name=name,
                permission=permission,
                reason="configure-not-leader",
            )
        is_member = await self._group_acl_service.check_group_membership(
            group_exchange.leader_aic,
            group_exchange.group_id,
            username,
        )
        if is_member:
            return self._log_decision(
                "exchange",
                AuthDecision.ALLOW,
                username=username,
                name=name,
                permission=permission,
                leader_aic=group_exchange.leader_aic,
                group_id=group_exchange.group_id,
            )
        return self._log_decision(
            "exchange",
            AuthDecision.DENY,
            username=username,
            name=name,
            permission=permission,
            leader_aic=group_exchange.leader_aic,
            group_id=group_exchange.group_id,
            reason="not-group-member",
        )

    async def _check_queue_permission(
        self,
        username: str,
        name: str,
        permission: str,
    ) -> AuthDecision:
        inbox_owner = _parse_inbox_queue(name)
        if inbox_owner is not None:
            if inbox_owner == username:
                return self._log_decision(
                    "queue",
                    AuthDecision.ALLOW,
                    username=username,
                    name=name,
                    permission=permission,
                    reason="own-inbox",
                )
            return self._log_decision(
                "queue",
                AuthDecision.DENY,
                username=username,
                name=name,
                permission=permission,
                reason="foreign-inbox",
            )

        group_queue = _parse_group_queue(name)
        if group_queue is None:
            return self._log_decision(
                "queue",
                AuthDecision.DENY,
                username=username,
                name=name,
                permission=permission,
                reason="invalid-group-queue",
            )

        is_active_member = False
        if username == group_queue.member_aic:
            is_active_member = await self._group_acl_service.check_group_membership(
                group_queue.leader_aic,
                group_queue.group_id,
                username,
            )

        if permission in {"configure", "write"}:
            if username == group_queue.leader_aic:
                return self._log_decision(
                    "queue",
                    AuthDecision.ALLOW,
                    username=username,
                    name=name,
                    permission=permission,
                    leader_aic=group_queue.leader_aic,
                    member_aic=group_queue.member_aic,
                )
            if username == group_queue.member_aic and is_active_member:
                return self._log_decision(
                    "queue",
                    AuthDecision.ALLOW,
                    username=username,
                    name=name,
                    permission=permission,
                    leader_aic=group_queue.leader_aic,
                    member_aic=group_queue.member_aic,
                )
            return self._log_decision(
                "queue",
                AuthDecision.DENY,
                username=username,
                name=name,
                permission=permission,
                leader_aic=group_queue.leader_aic,
                member_aic=group_queue.member_aic,
                reason="not-active-queue-member",
            )
        if permission == "read":
            if username == group_queue.member_aic and is_active_member:
                return self._log_decision(
                    "queue",
                    AuthDecision.ALLOW,
                    username=username,
                    name=name,
                    permission=permission,
                    member_aic=group_queue.member_aic,
                )
            return self._log_decision(
                "queue",
                AuthDecision.DENY,
                username=username,
                name=name,
                permission=permission,
                member_aic=group_queue.member_aic,
                reason="read-not-active-member",
            )
        return self._log_decision(
            "queue",
            AuthDecision.DENY,
            username=username,
            name=name,
            permission=permission,
            member_aic=group_queue.member_aic,
            reason="read-not-member",
        )

    async def check_topic(
        self,
        *,
        username: str,
        vhost: str,
        resource: str,
        name: str,
        permission: str,
        routing_key: str,
    ) -> AuthDecision:
        if not validate_aic_format(username):
            return self._log_decision(
                "topic",
                AuthDecision.DENY,
                username=username,
                name=name,
                permission=permission,
                routing_key=routing_key,
                reason="invalid-aic",
            )
        if vhost != "acps" or resource != "topic":
            return self._log_decision(
                "topic",
                AuthDecision.DENY,
                username=username,
                vhost=vhost,
                resource=resource,
                name=name,
                permission=permission,
                routing_key=routing_key,
                reason="unsupported-scope",
            )
        if name != "inbox.topic":
            return self._log_decision(
                "topic",
                AuthDecision.DENY,
                username=username,
                name=name,
                permission=permission,
                routing_key=routing_key,
                reason="unsupported-exchange",
            )
        if permission == "read":
            if routing_key == f"inbox_{username}":
                return self._log_decision(
                    "topic",
                    AuthDecision.ALLOW,
                    username=username,
                    name=name,
                    permission=permission,
                    routing_key=routing_key,
                )
            return self._log_decision(
                "topic",
                AuthDecision.DENY,
                username=username,
                name=name,
                permission=permission,
                routing_key=routing_key,
                reason="foreign-inbox-routing-key",
            )
        if permission == "write" and _parse_inbox_queue(routing_key) is not None:
            return self._log_decision(
                "topic",
                AuthDecision.ALLOW,
                username=username,
                name=name,
                permission=permission,
                routing_key=routing_key,
            )
        return self._log_decision(
            "topic",
            AuthDecision.DENY,
            username=username,
            name=name,
            permission=permission,
            routing_key=routing_key,
            reason="invalid-routing-key",
        )
