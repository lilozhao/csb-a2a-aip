"""certificates/api_ext.py 单元测试 - mock CertificateManagementService + get_ca_manager。"""

from __future__ import annotations

import os
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.certificates.api_ext import (
    get_certificate_service,
    get_revocation_reason_text,
    router,
)
from app.certificates.exception import (
    CertificateNotFoundError,
    InvalidAICFormatError,
    InvalidCertificatePEMFormatError,
    TrustBundleRetrievalFailedError,
)
from app.core.base_exception import register_exception_handlers
from app.core.config import get_settings
from app.core.public_access import PUBLIC_READ_RATE_LIMITER


@pytest.fixture()
def mock_service() -> Any:
    svc = MagicMock()
    svc.revoke_certificates_by_aic = AsyncMock(return_value=2)
    svc.retrieve_certificate_by_aic_and_version = AsyncMock()
    svc.retrieve_certificate_by_cert = AsyncMock()
    return svc


@pytest.fixture()
def app_with_mock(mock_service: Any) -> Any:
    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(router, prefix="/acps-atr-v2/certificates")
    test_app.dependency_overrides[get_certificate_service] = lambda: mock_service
    return test_app


@pytest.fixture()
def client(app_with_mock: Any) -> TestClient:
    return TestClient(
        app_with_mock,
        raise_server_exceptions=False,
        headers={"Authorization": f"Bearer {os.environ['CA_SERVER_INTERNAL_API_TOKEN']}"},
    )


def _make_cert(aic: str = "AIC-001", pem: str = "---BEGIN CERTIFICATE---", version: int = 1) -> Any:
    cert = MagicMock()
    cert.aic = aic
    cert.certificate_pem = pem
    cert.version = version
    return cert


class TestGetRevocationReasonText:
    def test_known_codes(self) -> None:
        assert get_revocation_reason_text(0) == "unspecified"
        assert get_revocation_reason_text(1) == "keyCompromise"
        assert get_revocation_reason_text(2) == "cACompromise"
        assert get_revocation_reason_text(3) == "affiliationChanged"
        assert get_revocation_reason_text(4) == "superseded"
        assert get_revocation_reason_text(5) == "cessationOfOperation"

    def test_unknown_code_returns_unspecified(self) -> None:
        assert get_revocation_reason_text(99) == "unspecified"
        assert get_revocation_reason_text(-1) == "unspecified"


class TestGetTrustBundle:
    def test_public_route_allows_request_without_auth(self, app_with_mock: Any) -> None:
        client = TestClient(app_with_mock, raise_server_exceptions=False)
        mock_ca = MagicMock()
        mock_ca.get_trust_bundle_pem.return_value = b"-----BEGIN CERTIFICATE-----\n..."

        with patch("app.certificates.api_ext.get_ca_manager", return_value=mock_ca):
            resp = client.get("/acps-atr-v2/certificates/trust-bundle")

        assert resp.status_code == 200

    def test_success(self, client: TestClient) -> None:
        mock_ca = MagicMock()
        mock_ca.get_trust_bundle_pem.return_value = b"-----BEGIN CERTIFICATE-----\n..."
        with patch("app.certificates.api_ext.get_ca_manager", return_value=mock_ca):
            resp = client.get("/acps-atr-v2/certificates/trust-bundle")
        assert resp.status_code == 200
        assert resp.headers["content-type"].startswith("application/x-pem-file")
        assert resp.headers["cache-control"] == "public, max-age=3600, no-transform, must-revalidate"
        assert resp.headers["etag"].startswith('"')
        assert "last-modified" in resp.headers

    def test_runtime_error_wrapped(self, client: TestClient) -> None:
        with patch("app.certificates.api_ext.get_ca_manager", side_effect=RuntimeError("cert load failed")):
            resp = client.get("/acps-atr-v2/certificates/trust-bundle")
        assert resp.status_code == 500

    def test_app_error_reraises(self, client: TestClient) -> None:
        mock_ca = MagicMock()
        mock_ca.get_trust_bundle_pem.side_effect = TrustBundleRetrievalFailedError()
        with patch("app.certificates.api_ext.get_ca_manager", return_value=mock_ca):
            resp = client.get("/acps-atr-v2/certificates/trust-bundle")
        assert resp.status_code == 500

    def test_os_error_wrapped(self, client: TestClient) -> None:
        mock_ca = MagicMock()
        mock_ca.get_trust_bundle_pem.side_effect = OSError("file not found")
        with patch("app.certificates.api_ext.get_ca_manager", return_value=mock_ca):
            resp = client.get("/acps-atr-v2/certificates/trust-bundle")
        assert resp.status_code == 500

    def test_rate_limited_returns_429(self, app_with_mock: Any) -> None:
        client = TestClient(app_with_mock, raise_server_exceptions=False)
        mock_ca = MagicMock()
        mock_ca.get_trust_bundle_pem.return_value = b"-----BEGIN CERTIFICATE-----\n..."
        settings_mock = MagicMock()
        settings_mock.public_read_rate_limit_requests = 1
        settings_mock.public_read_rate_limit_window_seconds = 60
        settings_mock.public_read_retry_after_seconds = 30
        settings_mock.trust_bundle_path = "certs/trust-bundle.pem"
        PUBLIC_READ_RATE_LIMITER.reset()
        app_with_mock.dependency_overrides[get_settings] = lambda: settings_mock

        with (
            patch("app.certificates.api_ext.get_ca_manager", return_value=mock_ca),
        ):
            first = client.get("/acps-atr-v2/certificates/trust-bundle")
            second = client.get("/acps-atr-v2/certificates/trust-bundle")

        assert first.status_code == 200
        assert second.status_code == 429
        assert second.headers["retry-after"] == "60"
        app_with_mock.dependency_overrides.pop(get_settings, None)


