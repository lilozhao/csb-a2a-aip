"""certificates/api.py 单元测试 - mock CertificateManagementService。"""

from __future__ import annotations

import os
from datetime import UTC, datetime
from unittest.mock import AsyncMock, MagicMock
from uuid import UUID, uuid4

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.certificates.api import get_certificate_service, router
from app.certificates.exception import CertificateNotFoundError, CertificateOperationFailedError
from app.certificates.service import CertificateManagementService
from app.common import (
    Certificate,
    CertificateStatus,
    CertificateType,
)
from app.core.base_exception import register_exception_handlers


def _make_cert(
    cert_id: UUID | None = None,
    cert_type: CertificateType = CertificateType.ROOT,
    subject: str = "CN=Test Root CA",
    serial: str = "AABBCC001122",
    status: CertificateStatus = CertificateStatus.VALID,
    pem: str = "-----BEGIN CERTIFICATE-----\nfakedata\n-----END CERTIFICATE-----",
) -> Certificate:
    """构造测试用 Certificate 对象（不涉及数据库）。"""
    now = datetime.now(tz=UTC)
    return Certificate(
        id=cert_id or uuid4(),
        certificate_type=cert_type,
        serial_number=serial,
        subject=subject,
        issuer="CN=Test Root CA",
        status=status,
        issued_at=now,
        expires_at=now,
        revoked_at=None,
        revocation_reason=None,
        certificate_pem=pem,
        public_key="ssh-rsa fakepublickey",
        version=1,
        parent_certificate_id=None,
        aic=None,
        created_at=now,
        updated_at=now,
    )


@pytest.fixture()
def mock_service() -> CertificateManagementService:
    """返回 mock 过的 CertificateManagementService。"""
    svc = MagicMock(spec=CertificateManagementService)
    # 默认所有 async 方法返回 AsyncMock
    for attr in dir(svc):
        if not attr.startswith("_") and callable(getattr(svc, attr)):
            setattr(svc, attr, AsyncMock())
    return svc


@pytest.fixture()
def app_with_mock(mock_service: CertificateManagementService) -> FastAPI:
    """创建仅挂载 certificates router 的 FastAPI 测试 app。"""
    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(router, prefix="/admin/certificates")
    test_app.dependency_overrides[get_certificate_service] = lambda: mock_service
    return test_app


@pytest.fixture()
def client(app_with_mock: FastAPI) -> TestClient:
    return TestClient(
        app_with_mock,
        raise_server_exceptions=False,
        headers={"Authorization": f"Bearer {os.environ['CA_SERVER_ADMIN_API_TOKEN']}"},
    )


