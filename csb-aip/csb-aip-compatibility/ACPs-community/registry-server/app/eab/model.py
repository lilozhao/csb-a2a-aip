import uuid
from datetime import datetime

from sqlalchemy import TIMESTAMP, Boolean, Column, String
from sqlmodel import Field, SQLModel

from app.utils.utils import get_beijing_time


class EabCredential(SQLModel, table=True):
    __tablename__ = "eab_credential"  # pyright: ignore[reportAssignmentType, reportIncompatibleVariableOverride]

    id: uuid.UUID = Field(default_factory=uuid.uuid7, primary_key=True, index=True)
    key_id: str = Field(sa_column=Column(String(), nullable=False, unique=True, index=True))
    mac_key_encrypted: str = Field(sa_column=Column(String(), nullable=False))
    aic: str = Field(sa_column=Column(String(), nullable=False, index=True))
    user_id: uuid.UUID = Field(foreign_key="account_user.id", index=True)
    is_consumed: bool = Field(
        default=False,
        sa_column=Column(Boolean, nullable=False, default=False),
    )
    consumed_at: datetime | None = Field(
        default=None,
        sa_column=Column(TIMESTAMP(timezone=True), nullable=True),
    )
    expires_at: datetime = Field(sa_column=Column(TIMESTAMP(timezone=True), nullable=False))
    created_at: datetime = Field(
        default_factory=get_beijing_time,
        sa_column=Column(TIMESTAMP(timezone=True), nullable=False),
    )
