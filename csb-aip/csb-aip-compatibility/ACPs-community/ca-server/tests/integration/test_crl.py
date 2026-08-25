"""
CRL (Certificate Revocation List) 测试

测试CRL的创建、更新、查询和下载功能
"""

import asyncio
from datetime import timedelta
from uuid import uuid4

import pytest
from cryptography import x509
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.common import (
    Certificate,
    CertificateStatus,
    CRLService,
    CRLStatus,
    RevocationReason,
    beijing_now,
)
from app.core.ca_manager import get_ca_manager
from app.core.db_session import engine
from app.main import app

pytestmark = pytest.mark.crl


@pytest.fixture
def db_session():
    """数据库会话fixture"""
    with Session(engine) as session:
        yield session


@pytest.fixture
async def crl_service(async_db_session):
    """CRL服务fixture"""
    return CRLService(async_db_session)


@pytest.fixture
def sample_certificate(db_session):
    """创建示例证书"""
    # 生成符合标准的16进制序列号
    serial_hex = f"{1001:04X}{uuid4().hex[:12].upper()}"

    cert = Certificate(
        certificate_type="user",
        serial_number=serial_hex,
        subject="CN=test.example.com,O=Test Org,C=CN",
        issuer="CN=Test CA,O=Test CA,C=CN",
        status=CertificateStatus.VALID,
        issued_at=beijing_now(),
        expires_at=beijing_now() + timedelta(days=365),
        certificate_pem="-----BEGIN CERTIFICATE-----\nTEST_CERT\n-----END CERTIFICATE-----",
        public_key="TEST_PUBLIC_KEY",
    )
    db_session.add(cert)
    db_session.commit()
    db_session.refresh(cert)
    return cert


@pytest.fixture
def revoked_certificate(db_session):
    """创建已吊销证书"""
    # 生成符合标准的16进制序列号
    serial_hex = f"{9999:04X}{uuid4().hex[:12].upper()}"

    cert = Certificate(
        certificate_type="user",
        serial_number=serial_hex,
        subject="CN=revoked.example.com,O=Test Org,C=CN",
        issuer="CN=Test CA,O=Test CA,C=CN",
        status=CertificateStatus.REVOKED,
        issued_at=beijing_now() - timedelta(days=30),
        expires_at=beijing_now() + timedelta(days=335),
        revoked_at=beijing_now() - timedelta(days=1),
        revocation_reason=RevocationReason.KEY_COMPROMISE,
        certificate_pem="-----BEGIN CERTIFICATE-----\nREVOKED_CERT\n-----END CERTIFICATE-----",
        public_key="REVOKED_PUBLIC_KEY",
    )
    db_session.add(cert)
    db_session.commit()
    db_session.refresh(cert)
    return cert


class TestCRLGeneration:
    """测试CRL生成功能"""

    async def test_generate_new_crl_empty(self, crl_service, clean_db) -> None:
        """测试生成空CRL（无吊销证书）"""
        crl = await crl_service.generate_new_crl(issuer="CN=Test CA,O=Test CA,C=CN", next_update_hours=24)

        assert crl is not None
        assert crl.status == CRLStatus.CURRENT
        assert crl.revoked_certificates_count == 0
        assert crl.crl_pem.startswith("-----BEGIN X509 CRL-----")
        assert crl.crl_pem.strip().endswith("-----END X509 CRL-----")

    async def test_generate_new_crl_with_revoked_cert(self, crl_service, revoked_certificate, clean_db) -> None:
        """测试生成包含吊销证书的CRL"""
        crl = await crl_service.generate_new_crl(issuer="CN=Test CA,O=Test CA,C=CN", next_update_hours=24)

        assert crl is not None
        assert crl.status == CRLStatus.CURRENT
        assert crl.revoked_certificates_count == 1
        assert crl.crl_pem.startswith("-----BEGIN X509 CRL-----")

    async def test_generate_new_crl_includes_authority_key_identifier(self, crl_service, clean_db) -> None:
        """测试生成的 CRL 包含 AuthorityKeyIdentifier 扩展。"""
        crl = await crl_service.generate_new_crl(issuer="CN=Test CA,O=Test CA,C=CN", next_update_hours=24)

        parsed_crl = x509.load_der_x509_crl(crl.crl_der)
        authority_key_identifier = parsed_crl.extensions.get_extension_for_class(x509.AuthorityKeyIdentifier).value
        crl_number = parsed_crl.extensions.get_extension_for_class(x509.CRLNumber).value

        ca_cert = get_ca_manager().ca_cert
        assert ca_cert is not None
        ca_subject_key_identifier = ca_cert.extensions.get_extension_for_class(x509.SubjectKeyIdentifier).value

        assert authority_key_identifier.key_identifier == ca_subject_key_identifier.digest
        assert crl_number.crl_number == crl.crl_number

    async def test_crl_version_format(self, crl_service, clean_db) -> None:
        """测试CRL版本号格式"""
        crl = await crl_service.generate_new_crl(issuer="CN=Test CA")

        # 版本号应该是YYYYMMDDHHMMSS + 毫秒格式
        assert len(crl.version) == 17
        assert crl.version.isdigit()

        # 检查年份部分（前4位）
        current_year = beijing_now().year
        version_year = int(crl.version[:4])
        assert version_year == current_year

    async def test_crl_number_increment(self, crl_service, clean_db) -> None:
        """测试CRL编号递增"""
        # 添加微小延迟确保版本号不同
        crl1 = await crl_service.generate_new_crl(issuer="CN=Test CA")
        await asyncio.sleep(0.01)
        crl2 = await crl_service.generate_new_crl(issuer="CN=Test CA")

        assert crl2.crl_number == crl1.crl_number + 1
        assert crl1.version != crl2.version

    async def test_old_crl_superseded(self, crl_service, clean_db) -> None:
        """测试旧CRL被正确标记为已取代"""
        # 生成第一个CRL
        crl1 = await crl_service.generate_new_crl(issuer="CN=Test CA")
        assert crl1.status == CRLStatus.CURRENT

        # 添加延迟确保版本号不同
        await asyncio.sleep(0.01)
        # 生成第二个CRL
        crl2 = await crl_service.generate_new_crl(issuer="CN=Test CA")
        assert crl2.status == CRLStatus.CURRENT

        # 刷新第一个CRL的状态
        await crl_service.db.refresh(crl1)
        assert crl1.status == CRLStatus.SUPERSEDED


