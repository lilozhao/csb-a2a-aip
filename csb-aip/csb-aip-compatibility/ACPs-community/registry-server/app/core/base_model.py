"""SQLModel 公共 mixin 定义。"""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy import DateTime as SADateTime
from sqlmodel import Field, SQLModel

from app.utils.utils import get_beijing_time


def _aware_datetime_type() -> Any:
    """返回带时区的 datetime SQLAlchemy 类型。"""

    return SADateTime(timezone=True)


class UUIDMixin(SQLModel):
    """UUID7 主键 mixin。"""

    id: uuid.UUID = Field(default_factory=uuid.uuid7, primary_key=True, index=True)


class TimestampMixin(SQLModel):
    """时间戳字段 mixin。"""

    created_at: datetime = Field(
        default_factory=get_beijing_time,
        sa_type=_aware_datetime_type(),
    )
    updated_at: datetime = Field(
        default_factory=get_beijing_time,
        sa_type=_aware_datetime_type(),
    )


class SoftDeleteMixin(SQLModel):
    """软删除字段 mixin。"""

    deleted_at: datetime | None = Field(
        default=None,
        sa_type=_aware_datetime_type(),
    )


class AuditMixin(TimestampMixin, SoftDeleteMixin):
    """审计字段组合 mixin。"""
