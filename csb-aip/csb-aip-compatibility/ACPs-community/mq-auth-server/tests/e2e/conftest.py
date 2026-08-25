"""端到端测试 fixtures。

命中已部署的真实实例，验证完整 mTLS 认证流程。
需要设置环境变量：
  - GROUP_API_URL:   Group API 地址（如 https://mq-auth:9007）
  - AUTH_API_URL:    Auth API 地址（如 https://mq-auth:9008）
  - TLS_CERT_FILE:   mTLS 客户端证书（PEM）
  - TLS_KEY_FILE:    mTLS 客户端私钥（PEM）
  - TLS_CA_CERT_FILE: CA 证书（验证服务端）

如果以上必要的 TLS 环境变量未配置，相关测试将自动 skip。
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path
from typing import TYPE_CHECKING

import pytest

if TYPE_CHECKING:
    import httpx


@pytest.fixture(scope="session")
def group_api_url() -> str:
    return os.environ.get("GROUP_API_URL", "https://localhost:9007")


@pytest.fixture(scope="session")
def auth_api_url() -> str:
    return os.environ.get("AUTH_API_URL", "https://localhost:9008")


@pytest.fixture(scope="session")
def tls_cert_file() -> Path | None:
    v = os.environ.get("TLS_CERT_FILE")
    return Path(v) if v else None


@pytest.fixture(scope="session")
def tls_key_file() -> Path | None:
    v = os.environ.get("TLS_KEY_FILE")
    return Path(v) if v else None


@pytest.fixture(scope="session")
def tls_ca_cert_file() -> Path | None:
    v = os.environ.get("TLS_CA_CERT_FILE")
    return Path(v) if v else None


@pytest.fixture(scope="session")
def mtls_configured(tls_cert_file: Path | None, tls_key_file: Path | None, tls_ca_cert_file: Path | None) -> bool:
    """若 mTLS 证书未配置，标记测试为 skip。"""
    if not tls_cert_file or not tls_key_file or not tls_ca_cert_file:
        pytest.skip("mTLS 环境变量未配置 — 跳过 e2e 测试")
    if not tls_cert_file.exists() or not tls_key_file.exists() or not tls_ca_cert_file.exists():
        pytest.skip("mTLS 证书文件不存在 — 跳过 e2e 测试")
    return True


@pytest.fixture
def mtls_client(
    mtls_configured: bool,
    tls_cert_file: Path | None,
    tls_key_file: Path | None,
    tls_ca_cert_file: Path | None,
) -> Iterator[httpx.Client]:
    """使用 mTLS 证书的 httpx.Client（同步）。

    注意：httpx 0.28+ 中 verify=str + cert=tuple 的组合会触发 DeprecationWarning，
    且 cert= 参数在该路径下会被忽略（verify=str 分支提前 return，导致客户端证书未加载）。
    必须手动构建 ssl.SSLContext 并通过 verify=ssl_context 传入。

    这里按测试用例创建独立客户端，避免复用已被临时服务端关闭的 keep-alive 连接。
    """
    import ssl

    import httpx

    assert mtls_configured
    assert tls_cert_file is not None
    assert tls_key_file is not None
    assert tls_ca_cert_file is not None

    ssl_context = ssl.create_default_context(
        purpose=ssl.Purpose.SERVER_AUTH,
        cafile=str(tls_ca_cert_file),
    )
    ssl_context.load_cert_chain(
        certfile=str(tls_cert_file),
        keyfile=str(tls_key_file),
    )

    with httpx.Client(
        verify=ssl_context,
        timeout=10.0,
    ) as client:
        yield client
