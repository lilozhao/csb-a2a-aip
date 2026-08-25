"""RabbitMQ HTTP auth backend 路由及应用级端点的单元测试。

覆盖：
- /auth/user /auth/vhost /auth/resource /auth/topic 各种决策
- Redis 降级场景（本地缓存 fallback）
- /health /ready 端点
- Auth 路由在错误端口（9007）应返回 404
"""

from __future__ import annotations

from tests.conftest import (
    VALID_GROUP_ID,
    VALID_LEADER_AIC,
    VALID_MEMBER_AIC,
    VALID_OTHER_AIC,
    build_test_client,
)


def test_auth_user_and_vhost_decisions() -> None:
    client, _, _, _ = build_test_client(listener_port=9008)

    response = client.post(
        "/auth/user",
        data={"username": VALID_LEADER_AIC, "password": ""},
    )
    assert response.status_code == 200
    assert response.text == "allow"

    response = client.post(
        "/auth/user",
        data={"username": "admin", "password": ""},
    )
    assert response.status_code == 200
    assert response.text == "deny"

    response = client.post(
        "/auth/vhost",
        data={"username": VALID_LEADER_AIC, "vhost": "acps"},
    )
    assert response.text == "allow"

    response = client.post(
        "/auth/vhost",
        data={"username": VALID_LEADER_AIC, "vhost": "other"},
    )
    assert response.text == "deny"

    response = client.post("/auth/user", data={"username": VALID_LEADER_AIC})
    assert response.status_code == 200
    assert response.text == "allow"


def test_auth_resource_rules_cover_inbox_group_and_default_exchange(
    group_cache_key: str,
) -> None:
    client, _, store, _ = build_test_client(listener_port=9008)
    store.groups[group_cache_key] = {VALID_LEADER_AIC, VALID_MEMBER_AIC}

    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "exchange",
                "name": "inbox.topic",
                "permission": "read",
            },
        ).text
        == "allow"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "exchange",
                "name": "inbox.topic",
                "permission": "configure",
            },
        ).text
        == "allow"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "exchange",
                "name": "inbox.topic",
                "permission": "write",
            },
        ).text
        == "allow"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": f"inbox_{VALID_MEMBER_AIC}",
                "permission": "read",
            },
        ).text
        == "allow"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_OTHER_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": f"inbox_{VALID_MEMBER_AIC}",
                "permission": "read",
            },
        ).text
        == "deny"
    )

    exchange_name = f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}"
    queue_name = f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}_{VALID_MEMBER_AIC}"

    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_LEADER_AIC,
                "vhost": "acps",
                "resource": "exchange",
                "name": exchange_name,
                "permission": "configure",
            },
        ).text
        == "allow"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_OTHER_AIC,
                "vhost": "acps",
                "resource": "exchange",
                "name": exchange_name,
                "permission": "write",
            },
        ).text
        == "deny"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "read",
            },
        ).text
        == "allow"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_LEADER_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "configure",
            },
        ).text
        == "allow"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "write",
            },
        ).text
        == "allow"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_LEADER_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "read",
            },
        ).text
        == "deny"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_OTHER_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "write",
            },
        ).text
        == "deny"
    )
    store.groups[group_cache_key] = {VALID_LEADER_AIC}
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "configure",
            },
        ).text
        == "deny"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "read",
            },
        ).text
        == "deny"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_LEADER_AIC,
                "vhost": "acps",
                "resource": "exchange",
                "name": "amq.default",
                "permission": "write",
            },
        ).text
        == "deny"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_LEADER_AIC,
                "vhost": "acps",
                "resource": "exchange",
                "name": "unknown.exchange",
                "permission": "read",
            },
        ).text
        == "deny"
    )
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_LEADER_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "consume",
            },
        ).text
        == "deny"
    )


