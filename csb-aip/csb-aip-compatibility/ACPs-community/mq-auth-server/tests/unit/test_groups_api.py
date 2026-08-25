"""Group ACL 路由的单元测试（API 层行为）。

覆盖：
- PUT   /groups/{leader}/{group}/members/{member}  - 添加成员
- DELETE /groups/{leader}/{group}/members/{member}  - 移除成员
- DELETE /groups/{leader}/{group}                   - 删除群组
- DELETE /groups/{leader}/{group}/members/{member}/connection - 关闭连接
- 鉴权失败（调用方 AIC 与 leader AIC 不匹配） → 403
- 路径参数非法（AIC 格式错误、group_id 含非法字符）→ 422
- 在错误端口（9008）访问 group 路由 → 404
"""

from __future__ import annotations

from typing import Any

from tests.conftest import (
    VALID_GROUP_ID,
    VALID_LEADER_AIC,
    VALID_MEMBER_AIC,
    VALID_OTHER_AIC,
    build_test_client,
)


def assert_problem(
    response: Any,
    *,
    status_code: int,
    code: str,
    title: str,
) -> None:
    assert response.status_code == status_code
    assert response.headers["content-type"].startswith("application/problem+json")
    body = response.json()
    assert body["code"] == code
    assert body["title"] == title
    assert body["status"] == status_code
    assert body["type"] == "about:blank"
    assert body["instance"].startswith("/groups/")


def test_group_acl_routes_require_matching_client_certificate(
    group_cache_key: str,
) -> None:
    client, _, store, management_client = build_test_client(
        listener_port=9007,
        caller_aic=VALID_LEADER_AIC,
    )

    response = client.put(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}/members/{VALID_MEMBER_AIC}")
    assert response.status_code == 204
    assert store.groups[group_cache_key] == {VALID_MEMBER_AIC}

    response = client.delete(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}/members/{VALID_MEMBER_AIC}/connection")
    assert response.status_code == 204
    assert management_client.calls == [
        (
            VALID_MEMBER_AIC,
            f"Removed from group by leader {VALID_LEADER_AIC}",
        )
    ]

    response = client.delete(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}")
    assert response.status_code == 204
    assert group_cache_key not in store.groups


def test_group_acl_routes_reject_wrong_caller_and_invalid_group_id() -> None:
    client, _, _, _ = build_test_client(
        listener_port=9007,
        caller_aic=VALID_OTHER_AIC,
    )

    response = client.put(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}/members/{VALID_MEMBER_AIC}")
    assert_problem(
        response,
        status_code=403,
        code="LEADER_AIC_MISMATCH",
        title="Forbidden",
    )

    response = client.put(f"/groups/{VALID_LEADER_AIC}/bad_group!/members/{VALID_MEMBER_AIC}")
    assert_problem(
        response,
        status_code=422,
        code="INVALID_GROUP_ID",
        title="Invalid group ID",
    )


def test_remove_group_member_success(group_cache_key: str) -> None:
    """DELETE /groups/{leader}/{group}/members/{member} — 正常移除成员。"""
    client, _, store, _ = build_test_client(
        listener_port=9007,
        caller_aic=VALID_LEADER_AIC,
    )
    store.groups[group_cache_key] = {VALID_MEMBER_AIC, VALID_OTHER_AIC}

    response = client.delete(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}/members/{VALID_MEMBER_AIC}")
    assert response.status_code == 204
    assert VALID_MEMBER_AIC not in store.groups.get(group_cache_key, set())
    assert VALID_OTHER_AIC in store.groups.get(group_cache_key, set())


def test_remove_group_member_forbidden_wrong_caller() -> None:
    """DELETE /groups/{leader}/{group}/members/{member} — 调用方非 leader → 403。"""
    client, _, _, _ = build_test_client(
        listener_port=9007,
        caller_aic=VALID_OTHER_AIC,
    )
    response = client.delete(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}/members/{VALID_MEMBER_AIC}")
    assert_problem(
        response,
        status_code=403,
        code="LEADER_AIC_MISMATCH",
        title="Forbidden",
    )


def test_remove_group_member_no_cert_forbidden() -> None:
    """DELETE /groups/{leader}/{group}/members/{member} — 无证书调用方 → 403。"""
    client, _, _, _ = build_test_client(listener_port=9007)
    response = client.delete(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}/members/{VALID_MEMBER_AIC}")
    assert_problem(
        response,
        status_code=403,
        code="CLIENT_CERTIFICATE_REQUIRED",
        title="Client certificate required",
    )


def test_delete_group_forbidden_wrong_caller() -> None:
    """DELETE /groups/{leader}/{group} — 调用方非 leader → 403。"""
    client, _, _, _ = build_test_client(
        listener_port=9007,
        caller_aic=VALID_OTHER_AIC,
    )
    response = client.delete(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}")
    assert_problem(
        response,
        status_code=403,
        code="LEADER_AIC_MISMATCH",
        title="Forbidden",
    )


def test_close_connection_success(group_cache_key: str) -> None:
    """DELETE /groups/{leader}/{group}/members/{member}/connection — 正常关闭连接。"""
    client, _, _, management_client = build_test_client(
        listener_port=9007,
        caller_aic=VALID_LEADER_AIC,
    )

    response = client.delete(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}/members/{VALID_MEMBER_AIC}/connection")
    assert response.status_code == 204
    assert management_client.calls == [(VALID_MEMBER_AIC, f"Removed from group by leader {VALID_LEADER_AIC}")]


def test_close_connection_forbidden_wrong_caller() -> None:
    """DELETE .../connection — 调用方非 leader → 403。"""
    client, _, _, _ = build_test_client(
        listener_port=9007,
        caller_aic=VALID_OTHER_AIC,
    )
    response = client.delete(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}/members/{VALID_MEMBER_AIC}/connection")
    assert_problem(
        response,
        status_code=403,
        code="LEADER_AIC_MISMATCH",
        title="Forbidden",
    )


def test_invalid_leader_aic_in_path_returns_422() -> None:
    """路径中 leader_aic 格式非法 → 422。"""
    client, _, _, _ = build_test_client(
        listener_port=9007,
        caller_aic=VALID_LEADER_AIC,
    )
    response = client.put(f"/groups/bad-aic/{VALID_GROUP_ID}/members/{VALID_MEMBER_AIC}")
    assert_problem(
        response,
        status_code=422,
        code="INVALID_LEADER_AIC",
        title="Invalid leader AIC",
    )


def test_invalid_member_aic_in_path_returns_422() -> None:
    """路径中 member_aic 格式非法 → 422。"""
    client, _, _, _ = build_test_client(
        listener_port=9007,
        caller_aic=VALID_LEADER_AIC,
    )
    response = client.put(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}/members/bad-aic")
    assert_problem(
        response,
        status_code=422,
        code="INVALID_MEMBER_AIC",
        title="Invalid member AIC",
    )


def test_group_routes_not_accessible_on_auth_port() -> None:
    """Group 路由在 Auth 端口（9008）应返回 404。"""
    client, _, _, _ = build_test_client(
        listener_port=9008,
        caller_aic=VALID_LEADER_AIC,
    )
    response = client.put(f"/groups/{VALID_LEADER_AIC}/{VALID_GROUP_ID}/members/{VALID_MEMBER_AIC}")
    assert response.status_code == 404
    assert response.json()["detail"] == "Not Found"
