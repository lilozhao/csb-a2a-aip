"""端到端测试 fixtures：严格黑盒，只命中已部署实例。"""

import os
import ssl
import uuid
from collections.abc import AsyncGenerator
from pathlib import Path
from urllib.parse import urlparse, urlunparse

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db_session import AsyncSessionLocal
from tests.support.database import reset_database_state


@pytest.fixture(scope="session")
def e2e_base_url() -> str:
    """返回 E2E 目标服务地址；未配置时跳过黑盒测试。"""
    base_url = os.getenv("TEST_E2E_BASE_URL", "").strip()
    if not base_url:
        pytest.skip("未设置 TEST_E2E_BASE_URL，跳过黑盒端到端测试")
    return base_url.rstrip("/")


@pytest.fixture(scope="session")
def e2e_mtls_base_url(e2e_base_url: str) -> str:
    """返回 E2E mTLS 平面地址；未显式配置时尝试从公共地址派生 9002。"""
    explicit_base_url = os.getenv("TEST_E2E_MTLS_BASE_URL", "").strip()
    if explicit_base_url:
        parsed_explicit_url = urlparse(explicit_base_url)
        if parsed_explicit_url.scheme != "https":
            pytest.fail("TEST_E2E_MTLS_BASE_URL 必须使用 https 协议")
        return explicit_base_url.rstrip("/")

    parsed_url = urlparse(e2e_base_url)
    if parsed_url.port is None:
        pytest.skip("未设置 TEST_E2E_MTLS_BASE_URL，且无法从 TEST_E2E_BASE_URL 派生 9002 端口")

    derived_netloc = f"{parsed_url.hostname}:9002"
    if parsed_url.username and parsed_url.password:
        derived_netloc = f"{parsed_url.username}:{parsed_url.password}@{derived_netloc}"
    elif parsed_url.username:
        derived_netloc = f"{parsed_url.username}@{derived_netloc}"

    return urlunparse(parsed_url._replace(scheme="https", netloc=derived_netloc)).rstrip("/")


def _resolve_mtls_path(env_name: str, default_path: str) -> Path:
    return Path(os.getenv(env_name, default_path)).expanduser()


@pytest.fixture(scope="session")
def mtls_client_ssl_context() -> ssl.SSLContext:
    """构建黑盒 E2E mTLS 客户端使用的 SSL 上下文。"""

    cert_path = _resolve_mtls_path("TEST_E2E_MTLS_CLIENT_CERT_FILE", "certs/client.pem")
    key_path = _resolve_mtls_path("TEST_E2E_MTLS_CLIENT_KEY_FILE", "certs/client.key")
    ca_path = _resolve_mtls_path("TEST_E2E_MTLS_CA_CERT_FILE", "certs/trust-bundle.pem")

    missing_paths = [str(path) for path in (cert_path, key_path, ca_path) if not path.is_file()]
    if missing_paths:
        pytest.skip("缺少 E2E mTLS 客户端证书材料，请先执行 just prep certs：" + ", ".join(missing_paths))

    ssl_context = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
    ssl_context.minimum_version = ssl.TLSVersion.TLSv1_3
    ssl_context.verify_mode = ssl.CERT_REQUIRED
    ssl_context.check_hostname = True
    ssl_context.load_verify_locations(cafile=str(ca_path))
    ssl_context.load_cert_chain(certfile=str(cert_path), keyfile=str(key_path))
    return ssl_context


@pytest.fixture(scope="session")
def e2e_run_id() -> str:
    """提供当前 E2E 运行的唯一前缀。"""
    return uuid.uuid4().hex[:8]


@pytest.fixture(autouse=True)
async def isolated_database() -> AsyncGenerator[None]:
    """在每个黑盒用例前后清理共享测试数据库。"""

    await reset_database_state()
    yield
    await reset_database_state()


@pytest.fixture
async def db_session() -> AsyncGenerator[AsyncSession]:
    """提供给黑盒测试准备数据的真实数据库会话。"""

    async with AsyncSessionLocal() as session:
        yield session


@pytest.fixture
async def client(e2e_base_url: str) -> AsyncGenerator[AsyncClient]:
    """黑盒 E2E HTTP 客户端。"""
    async with AsyncClient(base_url=e2e_base_url, trust_env=False) as e2e_client:
        yield e2e_client


@pytest.fixture
async def mtls_client(
    e2e_mtls_base_url: str,
    mtls_client_ssl_context: ssl.SSLContext,
) -> AsyncGenerator[AsyncClient]:
    """黑盒 E2E mTLS 平面 HTTPS 客户端。"""
    async with AsyncClient(
        base_url=e2e_mtls_base_url,
        verify=mtls_client_ssl_context,
        trust_env=False,
    ) as e2e_client:
        yield e2e_client
