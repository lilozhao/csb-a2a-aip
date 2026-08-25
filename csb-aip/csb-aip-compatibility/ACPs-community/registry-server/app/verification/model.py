import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import TIMESTAMP, Column, String, Text
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, SQLModel

from app.core.base_model import AuditMixin, UUIDMixin

ACCOUNT_USER_FK = "account_user.id"


class IdentityDocumentType(StrEnum):
    CN_ID_CARD = "CN_ID_CARD"
    PASSPORT = "PASSPORT"
    OTHER = "OTHER"


class VerificationMethod(StrEnum):
    AUTO = "AUTO"
    MANUAL = "MANUAL"


class VerificationStatus(StrEnum):
    PENDING = "PENDING"
    APPROVED = "APPROVED"
    REJECTED = "REJECTED"


class IdentityVerification(UUIDMixin, AuditMixin, SQLModel, table=True):
    __tablename__ = "identity_verification"  # pyright: ignore[reportAssignmentType, reportIncompatibleVariableOverride]
    user_id: uuid.UUID = Field(foreign_key=ACCOUNT_USER_FK, index=True)
    id_type: IdentityDocumentType = Field(default=IdentityDocumentType.CN_ID_CARD)
    id_number_hash: str = Field(sa_column=Column(String(), nullable=False))
    real_name_encrypted: str = Field(sa_column=Column(String(), nullable=False))
    method: VerificationMethod = Field(default=VerificationMethod.AUTO)
    provider: str | None = Field(default=None, max_length=255)
    provider_request_id: str | None = Field(default=None, max_length=255)
    reviewer_id: uuid.UUID | None = Field(default=None, foreign_key=ACCOUNT_USER_FK)
    status: VerificationStatus = Field(default=VerificationStatus.PENDING)
    decided_at: datetime | None = Field(
        default=None,
        sa_column=Column(TIMESTAMP(timezone=True), nullable=True),
    )
    remark: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    attachment_urls: list[dict[str, str]] | None = Field(
        default=None,
        sa_column=Column(JSONB, nullable=True),
    )


class OrgVerification(UUIDMixin, AuditMixin, SQLModel, table=True):
    __tablename__ = "org_verification"  # pyright: ignore[reportAssignmentType, reportIncompatibleVariableOverride]
    user_id: uuid.UUID = Field(foreign_key=ACCOUNT_USER_FK, index=True)
    org_name: str = Field(max_length=255)
    usci: str | None = Field(default=None, max_length=18)
    org_registration_number: str | None = Field(default=None, max_length=255)
    legal_rep_name_encrypted: str | None = Field(default=None, max_length=2048)
    legal_rep_id_hash: str | None = Field(default=None, max_length=2048)
    method: VerificationMethod = Field(default=VerificationMethod.AUTO)
    provider: str | None = Field(default=None, max_length=255)
    provider_request_id: str | None = Field(default=None, max_length=255)
    reviewer_id: uuid.UUID | None = Field(default=None, foreign_key=ACCOUNT_USER_FK)
    status: VerificationStatus = Field(default=VerificationStatus.PENDING)
    decided_at: datetime | None = Field(
        default=None,
        sa_column=Column(TIMESTAMP(timezone=True), nullable=True),
    )
    remark: str | None = Field(default=None, sa_column=Column(Text, nullable=True))
    attachment_urls: list[dict[str, str]] | None = Field(
        default=None,
        sa_column=Column(JSONB, nullable=True),
    )
