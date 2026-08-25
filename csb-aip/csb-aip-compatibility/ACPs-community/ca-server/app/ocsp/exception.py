"""OCSP 模块业务异常定义"""

from enum import StrEnum

from app.core.base_exception import AppError


class OCSPErrCode(StrEnum):
    """OCSP 模块错误码"""

    OCSP_INVALID_CONTENT_TYPE = "OCSP_INVALID_CONTENT_TYPE"
    OCSP_INVALID_REQUEST = "OCSP_INVALID_REQUEST"
    OCSP_PROCESSING_FAILED = "OCSP_PROCESSING_FAILED"
    OCSP_RESPONDER_NOT_FOUND = "OCSP_RESPONDER_NOT_FOUND"
    OCSP_STATISTICS_RETRIEVAL_FAILED = "OCSP_STATISTICS_RETRIEVAL_FAILED"
    OCSP_CERT_STATUS_RETRIEVAL_FAILED = "OCSP_CERT_STATUS_RETRIEVAL_FAILED"


class OCSPInvalidContentTypeError(AppError):
    """OCSP 请求 Content-Type 无效"""

    def __init__(self, detail: str = "Invalid Content-Type. Expected application/ocsp-request.") -> None:
        super().__init__(
            code=OCSPErrCode.OCSP_INVALID_CONTENT_TYPE,
            title="Invalid OCSP content type",
            detail=detail,
            status_code=415,
        )


class OCSPInvalidRequestError(AppError):
    """OCSP 请求无效"""

    def __init__(self, detail: str = "Invalid OCSP request.") -> None:
        super().__init__(
            code=OCSPErrCode.OCSP_INVALID_REQUEST,
            title="Invalid OCSP request",
            detail=detail,
            status_code=400,
        )


class OCSPProcessingFailedError(AppError):
    """OCSP 请求处理失败"""

    def __init__(self, detail: str = "OCSP processing failed.") -> None:
        super().__init__(
            code=OCSPErrCode.OCSP_PROCESSING_FAILED,
            title="OCSP processing failed",
            detail=detail,
            status_code=400,
        )


class OCSPResponderNotFoundError(AppError):
    """OCSP 响应器不存在"""

    def __init__(self, detail: str = "No active OCSP responder found.") -> None:
        super().__init__(
            code=OCSPErrCode.OCSP_RESPONDER_NOT_FOUND,
            title="OCSP responder not found",
            detail=detail,
            status_code=404,
        )


class OCSPStatisticsRetrievalFailedError(AppError):
    """OCSP 统计查询失败"""

    def __init__(self, detail: str = "Failed to get OCSP statistics.") -> None:
        super().__init__(
            code=OCSPErrCode.OCSP_STATISTICS_RETRIEVAL_FAILED,
            title="OCSP statistics retrieval failed",
            detail=detail,
            status_code=500,
        )


class OCSPCertificateStatusRetrievalFailedError(AppError):
    """证书状态查询失败"""

    def __init__(self, detail: str = "Failed to get certificate status.") -> None:
        super().__init__(
            code=OCSPErrCode.OCSP_CERT_STATUS_RETRIEVAL_FAILED,
            title="Certificate status retrieval failed",
            detail=detail,
            status_code=500,
        )
