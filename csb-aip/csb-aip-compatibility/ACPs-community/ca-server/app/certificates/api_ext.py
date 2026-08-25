"""扩展 API 路由：实现 ATR-DESIGN 第四章规范，包括信任包获取与被动吊销通知"""

import hashlib
from datetime import UTC, datetime
from email.utils import format_datetime as format_http_datetime
from pathlib import Path
from typing import Annotated

from fastapi import APIRouter, Body, Depends, Query, Response
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import beijing_now, format_datetime
from app.core.auth import require_internal_service_auth
from app.core.base_exception import AppError
from app.core.ca_manager import get_ca_manager
from app.core.config import get_settings
from app.core.db_session import get_async_session
from app.core.public_access import limit_public_read_access

from .exception import (
    CertificateRetrievalFailedError,
    InvalidAICFormatError,
    InvalidCertificatePEMFormatError,
    InvalidRevocationReasonCodeError,
    TrustBundleRetrievalFailedError,
)
from .service import CertificateManagementService


class RetrieveResponse(BaseModel):
    """检索响应模型"""

    aic: str  # Agent Identity Code
    cert: str  # 证书内容（PEM 格式）
    version: int | None = None  # 证书版本号
    retrieved_at: str = Field(..., serialization_alias="retrievedAt")  # 检索时间 (ISO8601)

    model_config = ConfigDict(populate_by_name=True)


class RetrieveByCertRequest(BaseModel):
    """按证书反查请求"""

    cert_pem: str = Field(..., serialization_alias="certPem", description="证书内容（PEM 格式）")

    model_config = ConfigDict(populate_by_name=True)


router = APIRouter()
PROJECT_ROOT = Path(__file__).resolve().parents[2]
TRUST_BUNDLE_CACHE_CONTROL = "public, max-age=3600, no-transform, must-revalidate"


