"""CRL 模块业务异常定义"""

from enum import StrEnum

from app.core.base_exception import AppError


class CRLErrorCode(StrEnum):
    """CRL 模块错误码"""

    CRL_NOT_FOUND = "CRL_NOT_FOUND"
    CRL_GENERATION_FAILED = "CRL_GENERATION_FAILED"
    CRL_REFRESH_FAILED = "CRL_REFRESH_FAILED"
    CRL_DETAIL_RETRIEVAL_FAILED = "CRL_DETAIL_RETRIEVAL_FAILED"


class CRLNotFoundError(AppError):
    """CRL 不存在"""

    def __init__(self, detail: str = "CRL not found.") -> None:
        super().__init__(
            code=CRLErrorCode.CRL_NOT_FOUND,
            title="CRL not found",
            detail=detail,
            status_code=404,
        )


class CRLGenerationFailedError(AppError):
    """CRL 生成失败"""

    def __init__(self, detail: str = "Failed to generate CRL.") -> None:
        super().__init__(
            code=CRLErrorCode.CRL_GENERATION_FAILED,
            title="CRL generation failed",
            detail=detail,
            status_code=500,
        )


class CRLRefreshFailedError(AppError):
    """CRL 刷新失败"""

    def __init__(self, detail: str = "Failed to refresh CRL.") -> None:
        super().__init__(
            code=CRLErrorCode.CRL_REFRESH_FAILED,
            title="CRL refresh failed",
            detail=detail,
            status_code=500,
        )


class CRLDetailRetrievalFailedError(AppError):
    """CRL 详情查询失败"""

    def __init__(self, detail: str = "Failed to retrieve CRL detail.") -> None:
        super().__init__(
            code=CRLErrorCode.CRL_DETAIL_RETRIEVAL_FAILED,
            title="CRL detail retrieval failed",
            detail=detail,
            status_code=500,
        )