def test_auth_topic_rules_and_redis_fallback(group_cache_key: str) -> None:
    client, service, store, _ = build_test_client(listener_port=9008)
    store.groups[group_cache_key] = {VALID_LEADER_AIC, VALID_MEMBER_AIC}

    response = client.post(
        "/auth/resource",
        data={
            "username": VALID_MEMBER_AIC,
            "vhost": "acps",
            "resource": "exchange",
            "name": f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}",
            "permission": "write",
        },
    )
    assert response.text == "allow"
    assert group_cache_key in service.local_cache

    store.unavailable = True
    response = client.post(
        "/auth/resource",
        data={
            "username": VALID_MEMBER_AIC,
            "vhost": "acps",
            "resource": "exchange",
            "name": f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}",
            "permission": "read",
        },
    )
    assert response.text == "allow"

    service.local_cache.clear()
    response = client.post(
        "/auth/resource",
        data={
            "username": VALID_MEMBER_AIC,
            "vhost": "acps",
            "resource": "exchange",
            "name": f"group_{VALID_LEADER_AIC}_{VALID_GROUP_ID}",
            "permission": "read",
        },
    )
    assert response.text == "deny"

    client, _, _, _ = build_test_client(listener_port=9008)
    assert (
        client.post(
            "/auth/topic",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "topic",
                "name": "inbox.topic",
                "permission": "read",
                "routing_key": f"inbox_{VALID_MEMBER_AIC}",
            },
        ).text
        == "allow"
    )
    assert (
        client.post(
            "/auth/topic",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "topic",
                "name": "inbox.topic",
                "permission": "read",
                "routing_key": f"inbox_{VALID_LEADER_AIC}",
            },
        ).text
        == "deny"
    )
    assert (
        client.post(
            "/auth/topic",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "topic",
                "name": "group_other_demo",
                "permission": "write",
                "routing_key": f"inbox_{VALID_LEADER_AIC}",
            },
        ).text
        == "deny"
    )
    assert (
        client.post(
            "/auth/topic",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "topic",
                "name": "inbox.topic",
                "permission": "write",
                "routing_key": f"inbox_{VALID_LEADER_AIC}",
            },
        ).text
        == "allow"
    )
    assert (
        client.post(
            "/auth/topic",
            data={
                "username": VALID_MEMBER_AIC,
                "vhost": "acps",
                "resource": "topic",
                "name": "inbox.topic",
                "permission": "write",
                "routing_key": "inbox_not-a-valid-aic",
            },
        ).text
        == "deny"
    )


def test_auth_resource_wrong_vhost_and_resource_type() -> None:
    """check_resource — 非 acps vhost 或不支持的 resource 类型均应被拒绝。"""
    client, _, _, _ = build_test_client(listener_port=9008)

    # 错误 vhost
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_LEADER_AIC,
                "vhost": "other",
                "resource": "exchange",
                "name": "inbox.topic",
                "permission": "read",
            },
        ).text
        == "deny"
    )

    # 不支持的 resource 类型（topic 应通过 /auth/topic 端点）
    assert (
        client.post(
            "/auth/resource",
            data={
                "username": VALID_LEADER_AIC,
                "vhost": "acps",
                "resource": "topic",
                "name": "inbox.topic",
                "permission": "read",
            },
        ).text
        == "deny"
    )


def test_health_endpoint_returns_status_and_port() -> None:
    """/health 端点应返回 {"status": "ok", "port": <listener_port>}。"""
    client, _, _, _ = build_test_client(listener_port=9007)
    response = client.get("/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert body["port"] == 9007


def test_ready_endpoint_when_store_available() -> None:
    """/ready 端点：store ping 成功 → 200 ready。"""
    client, _, store, _ = build_test_client(listener_port=9007)
    store.unavailable = False
    response = client.get("/ready")
    assert response.status_code == 200
    assert response.json()["status"] == "ready"


def test_ready_endpoint_when_store_unavailable() -> None:
    """/ready 端点：store ping 失败 → 503 not_ready。"""
    client, _, store, _ = build_test_client(listener_port=9007)
    store.unavailable = True
    response = client.get("/ready")
    assert response.status_code == 503
    assert response.json()["status"] == "not_ready"


def test_auth_routes_not_accessible_on_group_port() -> None:
    """Auth 路由在 Group API 端口（9007）应返回 404。"""
    client, _, _, _ = build_test_client(listener_port=9007)
    response = client.post("/auth/user", data={"username": VALID_LEADER_AIC, "password": ""})
    assert response.status_code == 404


def test_auth_resource_empty_form_body_denies() -> None:
    """空表单体提交 /auth/resource 应被拒绝（空字符串 username 不是有效 AIC）。"""
    client, _, _, _ = build_test_client(listener_port=9008)
    response = client.post("/auth/resource", data={})
    assert response.status_code == 200
    assert response.text == "deny"


def test_auth_topic_wrong_vhost_denies() -> None:
    """check_topic — 错误 vhost 应被拒绝。"""
    client, _, _, _ = build_test_client(listener_port=9008)
    response = client.post(
        "/auth/topic",
        data={
            "username": VALID_MEMBER_AIC,
            "vhost": "other",
            "resource": "topic",
            "name": "inbox.topic",
            "permission": "read",
            "routing_key": f"inbox_{VALID_MEMBER_AIC}",
        },
    )
    assert response.text == "deny"


def test_auth_user_no_password_field_still_allows_valid_aic() -> None:
    """check_user — RabbitMQ 有时不提交 password 字段，仍应根据 AIC 格式判断。"""
    client, _, _, _ = build_test_client(listener_port=9008)
    response = client.post("/auth/user", data={"username": VALID_LEADER_AIC})
    assert response.status_code == 200
    assert response.text == "allow"