def get_certificate_service(
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> CertificateManagementService:
    """依赖注入：获取证书管理服务"""
    return CertificateManagementService(session)


CertificateServiceDep = Annotated[CertificateManagementService, Depends(get_certificate_service)]
VersionQuery = Annotated[int | None, Query(ge=1, description="版本号（可选）；不传则返回最新有效证书")]
RetrieveByCertBody = Annotated[RetrieveByCertRequest, Body(...)]


def _validate_aic_or_raise(aic: str) -> str:
    """统一校验 AIC 并返回规范化后的值"""
    normalized = (aic or "").strip()
    if not normalized:
        raise InvalidAICFormatError()
    return normalized


def _build_trust_bundle_headers(trust_bundle_pem: str | bytes) -> dict[str, str]:
    """构造 Trust Bundle 的公开缓存头。"""
    trust_bundle_bytes = trust_bundle_pem.encode("utf-8") if isinstance(trust_bundle_pem, str) else trust_bundle_pem
    bundle_path = Path(get_settings().trust_bundle_path)
    if not bundle_path.is_absolute():
        bundle_path = PROJECT_ROOT / bundle_path

    if bundle_path.exists():
        last_modified_at = datetime.fromtimestamp(bundle_path.stat().st_mtime, tz=UTC)
    else:
        last_modified_at = datetime.now(tz=UTC)

    return {
        "Cache-Control": TRUST_BUNDLE_CACHE_CONTROL,
        "ETag": f'"{hashlib.sha256(trust_bundle_bytes).hexdigest()}"',
        "Last-Modified": format_http_datetime(last_modified_at, usegmt=True),
    }


def get_revocation_reason_text(reason_code: int) -> str:
    """获取吊销原因文本描述"""
    reason_map = {
        0: "unspecified",  # 未指定
        1: "keyCompromise",  # 密钥泄露
        2: "cACompromise",  # CA 泄露
        3: "affiliationChanged",  # 隶属关系变更
        4: "superseded",  # 被替代
        5: "cessationOfOperation",  # 停止运营
    }
    return reason_map.get(reason_code, "unspecified")


# --- 数据模型 ---


class ManagementRevokeRequest(BaseModel):
    """管理端吊销请求"""

    aic: str = Field(..., description="Agent Identity Code")
    reason: int = Field(..., description="吊销原因代码 (0-5)")


class ManagementRevokeResponse(BaseModel):
    """管理端吊销响应"""

    aic: str
    revocation_reason: str = Field(..., serialization_alias="revocationReason")
    revoked_at: str = Field(..., serialization_alias="revokedAt")
    revoked_cert_count: int = Field(..., serialization_alias="revokedCertCount")

    model_config = ConfigDict(populate_by_name=True)


# --- API 端点 ---


@router.get(
    "/trust-bundle",
    summary="获取信任包 (Trust Bundle)",
    description="获取 CA 的信任包，包含本 CA 的根证书以及本 CA 所信任的其他 CA 的根证书。",
    response_class=Response,
    dependencies=[Depends(limit_public_read_access)],
)
async def get_trust_bundle() -> Response:
    """
    获取信任包 (Trust Bundle)

    权限级别: public - 获取信任包是建立 mTLS 连接的前提
    """
    try:
        ca_manager = get_ca_manager()
        trust_bundle_pem = ca_manager.get_trust_bundle_pem()

        return Response(
            content=trust_bundle_pem,
            media_type="application/x-pem-file",
            headers=_build_trust_bundle_headers(trust_bundle_pem),
        )
    except AppError:
        raise
    except (OSError, RuntimeError, ValueError) as e:
        raise TrustBundleRetrievalFailedError() from e


@router.post(
    "/revoke-notify",
    response_model=ManagementRevokeResponse,
    summary="被动吊销通知",
    description="当 Registry Server 中的 Agent 状态变更（如删除、禁用）时，通知 CA Server 吊销相关证书。",
    dependencies=[Depends(require_internal_service_auth)],
)
async def revoke_notify(
    request: ManagementRevokeRequest,
    service: CertificateServiceDep,
) -> ManagementRevokeResponse:
    """
    被动吊销通知

    权限级别: internal/mTLS - 仅限受信任的内部组件调用

    Args:
        request: 吊销请求，包含 AIC 和吊销原因
        service: 证书管理服务

    Returns:
        ManagementRevokeResponse: 吊销结果
    """
    aic = _validate_aic_or_raise(request.aic)

    # 验证吊销原因代码
    if request.reason < 0 or request.reason > 5:
        raise InvalidRevocationReasonCodeError("Invalid revocation reason code. Must be between 0 and 5.")

    reason_text = get_revocation_reason_text(request.reason)
    revoked_count = await service.revoke_certificates_by_aic(aic, reason_text)

    return ManagementRevokeResponse(
        aic=aic,
        revocation_reason=reason_text,
        revoked_at=format_datetime(beijing_now()),
        revoked_cert_count=revoked_count,
    )


@router.get(
    "/retrieve/aic/",
    response_model=RetrieveResponse,
    summary="检索 Agent 证书",
    description="根据 AIC 和版本号，检索相关证书",
    dependencies=[Depends(require_internal_service_auth)],
)
async def retrieve_agent_certificate_by_aic(
    aic: str,
    service: CertificateServiceDep,
    version: VersionQuery = None,
) -> RetrieveResponse:
    """
    检索 Agent 证书

    根据 ATR-DESIGN 规范，检索指定 AIC 和版本号的证书。
    如果未指定版本号，则检索最新版本的状态为"valid" 证书。

    Args:
        aic: Agent Identity Code
        version: 版本号（可选）
        service: 证书管理服务

    Returns:
        RetrieveResponse: 检索结果，包含证书内容等信息

    Raises:
        AppError: 当 AIC 格式无效或证书检索失败时
    """
    normalized_aic = _validate_aic_or_raise(aic)

    try:
        certificate = await service.retrieve_certificate_by_aic_and_version(aic=normalized_aic, version=version)

        return RetrieveResponse(
            aic=certificate.aic,
            cert=certificate.certificate_pem,
            version=certificate.version,
            retrieved_at=format_datetime(beijing_now()),
        )

    except AppError:
        raise
    except ValidationError as e:
        raise CertificateRetrievalFailedError("Failed to retrieve certificate by AIC.") from e


@router.post(
    "/retrieve/cert",
    response_model=RetrieveResponse,
    summary="检索 Agent 证书 索引",
    description="根据证书，查询相关证书信息",
    dependencies=[Depends(require_internal_service_auth)],
)
async def retrieve_agent_certificate_by_cert(
    request: RetrieveByCertBody,
    service: CertificateServiceDep,
) -> RetrieveResponse:
    """
    检索 Agent 证书

    根据 ATR-DESIGN 规范，检索指定证书的相关信息。

    Args:
        cert_pem: 证书内容（PEM 格式）
        service: 证书管理服务
    Returns:
        RetrieveResponse: 检索结果，包含证书内容等信息
    Raises:
        AppError: 当证书格式无效或证书检索失败时
    """
    try:
        cert_pem = request.cert_pem
        if not cert_pem or "BEGIN CERTIFICATE" not in cert_pem:
            raise InvalidCertificatePEMFormatError()

        certificate = await service.retrieve_certificate_by_cert(cert_pem)

        return RetrieveResponse(
            aic=certificate.aic,
            cert=certificate.certificate_pem,
            version=certificate.version,
            retrieved_at=format_datetime(beijing_now()),
        )

    except AppError:
        raise
    except ValidationError as e:
        raise CertificateRetrievalFailedError("Failed to retrieve certificate by certificate content.") from e
