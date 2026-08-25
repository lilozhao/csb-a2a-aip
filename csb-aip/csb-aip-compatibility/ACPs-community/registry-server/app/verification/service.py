import uuid
from datetime import datetime
from typing import TYPE_CHECKING, cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm.attributes import QueryableAttribute
from sqlalchemy.sql.elements import ColumnElement

from app.core.config import settings
from app.core.crypto import generate_sm3_salt, sm3_hash, sm4_encrypt
from app.utils.utils import get_beijing_time
from app.verification.exception import (
    IdentityAlreadyVerifiedError,
    IdentityVerificationPendingError,
    IdentityVerificationRequiredError,
    OrganizationAlreadyVerifiedError,
    OrganizationVerificationPendingError,
)
from app.verification.model import (
    IdentityVerification,
    OrgVerification,
    VerificationMethod,
    VerificationStatus,
)

if TYPE_CHECKING:
    from app.account.model import User
    from app.verification.schema import IdentityVerificationRequest, OrgVerificationRequest


type VerificationWhereClause = ColumnElement[bool]


IDENTITY_USER_ID_COLUMN = cast("QueryableAttribute[uuid.UUID]", IdentityVerification.user_id)
IDENTITY_DELETED_AT_COLUMN = cast("QueryableAttribute[datetime | None]", IdentityVerification.deleted_at)
IDENTITY_CREATED_AT_COLUMN = cast("QueryableAttribute[datetime]", IdentityVerification.created_at)
ORG_USER_ID_COLUMN = cast("QueryableAttribute[uuid.UUID]", OrgVerification.user_id)
ORG_DELETED_AT_COLUMN = cast("QueryableAttribute[datetime | None]", OrgVerification.deleted_at)
ORG_CREATED_AT_COLUMN = cast("QueryableAttribute[datetime]", OrgVerification.created_at)


def _as_verification_clause(value: ColumnElement[bool] | bool) -> VerificationWhereClause:
    return cast("VerificationWhereClause", value)


def _hash_with_salt(value: str) -> str:
    salt = generate_sm3_salt()
    return f"{salt}${sm3_hash(value, salt)}"


def _ensure_identity_submission_allowed(user: User, latest_record: IdentityVerification | None) -> None:
    if user.identity_verified or (latest_record and latest_record.status == VerificationStatus.APPROVED):
        raise IdentityAlreadyVerifiedError(user_id=str(user.id))

    if latest_record and latest_record.status == VerificationStatus.PENDING:
        raise IdentityVerificationPendingError(
            user_id=str(user.id),
            verification_id=str(latest_record.id),
        )


def _ensure_org_submission_allowed(user: User, latest_record: OrgVerification | None) -> None:
    if user.org_verified or (latest_record and latest_record.status == VerificationStatus.APPROVED):
        raise OrganizationAlreadyVerifiedError(user_id=str(user.id))

    if latest_record and latest_record.status == VerificationStatus.PENDING:
        raise OrganizationVerificationPendingError(
            user_id=str(user.id),
            verification_id=str(latest_record.id),
        )

    if not user.identity_verified:
        raise IdentityVerificationRequiredError(user_id=str(user.id))


def _auto_approve_identity_record(user: User, record: IdentityVerification, now: datetime) -> None:
    record.status = VerificationStatus.APPROVED
    record.decided_at = now
    user.identity_verified = True
    user.identity_verified_at = now
    user.current_identity_id = record.id
    user.updated_at = now


def _auto_approve_org_record(user: User, record: OrgVerification, now: datetime) -> None:
    record.status = VerificationStatus.APPROVED
    record.decided_at = now
    user.org_verified = True
    user.org_verified_at = now
    user.current_org_id = record.id
    user.updated_at = now


async def _get_latest_identity_verification(session: AsyncSession, user_id: uuid.UUID) -> IdentityVerification | None:
    stmt = (
        select(IdentityVerification)
        .where(
            _as_verification_clause(user_id == IDENTITY_USER_ID_COLUMN),
            IDENTITY_DELETED_AT_COLUMN.is_(None),
        )
        .order_by(IDENTITY_CREATED_AT_COLUMN.desc())
        .limit(1)
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def _get_latest_org_verification(session: AsyncSession, user_id: uuid.UUID) -> OrgVerification | None:
    stmt = (
        select(OrgVerification)
        .where(
            _as_verification_clause(user_id == ORG_USER_ID_COLUMN),
            ORG_DELETED_AT_COLUMN.is_(None),
        )
        .order_by(ORG_CREATED_AT_COLUMN.desc())
        .limit(1)
    )
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def submit_identity_verification(
    session: AsyncSession,
    user: User,
    request: IdentityVerificationRequest,
) -> IdentityVerification:
    latest_record = await _get_latest_identity_verification(session, user.id)
    _ensure_identity_submission_allowed(user, latest_record)

    now = get_beijing_time()
    record = IdentityVerification(
        user_id=user.id,
        id_type=request.id_type,
        id_number_hash=_hash_with_salt(request.id_number),
        real_name_encrypted=sm4_encrypt(request.real_name, settings.sm4_encryption_key),
        method=VerificationMethod.AUTO,
        provider=("AUTO_APPROVE" if settings.auto_approve_identity_verification else None),
        status=VerificationStatus.PENDING,
    )

    if settings.auto_approve_identity_verification:
        _auto_approve_identity_record(user, record, now)
        session.add(user)

    session.add(record)
    await session.flush()
    return record


async def submit_org_verification(
    session: AsyncSession,
    user: User,
    request: OrgVerificationRequest,
) -> OrgVerification:
    latest_record = await _get_latest_org_verification(session, user.id)
    _ensure_org_submission_allowed(user, latest_record)

    now = get_beijing_time()
    record = OrgVerification(
        user_id=user.id,
        org_name=request.org_name,
        usci=request.usci,
        org_registration_number=request.org_registration_number,
        legal_rep_name_encrypted=(
            sm4_encrypt(request.legal_rep_name, settings.sm4_encryption_key) if request.legal_rep_name else None
        ),
        legal_rep_id_hash=(_hash_with_salt(request.legal_rep_id_number) if request.legal_rep_id_number else None),
        method=VerificationMethod.AUTO,
        provider="AUTO_APPROVE" if settings.auto_approve_org_verification else None,
        status=VerificationStatus.PENDING,
    )

    if settings.auto_approve_org_verification:
        _auto_approve_org_record(user, record, now)
        session.add(user)

    session.add(record)
    await session.flush()
    return record


async def get_identity_verification_status(
    session: AsyncSession,
    user: User,
) -> IdentityVerification | None:
    return await _get_latest_identity_verification(session, user.id)


async def get_org_verification_status(session: AsyncSession, user: User) -> OrgVerification | None:
    return await _get_latest_org_verification(session, user.id)
