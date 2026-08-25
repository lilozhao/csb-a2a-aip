"""
OCSP API路由

实现OCSP (Online Certificate Status Protocol) 相关的API端点。
"""

import base64
import hashlib
from datetime import UTC, datetime
from email.utils import format_datetime as format_http_datetime
from typing import Annotated, Any

from cryptography import x509
from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.common import (
    OCSPBatchRequest,
    OCSPBatchResponse,
    OCSPResponderInfo,
    OCSPService,
    OCSPSingleResponse,
    OCSPStatsResponse,
    beijing_now,
)
from app.core.base_exception import AppError
from app.core.db_session import get_async_session
from app.core.public_access import limit_public_read_access

from .exception import (
    OCSPCertificateStatusRetrievalFailedError,
    OCSPInvalidContentTypeError,
    OCSPInvalidRequestError,
    OCSPProcessingFailedError,
    OCSPResponderNotFoundError,
    OCSPStatisticsRetrievalFailedError,
)

router = APIRouter(dependencies=[Depends(limit_public_read_access)])
OCSP_CACHE_CONTROL_TEMPLATE = "max-age={max_age}, public, no-transform, must-revalidate"


def get_ocsp_service(session: Annotated[AsyncSession, Depends(get_async_session)]) -> OCSPService:
    """获取OCSP服务实例"""
    return OCSPService(session)


OCSPServiceDep = Annotated[OCSPService, Depends(get_ocsp_service)]


def _normalize_http_datetime(value: datetime) -> str:
    """将时间转换为 RFC 1123 头格式。"""
    if value.tzinfo is None:
        value = value.replace(tzinfo=UTC)
    return format_http_datetime(value.astimezone(UTC), usegmt=True)


def _build_ocsp_cache_headers(response_der: bytes, processing_time: int) -> dict[str, str]:
    """构造 OCSP 响应缓存头。"""
    response = x509.ocsp.load_der_ocsp_response(response_der)
    this_update = response.this_update_utc
    next_update = response.next_update_utc or this_update
    max_age = max(0, int((next_update - this_update).total_seconds()))

    return {
        "Cache-Control": OCSP_CACHE_CONTROL_TEMPLATE.format(max_age=max_age),
        "Expires": _normalize_http_datetime(next_update),
        "Last-Modified": _normalize_http_datetime(this_update),
        "ETag": f'"{hashlib.sha256(response_der).hexdigest()}"',
        "X-Processing-Time-MS": str(processing_time),
    }


@router.post(
    "/batch",
    summary="批量OCSP查询",
    description="查询多个证书的状态",
)
async def ocsp_batch_request(
    batch_request: OCSPBatchRequest,
    service: OCSPServiceDep,
) -> OCSPBatchResponse:
    """
    批量OCSP查询

    权限级别: public - 批量OCSP查询同样是公开服务
    """
    try:
        # 转换请求格式
        certificates = []
        for cert_req in batch_request.certificates:
            certificates.append(
                {
                    "serial_number": cert_req.serial_number,
                    "issuer_key_hash": cert_req.issuer_key_hash,
                }
            )

        # 批量检查证书状态
        responses = await service.batch_check_certificates(certificates)

        # 转换响应格式

        ocsp_responses = []
        for resp in responses:
            ocsp_responses.append(
                OCSPSingleResponse(
                    serial_number=resp["serial_number"],
                    status=resp["status"],
                    this_update=resp["this_update"],
                    next_update=resp["next_update"],
                    revocation_time=resp.get("revocation_time"),
                    revocation_reason=resp.get("revocation_reason"),
                )
            )

        responder = await service.get_active_responder()
        responder_name = responder.name if responder else "Agent CA OCSP Responder"

        return OCSPBatchResponse(
            responses=ocsp_responses,
            responder_id=responder_name,
            produced_at=beijing_now(),
        )

    except AppError:
        raise
    except (RuntimeError, ValueError, OSError) as e:
        raise OCSPProcessingFailedError(f"Batch OCSP processing failed: {e!s}") from e


@router.get(
    "/responder/info",
    summary="获取OCSP响应器信息",
    description="获取OCSP响应器的配置信息",
)
async def get_ocsp_responder_info(service: OCSPServiceDep) -> OCSPResponderInfo:
    """
    获取OCSP响应器信息

    权限级别: public - OCSP响应器信息公开可访问
    """
    try:
        responder_info = await service.get_responder_info()
        return OCSPResponderInfo(**responder_info)

    except OCSPResponderNotFoundError:
        raise
    except AppError:
        raise
    except (RuntimeError, ValueError, OSError) as e:
        raise OCSPResponderNotFoundError(f"OCSP responder not found: {e!s}") from e


