"""证书管理 API 路由：根证书、中间证书、Agent 证书的 CRUD 及吊销管理"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Path, Query
from fastapi.responses import PlainTextResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import (
    Certificate,
    CertificateListResponse,
    CertificateResponse,
    CertificateStatus,
    CertificateType,
    CreateIntermediateCertificateRequest,
    CreateRootCertificateRequest,
    PagedResponse,
)
from app.core.auth import require_admin_auth
from app.core.base_exception import AppError
from app.core.db_session import get_async_session

from .exception import CertificateNotFoundError, CertificateOperationFailedError
from .service import CertificateManagementService

router = APIRouter(dependencies=[Depends(require_admin_auth)])


def get_certificate_service(
    session: Annotated[AsyncSession, Depends(get_async_session)],
) -> CertificateManagementService:
    """依赖注入：获取证书管理服务"""
    return CertificateManagementService(session)


CertificateServiceDep = Annotated[CertificateManagementService, Depends(get_certificate_service)]
CertificateIdPath = Annotated[UUID, Path(description="证书ID")]
ReasonQuery = Annotated[str, Query(description="吊销原因")]
ParentIdQuery = Annotated[UUID | None, Query(description="父证书ID")]
PageQuery = Annotated[int, Query(ge=1, description="页码")]
PageSizeQuery = Annotated[int, Query(ge=1, le=100, description="每页数量")]
CertificateTypeQuery = Annotated[CertificateType | None, Query(description="证书类型过滤")]
CertificateStatusQuery = Annotated[CertificateStatus | None, Query(description="状态过滤")]
AICQuery = Annotated[str | None, Query(description="AIC过滤")]
DaysAheadQuery = Annotated[int, Query(ge=1, le=365, description="提前天数")]
RenewalValidityDaysQuery = Annotated[int | None, Query(ge=1, le=7300, description="续期有效期天数")]


# 根证书管理
@router.get("/root", response_model=list[CertificateResponse], summary="获取根证书列表")
async def get_root_certificates(
    service: CertificateServiceDep,
) -> list[Certificate]:
    """获取所有根证书"""
    return await service.get_root_certificates()


@router.post("/root", response_model=CertificateResponse, summary="创建根证书")
async def create_root_certificate(
    request: CreateRootCertificateRequest,
    service: CertificateServiceDep,
) -> Certificate:
    """
    创建根证书（系统级操作）
    """
    try:
        return await service.create_root_certificate(request.subject_name, request.validity_days)
    except AppError:
        raise
    except (ValueError, RuntimeError, OSError) as e:
        raise CertificateOperationFailedError("Failed to create root certificate.") from e


@router.post(
    "/root/{certificate_id}/renew",
    response_model=CertificateResponse,
    summary="续期根证书",
)
async def renew_root_certificate(
    certificate_id: CertificateIdPath,
    service: CertificateServiceDep,
    validity_days: RenewalValidityDaysQuery = None,
) -> Certificate:
    """续期根证书（系统级操作）"""
    return await service.renew_certificate(certificate_id, validity_days)


@router.post(
    "/root/{certificate_id}/revoke",
    response_model=CertificateResponse,
    summary="吊销根证书",
)
async def revoke_root_certificate(
    certificate_id: CertificateIdPath,
    reason: ReasonQuery,
    service: CertificateServiceDep,
) -> Certificate:
    """吊销根证书（系统级操作）"""
    return await service.revoke_certificate(certificate_id, reason)


# 中间证书管理
@router.get(
    "/intermediate",
    response_model=list[CertificateResponse],
    summary="获取中间证书列表",
)
async def get_intermediate_certificates(
    service: CertificateServiceDep,
    parent_id: ParentIdQuery = None,
) -> list[Certificate]:
    """获取中间证书列表"""
    return await service.get_intermediate_certificates(parent_id)


@router.get(
    "/intermediate/{certificate_id}",
    response_model=CertificateResponse,
    summary="获取特定中间证书",
)
async def get_intermediate_certificate(
    certificate_id: CertificateIdPath,
    service: CertificateServiceDep,
) -> Certificate:
    """获取特定中间证书详情"""
    certificate = await service.get_certificate_or_error(certificate_id)
    if certificate.certificate_type != CertificateType.INTERMEDIATE:
        raise CertificateNotFoundError("Intermediate certificate not found.")
    return certificate


@router.post("/intermediate", response_model=CertificateResponse, summary="创建中间证书")
async def create_intermediate_certificate(
    request: CreateIntermediateCertificateRequest,
    service: CertificateServiceDep,
) -> Certificate:
    """
    创建中间证书（系统级操作）
    """
    return await service.create_intermediate_certificate(
        request.subject_name, request.parent_certificate_id, request.validity_days
    )


@router.post(
    "/intermediate/{certificate_id}/renew",
    response_model=CertificateResponse,
    summary="续期中间证书",
)
async def renew_intermediate_certificate(
    certificate_id: CertificateIdPath,
    service: CertificateServiceDep,
    validity_days: RenewalValidityDaysQuery = None,
) -> Certificate:
    """续期中间证书（系统级操作）"""
    return await service.renew_certificate(certificate_id, validity_days)


@router.post(
    "/intermediate/{certificate_id}/revoke",
    response_model=CertificateResponse,
    summary="吊销中间证书",
)
async def revoke_intermediate_certificate(
    certificate_id: CertificateIdPath,
    reason: ReasonQuery,
    service: CertificateServiceDep,
) -> Certificate:
    """吊销中间证书（系统级操作）"""
    return await service.revoke_certificate(certificate_id, reason)


# 用户证书查询与管理
@router.get("/expiring", response_model=list[CertificateResponse], summary="获取即将过期的证书")
async def get_expiring_certificates(
    service: CertificateServiceDep,
    days_ahead: DaysAheadQuery = 30,
) -> list[Certificate]:
    """获取即将过期的证书列表，用于续期提醒"""
    return await service.get_expiring_certificates(days_ahead)


@router.get("", response_model=PagedResponse, summary="查询证书列表")
async def list_certificates(
    service: CertificateServiceDep,
    page: PageQuery = 1,
    page_size: PageSizeQuery = 20,
    certificate_type: CertificateTypeQuery = None,
    status: CertificateStatusQuery = None,
    aic: AICQuery = None,
) -> PagedResponse:
    """查询证书列表，支持分页和过滤"""
    certificates, total = await service.list_certificates(
        page=page,
        page_size=page_size,
        certificate_type=certificate_type,
        status=status,
        aic=aic,
    )

    # 转换为列表响应格式
    items = [CertificateListResponse.model_validate(cert) for cert in certificates]

    return PagedResponse(
        items=items,
        total=total,
        page=page,
        page_size=page_size,
        total_pages=(total + page_size - 1) // page_size,
    )


@router.get("/{certificate_id}", response_model=CertificateResponse, summary="获取特定证书详情")
async def get_certificate(
    certificate_id: CertificateIdPath,
    service: CertificateServiceDep,
) -> Certificate:
    """获取特定证书的详细信息"""
    return await service.get_certificate_or_error(certificate_id)


@router.get("/{certificate_id}/download", response_class=PlainTextResponse, summary="下载证书")
async def download_certificate(
    certificate_id: CertificateIdPath,
    service: CertificateServiceDep,
) -> PlainTextResponse:
    """下载证书PEM格式文件"""
    certificate = await service.get_certificate_or_error(certificate_id)

    return PlainTextResponse(
        content=certificate.certificate_pem,
        media_type="application/x-pem-file",
        headers={"Content-Disposition": f"attachment; filename=certificate-{certificate.serial_number}.pem"},
    )


@router.get(
    "/{certificate_id}/chain",
    response_model=list[CertificateResponse],
    summary="获取证书链",
)
async def get_certificate_chain(
    certificate_id: CertificateIdPath,
    service: CertificateServiceDep,
) -> list[Certificate]:
    """获取完整的证书链"""
    chain = await service.get_certificate_chain(certificate_id)
    if not chain:
        raise CertificateNotFoundError()
    return chain


@router.post(
    "/{certificate_id}/revoke",
    response_model=CertificateResponse,
    summary="手动吊销证书",
)
async def revoke_certificate(
    certificate_id: CertificateIdPath,
    reason: ReasonQuery,
    service: CertificateServiceDep,
) -> Certificate:
    """手动吊销证书（管理员操作）"""
    return await service.revoke_certificate(certificate_id, reason)