class TestRevokeNotify:
    def test_requires_internal_service_auth(self, app_with_mock: Any) -> None:
        client = TestClient(app_with_mock, raise_server_exceptions=False)

        resp = client.post(
            "/acps-atr-v2/certificates/revoke-notify",
            json={"aic": "AIC-001", "reason": 1},
        )

        assert resp.status_code == 401

    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.revoke_certificates_by_aic.return_value = 3
        resp = client.post(
            "/acps-atr-v2/certificates/revoke-notify",
            json={"aic": "AIC-001", "reason": 1},
        )
        assert resp.status_code == 200
        data = resp.json()
        assert data["aic"] == "AIC-001"
        assert data["revocationReason"] == "keyCompromise"
        assert data["revokedCertCount"] == 3

    def test_empty_aic_returns_400(self, client: TestClient) -> None:
        resp = client.post(
            "/acps-atr-v2/certificates/revoke-notify",
            json={"aic": "", "reason": 0},
        )
        assert resp.status_code == 400

    def test_whitespace_aic_returns_400(self, client: TestClient) -> None:
        resp = client.post(
            "/acps-atr-v2/certificates/revoke-notify",
            json={"aic": "   ", "reason": 0},
        )
        assert resp.status_code == 400

    def test_reason_out_of_range_returns_400(self, client: TestClient) -> None:
        resp = client.post(
            "/acps-atr-v2/certificates/revoke-notify",
            json={"aic": "AIC-001", "reason": 6},
        )
        assert resp.status_code == 400

    def test_reason_negative_returns_400(self, client: TestClient) -> None:
        resp = client.post(
            "/acps-atr-v2/certificates/revoke-notify",
            json={"aic": "AIC-001", "reason": -1},
        )
        assert resp.status_code == 400

    def test_invalid_body_returns_422(self, client: TestClient) -> None:
        resp = client.post("/acps-atr-v2/certificates/revoke-notify", json={"aic": "AIC-001"})
        assert resp.status_code == 422

    def test_reason_0_unspecified(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.revoke_certificates_by_aic.return_value = 0
        resp = client.post(
            "/acps-atr-v2/certificates/revoke-notify",
            json={"aic": "AIC-001", "reason": 0},
        )
        assert resp.status_code == 200
        assert resp.json()["revocationReason"] == "unspecified"


class TestRetrieveAgentCertificateByAic:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.retrieve_certificate_by_aic_and_version.return_value = _make_cert(aic="AIC-001")
        resp = client.get("/acps-atr-v2/certificates/retrieve/aic/?aic=AIC-001")
        assert resp.status_code == 200
        data = resp.json()
        assert data["aic"] == "AIC-001"

    def test_with_version(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.retrieve_certificate_by_aic_and_version.return_value = _make_cert(aic="AIC-001", version=3)
        resp = client.get("/acps-atr-v2/certificates/retrieve/aic/?aic=AIC-001&version=3")
        assert resp.status_code == 200
        assert resp.json()["version"] == 3

    def test_empty_aic_returns_400(self, client: TestClient) -> None:
        resp = client.get("/acps-atr-v2/certificates/retrieve/aic/?aic=")
        assert resp.status_code == 400

    def test_not_found_returns_404(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.retrieve_certificate_by_aic_and_version.side_effect = CertificateNotFoundError()
        resp = client.get("/acps-atr-v2/certificates/retrieve/aic/?aic=AIC-999")
        assert resp.status_code == 404

    def test_invalid_aic_format_returns_400(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.retrieve_certificate_by_aic_and_version.side_effect = InvalidAICFormatError()
        resp = client.get("/acps-atr-v2/certificates/retrieve/aic/?aic=bad!!!")
        assert resp.status_code == 400


class TestRetrieveAgentCertificateByCert:
    _VALID_PEM = "-----BEGIN CERTIFICATE-----\nMIIB...\n-----END CERTIFICATE-----"

    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.retrieve_certificate_by_cert.return_value = _make_cert(aic="AIC-001")
        resp = client.post(
            "/acps-atr-v2/certificates/retrieve/cert",
            json={"cert_pem": self._VALID_PEM},
        )
        assert resp.status_code == 200
        assert resp.json()["aic"] == "AIC-001"

    def test_missing_cert_marker_returns_400(self, client: TestClient) -> None:
        resp = client.post(
            "/acps-atr-v2/certificates/retrieve/cert",
            json={"cert_pem": "not a pem"},
        )
        assert resp.status_code == 400

    def test_empty_cert_pem_returns_400(self, client: TestClient) -> None:
        resp = client.post(
            "/acps-atr-v2/certificates/retrieve/cert",
            json={"cert_pem": ""},
        )
        assert resp.status_code == 400

    def test_not_found_returns_404(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.retrieve_certificate_by_cert.side_effect = CertificateNotFoundError()
        resp = client.post(
            "/acps-atr-v2/certificates/retrieve/cert",
            json={"cert_pem": self._VALID_PEM},
        )
        assert resp.status_code == 404

    def test_app_error_reraises(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.retrieve_certificate_by_cert.side_effect = InvalidCertificatePEMFormatError()
        resp = client.post(
            "/acps-atr-v2/certificates/retrieve/cert",
            json={"cert_pem": self._VALID_PEM},
        )
        assert resp.status_code == 400
