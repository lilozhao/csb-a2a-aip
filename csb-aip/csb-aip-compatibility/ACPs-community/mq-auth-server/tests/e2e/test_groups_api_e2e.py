"""Group ACL API 的端到端测试。

对已部署的真实 mq-auth-server 实例验证完整群组管理流程（含 mTLS）。
所有测试需要环境变量正确配置（见 conftest.py），否则自动 skip。

运行方式：
    export GROUP_API_URL=https://mq-auth:9007
    export TLS_CERT_FILE=/path/to/leader.pem
    export TLS_KEY_FILE=/path/to/leader-key.pem
    export TLS_CA_CERT_FILE=/path/to/acps-root-ca.pem
    export E2E_LEADER_AIC=1.2.156.3088.1.1.XXXX.YYYYYY.ZZZZZZ.AAAA
    export E2E_MEMBER_AIC=1.2.156.3088.1.1.BBBB.CCCCCC.DDDDDD.EEEE
    uv run pytest tests/e2e/ -v -m e2e
"""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    import httpx

_LEADER_AIC = os.environ.get("E2E_LEADER_AIC", "")
_MEMBER_AIC = os.environ.get("E2E_MEMBER_AIC", "")


@pytest.fixture(scope="module")
def skip_if_no_e2e_aics() -> None:
    """如果未配置 Leader / Member AIC，跳过 Group API e2e 测试。"""
    if not _LEADER_AIC or not _MEMBER_AIC:
        pytest.skip("E2E_LEADER_AIC / E2E_MEMBER_AIC 未配置 — 跳过 Group API e2e 测试")


@pytest.fixture
def unique_group_id() -> str:
    """每个测试使用独立的 group_id 避免状态污染。"""
    return f"e2e-test-{uuid.uuid4().hex[:8]}"


class TestGroupCrudLifecycle:
    """群组 CRUD 生命周期的 e2e 验证。"""

    def test_add_member_returns_204(
        self,
        mtls_client: httpx.Client,
        group_api_url: str,
        skip_if_no_e2e_aics: None,
        unique_group_id: str,
    ) -> None:
        """PUT /groups/{leader}/{group}/members/{member} 应返回 204。"""
        url = f"{group_api_url}/groups/{_LEADER_AIC}/{unique_group_id}/members/{_MEMBER_AIC}"
        response = mtls_client.put(url)
        assert response.status_code == 204

    def test_delete_group_returns_204(
        self,
        mtls_client: httpx.Client,
        group_api_url: str,
        skip_if_no_e2e_aics: None,
        unique_group_id: str,
    ) -> None:
        """
        完整 add → delete 生命周期：
        1. 添加成员
        2. 删除群组
        两步均应返回 204。
        """
        base_url = f"{group_api_url}/groups/{_LEADER_AIC}/{unique_group_id}"

        # 1. 添加
        resp_add = mtls_client.put(f"{base_url}/members/{_MEMBER_AIC}")
        assert resp_add.status_code == 204

        # 2. 删除群组
        resp_del = mtls_client.delete(base_url)
        assert resp_del.status_code == 204

    def test_remove_member_returns_204(
        self,
        mtls_client: httpx.Client,
        group_api_url: str,
        skip_if_no_e2e_aics: None,
        unique_group_id: str,
    ) -> None:
        """add member → remove member 均应返回 204。"""
        base_url = f"{group_api_url}/groups/{_LEADER_AIC}/{unique_group_id}"

        # 添加
        mtls_client.put(f"{base_url}/members/{_MEMBER_AIC}")

        # 移除
        resp = mtls_client.delete(f"{base_url}/members/{_MEMBER_AIC}")
        assert resp.status_code == 204


class TestGroupApiAuthErrors:
    """Group API 鉴权和校验错误的 e2e 验证。"""

    def test_no_cert_returns_connection_error_or_403(
        self,
        tls_ca_cert_file: Path | None,
        group_api_url: str,
        skip_if_no_e2e_aics: None,
        unique_group_id: str,
    ) -> None:
        """不携带客户端证书时，服务端应拒绝连接（SSL 握手失败或 403）。"""
        # 不携带 cert，但仍然验证服务端证书
        import ssl

        import httpx

        ssl_ctx_no_cert = ssl.create_default_context(
            purpose=ssl.Purpose.SERVER_AUTH,
            cafile=str(tls_ca_cert_file),
        )
        client_no_cert = httpx.Client(
            verify=ssl_ctx_no_cert,
            timeout=5.0,
        )
        try:
            response = client_no_cert.put(
                f"{group_api_url}/groups/{_LEADER_AIC}/{unique_group_id}/members/{_MEMBER_AIC}"
            )
            # 若连接未被强制中断，HTTP 层应返回 403
            assert response.status_code == 403
        except httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError:
            # SSL 握手阶段被拒绝或 TLSv1.3 握手后连接被重置，均属预期行为
            pass

    def test_invalid_group_id_returns_422(
        self,
        mtls_client: httpx.Client,
        group_api_url: str,
        skip_if_no_e2e_aics: None,
    ) -> None:
        """路径中使用非法 group_id（含 "!"）应返回 422。"""
        url = f"{group_api_url}/groups/{_LEADER_AIC}/bad!group/members/{_MEMBER_AIC}"
        response = mtls_client.put(url)
        assert response.status_code == 422
