"""
OCSP (Online Certificate Status Protocol) 相关的Pydantic Schema
"""

from datetime import datetime
from typing import Any
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field

from .certificate_model import RevocationReason
from .ocsp_model import OCSPResponseStatus


class OCSPSingleRequest(BaseModel):
    """单个OCSP请求"""

    model_config = ConfigDict(extra="forbid")

    serial_number: str = Field(..., description="证书序列号")
    issuer_key_hash: str = Field(..., description="签发者密钥哈希")
    issuer_name_hash: str | None = Field(None, description="签发者名称哈希")
    hash_algorithm: str = Field(default="sha1", description="哈希算法")


class OCSPBatchRequest(BaseModel):
    """批量OCSP请求"""

    model_config = ConfigDict(extra="forbid")

    certificates: list[OCSPSingleRequest] = Field(..., description="证书列表")


class OCSPSingleResponse(BaseModel):
    """单个OCSP响应"""

    model_config = ConfigDict(from_attributes=True)

    serial_number: str = Field(..., description="证书序列号")
    status: OCSPResponseStatus = Field(..., description="证书状态")
    this_update: datetime = Field(..., description="本次更新时间")
    next_update: datetime | None = Field(None, description="下次更新时间")
    revocation_time: datetime | None = Field(None, description="吊销时间")
    revocation_reason: RevocationReason | None = Field(None, description="吊销原因")


class OCSPBatchResponse(BaseModel):
    """批量OCSP响应"""

    model_config = ConfigDict(from_attributes=True)

    responses: list[OCSPSingleResponse] = Field(..., description="响应列表")
    responder_id: str = Field(..., description="响应者ID")
    produced_at: datetime = Field(..., description="生成时间")


class OCSPResponderInfo(BaseModel):
    """OCSP响应器信息"""

    model_config = ConfigDict(from_attributes=True)

    responder: dict[str, Any] = Field(..., description="响应器信息")
    service_info: dict[str, Any] = Field(..., description="服务信息")
    endpoints: dict[str, str] = Field(..., description="服务端点")


class OCSPCreateResponderRequest(BaseModel):
    """创建OCSP响应器请求"""

    model_config = ConfigDict(extra="forbid")

    name: str = Field(..., description="响应器名称")
    certificate_pem: str = Field(..., description="响应器证书PEM")
    private_key_pem: str = Field(..., description="响应器私钥PEM")
    endpoints: dict[str, Any] = Field(..., description="服务端点配置")
    max_request_size: int = Field(1048576, ge=1024, le=10485760, description="最大请求大小（字节）")
    response_timeout_seconds: int = Field(30, ge=1, le=300, description="响应超时时间（秒）")
    supported_extensions: list[str] = Field(default=["nonce"], description="支持的扩展")


class OCSPResponderResponse(BaseModel):
    """OCSP响应器响应"""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    name: str
    certificate_serial: str
    is_active: bool
    endpoints: dict[str, Any]
    max_request_size: int
    response_timeout_seconds: int
    supported_extensions: list[str]
    created_at: datetime
    updated_at: datetime


class OCSPStatsResponse(BaseModel):
    """OCSP统计响应"""

    total_requests: int = Field(..., description="总请求数")
    good_responses: int = Field(..., description="良好状态响应数")
    valid_responses: int = Field(..., description="有效响应数")
    revoked_responses: int = Field(..., description="吊销响应数")
    unknown_responses: int = Field(..., description="未知状态响应数")
    average_response_time_ms: float = Field(..., description="平均响应时间（毫秒）")
    last_24h_requests: int = Field(..., description="最近24小时请求数")


class ErrorResponse(BaseModel):
    """错误响应"""

    error: str
    detail: str | None = None
    code: str | None = None
