"""ocsp/api.py 单元测试 - mock OCSPService。"""

from __future__ import annotations

import base64
from datetime import UTC, datetime
from typing import Any
from unittest.mock import AsyncMock, MagicMock

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.common import OCSPResponseStatus
from app.common.ocsp_service import OCSPService
from app.core.base_exception import register_exception_handlers
from app.core.config import get_settings
from app.core.public_access import PUBLIC_READ_RATE_LIMITER
from app.ocsp.api import get_ocsp_service, router
from app.ocsp.exception import (
    OCSPInvalidRequestError,
    OCSPProcessingFailedError,
    OCSPResponderNotFoundError,
    OCSPStatisticsRetrievalFailedError,
)


@pytest.fixture()
def mock_service() -> OCSPService:
    svc = MagicMock(spec=OCSPService)
    for attr in dir(svc):
        if not attr.startswith("_") and callable(getattr(svc, attr)):
            setattr(svc, attr, AsyncMock())
    return svc


@pytest.fixture()
def app_with_mock(mock_service: OCSPService) -> Any:
    test_app = FastAPI()
    register_exception_handlers(test_app)
    test_app.include_router(router, prefix="/acps-atr-v2/ocsp")
    test_app.dependency_overrides[get_ocsp_service] = lambda: mock_service
    return test_app


@pytest.fixture()
def client(app_with_mock: Any) -> TestClient:
    return TestClient(app_with_mock, raise_server_exceptions=False)


def _now() -> datetime:
    return datetime.now(tz=UTC)


