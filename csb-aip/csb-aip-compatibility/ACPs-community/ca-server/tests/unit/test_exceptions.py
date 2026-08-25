"""测试业务异常类（certificates/crl/ocsp exception）。"""

from __future__ import annotations

import pytest

from app.acme.exception import AcmeError, AcmeException
from app.certificates.exception import (
    CertificateErrorCode,
    CertificateNotFoundError,
    CertificateOperationFailedError,
    CertificateRetrievalFailedError,
    InvalidAICFormatError,
    InvalidCertificatePEMFormatError,
    InvalidParentCertificateError,
    InvalidRevocationReasonCodeError,
    TrustBundleRetrievalFailedError,
)
from app.crl.exception import (
    CRLDetailRetrievalFailedError,
    CRLErrorCode,
    CRLGenerationFailedError,
    CRLNotFoundError,
    CRLRefreshFailedError,
)
from app.ocsp.exception import (
    OCSPCertificateStatusRetrievalFailedError,
    OCSPErrCode,
    OCSPInvalidContentTypeError,
    OCSPInvalidRequestError,
    OCSPProcessingFailedError,
    OCSPResponderNotFoundError,
    OCSPStatisticsRetrievalFailedError,
)

# ---------- AcmeException ----------


class TestAcmeException:
    def test_default_values(self) -> None:
        exc = AcmeException()
        assert exc.status_code == 400
        assert exc.error_name == "acme_error"

    def test_custom_status_code(self) -> None:
        exc = AcmeException(status_code=403, error_name=AcmeError.UNAUTHORIZED, error_msg="forbidden")
        assert exc.status_code == 403

    def test_error_name_stored(self) -> None:
        exc = AcmeException(error_name=AcmeError.BAD_NONCE)
        assert exc.error_name == AcmeError.BAD_NONCE

    def test_error_group_is_acme(self) -> None:
        exc = AcmeException()
        assert exc.extensions["error_group"] == "acme"

    def test_is_exception(self) -> None:
        exc = AcmeException(error_name=AcmeError.SERVER_INTERNAL, error_msg="server error")
        with pytest.raises(AcmeException):
            raise exc


class TestAcmeError:
    def test_all_expected_error_codes_present(self) -> None:
        expected_codes = [
            "BAD_NONCE",
            "BAD_SIGNATURE",
            "MALFORMED",
            "UNAUTHORIZED",
            "SERVER_INTERNAL",
            "RATE_LIMITED",
            "UNSUPPORTED_ALGORITHM",
            "EXTERNAL_ACCOUNT_REQUIRED",
        ]
        for code in expected_codes:
            assert hasattr(AcmeError, code), f"AcmeError missing: {code}"


# ---------- CertificateErrorCode & Exceptions ----------


class TestCertificateExceptions:
    def test_not_found_default_status(self) -> None:
        exc = CertificateNotFoundError()
        assert exc.status_code == 404

    def test_not_found_custom_detail(self) -> None:
        exc = CertificateNotFoundError(detail="cert abc not found")
        assert "abc" in exc.detail

    def test_invalid_parent_status(self) -> None:
        exc = InvalidParentCertificateError()
        assert exc.status_code == 400

    def test_invalid_aic_status(self) -> None:
        exc = InvalidAICFormatError()
        assert exc.status_code == 400

    def test_invalid_revocation_reason_status(self) -> None:
        exc = InvalidRevocationReasonCodeError()
        assert exc.status_code == 400

    def test_invalid_pem_status(self) -> None:
        exc = InvalidCertificatePEMFormatError()
        assert exc.status_code == 400

    def test_operation_failed_is_500(self) -> None:
        exc = CertificateOperationFailedError()
        assert exc.status_code == 500

    def test_retrieval_failed_is_500(self) -> None:
        exc = CertificateRetrievalFailedError()
        assert exc.status_code == 500

    def test_trust_bundle_retrieval_failed_is_500(self) -> None:
        exc = TrustBundleRetrievalFailedError()
        assert exc.status_code == 500

    def test_error_codes_are_str_enum(self) -> None:
        assert CertificateErrorCode.CERTIFICATE_NOT_FOUND == "CERTIFICATE_NOT_FOUND"
        assert CertificateErrorCode.INVALID_AIC_FORMAT == "INVALID_AIC_FORMAT"

    def test_exception_code_matches_enum(self) -> None:
        exc = CertificateNotFoundError()
        assert exc.code == CertificateErrorCode.CERTIFICATE_NOT_FOUND


# ---------- CRL Exceptions ----------


class TestCRLExceptions:
    def test_not_found_is_404(self) -> None:
        exc = CRLNotFoundError()
        assert exc.status_code == 404

    def test_generation_failed_is_500(self) -> None:
        exc = CRLGenerationFailedError()
        assert exc.status_code == 500

    def test_refresh_failed_is_500(self) -> None:
        exc = CRLRefreshFailedError()
        assert exc.status_code == 500

    def test_detail_retrieval_failed_is_500(self) -> None:
        exc = CRLDetailRetrievalFailedError()
        assert exc.status_code == 500

    def test_custom_detail(self) -> None:
        exc = CRLNotFoundError(detail="no crl for issuer X")
        assert "issuer X" in exc.detail

    def test_error_codes_str_enum(self) -> None:
        assert CRLErrorCode.CRL_NOT_FOUND == "CRL_NOT_FOUND"
        assert CRLErrorCode.CRL_GENERATION_FAILED == "CRL_GENERATION_FAILED"


# ---------- OCSP Exceptions ----------


class TestOCSPExceptions:
    def test_invalid_content_type_is_415(self) -> None:
        exc = OCSPInvalidContentTypeError()
        assert exc.status_code == 415

    def test_invalid_request_is_400(self) -> None:
        exc = OCSPInvalidRequestError()
        assert exc.status_code == 400

    def test_processing_failed_is_400(self) -> None:
        exc = OCSPProcessingFailedError()
        assert exc.status_code == 400

    def test_responder_not_found_is_404(self) -> None:
        exc = OCSPResponderNotFoundError()
        assert exc.status_code == 404

    def test_statistics_failed_is_500(self) -> None:
        exc = OCSPStatisticsRetrievalFailedError()
        assert exc.status_code == 500

    def test_cert_status_retrieval_failed_is_500(self) -> None:
        exc = OCSPCertificateStatusRetrievalFailedError()
        assert exc.status_code == 500

    def test_custom_content_type_detail(self) -> None:
        exc = OCSPInvalidContentTypeError(detail="got text/plain")
        assert "text/plain" in exc.detail

    def test_error_codes_str_enum(self) -> None:
        assert OCSPErrCode.OCSP_INVALID_CONTENT_TYPE == "OCSP_INVALID_CONTENT_TYPE"
        assert OCSPErrCode.OCSP_INVALID_REQUEST == "OCSP_INVALID_REQUEST"
