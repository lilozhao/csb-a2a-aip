"""GroupAclService 业务逻辑的单元测试。

完全隔离 Redis（使用 InMemoryGroupAclStore），覆盖：
- add_member / remove_member / delete_group
- close_member_connections
- check_group_membership（Redis 路径 + 本地缓存降级路径）
- _ensure_valid_identifiers 校验
- aclose 生命周期
"""

from __future__ import annotations

import pytest
from cachetools import TTLCache

from app.services.group_acl import GroupAclService
from tests.conftest import (
    VALID_GROUP_ID,
    VALID_LEADER_AIC,
    VALID_MEMBER_AIC,
    VALID_OTHER_AIC,
    FakeRabbitMqManagementClient,
    InMemoryGroupAclStore,
)

KEY_TTL = 7 * 24 * 60 * 60  # 7 天，与生产配置一致


def make_service(
    store: InMemoryGroupAclStore | None = None,
    management_client: FakeRabbitMqManagementClient | None = None,
) -> tuple[GroupAclService, InMemoryGroupAclStore, FakeRabbitMqManagementClient]:
    """创建 GroupAclService 及其依赖的测试辅助函数。"""
    resolved_store = store or InMemoryGroupAclStore()
    resolved_mgmt = management_client or FakeRabbitMqManagementClient()
    service = GroupAclService(
        store=resolved_store,
        management_client=resolved_mgmt,
        local_cache=TTLCache(maxsize=128, ttl=30),
        key_ttl_seconds=KEY_TTL,
    )
    return service, resolved_store, resolved_mgmt


class TestBuildCacheKey:
    """build_cache_key 静态方法。"""

    def test_format_matches_expected_pattern(self) -> None:
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        assert key == f"group_acl:{VALID_LEADER_AIC}:{VALID_GROUP_ID}"

    def test_different_leaders_produce_different_keys(self) -> None:
        key1 = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        key2 = GroupAclService.build_cache_key(VALID_MEMBER_AIC, VALID_GROUP_ID)
        assert key1 != key2

    def test_different_group_ids_produce_different_keys(self) -> None:
        key1 = GroupAclService.build_cache_key(VALID_LEADER_AIC, "group-alpha-001")
        key2 = GroupAclService.build_cache_key(VALID_LEADER_AIC, "group-beta-002")
        assert key1 != key2


class TestAddMember:
    """add_member — 写入 store、更新本地缓存、设置 TTL。"""

    async def test_adds_member_to_store(self) -> None:
        service, store, _ = make_service()
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        assert VALID_MEMBER_AIC in store.groups[key]

    async def test_sets_expire_on_key(self) -> None:
        service, store, _ = make_service()
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        assert store.expire_calls == [(key, KEY_TTL)]

    async def test_updates_local_cache(self) -> None:
        service, _, _ = make_service()
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        assert VALID_MEMBER_AIC in service.local_cache[key]

    async def test_adding_second_member_preserves_first(self) -> None:
        service, _, _ = make_service()
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_OTHER_AIC)
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        assert VALID_MEMBER_AIC in service.local_cache[key]
        assert VALID_OTHER_AIC in service.local_cache[key]

    async def test_invalid_leader_aic_raises_value_error(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError, match="invalid leader AIC"):
            await service.add_member("bad-aic", VALID_GROUP_ID, VALID_MEMBER_AIC)

    async def test_invalid_member_aic_raises_value_error(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError, match="invalid member AIC"):
            await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, "bad-aic")

    async def test_invalid_group_id_raises_value_error(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError, match="invalid group-id"):
            await service.add_member(VALID_LEADER_AIC, "bad_group_id!", VALID_MEMBER_AIC)


class TestRemoveMember:
    """remove_member — 从 store 移除、更新本地缓存。"""

    async def test_removes_member_from_store(self) -> None:
        service, store, _ = make_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        store.groups[key] = {VALID_MEMBER_AIC, VALID_OTHER_AIC}
        await service.remove_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert VALID_MEMBER_AIC not in store.groups.get(key, set())
        assert VALID_OTHER_AIC in store.groups.get(key, set())

    async def test_updates_local_cache(self) -> None:
        service, store, _ = make_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        store.groups[key] = {VALID_MEMBER_AIC, VALID_OTHER_AIC}
        service.local_cache[key] = frozenset({VALID_MEMBER_AIC, VALID_OTHER_AIC})
        await service.remove_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert key in service.local_cache
        assert VALID_MEMBER_AIC not in service.local_cache[key]
        assert VALID_OTHER_AIC in service.local_cache[key]

    async def test_clears_cache_entry_when_last_member_removed(self) -> None:
        service, store, _ = make_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        store.groups[key] = {VALID_MEMBER_AIC}
        service.local_cache[key] = frozenset({VALID_MEMBER_AIC})
        await service.remove_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert key not in service.local_cache

    async def test_invalid_leader_aic_raises(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError, match="invalid leader AIC"):
            await service.remove_member("bad-aic", VALID_GROUP_ID, VALID_MEMBER_AIC)

    async def test_invalid_member_aic_raises(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError, match="invalid member AIC"):
            await service.remove_member(VALID_LEADER_AIC, VALID_GROUP_ID, "bad-aic")