def _build_ocsp_response_der() -> bytes:
    issuer_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    issuer_subject = x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "Test CA")])
    issuer_cert = (
        x509.CertificateBuilder()
        .subject_name(issuer_subject)
        .issuer_name(issuer_subject)
        .public_key(issuer_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(_now())
        .not_valid_after(_now())
        .sign(issuer_key, hashes.SHA256())
    )

    leaf_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    leaf_cert = (
        x509.CertificateBuilder()
        .subject_name(x509.Name([x509.NameAttribute(x509.NameOID.COMMON_NAME, "leaf")]))
        .issuer_name(issuer_cert.subject)
        .public_key(leaf_key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(_now())
        .not_valid_after(_now())
        .sign(issuer_key, hashes.SHA256())
    )

    builder = x509.ocsp.OCSPResponseBuilder()
    builder = builder.add_response(
        cert=leaf_cert,
        issuer=issuer_cert,
        algorithm=hashes.SHA1(),
        cert_status=x509.ocsp.OCSPCertStatus.GOOD,
        this_update=_now(),
        next_update=_now(),
        revocation_time=None,
        revocation_reason=None,
    )
    builder = builder.responder_id(x509.ocsp.OCSPResponderEncoding.HASH, issuer_cert)
    builder = builder.certificates([issuer_cert])
    response = builder.sign(private_key=issuer_key, algorithm=hashes.SHA256())
    return response.public_bytes(serialization.Encoding.DER)


class TestOCSPBatchRequest:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.batch_check_certificates.return_value = [
            {
                "serial_number": "AABB",
                "status": OCSPResponseStatus.GOOD,
                "this_update": _now(),
                "next_update": _now(),
                "revocation_time": None,
                "revocation_reason": None,
            }
        ]
        mock_service.get_active_responder.return_value = None

        payload = {"certificates": [{"serial_number": "AABB", "issuer_key_hash": "CCDD"}]}
        resp = client.post("/acps-atr-v2/ocsp/batch", json=payload)
        assert resp.status_code == 200
        data = resp.json()
        assert len(data["responses"]) == 1
        assert data["responses"][0]["serial_number"] == "AABB"

    def test_with_active_responder(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.batch_check_certificates.return_value = []
        responder = MagicMock()
        responder.name = "My OCSP Responder"
        mock_service.get_active_responder.return_value = responder

        payload = {"certificates": [{"serial_number": "0001", "issuer_key_hash": "AABB"}]}
        resp = client.post("/acps-atr-v2/ocsp/batch", json=payload)
        assert resp.status_code == 200
        assert resp.json()["responder_id"] == "My OCSP Responder"

    def test_runtime_error_wrapped(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.batch_check_certificates.side_effect = RuntimeError("DB down")
        payload = {"certificates": [{"serial_number": "0001", "issuer_key_hash": "AABB"}]}
        resp = client.post("/acps-atr-v2/ocsp/batch", json=payload)
        assert resp.status_code == 400

    def test_app_error_reraises(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.batch_check_certificates.side_effect = OCSPProcessingFailedError()
        payload = {"certificates": [{"serial_number": "0001", "issuer_key_hash": "AABB"}]}
        resp = client.post("/acps-atr-v2/ocsp/batch", json=payload)
        assert resp.status_code == 400

    def test_invalid_body_returns_422(self, client: TestClient, mock_service: MagicMock) -> None:
        resp = client.post("/acps-atr-v2/ocsp/batch", json={"invalid": "data"})
        assert resp.status_code == 422


class TestGetOCSPResponderInfo:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_responder_info.return_value = {
            "responder": {"name": "Test CA OCSP", "is_active": True},
            "service_info": {"version": "1.0"},
            "endpoints": {"ocsp": "http://example.com/ocsp"},
        }
        resp = client.get("/acps-atr-v2/ocsp/responder/info")
        assert resp.status_code == 200
        data = resp.json()
        assert data["responder"]["name"] == "Test CA OCSP"

    def test_not_found_error(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_responder_info.side_effect = OCSPResponderNotFoundError("not found")
        resp = client.get("/acps-atr-v2/ocsp/responder/info")
        assert resp.status_code == 404

    def test_runtime_error_wrapped(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_responder_info.side_effect = RuntimeError("cert load failed")
        resp = client.get("/acps-atr-v2/ocsp/responder/info")
        assert resp.status_code == 404


class TestGetOCSPStatistics:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_ocsp_statistics.return_value = {
            "total_requests": 100,
            "good_responses": 90,
            "valid_responses": 90,
            "revoked_responses": 5,
            "unknown_responses": 5,
            "average_response_time_ms": 12.5,
            "last_24h_requests": 20,
        }
        resp = client.get("/acps-atr-v2/ocsp/stats")
        assert resp.status_code == 200
        data = resp.json()
        assert data["total_requests"] == 100

    def test_runtime_error_wrapped(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_ocsp_statistics.side_effect = RuntimeError("stats unavailable")
        resp = client.get("/acps-atr-v2/ocsp/stats")
        assert resp.status_code == 500

    def test_app_error_reraises(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_ocsp_statistics.side_effect = OCSPStatisticsRetrievalFailedError()
        resp = client.get("/acps-atr-v2/ocsp/stats")
        assert resp.status_code == 500


class TestOCSPRequestPost:
    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.process_ocsp_request.return_value = (_build_ocsp_response_der(), 5)
        resp = client.post(
            "/acps-atr-v2/ocsp",
            content=b"\x30\x01\x02",
            headers={"Content-Type": "application/ocsp-request"},
        )
        assert resp.status_code == 200
        assert resp.headers["cache-control"].startswith("max-age=")
        assert resp.headers["etag"].startswith('"')
        assert "expires" in resp.headers
        assert "last-modified" in resp.headers
        assert resp.headers["x-processing-time-ms"] == "5"

    def test_wrong_content_type_returns_415(self, client: TestClient, mock_service: MagicMock) -> None:
        resp = client.post(
            "/acps-atr-v2/ocsp",
            content=b"\x30\x01\x02",
            headers={"Content-Type": "application/json"},
        )
        assert resp.status_code == 415

    def test_empty_body_returns_400(self, client: TestClient, mock_service: MagicMock) -> None:
        resp = client.post(
            "/acps-atr-v2/ocsp",
            content=b"",
            headers={"Content-Type": "application/ocsp-request"},
        )
        assert resp.status_code == 400

    def test_runtime_error_wrapped(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.process_ocsp_request.side_effect = RuntimeError("parse failed")
        resp = client.post(
            "/acps-atr-v2/ocsp",
            content=b"\x30\x01\x02",
            headers={"Content-Type": "application/ocsp-request"},
        )
        assert resp.status_code == 400

    def test_app_error_reraises(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.process_ocsp_request.side_effect = OCSPInvalidRequestError("bad format")
        resp = client.post(
            "/acps-atr-v2/ocsp",
            content=b"\x30\x01\x02",
            headers={"Content-Type": "application/ocsp-request"},
        )
        assert resp.status_code == 400


class TestOCSPRequestGet:
    def _encode_request(self, data: bytes = b"\x30\x82\x00\x01") -> str:
        return base64.urlsafe_b64encode(data).rstrip(b"=").decode()

    def test_success(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.process_ocsp_request.return_value = (_build_ocsp_response_der(), 3)
        encoded = self._encode_request()
        resp = client.get(f"/acps-atr-v2/ocsp/{encoded}")
        assert resp.status_code == 200
        assert resp.headers["cache-control"].startswith("max-age=")
        assert resp.headers["etag"].startswith('"')
        assert "expires" in resp.headers
        assert "last-modified" in resp.headers
        assert resp.headers["x-processing-time-ms"] == "3"

    def test_rate_limit_applies_across_different_request_paths(
        self,
        app_with_mock: Any,
        mock_service: MagicMock,
    ) -> None:
        client = TestClient(app_with_mock, raise_server_exceptions=False)
        settings_mock = MagicMock()
        settings_mock.public_read_rate_limit_requests = 1
        settings_mock.public_read_rate_limit_window_seconds = 60
        settings_mock.public_read_retry_after_seconds = 30
        app_with_mock.dependency_overrides[get_settings] = lambda: settings_mock
        PUBLIC_READ_RATE_LIMITER.reset()
        mock_service.process_ocsp_request.return_value = (_build_ocsp_response_der(), 3)

        first = client.get(f"/acps-atr-v2/ocsp/{self._encode_request(b'first-request')}")
        second = client.get(f"/acps-atr-v2/ocsp/{self._encode_request(b'second-request')}")

        assert first.status_code == 200
        assert second.status_code == 429
        assert second.headers["retry-after"] == "60"
        app_with_mock.dependency_overrides.pop(get_settings, None)

    def test_runtime_error_wrapped(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.process_ocsp_request.side_effect = RuntimeError("parse error")
        encoded = self._encode_request()
        resp = client.get(f"/acps-atr-v2/ocsp/{encoded}")
        assert resp.status_code == 400

    def test_app_error_reraises(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.process_ocsp_request.side_effect = OCSPInvalidRequestError()
        encoded = self._encode_request()
        resp = client.get(f"/acps-atr-v2/ocsp/{encoded}")
        assert resp.status_code == 400


class TestGetCertificateStatus:
    def test_returns_status(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_certificate_status.return_value = {
            "serialNumber": "AABB",
            "certificateStatus": "good",
            "thisUpdate": _now().isoformat(),
            "nextUpdate": _now().isoformat(),
        }
        resp = client.get("/acps-atr-v2/ocsp/certificate/AABB")
        assert resp.status_code == 200
        data = resp.json()
        assert data["serialNumber"] == "AABB"

    def test_not_found_returns_unknown(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_certificate_status.return_value = None
        resp = client.get("/acps-atr-v2/ocsp/certificate/NOTEXIST")
        assert resp.status_code == 200
        data = resp.json()
        assert data["certificateStatus"] == "unknown"

    def test_runtime_error_wrapped(self, client: TestClient, mock_service: MagicMock) -> None:
        mock_service.get_certificate_status.side_effect = RuntimeError("DB error")
        resp = client.get("/acps-atr-v2/ocsp/certificate/AABB")
        assert resp.status_code == 500
