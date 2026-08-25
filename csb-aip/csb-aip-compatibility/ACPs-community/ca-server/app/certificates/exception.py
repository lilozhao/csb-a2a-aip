"""证书模块业务异常定义"""

from enum import StrEnum

from app.core.base_exception import AppError


class CertificateErrorCode(StrEnum):
    """证书模块错误码"""

    CERTIFICATE_NOT_FOUND = "CERTIFICATE_NOT_FOUND"
    INVALID_PARENT_CERTIFICATE = "INVALID_PARENT_CERTIFICATE"
    INVALID_AIC_FORMAT = "INVALID_AIC_FORMAT"
    INVALID_REVOCATION_REASON_CODE = "INVALID_REVOCATION_REASON_CODE"
    INVALID_CERTIFICATE_PEM_FORMAT = "INVALID_CERTIFICATE_PEM_FORMAT"
    CERTIFICATE_OPERATION_FAILED = "CERTIFICATE_OPERATION_FAILED"
    CERTIFICATE_RETRIEVAL_FAILED = "CERTIFICATE_RETRIEVAL_FAILED"
    TRUST_BUNDLE_RETRIEVAL_FAILED = "TRUST_BUNDLE_RETRIEVAL_FAILED"


class CertificateNotFoundError(AppError):
    """证书不存在"""

    def __init__(self, detail: str = "Certificate not found.") -> None:
        super().__init__(
            code=CertificateErrorCode.CERTIFICATE_NOT_FOUND,
            title="Certificate not found",
            detail=detail,
            status_code=404,
        )


class InvalidParentCertificateError(AppError):
    """父证书不存在或不可用"""

    def __init__(self, detail: str = "Parent certificate is missing or invalid.") -> None:
        super().__init__(
            code=CertificateErrorCode.INVALID_PARENT_CERTIFICATE,
            title="Invalid parent certificate",
            detail=detail,
            status_code=400,
        )


class InvalidAICFormatError(AppError):
    """AIC 格式无效"""

    def __init__(self, detail: str = "Invalid AIC format.") -> None:
        super().__init__(
            code=CertificateErrorCode.INVALID_AIC_FORMAT,
            title="Invalid AIC format",
            detail=detail,
            status_code=400,
        )


class InvalidRevocationReasonCodeError(AppError):
    """吊销原因码无效"""

    def __init__(self, detail: str = "Invalid revocation reason code.") -> None:
        super().__init__(
            code=CertificateErrorCode.INVALID_REVOCATION_REASON_CODE,
            title="Invalid revocation reason code",
            detail=detail,
            status_code=400,
        )


class InvalidCertificatePEMFormatError(AppError):
    """证书 PEM 格式无效"""

    def __init__(self, detail: str = "Invalid certificate PEM format.") -> None:
        super().__init__(
            code=CertificateErrorCode.INVALID_CERTIFICATE_PEM_FORMAT,
            title="Invalid certificate PEM format",
            detail=detail,
            status_code=400,
        )


class CertificateOperationFailedError(AppError):
    """证书操作执行失败"""

    def __init__(self, detail: str = "Certificate operation failed.") -> None:
        super().__init__(
            code=CertificateErrorCode.CERTIFICATE_OPERATION_FAILED,
            title="Certificate operation failed",
            detail=detail,
            status_code=500,
        )


class CertificateRetrievalFailedError(AppError):
    """证书检索失败"""

    def __init__(self, detail: str = "Failed to retrieve certificate.") -> None:
        super().__init__(
            code=CertificateErrorCode.CERTIFICATE_RETRIEVAL_FAILED,
            title="Certificate retrieval failed",
            detail=detail,
            status_code=500,
        )


class TrustBundleRetrievalFailedError(AppError):
    """信任包获取失败"""

    def __init__(self, detail: str = "Failed to retrieve trust bundle.") -> None:
        super().__init__(
            code=CertificateErrorCode.TRUST_BUNDLE_RETRIEVAL_FAILED,
            title="Trust bundle retrieval failed",
            detail=detail,
            status_code=500,
        )
