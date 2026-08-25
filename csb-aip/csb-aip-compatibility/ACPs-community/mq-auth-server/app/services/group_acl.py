"""Redis-backed group ACL storage and business logic."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

import structlog
from cachetools import TTLCache
from redis import asyncio as redis_asyncio
from redis.exceptions import RedisError

from app.core.validation import validate_aic_format, validate_group_id_format

logger = structlog.get_logger()


class StoreUnavailableError(RuntimeError):
    """Raised when Redis is unavailable and the request should fall back or deny."""


class GroupAclStore(Protocol):
    """Async storage contract used by the ACL service."""

    async def ping(self) -> bool: ...

    async def sismember(self, key: str, member: str) -> bool: ...

    async def smembers(self, key: str) -> set[str]: ...

    async def sadd(self, key: str, member: str) -> None: ...

    async def srem(self, key: str, member: str) -> None: ...

    async def delete(self, key: str) -> None: ...

    async def expire(self, key: str, ttl_seconds: int) -> None: ...

    async def aclose(self) -> None: ...


class ConnectionManagementClient(Protocol):
    """Management API contract used by the ACL service."""

    async def delete_connections_by_username(self, *, username: str, reason: str) -> None: ...

    async def aclose(self) -> None: ...


class RedisGroupAclStore:
    """Redis implementation of the group ACL store."""

    def __init__(
        self,
        redis_url: str,
        *,
        tls_ca_cert: str | None,
        tls_check_hostname: bool,
    ) -> None:
        is_tls = redis_url.lower().startswith("rediss://")
        logger.info(
            "redis_group_acl_store_init",
            tls_enabled=is_tls,
            tls_check_hostname=tls_check_hostname,
        )
        redis_kwargs: dict[str, Any] = {
            "decode_responses": True,
            "encoding": "utf-8",
        }
        if is_tls:
            redis_kwargs["ssl_ca_certs"] = tls_ca_cert
            redis_kwargs["ssl_cert_reqs"] = "required"
            redis_kwargs["ssl_check_hostname"] = tls_check_hostname
        self._client: Any = redis_asyncio.from_url(redis_url, **redis_kwargs)

    async def ping(self) -> bool:
        try:
            return bool(await self._client.ping())
        except RedisError:
            return False

    async def sismember(self, key: str, member: str) -> bool:
        try:
            return bool(await self._client.sismember(key, member))
        except RedisError as exc:
            raise StoreUnavailableError from exc

    async def smembers(self, key: str) -> set[str]:
        try:
            values = await self._client.smembers(key)
        except RedisError as exc:
            raise StoreUnavailableError from exc
        return {value for value in values if isinstance(value, str)}

    async def sadd(self, key: str, member: str) -> None:
        try:
            await self._client.sadd(key, member)
        except RedisError as exc:
            raise StoreUnavailableError from exc

    async def srem(self, key: str, member: str) -> None:
        try:
            await self._client.srem(key, member)
        except RedisError as exc:
            raise StoreUnavailableError from exc

    async def delete(self, key: str) -> None:
        try:
            await self._client.delete(key)
        except RedisError as exc:
            raise StoreUnavailableError from exc

    async def expire(self, key: str, ttl_seconds: int) -> None:
        try:
            await self._client.expire(key, ttl_seconds)
        except RedisError as exc:
            raise StoreUnavailableError from exc

    async def aclose(self) -> None:
        await self._client.aclose()


@dataclass
class GroupAclService:
    """Business logic for group ACL membership, fallback cache, and connection closure."""

    store: GroupAclStore
    management_client: ConnectionManagementClient
    local_cache: TTLCache[str, frozenset[str]]
    key_ttl_seconds: int

    @staticmethod
    def build_cache_key(leader_aic: str, group_id: str) -> str:
        return f"group_acl:{leader_aic}:{group_id}"

    def _cache_members(self, cache_key: str, members: set[str]) -> None:
        self.local_cache[cache_key] = frozenset(members)
        logger.debug(
            "group_acl_cache_update",
            cache_key=cache_key,
            member_count=len(members),
        )

    def _ensure_valid_identifiers(
        self,
        leader_aic: str,
        group_id: str,
        member_aic: str | None = None,
    ) -> None:
        if not validate_aic_format(leader_aic):
            raise ValueError("invalid leader AIC")
        if member_aic is not None and not validate_aic_format(member_aic):
            raise ValueError("invalid member AIC")
        if not validate_group_id_format(group_id):
            raise ValueError("invalid group-id")

    async def add_member(self, leader_aic: str, group_id: str, member_aic: str) -> None:
        self._ensure_valid_identifiers(leader_aic, group_id, member_aic)
        cache_key = self.build_cache_key(leader_aic, group_id)
        logger.info(
            "group_acl_add_member",
            leader_aic=leader_aic,
            group_id=group_id,
            member_aic=member_aic,
        )
        await self.store.sadd(cache_key, member_aic)
        await self.store.expire(cache_key, self.key_ttl_seconds)
        cached_members = set(self.local_cache.get(cache_key, frozenset()))
        cached_members.add(member_aic)
        self._cache_members(cache_key, cached_members)

    async def remove_member(self, leader_aic: str, group_id: str, member_aic: str) -> None:
        self._ensure_valid_identifiers(leader_aic, group_id, member_aic)
        cache_key = self.build_cache_key(leader_aic, group_id)
        logger.info(
            "group_acl_remove_member",
            leader_aic=leader_aic,
            group_id=group_id,
            member_aic=member_aic,
        )
        await self.store.srem(cache_key, member_aic)
        await self.store.expire(cache_key, self.key_ttl_seconds)
        cached_members = set(self.local_cache.get(cache_key, frozenset()))
        cached_members.discard(member_aic)
        if cached_members:
            self._cache_members(cache_key, cached_members)
        else:
            self.local_cache.pop(cache_key, None)

    async def delete_group(self, leader_aic: str, group_id: str) -> None:
        self._ensure_valid_identifiers(leader_aic, group_id)
        cache_key = self.build_cache_key(leader_aic, group_id)
        logger.info(
            "group_acl_delete_group",
            leader_aic=leader_aic,
            group_id=group_id,
        )
        await self.store.delete(cache_key)
        self.local_cache.pop(cache_key, None)

    async def close_member_connections(self, leader_aic: str, member_aic: str) -> None:
        if not validate_aic_format(leader_aic):
            raise ValueError("invalid leader AIC")
        if not validate_aic_format(member_aic):
            raise ValueError("invalid member AIC")
        logger.info(
            "group_acl_close_connections",
            leader_aic=leader_aic,
            member_aic=member_aic,
        )
        await self.management_client.delete_connections_by_username(
            username=member_aic,
            reason=f"Removed from group by leader {leader_aic}",
        )

    async def check_group_membership(
        self,
        leader_aic: str,
        group_id: str,
        requester_aic: str,
    ) -> bool:
        self._ensure_valid_identifiers(leader_aic, group_id, requester_aic)
        cache_key = self.build_cache_key(leader_aic, group_id)
        try:
            is_member = await self.store.sismember(cache_key, requester_aic)
            if cache_key not in self.local_cache:
                try:
                    members = await self.store.smembers(cache_key)
                except StoreUnavailableError:
                    logger.warning(
                        "group_acl_store_degraded",
                        cache_key=cache_key,
                        requester_aic=requester_aic,
                        membership=is_member,
                        source="redis-sismember-only",
                    )
                    return is_member
                self._cache_members(cache_key, members)
            logger.debug(
                "group_acl_membership_check",
                cache_key=cache_key,
                requester_aic=requester_aic,
                membership=is_member,
                source="redis",
            )
            return is_member
        except StoreUnavailableError:
            cached_members = self.local_cache.get(cache_key)
            if cached_members is None:
                logger.warning(
                    "group_acl_membership_fallback",
                    cache_key=cache_key,
                    requester_aic=requester_aic,
                    membership=False,
                    source="empty-cache",
                )
                return False
            logger.warning(
                "group_acl_membership_fallback",
                cache_key=cache_key,
                requester_aic=requester_aic,
                membership=requester_aic in cached_members,
                source="local-cache",
            )
            return requester_aic in cached_members

    async def aclose(self) -> None:
        logger.info("group_acl_service_close")
        await self.store.aclose()
        await self.management_client.aclose()