class TestCRLQuery:
    """测试CRL查询功能"""

    async def test_get_current_crl(self, crl_service, clean_db) -> None:
        """测试获取当前CRL"""
        # 生成一个CRL
        created_crl = await crl_service.generate_new_crl(issuer="CN=Test CA")

        # 查询当前CRL
        current_crl = await crl_service.get_current_crl()

        assert current_crl is not None
        assert current_crl.id == created_crl.id
        assert current_crl.status == CRLStatus.CURRENT

    async def test_get_crl_by_number(self, crl_service, clean_db) -> None:
        """测试根据编号获取CRL"""
        # 生成一个CRL
        created_crl = await crl_service.generate_new_crl(issuer="CN=Test CA")

        # 根据编号查询
        found_crl = await crl_service.get_crl_by_number(created_crl.crl_number)

        assert found_crl is not None
        assert found_crl.id == created_crl.id
        assert found_crl.crl_number == created_crl.crl_number


class TestCRLAPI:
    """测试CRL API接口"""

    @pytest.fixture
    def client(self):
        with TestClient(app) as client:
            yield client

    async def test_download_crl_default(self, client, crl_service, clean_db) -> None:
        """测试默认下载CRL (DER格式)"""
        # 生成CRL
        await crl_service.generate_new_crl(issuer="CN=Test CA")
        await crl_service.db.commit()

        response = client.get("/acps-atr-v2/crl")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pkix-crl"
        assert response.headers["cache-control"] == "max-age=3600"
        assert "expires" in response.headers
        assert "etag" in response.headers
        assert "last-modified" in response.headers
        # DER编码通常以0x30开头 (SEQUENCE)
        assert response.content.startswith(b"\x30")

    async def test_download_crl_pem(self, client, crl_service, clean_db) -> None:
        """测试下载PEM格式CRL"""
        # 生成CRL
        await crl_service.generate_new_crl(issuer="CN=Test CA")
        await crl_service.db.commit()

        response = client.get("/acps-atr-v2/crl?format=pem")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/x-pem-file"
        assert b"BEGIN X509 CRL" in response.content

    async def test_get_current_crl_api(self, client, crl_service, clean_db) -> None:
        """测试获取当前CRL接口"""
        await crl_service.generate_new_crl(issuer="CN=Test CA")
        await crl_service.db.commit()

        response = client.get("/acps-atr-v2/crl/current")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/pkix-crl"
        assert "expires" in response.headers

    async def test_get_crl_info(self, client, crl_service, clean_db) -> None:
        """测试获取CRL信息"""
        await crl_service.generate_new_crl(issuer="CN=Test CA")
        await crl_service.db.commit()

        response = client.get("/acps-atr-v2/crl/info")
        assert response.status_code == 200
        data = response.json()
        assert "version" in data
        assert "issuer" in data
        assert "this_update" in data
        assert "next_update" in data
