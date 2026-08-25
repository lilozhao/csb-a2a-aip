import uuid
from datetime import datetime
from enum import StrEnum
from typing import TYPE_CHECKING, Any, ClassVar, Optional, cast

from pydantic import ConfigDict
from sqlalchemy import TIMESTAMP, BigInteger, Column, Index, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, Relationship, SQLModel
from sqlmodel._compat import SQLModelConfig

from app.core.base_model import SoftDeleteMixin, TimestampMixin, UUIDMixin
from app.utils.utils import get_beijing_time

# 使用 TYPE_CHECKING 处理循环引用
if TYPE_CHECKING:
    from app.account.model import User


class ApprovalStatus(StrEnum):
    DRAFT = "DRAFT"  # Not submitted for approval yet
    PENDING = "PENDING"  # Submitted, waiting for approval
    APPROVED = "APPROVED"  # Approved by staff
    REJECTED = "REJECTED"  # Rejected by staff


class Agent(UUIDMixin, TimestampMixin, SoftDeleteMixin, SQLModel, table=True):
    # 添加部分唯一约束，只在 is_active=true 时对 name+version 要求唯一
    __table_args__ = (
        Index(
            "uq_agent_name_version_active",  # 索引名称
            "name",
            "version",  # 索引字段
            unique=True,  # 设置为唯一索引
            postgresql_where=text("is_active = true"),  # 部分索引条件
        ),
    )

    aic: str | None = Field(default=None, sa_column=Column(String(), unique=True, index=True))
    name: str = Field(index=True, max_length=255)
    version: str = Field(index=True, max_length=255)
    description: str | None = Field(
        default=None,
        sa_column=Column(Text),  # 映射到 PostgreSQL 的 TEXT 类型
    )

    # Agent 展示与集成字段
    logo_url: str | None = Field(default=None, max_length=1000)
    # acp_url: Optional[str] = Field(default=None, max_length=1000)
    acs: dict[str, Any] | None = Field(default=None, sa_column=Column(JSONB))
    acs_hash: str | None = Field(default=None, max_length=256)  # acs 的checksum。
    acs_version: int = Field(default=1)  # acs版本号，每次acs变化时自增
    acs_last_seq: int | None = Field(
        default=None, sa_column=Column(BigInteger, index=True)
    )  # 最后一次acs变化对应的seq号

    # Ontology/Entity 区分
    # True = 本体 (Ontology)，可以派生实体
    # False = 实体 (Entity) 或传统 Agent（本体与实体合一）
    is_ontology: bool = Field(default=False, index=True)

    # 状态信息
    is_active: bool = Field(default=True)
    # 用户删除标志
    is_deleted: bool = Field(default=False)
    deleted_reason: str | None = Field(default=None, max_length=255)
    # 业务员禁用标志
    is_disabled: bool = Field(default=False)
    disabled_at: datetime | None = Field(default=None, sa_column=Column(TIMESTAMP(timezone=True)))
    disabled_reason: str | None = Field(default=None, max_length=255)

    # 注册信息
    created_by_id: uuid.UUID = Field(foreign_key="account_user.id")
    # 使用带时区的时间戳类型
    # 审核信息
    submitted_at: datetime | None = Field(
        default=None,
        sa_column=Column(TIMESTAMP(timezone=True)),  # 指定使用带时区的时间戳
    )
    approval_status: ApprovalStatus = Field(default=ApprovalStatus.DRAFT)
    processed_by_id: uuid.UUID | None = Field(default=None, foreign_key="account_user.id")
    processed_at: datetime | None = Field(
        default=None,
        sa_column=Column(TIMESTAMP(timezone=True)),  # 指定使用带时区的时间戳
    )
    process_comments: str | None = Field(default=None, max_length=2000)

    # 向量数据库引用
    vector_id: str | None = None

    # 定义 ORM 关系
    # 注意：必须使用 Optional["User"] 而非 "User | None"；SQLModel 从注解中提取 "User" 作为关系目标，
    # 若使用管道符写法，SQLAlchemy 会将 "User | None" 整体作为类名查找，导致解析失败
    created_by: Optional["User"] = Relationship(  # noqa: UP045, UP037
        sa_relationship_kwargs={
            "foreign_keys": "Agent.created_by_id",
            "primaryjoin": "Agent.created_by_id == User.id",
        }
    )
    processed_by: Optional["User"] = Relationship(  # noqa: UP045, UP037
        sa_relationship_kwargs={
            "foreign_keys": "Agent.processed_by_id",
            "primaryjoin": "Agent.processed_by_id == User.id",
        }
    )

    model_config: ClassVar[SQLModelConfig] = cast("SQLModelConfig", ConfigDict(from_attributes=True))


class EmailCode(UUIDMixin, SQLModel, table=True):
    """
    邮箱验证日志表
    记录所有验证码
    """

    __tablename__ = "email_code"  # pyright: ignore[reportAssignmentType, reportIncompatibleVariableOverride]

    # 邮箱地址
    email: str = Field(max_length=255, nullable=False, description="邮箱地址")

    # 验证码
    code: str | None = Field(default=None, max_length=10, description="验证码内容")

    # 创建日期（北京时间，带时区）
    created_at: datetime = Field(
        default_factory=get_beijing_time,
        sa_column=Column(TIMESTAMP(timezone=True), nullable=False),
        description="创建日期时间",
    )

    # 过期日期（北京时间，带时区）
    expires_at: datetime = Field(
        sa_column=Column(TIMESTAMP(timezone=True), nullable=False),
        description="验证码过期日期时间",
    )
    # 使用时间
    used_at: datetime | None = Field(
        default=None,
        sa_column=Column(TIMESTAMP(timezone=True)),
        description="验证码使用日期时间",
    )

    model_config: ClassVar[SQLModelConfig] = cast("SQLModelConfig", ConfigDict(arbitrary_types_allowed=True))


# 这个导入放在文件末尾，避免循环导入问题
from app.account.model import User  # noqa: E402, TC001