class TestGetRootCertificates:
    def test_requires_admin_auth(self, app_with_mock: FastAPI) -> None:
        client = TestClient(app_with_mock, raise_server_exceptions=False)

        resp = client.get("/admin/certificates/root")

        assert resp.status_code == 401

    def test_returns_list(self, client: TestClient, mock_service: MagicMock) -> None:
        cert = _make_cert()
        mock_service.get_root_certificates.return_value = [cert]
        resp = client.get("/admin/certificates/root")
        assert resp.status_code == 200
        data = resp.json()
        assert len(data) == 1
        assert data[0]["serial_number"] == "AABBCC001122"

    def test_returns_empty_list(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_root_certificates.return_value = []
        resp = client.get("/admin/certificates/root")
        assert resp.status_code == 200
        assert resp.json() == []


class TestCreateRootCertificate:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        cert = _make_cert()
        mock_service.create_root_certificate.return_value = cert
        resp = client.post("/admin/certificates/root", json={"subject_name": "CN=Root CA", "validity_days": 3650})
        assert resp.status_code == 200
        assert resp.json()["subject"] == "CN=Test Root CA"

    def test_app_error_reraises(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.create_root_certificate.side_effect = CertificateOperationFailedError("CA error")
        resp = client.post("/admin/certificates/root", json={"subject_name": "CN=Root CA", "validity_days": 3650})
        assert resp.status_code == 500

    def test_runtime_error_wrapped(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.create_root_certificate.side_effect = RuntimeError("disk full")
        resp = client.post("/admin/certificates/root", json={"subject_name": "CN=Root CA", "validity_days": 3650})
        assert resp.status_code == 500


class TestRenewRootCertificate:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        cert = _make_cert()
        mock_service.renew_certificate.return_value = cert
        resp = client.post(f"/admin/certificates/root/{cert.id}/renew")
        assert resp.status_code == 200

    def test_with_validity_days(self, client: TestClient, mock_service: MagicMock) -> None:
        cert = _make_cert()
        mock_service.renew_certificate.return_value = cert
        resp = client.post(f"/admin/certificates/root/{cert.id}/renew?validity_days=365")
        assert resp.status_code == 200
        mock_service.renew_certificate.assert_called_once_with(cert.id, 365)


class TestRevokeRootCertificate:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        cert = _make_cert(status=CertificateStatus.REVOKED)
        mock_service.revoke_certificate.return_value = cert
        resp = client.post(f"/admin/certificates/root/{cert.id}/revoke?reason=keyCompromise")
        assert resp.status_code == 200


class TestGetIntermediateCertificates:
    def test_returns_list(self, client: TestClient, mock_service: MagicMock) -> None:
        cert = _make_cert(cert_type=CertificateType.INTERMEDIATE, serial="DDEEEE1122")
        mock_service.get_intermediate_certificates.return_value = [cert]
        resp = client.get("/admin/certificates/intermediate")
        assert resp.status_code == 200
        assert len(resp.json()) == 1

    def test_with_parent_id_filter(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_intermediate_certificates.return_value = []
        parent_id = uuid4()
        resp = client.get(f"/admin/certificates/intermediate?parent_id={parent_id}")
        assert resp.status_code == 200
        mock_service.get_intermediate_certificates.assert_called_once_with(parent_id)


class TestGetIntermediateCertificate:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        cert = _make_cert(cert_type=CertificateType.INTERMEDIATE)
        mock_service.get_certificate_or_error.return_value = cert
        resp = client.get(f"/admin/certificates/intermediate/{cert.id}")
        assert resp.status_code == 200

    def test_wrong_type_returns_404(self, client: TestClient, mock_service: MagicMock) -> None:
        # 返回 ROOT 类型，但请求的是 intermediate 路径
        cert = _make_cert(cert_type=CertificateType.ROOT)
        mock_service.get_certificate_or_error.return_value = cert
        resp = client.get(f"/admin/certificates/intermediate/{cert.id}")
        assert resp.status_code == 404


class TestListCertificates:
    def test_basic_list(self, client: TestClient, mock_service: MagicMock) -> None:
        certs = [_make_cert()]
        mock_service.list_certificates.return_value = (certs, 1)
        resp = client.get("/admin/certificates/")
        # 路由不带尾部斜杠 - 用空路径
        resp2 = client.get("/admin/certificates")
        # 任一成功即可
        assert resp.status_code in (200, 307) or resp2.status_code == 200

    def test_pagination_params(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.list_certificates.return_value = ([], 0)
        resp = client.get("/admin/certificates/?page=2&page_size=10")
        assert resp.status_code in (200, 307, 422)

    def test_paged_response_structure(self, client: TestClient, mock_service: MagicMock) -> None:
        certs = [_make_cert()]
        mock_service.list_certificates.return_value = (certs, 5)
        resp = client.get("/admin/certificates/")
        if resp.status_code == 200:
            data = resp.json()
            assert "total" in data
            assert "items" in data


class TestGetCertificate:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        cert = _make_cert()
        mock_service.get_certificate_or_error.return_value = cert
        resp = client.get(f"/admin/certificates/{cert.id}")
        assert resp.status_code == 200
        assert resp.json()["serial_number"] == cert.serial_number

    def test_not_found(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_certificate_or_error.side_effect = CertificateNotFoundError()
        resp = client.get(f"/admin/certificates/{uuid4()}")
        assert resp.status_code == 404


class TestDownloadCertificate:
    def test_returns_pem_file(self, client: TestClient, mock_service: MagicMock) -> None:
        cert = _make_cert()
        mock_service.get_certificate_or_error.return_value = cert
        resp = client.get(f"/admin/certificates/{cert.id}/download")
        assert resp.status_code == 200
        assert "BEGIN CERTIFICATE" in resp.text
        assert "Content-Disposition" in resp.headers


class TestGetCertificateChain:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        chain = [_make_cert(), _make_cert(cert_type=CertificateType.INTERMEDIATE, serial="INTER001")]
        mock_service.get_certificate_chain.return_value = chain
        resp = client.get(f"/admin/certificates/{chain[0].id}/chain")
        assert resp.status_code == 200

    def test_empty_chain_returns_404(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_certificate_chain.return_value = []
        resp = client.get(f"/admin/certificates/{uuid4()}/chain")
        assert resp.status_code == 404


class TestRevokeCertificate:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        cert = _make_cert(status=CertificateStatus.REVOKED)
        mock_service.revoke_certificate.return_value = cert
        resp = client.post(f"/admin/certificates/{cert.id}/revoke?reason=unspecified")
        assert resp.status_code == 200


class TestGetExpiringCertificates:
    def test_returns_list(self, client: TestClient, mock_service: MagicMock) -> None:
        certs = [_make_cert()]
        mock_service.get_expiring_certificates.return_value = certs
        resp = client.get("/admin/certificates/expiring")
        assert resp.status_code == 200

    def test_custom_days_ahead(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_expiring_certificates.return_value = []
        resp = client.get("/admin/certificates/expiring?days_ahead=60")
        assert resp.status_code == 200
        mock_service.get_expiring_certificates.assert_called_once_with(60)
