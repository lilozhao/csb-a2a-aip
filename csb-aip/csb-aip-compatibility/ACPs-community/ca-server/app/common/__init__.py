"""
公共模块

包含多个功能模块共享的模型、服务、模式等组件。
"""

from .certificate_model import (
    Certificate,
    CertificateStatus,
    CertificateType,
    RevocationReason,
)
from .certificate_schema import (
    CertificateBase,
    CertificateCreate,
    CertificateListResponse,
    CertificateResponse,
    CertificateUpdate,
    CreateIntermediateCertificateRequest,
    CreateRootCertificateRequest,
    ErrorResponse,
    PagedResponse,
)
from .certificate_service import CertificateService
from .certificate_version import get_next_certificate_version

# CRL相关
from .crl_model import CRL, CRLStatus, RevokedCertificateEntry
from .crl_schema import (
    CRLCreateRequest,
    CRLDetailResponse,
    CRLDistributionPointsResponse,
    CRLInfoResponse,
    CRLListResponse,
    CRLResponse,
    RevokedCertificateInfo,
)
from .crl_service import CRLService

# OCSP相关
from .ocsp_model import (
    OCSPRequest,
    OCSPResponder,
    OCSPResponse,
    OCSPResponseStatus,
)
from .ocsp_schema import (
    OCSPBatchRequest,
    OCSPBatchResponse,
    OCSPCreateResponderRequest,
    OCSPResponderInfo,
    OCSPResponderResponse,
    OCSPSingleRequest,
    OCSPSingleResponse,
    OCSPStatsResponse,
)
from .ocsp_service import OCSPService
from .time_utils import (
    BEIJING_TZ,
    beijing_end_of_day,
    beijing_now,
    days_until_expiry,
    format_datetime,
    is_expired,
)

__all__ = [
    # Certificate Models
    "Certificate",
    "CertificateStatus",
    "CertificateType",
    "RevocationReason",
    # Certificate Services
    "CertificateService",
    # Certificate Schemas
    "CertificateBase",
    "CertificateCreate",
    "CertificateUpdate",
    "CertificateResponse",
    "CertificateListResponse",
    "PagedResponse",
    "ErrorResponse",
    "CreateRootCertificateRequest",
    "CreateIntermediateCertificateRequest",
    # CRL Models
    "CRL",
    "CRLStatus",
    "RevokedCertificateEntry",
    # CRL Services
    "CRLService",
    # CRL Schemas
    "CRLInfoResponse",
    "CRLDistributionPointsResponse",
    "RevokedCertificateInfo",
    "CRLCreateRequest",
    "CRLDetailResponse",
    "CRLResponse",
    "CRLListResponse",
    # OCSP Models
    "OCSPRequest",
    "OCSPResponse",
    "OCSPResponder",
    "OCSPResponseStatus",
    # OCSP Services
    "OCSPService",
    # OCSP Schemas
    "OCSPSingleRequest",
    "OCSPBatchRequest",
    "OCSPSingleResponse",
    "OCSPBatchResponse",
    "OCSPResponderInfo",
    "OCSPCreateResponderRequest",
    "OCSPResponderResponse",
    "OCSPStatsResponse",
    # Utils
    "BEIJING_TZ",
    "beijing_now",
    "beijing_end_of_day",
    "format_datetime",
    "is_expired",
    "days_until_expiry",
    "get_next_certificate_version",
]
