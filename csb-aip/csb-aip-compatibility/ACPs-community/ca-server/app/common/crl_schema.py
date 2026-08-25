"""
CRL (Certificate Revocation List) 相关的Pydantic Schema
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .certificate_model import RevocationReason
from .crl_model import CRLStatus


class CRLInfoResponse(BaseModel):
    """CRL信息响应"""

    model_config = ConfigDict(from_attributes=True)

    version: str = Field(..., description="CRL版本号")
    issuer: str = Field(..., description="CRL签发者")
    this_update: datetime = Field(..., description="本次更新时间")
    next_update: datetime = Field(..., description="下次更新时间")
    revoked_certificates_count: int = Field(..., description="吊销证书数量")
    crl_size: int = Field(..., description="CRL大小（字节）")
    distribution_point: str = Field(..., description="主要分发点")
    signature: dict[str, Any] = Field(..., description="签名信息")


class CRLDistributionPointsResponse(BaseModel):
    """CRL分发点响应"""

    model_config = ConfigDict(from_attributes=True)

    primary: str = Field(..., description="主要分发点")
    mirrors: list[str] = Field(..., description="镜像分发点")
    update_interval: str = Field(..., description="更新间隔（ISO 8601 duration）")
    max_age: str = Field(..., description="最大缓存时间（ISO 8601 duration）")


class RevokedCertificateInfo(BaseModel):
    """吊销证书信息"""

    model_config = ConfigDict(from_attributes=True, populate_by_name=True)

    serial_number: str = Field(..., description="证书序列号", serialization_alias="serialNumber")
    revocation_date: datetime = Field(..., description="吊销时间", serialization_alias="revocationDate")
    revocation_reason: RevocationReason = Field(..., description="吊销原因", serialization_alias="reason")


class CRLDetailResponse(BaseModel):
    """CRL详细信息响应"""

    version: str
    issuer: str
    this_update: datetime = Field(..., serialization_alias="thisUpdate")
    next_update: datetime = Field(..., serialization_alias="nextUpdate")
    revoked_certificates: list[RevokedCertificateInfo] = Field(..., serialization_alias="revokedCertificates")
    revoked_certificates_count: int = Field(..., serialization_alias="revokedCertificatesCount")

    model_config = ConfigDict(populate_by_name=True)


class CRLCreateRequest(BaseModel):
    """创建CRL请求"""

    model_config = ConfigDict(extra="forbid")

    version: str | None = Field(None, description="CRL版本号，不提供则自动生成")
    issuer: str = Field(..., description="CRL签发者")
    next_update_hours: int = Field(24, ge=1, le=168, description="下次更新间隔小时数，默认24小时")
    distribution_points: list[str] = Field(..., description="CRL分发点")


class CRLResponse(BaseModel):
    """CRL响应"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    version: str
    crl_number: int
    issuer: str
    this_update: datetime
    next_update: datetime
    status: CRLStatus
    revoked_certificates_count: int
    crl_size: int
    distribution_points: list[str]
    signature_algorithm: str
    signature_key_id: str
    created_at: datetime


class CRLListResponse(BaseModel):
    """CRL列表响应"""

    items: list[CRLResponse]
    total: int
    page: int = Field(ge=1, description="当前页码")
    page_size: int = Field(ge=1, le=100, description="每页数量")
    total_pages: int


class ErrorResponse(BaseModel):
    """错误响应"""

    error: str
    detail: str | None = None
    code: str | None = None
