"""AuthorizationService 及内部解析器的单元测试。

覆盖：
- _parse_inbox_queue / _parse_group_exchange / _parse_group_queue
- check_user / check_vhost / check_resource / check_topic
- 各种边界条件（无效 AIC、错误 vhost、不支持的权限类型等）
"""

from __future__ import annotations

from cachetools import TTLCache

from app.services.authz import (
    AuthDecision,
    AuthorizationService,
    GroupExchangeName,
    GroupQueueName,
    _parse_group_exchange,
    _parse_group_queue,
    _parse_inbox_queue,
)
from app.services.group_acl import GroupAclService
from tests.conftest import (
    VALID_GROUP_ID,
    VALID_LEADER_AIC,
    VALID_MEMBER_AIC,
    VALID_OTHER_AIC,
    FakeRabbitMqManagementClient,
    InMemoryGroupAclStore,
)


def make_authz_service(
    store: InMemoryGroupAclStore | None = None,
) -> tuple[AuthorizationService, InMemoryGroupAclStore]:
    """创建 AuthorizationService 的测试辅助函数。"""
    resolved_store = store or InMemoryGroupAclStore()
    group_acl_service = GroupAclService(
        store=resolved_store,
        management_client=FakeRabbitMqManagementClient(),
        local_cache=TTLCache(maxsize=128, ttl=30),
        key_ttl_seconds=604800,
    )
    return AuthorizationService(group_acl_service), resolved_store


# ─────────────────────────── 解析器测试 ────────────────────────────


class TestParseInboxQueue:
    """_parse_inbox_queue — 解析 inbox_<AIC> 形式的队列名。"""

    def test_valid_inbox_queue_returns_owner_aic(self) -> None:
        result = _parse_inbox_queue(f"inbox_{VALID_MEMBER_AIC}")
        assert result == VALID_MEMBER_AIC

    def test_wrong_prefix_returns_none(self) -> None:
        assert _parse_inbox_queue(f"outbox_{VALID_MEMBER_AIC}") is None

    def test_invalid_aic_suffix_returns_none(self) -> None:
        assert _parse_inbox_queue("inbox_not-an-aic") is None

    def test_empty_string_returns_none(self) -> None:
        assert _parse_inbox_queue("") is None

    def test_only_prefix_returns_none(self) -> None:
        # "inbox_" 之后没有有效 AIC
        assert _parse_inbox_queue("inbox_") is None


class TestParseGroupExchange:
    """_parse_group_exchange — 解析 group_<leader_aic>_<group_id> 形式的 exchange 名。"""

    def test_valid_group_exchange_returns_named_tuple(self) -> None:
        name = f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}"
        result = _parse_group_exchange(name)
        assert result == GroupExchangeName(leader_aic=VALID_LEADER_AIC, group_id=VALID_GROUP_ID)

    def test_wrong_prefix_returns_none(self) -> None:
        name = f"grp_{VALID_LEADER_AIC}_{VALID_GROUP_ID}"
        assert _parse_group_exchange(name) is None

    def test_too_few_parts_returns_none(self) -> None:
        assert _parse_group_exchange(f"group_{VALID_LEADER_AIC}") is None

    def test_too_many_parts_returns_none(self) -> None:
        assert _parse_group_exchange(f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}_extra") is None

    def test_invalid_leader_aic_returns_none(self) -> None:
        assert _parse_group_exchange(f"group_bad-aic_{VALID_GROUP_ID}") is None

    def test_invalid_group_id_returns_none(self) -> None:
        # bad!groupid 包含非法字符
        assert _parse_group_exchange(f"group_{VALID_LEADER_AIC}_bad!groupid") is None


class TestParseGroupQueue:
    """_parse_group_queue — 解析 group_<leader>_<group_id>_<member> 形式的队列名。"""

    def test_valid_group_queue_returns_named_tuple(self) -> None:
        name = f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}_{VALID_MEMBER_AIC}"
        result = _parse_group_queue(name)
        assert result == GroupQueueName(
            leader_aic=VALID_LEADER_AIC,
            group_id=VALID_GROUP_ID,
            member_aic=VALID_MEMBER_AIC,
        )

    def test_too_few_parts_returns_none(self) -> None:
        assert _parse_group_queue(f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}") is None

    def test_too_many_parts_returns_none(self) -> None:
        assert _parse_group_queue(f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}_{VALID_MEMBER_AIC}_extra") is None

    def test_invalid_leader_aic_returns_none(self) -> None:
        assert _parse_group_queue(f"group_bad-leader_{VALID_GROUP_ID}_{VALID_MEMBER_AIC}") is None

    def test_invalid_member_aic_returns_none(self) -> None:
        assert _parse_group_queue(f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}_bad-member") is None

    def test_invalid_group_id_returns_none(self) -> None:
        # bad!groupid 包含非法字符，split 后仍只有 4 段
        assert _parse_group_queue(f"group_{VALID_LEADER_AIC}_bad!groupid_{VALID_MEMBER_AIC}") is None


