import os
from datetime import timedelta
from uuid import uuid4

from fastapi.testclient import TestClient
from sqlmodel import Session

from app.common import beijing_now
from app.common.certificate_model import Certificate, CertificateStatus, CertificateType


def _internal_auth_headers() -> dict[str, str]:
    return {"Authorization": f"Bearer {os.environ['CA_SERVER_INTERNAL_API_TOKEN']}"}


class TestExtensionAPI:
    """测试扩展API (Trust Bundle & Revoke Notify)"""

    def test_get_trust_bundle(self, anonymous_client: TestClient) -> None:
        """测试获取信任包"""
        response = anonymous_client.get("/acps-atr-v2/ca/trust-bundle")
        assert response.status_code == 200
        assert response.headers["content-type"] == "application/x-pem-file"
        assert response.headers["cache-control"] == "public, max-age=3600, no-transform, must-revalidate"
        assert response.headers["etag"].startswith('"')
        assert "last-modified" in response.headers
        assert len(response.content) > 0
        assert b"BEGIN CERTIFICATE" in response.content

    def test_revoke_notify_success(self, client: TestClient, db_session: Session) -> None:
        """测试成功的吊销通知"""
        # 1. 准备测试数据：创建一个属于特定AIC的有效证书
        aic = "1.2.156.3088.1.1.34C2.478BDF.3GF546.0156"  # 10 段点分 AIC + CRC16(含盐) 的 Base36 编码
        # 创建证书
        cert = Certificate(
            certificate_type=CertificateType.USER,
            serial_number=f"TEST{uuid4().hex[:12].upper()}",
            subject="CN=test.example.com",
            issuer="CN=Test CA",
            status=CertificateStatus.VALID,
            issued_at=beijing_now(),
            expires_at=beijing_now() + timedelta(days=365),
            certificate_pem="-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----",
            public_key="TEST_KEY",
            aic=aic,
        )
        db_session.add(cert)
        db_session.commit()
        db_session.refresh(cert)

        # 2. 发送吊销通知
        payload = {"aic": aic, "reason": 1}  # keyCompromise
        response = client.post("/acps-atr-v2/ca/revoke-notify", json=payload, headers=_internal_auth_headers())

        # 3. 验证响应
        assert response.status_code == 200
        data = response.json()
        assert data["aic"] == aic
        assert data["revocationReason"] == "keyCompromise"
        assert data["revokedCertCount"] == 1

        # 4. 验证数据库状态
        db_session.refresh(cert)
        assert cert.status == CertificateStatus.REVOKED
        assert cert.revocation_reason == "keyCompromise"

    def test_revoke_notify_invalid_aic(self, client: TestClient) -> None:
        """测试无效AIC格式（空字符串）"""
        payload = {"aic": "", "reason": 1}
        response = client.post("/acps-atr-v2/ca/revoke-notify", json=payload, headers=_internal_auth_headers())
        assert response.status_code == 400
        assert "Invalid AIC format" in response.json()["detail"]

    def test_revoke_notify_invalid_reason(self, client: TestClient) -> None:
        """测试无效吊销原因"""
        payload = {"aic": "test_aic_12345678901234567890123", "reason": 99}
        response = client.post("/acps-atr-v2/ca/revoke-notify", json=payload, headers=_internal_auth_headers())
        assert response.status_code == 400
        assert "Invalid revocation reason code" in response.json()["detail"]

    def test_revoke_notify_no_certs(self, client: TestClient) -> None:
        """测试AIC无证书的情况"""
        payload = {"aic": "empty_aic_1234567890123456789012", "reason": 1}
        response = client.post("/acps-atr-v2/ca/revoke-notify", json=payload, headers=_internal_auth_headers())
        assert response.status_code == 200
        assert response.json()["revokedCertCount"] == 0

    def test_retrieve_certificate_by_aic_success(self, client: TestClient, db_session: Session) -> None:
        """测试内部按 AIC 检索证书"""
        aic = "1.2.156.3088.1.1.34C2.478BDF.3GF546.0156"
        certificate_pem = "-----BEGIN CERTIFICATE-----\nRETRIEVE-BY-AIC\n-----END CERTIFICATE-----"
        cert = Certificate(
            certificate_type=CertificateType.USER,
            serial_number=f"RETAIC{uuid4().hex[:10].upper()}",
            subject="CN=retrieve-aic.example.com",
            issuer="CN=Test CA",
            status=CertificateStatus.VALID,
            issued_at=beijing_now(),
            expires_at=beijing_now() + timedelta(days=365),
            certificate_pem=certificate_pem,
            public_key="RETRIEVE_AIC_KEY",
            aic=aic,
            version=2,
        )
        db_session.add(cert)
        db_session.commit()

        response = client.get(
            f"/acps-atr-v2/ca/retrieve/aic/?aic={aic}&version=2",
            headers=_internal_auth_headers(),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["aic"] == aic
        assert data["version"] == 2
        assert data["cert"] == certificate_pem

    def test_retrieve_certificate_by_aic_requires_internal_auth(self, anonymous_client: TestClient) -> None:
        """测试内部按 AIC 检索必须携带内部服务令牌"""
        response = anonymous_client.get("/acps-atr-v2/ca/retrieve/aic/?aic=1.2.156.3088.1.1.34C2.478BDF.3GF546.0156")
        assert response.status_code == 401

    def test_retrieve_certificate_by_cert_success(self, client: TestClient, db_session: Session) -> None:
        """测试内部按证书内容检索证书"""
        aic = "1.2.156.3088.1.1.34C2.478BDF.3GF546.0156"
        certificate_pem = "-----BEGIN CERTIFICATE-----\nRETRIEVE-BY-CERT\n-----END CERTIFICATE-----"
        cert = Certificate(
            certificate_type=CertificateType.USER,
            serial_number=f"RETCERT{uuid4().hex[:8].upper()}",
            subject="CN=retrieve-cert.example.com",
            issuer="CN=Test CA",
            status=CertificateStatus.VALID,
            issued_at=beijing_now(),
            expires_at=beijing_now() + timedelta(days=365),
            certificate_pem=certificate_pem,
            public_key="RETRIEVE_CERT_KEY",
            aic=aic,
            version=3,
        )
        db_session.add(cert)
        db_session.commit()

        response = client.post(
            "/acps-atr-v2/ca/retrieve/cert",
            json={"cert_pem": certificate_pem},
            headers=_internal_auth_headers(),
        )

        assert response.status_code == 200
        data = response.json()
        assert data["aic"] == aic
        assert data["version"] == 3
        assert data["cert"] == certificate_pem

    def test_retrieve_certificate_by_cert_requires_internal_auth(self, anonymous_client: TestClient) -> None:
        """测试内部按证书内容检索必须携带内部服务令牌"""
        response = anonymous_client.post(
            "/acps-atr-v2/ca/retrieve/cert",
            json={"cert_pem": "-----BEGIN CERTIFICATE-----\nTEST\n-----END CERTIFICATE-----"},
        )
        assert response.status_code == 401
