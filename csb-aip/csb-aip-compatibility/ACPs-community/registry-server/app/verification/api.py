from typing import Annotated

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.model import RoleType, User
from app.core.auth import check_user_role
from app.core.base_exception import PROBLEM_JSON_MEDIA_TYPE
from app.core.db_session import get_session
from app.verification.schema import (
    IdentityVerificationRequest,
    IdentityVerificationResponse,
    OrgVerificationRequest,
    OrgVerificationResponse,
)
from app.verification.service import (
    get_identity_verification_status,
    get_org_verification_status,
    submit_identity_verification,
    submit_org_verification,
)

router = APIRouter(prefix="/verification", tags=["verification"])

DbSession = Annotated[AsyncSession, Depends(get_session)]
CurrentClientUser = Annotated[User, Depends(check_user_role([RoleType.CLIENT]))]


def _to_identity_verification_response(record: IdentityVerificationResponse | object) -> IdentityVerificationResponse:
    return IdentityVerificationResponse.model_validate(record)


def _to_org_verification_response(record: OrgVerificationResponse | object) -> OrgVerificationResponse:
    return OrgVerificationResponse.model_validate(record)


def _problem_response(description: str) -> dict[str, object]:
    return {"description": description, "content": {PROBLEM_JSON_MEDIA_TYPE: {}}}


UNAUTHORIZED_RESPONSE = _problem_response("Authentication required")
FORBIDDEN_RESPONSE = _problem_response("Insufficient permissions")
CONFLICT_RESPONSE = _problem_response("Verification state conflict")
VALIDATION_RESPONSE = _problem_response("Request validation failed")


@router.post(
    "/identity",
    status_code=status.HTTP_201_CREATED,
    summary="提交身份审核申请",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_409_CONFLICT: CONFLICT_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def create_identity_verification(
    request: IdentityVerificationRequest,
    db: DbSession,
    current_user: CurrentClientUser,
) -> IdentityVerificationResponse:
    record = await submit_identity_verification(db, current_user, request)
    return _to_identity_verification_response(record)


@router.get(
    "/identity",
    status_code=status.HTTP_200_OK,
    summary="查询最新身份审核状态",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
    },
)
async def read_identity_verification(
    db: DbSession,
    current_user: CurrentClientUser,
) -> IdentityVerificationResponse | None:
    record = await get_identity_verification_status(db, current_user)
    return _to_identity_verification_response(record) if record else None


@router.post(
    "/org",
    status_code=status.HTTP_201_CREATED,
    summary="提交组织审核申请",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
        status.HTTP_409_CONFLICT: CONFLICT_RESPONSE,
        status.HTTP_422_UNPROCESSABLE_CONTENT: VALIDATION_RESPONSE,
    },
)
async def create_org_verification(
    request: OrgVerificationRequest,
    db: DbSession,
    current_user: CurrentClientUser,
) -> OrgVerificationResponse:
    record = await submit_org_verification(db, current_user, request)
    return _to_org_verification_response(record)


@router.get(
    "/org",
    status_code=status.HTTP_200_OK,
    summary="查询最新组织审核状态",
    responses={
        status.HTTP_401_UNAUTHORIZED: UNAUTHORIZED_RESPONSE,
        status.HTTP_403_FORBIDDEN: FORBIDDEN_RESPONSE,
    },
)
async def read_org_verification(
    db: DbSession,
    current_user: CurrentClientUser,
) -> OrgVerificationResponse | None:
    record = await get_org_verification_status(db, current_user)
    return _to_org_verification_response(record) if record else None