# ─────────────────────────── check_user ────────────────────────────


class TestCheckUser:
    """check_user — AIC 格式校验。"""

    async def test_valid_aic_allows(self) -> None:
        service, _ = make_authz_service()
        assert await service.check_user(VALID_LEADER_AIC) == AuthDecision.ALLOW

    async def test_invalid_aic_denies(self) -> None:
        service, _ = make_authz_service()
        assert await service.check_user("admin") == AuthDecision.DENY

    async def test_empty_string_denies(self) -> None:
        service, _ = make_authz_service()
        assert await service.check_user("") == AuthDecision.DENY

    async def test_partial_aic_denies(self) -> None:
        service, _ = make_authz_service()
        assert await service.check_user("1.2.156.3088") == AuthDecision.DENY


# ─────────────────────────── check_vhost ────────────────────────────


class TestCheckVhost:
    """check_vhost — vhost 名称校验。"""

    async def test_valid_aic_acps_vhost_allows(self) -> None:
        service, _ = make_authz_service()
        assert await service.check_vhost(VALID_LEADER_AIC, "acps") == AuthDecision.ALLOW

    async def test_valid_aic_other_vhost_denies(self) -> None:
        service, _ = make_authz_service()
        assert await service.check_vhost(VALID_LEADER_AIC, "other") == AuthDecision.DENY

    async def test_valid_aic_root_vhost_denies(self) -> None:
        service, _ = make_authz_service()
        assert await service.check_vhost(VALID_LEADER_AIC, "/") == AuthDecision.DENY

    async def test_invalid_aic_denies_regardless_of_vhost(self) -> None:
        service, _ = make_authz_service()
        assert await service.check_vhost("admin", "acps") == AuthDecision.DENY


# ─────────────────────────── check_resource ────────────────────────────


class TestCheckResource:
    """check_resource — 资源权限检查的各类场景。"""

    async def test_invalid_username_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_resource(
            username="admin",
            vhost="acps",
            resource="exchange",
            name="inbox.topic",
            permission="read",
        )
        assert result == AuthDecision.DENY

    async def test_wrong_vhost_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_resource(
            username=VALID_LEADER_AIC,
            vhost="other",
            resource="exchange",
            name="inbox.topic",
            permission="read",
        )
        assert result == AuthDecision.DENY

    async def test_unsupported_permission_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_resource(
            username=VALID_LEADER_AIC,
            vhost="acps",
            resource="exchange",
            name="inbox.topic",
            permission="consume",
        )
        assert result == AuthDecision.DENY

    async def test_unsupported_resource_type_denies(self) -> None:
        # "topic" 不是合法的 resource 类型（应用 /auth/resource 端点）
        service, _ = make_authz_service()
        result = await service.check_resource(
            username=VALID_LEADER_AIC,
            vhost="acps",
            resource="topic",
            name="inbox.topic",
            permission="read",
        )
        assert result == AuthDecision.DENY

    async def test_amq_default_exchange_always_denied(self) -> None:
        service, _ = make_authz_service()
        for perm in ("configure", "write", "read"):
            result = await service.check_resource(
                username=VALID_LEADER_AIC,
                vhost="acps",
                resource="exchange",
                name="amq.default",
                permission=perm,
            )
            assert result == AuthDecision.DENY, f"amq.default {perm} 应被拒绝"

    async def test_inbox_topic_exchange_read_allows(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_resource(
            username=VALID_LEADER_AIC,
            vhost="acps",
            resource="exchange",
            name="inbox.topic",
            permission="read",
        )
        assert result == AuthDecision.ALLOW

    async def test_inbox_topic_exchange_write_allows(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_resource(
            username=VALID_LEADER_AIC,
            vhost="acps",
            resource="exchange",
            name="inbox.topic",
            permission="write",
        )
        assert result == AuthDecision.ALLOW

    async def test_inbox_topic_exchange_configure_allows(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_resource(
            username=VALID_LEADER_AIC,
            vhost="acps",
            resource="exchange",
            name="inbox.topic",
            permission="configure",
        )
        assert result == AuthDecision.ALLOW

    async def test_own_inbox_queue_all_permissions_allow(self) -> None:
        service, _ = make_authz_service()
        for perm in ("configure", "write", "read"):
            result = await service.check_resource(
                username=VALID_MEMBER_AIC,
                vhost="acps",
                resource="queue",
                name=f"inbox_{VALID_MEMBER_AIC}",
                permission=perm,
            )
            assert result == AuthDecision.ALLOW, f"own inbox queue {perm} 应被允许"

    async def test_foreign_inbox_queue_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_resource(
            username=VALID_OTHER_AIC,
            vhost="acps",
            resource="queue",
            name=f"inbox_{VALID_MEMBER_AIC}",
            permission="read",
        )
        assert result == AuthDecision.DENY

    async def test_unknown_exchange_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_resource(
            username=VALID_LEADER_AIC,
            vhost="acps",
            resource="exchange",
            name="unknown.exchange",
            permission="read",
        )
        assert result == AuthDecision.DENY

    async def test_group_exchange_configure_by_leader_allows(self) -> None:
        service, _ = make_authz_service()
        exchange_name = f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}"
        result = await service.check_resource(
            username=VALID_LEADER_AIC,
            vhost="acps",
            resource="exchange",
            name=exchange_name,
            permission="configure",
        )
        assert result == AuthDecision.ALLOW

    async def test_group_exchange_configure_by_non_leader_denies(self) -> None:
        service, _ = make_authz_service()
        exchange_name = f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}"
        result = await service.check_resource(
            username=VALID_MEMBER_AIC,
            vhost="acps",
            resource="exchange",
            name=exchange_name,
            permission="configure",
        )
        assert result == AuthDecision.DENY

    async def test_group_exchange_write_by_member_allows(self) -> None:
        service, store = make_authz_service()
        key = GroupAclService.build_cache_key(VALID_LEADER_AIC, VALID_GROUP_ID)
        store.groups[key] = {VALID_MEMBER_AIC}
        exchange_name = f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}"
        result = await service.check_resource(
            username=VALID_MEMBER_AIC,
            vhost="acps",
            resource="exchange",
            name=exchange_name,
            permission="write",
        )
        assert result == AuthDecision.ALLOW

    async def test_group_exchange_write_by_non_member_denies(self) -> None:
        service, _ = make_authz_service()
        exchange_name = f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}"
        result = await service.check_resource(
            username=VALID_OTHER_AIC,
            vhost="acps",
            resource="exchange",
            name=exchange_name,
            permission="write",
        )
        assert result == AuthDecision.DENY