class TestDeleteGroup:
    """delete_group — 清理 store 和本地缓存中的 key。"""

    async def test_removes_key_from_store(self) -> None:
        service, store, _ = make_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        store.groups[key] = {VALID_MEMBER_AIC}
        await service.delete_group(VALID_LEADER_AIC, VALID_GROUP_ID)
        assert key not in store.groups

    async def test_removes_key_from_local_cache(self) -> None:
        service, store, _ = make_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        store.groups[key] = {VALID_MEMBER_AIC}
        service.local_cache[key] = frozenset({VALID_MEMBER_AIC})
        await service.delete_group(VALID_LEADER_AIC, VALID_GROUP_ID)
        assert key not in service.local_cache

    async def test_nonexistent_group_does_not_raise(self) -> None:
        service, _, _ = make_service()
        # 不存在的 group 不应抛异常
        await service.delete_group(VALID_LEADER_AIC, VALID_GROUP_ID)

    async def test_invalid_leader_aic_raises(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError, match="invalid leader AIC"):
            await service.delete_group("bad-aic", VALID_GROUP_ID)

    async def test_invalid_group_id_raises(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError, match="invalid group-id"):
            await service.delete_group(VALID_LEADER_AIC, "bad_group!")


class TestCloseMemberConnections:
    """close_member_connections — 调用 management_client 关闭连接。"""

    async def test_calls_management_client_with_correct_args(self) -> None:
        service, _, mgmt = make_service()
        await service.close_member_connections(VALID_LEADER_AIC, VALID_MEMBER_AIC)
        assert mgmt.calls == [(VALID_MEMBER_AIC, f"Removed from group by leader {VALID_LEADER_AIC}")]

    async def test_reason_includes_leader_aic(self) -> None:
        service, _, mgmt = make_service()
        await service.close_member_connections(VALID_LEADER_AIC, VALID_MEMBER_AIC)
        _, reason = mgmt.calls[0]
        assert VALID_LEADER_AIC in reason

    async def test_invalid_leader_aic_raises(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError, match="invalid leader AIC"):
            await service.close_member_connections("bad-aic", VALID_MEMBER_AIC)

    async def test_invalid_member_aic_raises(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError, match="invalid member AIC"):
            await service.close_member_connections(VALID_LEADER_AIC, "bad-aic")


class TestCheckGroupMembership:
    """check_group_membership — Redis 路径 + 本地缓存降级路径。"""

    async def test_member_in_group_returns_true(self) -> None:
        service, store, _ = make_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        store.groups[key] = {VALID_MEMBER_AIC}
        result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert result is True

    async def test_non_member_returns_false(self) -> None:
        service, store, _ = make_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        store.groups[key] = {VALID_MEMBER_AIC}
        result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_OTHER_AIC)
        assert result is False

    async def test_populates_local_cache_from_store(self) -> None:
        service, store, _ = make_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        store.groups[key] = {VALID_MEMBER_AIC, VALID_OTHER_AIC}
        await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert key in service.local_cache
        assert VALID_MEMBER_AIC in service.local_cache[key]
        assert VALID_OTHER_AIC in service.local_cache[key]

    async def test_uses_local_cache_when_store_unavailable(self) -> None:
        """store 不可用时，从本地缓存降级读取。"""
        service, store, _ = make_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        # 预热本地缓存
        service.local_cache[key] = frozenset({VALID_MEMBER_AIC})
        store.unavailable = True
        result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert result is True

    async def test_returns_false_when_store_unavailable_and_cache_empty(self) -> None:
        """store 不可用且缓存为空时，拒绝（fail-closed）。"""
        service, store, _ = make_service()
        store.unavailable = True
        result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert result is False

    async def test_non_member_not_in_cache_when_store_unavailable(self) -> None:
        """非成员在缓存降级场景下也返回 False。"""
        service, store, _ = make_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        service.local_cache[key] = frozenset({VALID_MEMBER_AIC})
        store.unavailable = True
        result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_OTHER_AIC)
        assert result is False

    async def test_empty_group_returns_false(self) -> None:
        service, _store, _ = make_service()
        # store 里 key 不存在（empty set）
        result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert result is False

    async def test_invalid_leader_aic_raises(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError):
            await service.check_group_membership("bad-aic", VALID_GROUP_ID, VALID_MEMBER_AIC)

    async def test_invalid_requester_aic_raises(self) -> None:
        service, _, _ = make_service()
        with pytest.raises(ValueError):
            await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, "bad-aic")


class TestAclose:
    """aclose — 关闭 store 和 management_client。"""

    async def test_aclose_does_not_raise(self) -> None:
        service, _, _ = make_service()
        await service.aclose()
