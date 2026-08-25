"""OCSP（在线证书状态协议）ORM 模型：OCSPResponse 表及相关枚举定义"""

from datetime import datetime
from enum import StrEnum
from typing import Any, ClassVar
from uuid import UUID, uuid7

from sqlalchemy import DateTime as SADateTime
from sqlmodel import JSON, Column, Field, SQLModel

from .certificate_model import RevocationReason
from .time_utils import beijing_now


def _aware_datetime_type() -> Any:
    """返回带时区的 datetime SQLAlchemy 类型"""
    return SADateTime(timezone=True)


class OCSPResponseStatus(StrEnum):
    """OCSP响应状态枚举 - 遵循 RFC 6960 + 扩展"""

    GOOD = "good"  # 0 - 证书有效
    REVOKED = "revoked"  # 1 - 证书已吊销
    UNKNOWN = "unknown"  # 2 - 证书状态未知
    EXPIRED = "expired"  # 扩展状态 - 证书已过期

    def to_asn1_code(self) -> int:
        """转换为ASN.1状态代码"""
        mapping = {
            self.GOOD: 0,
            self.REVOKED: 1,
            self.UNKNOWN: 2,
            self.EXPIRED: 2,  # Map expired to UNKNOWN in ASN.1
        }
        return mapping[self]

    @classmethod
    def from_asn1_code(cls, code: int) -> OCSPResponseStatus:
        """从ASN.1状态代码转换"""
        mapping = {
            0: cls.GOOD,
            1: cls.REVOKED,
            2: cls.UNKNOWN,
        }
        return mapping.get(code, cls.UNKNOWN)


class OCSPRequest(SQLModel, table=True):
    """OCSP请求记录"""

    __tablename__: ClassVar[str] = "ocsp_requests"

    # 基本字段
    id: UUID = Field(default_factory=uuid7, primary_key=True)
    request_id: str = Field(unique=True, index=True, description="请求唯一标识")

    # 请求信息
    certificate_serial: str = Field(index=True, description="证书序列号")
    issuer_key_hash: str = Field(description="签发者密钥哈希")
    issuer_name_hash: str = Field(description="签发者名称哈希")
    hash_algorithm: str = Field(description="哈希算法")

    # 请求来源
    client_ip: str | None = Field(default=None, description="客户端IP")
    user_agent: str | None = Field(default=None, description="用户代理")

    # 请求内容
    request_der: bytes = Field(description="DER格式的OCSP请求")

    # 元数据
    created_at: datetime = Field(default_factory=beijing_now, sa_type=_aware_datetime_type(), description="创建时间")


class OCSPResponse(SQLModel, table=True):
    """OCSP响应记录"""

    __tablename__: ClassVar[str] = "ocsp_responses"

    # 基本字段
    id: UUID = Field(default_factory=uuid7, primary_key=True)
    request_id: UUID = Field(foreign_key="ocsp_requests.id", description="关联的请求ID")

    # 响应信息
    certificate_serial: str = Field(index=True, description="证书序列号")
    cert_status: OCSPResponseStatus = Field(description="证书状态")

    # 时间信息
    this_update: datetime = Field(sa_type=_aware_datetime_type(), description="本次更新时间")
    next_update: datetime | None = Field(default=None, sa_type=_aware_datetime_type(), description="下次更新时间")

    # 吊销信息（仅当状态为revoked时）
    revocation_time: datetime | None = Field(default=None, sa_type=_aware_datetime_type(), description="吊销时间")
    revocation_reason: RevocationReason | None = Field(default=None, description="吊销原因")

    # 响应者信息
    responder_id: str = Field(description="OCSP响应者ID")
    responder_key_hash: str = Field(description="响应者密钥哈希")

    # 响应内容
    response_der: bytes = Field(description="DER格式的OCSP响应")
    response_size: int = Field(description="响应大小（字节）")

    # 签名信息
    signature_algorithm: str = Field(description="签名算法")

    # 性能指标
    processing_time_ms: int = Field(description="处理时间（毫秒）")

    # 元数据
    created_at: datetime = Field(default_factory=beijing_now, sa_type=_aware_datetime_type(), description="创建时间")


class OCSPResponder(SQLModel, table=True):
    """OCSP响应器配置"""

    __tablename__: ClassVar[str] = "ocsp_responders"

    # 基本字段
    id: UUID = Field(default_factory=uuid7, primary_key=True)
    name: str = Field(unique=True, description="响应器名称")

    # 响应器证书信息
    certificate_pem: str = Field(description="响应器证书PEM")
    private_key_pem: str = Field(description="响应器私钥PEM")
    certificate_serial: str = Field(description="响应器证书序列号")

    # 配置信息
    is_active: bool = Field(default=True, description="是否激活")
    endpoints: dict[str, Any] = Field(sa_column=Column(JSON), description="服务端点配置")

    # 服务配置
    max_request_size: int = Field(default=1048576, description="最大请求大小")
    response_timeout_seconds: int = Field(default=30, description="响应超时时间")
    supported_extensions: list[str] = Field(sa_column=Column(JSON), description="支持的扩展")

    # 元数据
    created_at: datetime = Field(default_factory=beijing_now, sa_type=_aware_datetime_type(), description="创建时间")
    updated_at: datetime = Field(default_factory=beijing_now, sa_type=_aware_datetime_type(), description="更新时间")