# ─────────────────────────── check_topic ────────────────────────────


class TestCheckTopic:
    """check_topic — inbox.topic 路由键权限检查。"""

    async def test_read_own_routing_key_allows(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_topic(
            username=VALID_MEMBER_AIC,
            vhost="acps",
            resource="topic",
            name="inbox.topic",
            permission="read",
            routing_key=f"inbox_{VALID_MEMBER_AIC}",
        )
        assert result == AuthDecision.ALLOW

    async def test_read_foreign_routing_key_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_topic(
            username=VALID_MEMBER_AIC,
            vhost="acps",
            resource="topic",
            name="inbox.topic",
            permission="read",
            routing_key=f"inbox_{VALID_LEADER_AIC}",
        )
        assert result == AuthDecision.DENY

    async def test_write_valid_inbox_routing_key_allows(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_topic(
            username=VALID_MEMBER_AIC,
            vhost="acps",
            resource="topic",
            name="inbox.topic",
            permission="write",
            routing_key=f"inbox_{VALID_LEADER_AIC}",
        )
        assert result == AuthDecision.ALLOW

    async def test_write_invalid_routing_key_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_topic(
            username=VALID_MEMBER_AIC,
            vhost="acps",
            resource="topic",
            name="inbox.topic",
            permission="write",
            routing_key="inbox_not-a-valid-aic",
        )
        assert result == AuthDecision.DENY

    async def test_invalid_username_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_topic(
            username="admin",
            vhost="acps",
            resource="topic",
            name="inbox.topic",
            permission="read",
            routing_key="inbox_admin",
        )
        assert result == AuthDecision.DENY

    async def test_wrong_vhost_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_topic(
            username=VALID_MEMBER_AIC,
            vhost="other",
            resource="topic",
            name="inbox.topic",
            permission="read",
            routing_key=f"inbox_{VALID_MEMBER_AIC}",
        )
        assert result == AuthDecision.DENY

    async def test_wrong_resource_type_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_topic(
            username=VALID_MEMBER_AIC,
            vhost="acps",
            resource="exchange",  # 应为 "topic"
            name="inbox.topic",
            permission="read",
            routing_key=f"inbox_{VALID_MEMBER_AIC}",
        )
        assert result == AuthDecision.DENY

    async def test_unsupported_exchange_name_denies(self) -> None:
        service, _ = make_authz_service()
        result = await service.check_topic(
            username=VALID_MEMBER_AIC,
            vhost="acps",
            resource="topic",
            name="other.exchange",
            permission="read",
            routing_key=f"inbox_{VALID_MEMBER_AIC}",
        )
        assert result == AuthDecision.DENY

    async def test_configure_permission_denies(self) -> None:
        # "configure" 不是合法的 topic 权限
        service, _ = make_authz_service()
        result = await service.check_topic(
            username=VALID_MEMBER_AIC,
            vhost="acps",
            resource="topic",
            name="inbox.topic",
            permission="configure",
            routing_key=f"inbox_{VALID_MEMBER_AIC}",
        )
        assert result == AuthDecision.DENY
