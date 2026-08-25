"""Auth API 的端到端测试。

对已部署的真实 mq-auth-server 实例验证完整鉴权流程。
所有测试需要 mTLS 环境变量正确配置（见 conftest.py），否则自动 skip。

运行方式：
    export GROUP_API_URL=https://mq-auth:9007
    export AUTH_API_URL=https://mq-auth:9008
    export TLS_CERT_FILE=/path/to/client.pem
    export TLS_KEY_FILE=/path/to/client.key
    export TLS_CA_CERT_FILE=/path/to/acps-root-ca.pem
    uv run pytest tests/e2e/ -v -m e2e
"""

from __future__ import annotations

import os
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    import httpx

# 从环境变量读取测试用 AIC（真实部署环境中的 Agent AIC）
_TEST_AIC = os.environ.get("E2E_TEST_AIC", "")


@pytest.fixture(scope="module")
def skip_if_no_test_aic() -> None:
    """如果未配置测试 AIC，跳过需要 AIC 的测试。"""
    if not _TEST_AIC:
        pytest.skip("E2E_TEST_AIC 未配置 — 跳过需要真实 AIC 的测试")


class TestHealthAndReady:
    """健康检查端点的 e2e 验证。"""

    def test_health_endpoint_returns_ok(self, mtls_client: httpx.Client, group_api_url: str) -> None:
        """/health 端点应返回 {"status": "ok", ...}。"""
        response = mtls_client.get(f"{group_api_url}/health")
        assert response.status_code == 200
        body = response.json()
        assert body["status"] == "ok"

    def test_ready_endpoint_returns_200_or_503(self, mtls_client: httpx.Client, group_api_url: str) -> None:
        """/ready 端点应返回 200（Redis 可用）或 503（Redis 不可用）。"""
        response = mtls_client.get(f"{group_api_url}/ready")
        assert response.status_code in (200, 503)
        body = response.json()
        assert body["status"] in ("ready", "not_ready")

    def test_auth_api_health_returns_ok(self, mtls_client: httpx.Client, auth_api_url: str) -> None:
        """/health 在 Auth API 端口上也应返回 {"status": "ok", ...}。"""
        response = mtls_client.get(f"{auth_api_url}/health")
        assert response.status_code == 200
        assert response.json()["status"] == "ok"


class TestAuthUserEndpoint:
    """Auth API /auth/user 端点的 e2e 验证。"""

    def test_valid_aic_allows(self, mtls_client: httpx.Client, auth_api_url: str, skip_if_no_test_aic: None) -> None:
        """合法 AIC 格式应被 allow。"""
        response = mtls_client.post(
            f"{auth_api_url}/auth/user",
            data={"username": _TEST_AIC, "password": ""},
        )
        assert response.status_code == 200
        assert response.text == "allow"

    def test_non_aic_username_denies(self, mtls_client: httpx.Client, auth_api_url: str) -> None:
        """非 AIC 格式用户名（如 "admin"）应被 deny。"""
        response = mtls_client.post(
            f"{auth_api_url}/auth/user",
            data={"username": "admin", "password": ""},
        )
        assert response.status_code == 200
        assert response.text == "deny"


class TestAuthVhostEndpoint:
    """Auth API /auth/vhost 端点的 e2e 验证。"""

    def test_acps_vhost_allows(self, mtls_client: httpx.Client, auth_api_url: str, skip_if_no_test_aic: None) -> None:
        """合法 AIC 访问 acps vhost 应被 allow。"""
        response = mtls_client.post(
            f"{auth_api_url}/auth/vhost",
            data={"username": _TEST_AIC, "vhost": "acps"},
        )
        assert response.status_code == 200
        assert response.text == "allow"

    def test_other_vhost_denies(self, mtls_client: httpx.Client, auth_api_url: str, skip_if_no_test_aic: None) -> None:
        """访问非 acps vhost 应被 deny。"""
        response = mtls_client.post(
            f"{auth_api_url}/auth/vhost",
            data={"username": _TEST_AIC, "vhost": "other"},
        )
        assert response.status_code == 200
        assert response.text == "deny"


class TestAuthResourceEndpoint:
    """Auth API /auth/resource 端点的 e2e 验证。"""

    def test_inbox_topic_exchange_read_allows(
        self,
        mtls_client: httpx.Client,
        auth_api_url: str,
        skip_if_no_test_aic: None,
    ) -> None:
        """inbox.topic exchange 的 read 权限应被 allow。"""
        response = mtls_client.post(
            f"{auth_api_url}/auth/resource",
            data={
                "username": _TEST_AIC,
                "vhost": "acps",
                "resource": "exchange",
                "name": "inbox.topic",
                "permission": "read",
            },
        )
        assert response.status_code == 200
        assert response.text == "allow"

    def test_own_inbox_queue_allows(
        self, mtls_client: httpx.Client, auth_api_url: str, skip_if_no_test_aic: None
    ) -> None:
        """自己的 inbox 队列的所有权限应被 allow。"""
        response = mtls_client.post(
            f"{auth_api_url}/auth/resource",
            data={
                "username": _TEST_AIC,
                "vhost": "acps",
                "resource": "queue",
                "name": f"inbox_{_TEST_AIC}",
                "permission": "read",
            },
        )
        assert response.status_code == 200
        assert response.text == "allow"

    def test_amq_default_exchange_denies(
        self,
        mtls_client: httpx.Client,
        auth_api_url: str,
        skip_if_no_test_aic: None,
    ) -> None:
        """amq.default exchange 应始终被 deny。"""
        response = mtls_client.post(
            f"{auth_api_url}/auth/resource",
            data={
                "username": _TEST_AIC,
                "vhost": "acps",
                "resource": "exchange",
                "name": "amq.default",
                "permission": "write",
            },
        )
        assert response.status_code == 200
        assert response.text == "deny"


class TestAuthTopicEndpoint:
    """Auth API /auth/topic 端点的 e2e 验证。"""

    def test_read_own_routing_key_allows(
        self,
        mtls_client: httpx.Client,
        auth_api_url: str,
        skip_if_no_test_aic: None,
    ) -> None:
        """读取自己的 inbox routing key 应被 allow。"""
        response = mtls_client.post(
            f"{auth_api_url}/auth/topic",
            data={
                "username": _TEST_AIC,
                "vhost": "acps",
                "resource": "topic",
                "name": "inbox.topic",
                "permission": "read",
                "routing_key": f"inbox_{_TEST_AIC}",
            },
        )
        assert response.status_code == 200
        assert response.text == "allow"