@router.get(
    "/stats",
    summary="获取OCSP统计信息",
    description="获取OCSP服务的统计数据",
)
async def get_ocsp_statistics(service: OCSPServiceDep) -> OCSPStatsResponse:
    """
    获取OCSP统计信息

    权限级别: public - 基本统计信息公开可访问

    Note: 实际部署时可能需要管理员权限
    """
    try:
        stats = await service.get_ocsp_statistics()
        return OCSPStatsResponse(**stats)

    except AppError:
        raise
    except (RuntimeError, ValueError, OSError) as e:
        raise OCSPStatisticsRetrievalFailedError(f"Failed to get OCSP statistics: {e!s}") from e


@router.post(
    "",
    summary="OCSP状态查询 (POST方法)",
    description="使用POST方法查询证书状态",
    response_class=Response,
)
async def ocsp_request_post(
    request: Request,
    service: OCSPServiceDep,
) -> Response:
    """
    OCSP状态查询 (POST方法)

    权限级别: public - OCSP查询是公开服务，任何客户端都可以验证证书状态
    """
    # 验证 Content-Type
    content_type = request.headers.get("content-type", "")
    if content_type != "application/ocsp-request":
        raise OCSPInvalidContentTypeError()

    try:
        # 读取请求体
        request_der = await request.body()

        if not request_der:
            raise OCSPInvalidRequestError("Empty OCSP request.")

        # 获取客户端IP
        client_ip = request.client.host if request.client else None

        # 处理OCSP请求
        response_der, processing_time = await service.process_ocsp_request(request_der, client_ip)

        return Response(
            content=response_der,
            media_type="application/ocsp-response",
            headers=_build_ocsp_cache_headers(response_der, processing_time),
        )

    except AppError:
        raise
    except (RuntimeError, ValueError, OSError) as e:
        raise OCSPInvalidRequestError(f"Invalid OCSP request: {e!s}") from e


@router.get(
    "/{base64_request}",
    summary="OCSP状态查询 (GET方法)",
    description="使用GET方法查询证书状态",
    response_class=Response,
)
async def ocsp_request_get(
    base64_request: str,
    request: Request,
    service: OCSPServiceDep,
) -> Response:
    """
    OCSP状态查询 (GET方法)

    权限级别: public - OCSP查询是公开服务，任何客户端都可以验证证书状态

    Args:
        base64_request: Base64URL编码的OCSP请求
    """
    try:
        # 补全填充
        padding = 4 - (len(base64_request) % 4)
        if padding != 4:
            base64_request += "=" * padding

        # 将Base64URL字符替换为标准Base64字符
        base64_request_std = base64_request.replace("-", "+").replace("_", "/")

        request_der = base64.b64decode(base64_request_std)

        # 获取客户端IP
        client_ip = request.client.host if request.client else None

        # 处理OCSP请求
        response_der, processing_time = await service.process_ocsp_request(request_der, client_ip)

        return Response(
            content=response_der,
            media_type="application/ocsp-response",
            headers=_build_ocsp_cache_headers(response_der, processing_time),
        )

    except AppError:
        raise
    except (RuntimeError, ValueError, OSError) as e:
        raise OCSPInvalidRequestError(f"Invalid OCSP request: {e!s}") from e


@router.get(
    "/certificate/{serial_number}",
    summary="简单OCSP状态查询",
    description="通过证书序列号查询证书状态（简化接口）",
)
async def get_certificate_status(
    serial_number: str,
    service: OCSPServiceDep,
) -> dict[str, Any]:
    """
    简单OCSP状态查询

    权限级别: public - 简化的证书状态查询接口

    Args:
        serial_number: 证书序列号
    """
    try:
        # 使用服务层查询证书状态
        certificate_status = await service.get_certificate_status(serial_number)

        if not certificate_status:
            return {
                "serialNumber": serial_number,
                "certificateStatus": "unknown",
                "thisUpdate": None,
                "nextUpdate": None,
            }

        return certificate_status

    except AppError:
        raise
    except (RuntimeError, ValueError, OSError) as e:
        raise OCSPCertificateStatusRetrievalFailedError(f"Failed to get certificate status: {e!s}") from e
