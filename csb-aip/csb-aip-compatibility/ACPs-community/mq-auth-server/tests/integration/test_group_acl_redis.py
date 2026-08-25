"""GroupAclService + RedisGroupAclStore 的集成测试。

需要真实 Redis 实例（通过 REDIS_URL 环境变量指定）。
Redis 不可用时自动 skip。

运行方式：
    REDIS_URL=redis://localhost:6379/0 uv run pytest tests/integration/ -v
"""

from __future__ import annotations

from app.services.group_acl import GroupAclService
from tests.conftest import (
    VALID_GROUP_ID,
    VALID_LEADER_AIC,
    VALID_MEMBER_AIC,
    VALID_OTHER_AIC,
)


class TestGroupAclServiceWithRedis:
    """使用真实 Redis 验证 GroupAclService 核心操作的完整性。"""

    async def test_add_member_and_check_membership(self, redis_group_acl_service: GroupAclService) -> None:
        """add_member 后 check_group_membership 应返回 True。"""
        service = redis_group_acl_service
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert result is True

    async def test_non_member_check_returns_false(self, redis_group_acl_service: GroupAclService) -> None:
        """未加入群组的 AIC check_group_membership 应返回 False。"""
        service = redis_group_acl_service
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_OTHER_AIC)
        assert result is False

    async def test_remove_member_then_check_returns_false(self, redis_group_acl_service: GroupAclService) -> None:
        """移除成员后 check_group_membership 应返回 False。"""
        service = redis_group_acl_service
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        await service.remove_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert result is False

    async def test_delete_group_clears_all_members(self, redis_group_acl_service: GroupAclService) -> None:
        """delete_group 后，所有成员的 check 均应返回 False。"""
        service = redis_group_acl_service
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_OTHER_AIC)
        await service.delete_group(VALID_LEADER_AIC, VALID_GROUP_ID)
        for aic in (VALID_MEMBER_AIC, VALID_OTHER_AIC):
            result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, aic)
            assert result is False, f"{aic} 删除群组后应返回 False"

    async def test_add_member_populates_local_cache(self, redis_group_acl_service: GroupAclService) -> None:
        """add_member 后本地 TTLCache 应被更新。"""
        from app.services.group_acl import GroupAclService

        service = redis_group_acl_service
        cache_key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, VALID_MEMBER_AIC)
        assert cache_key in service.local_cache
        assert VALID_MEMBER_AIC in service.local_cache[cache_key]

    async def test_multiple_members_all_check_true(self, redis_group_acl_service: GroupAclService) -> None:
        """同一群组中多个成员均应能通过 check。"""
        service = redis_group_acl_service
        members = [VALID_MEMBER_AIC, VALID_OTHER_AIC]
        for aic in members:
            await service.add_member(VALID_LEADER_AIC, VALID_GROUP_ID, aic)
        for aic in members:
            result = await service.check_group_membership(VALID_LEADER_AIC, VALID_GROUP_ID, aic)
            assert result is True, f"{aic} 应在群组中"

    async def test_delete_nonexistent_group_does_not_raise(self, redis_group_acl_service: GroupAclService) -> None:
        """删除不存在的群组不应抛出异常。"""
        service = redis_group_acl_service
        await service.delete_group(VALID_LEADER_AIC, "nonexistent-group-000")

    async def test_redis_store_ping_returns_true(self, redis_group_acl_service: GroupAclService) -> None:
        """RedisGroupAclStore.ping() 在 Redis 可用时应返回 True。"""
        assert await redis_group_acl_service.store.ping() is True
