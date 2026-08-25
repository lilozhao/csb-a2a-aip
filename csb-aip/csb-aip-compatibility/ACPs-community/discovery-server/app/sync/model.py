"""
DSP（Data Synchronization Protocol）数据模型。

此模块定义 DSP 协议中用于注册中心和发现服务之间数据同步的数据结构。
"""

from __future__ import annotations

from datetime import datetime  # noqa: TC003 - Pydantic model_rebuild needs this symbol in module globals
from enum import StrEnum
from typing import TYPE_CHECKING, Any, ClassVar, cast

from pgvector.sqlalchemy import Vector
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import BigInteger, ForeignKey, Index, Integer, String
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import relationship
from sqlmodel import Column, Relationship, SQLModel
from sqlmodel import Field as SQLField

from app.core.config import settings

if TYPE_CHECKING:
    from sqlmodel._compat import SQLModelConfig


class OperationType(StrEnum):
    """DSP 操作类型。"""

    UPSERT = "upsert"
    DELETE = "delete"


class PayloadType(StrEnum):
    """DSP 载荷类型。"""

    FULL_OBJ = "FULL_OBJ"
    OBJ_PATCH = "OBJ_PATCH"


class Envelope(BaseModel):
    """
    所有数据传输的 DSP 信封结构。

    所有传输的数据都使用这种统一的信封结构来确保幂等性和演化能力。
    """

    seq: int = Field(..., description="全局递增序列号")
    ts: datetime | None = Field(None, description="变更时间戳")
    op: OperationType | None = Field(
        default=OperationType.UPSERT,
        description="操作类型：upsert（默认）或 delete",
    )
    type: str = Field(..., description="对象类型（例如：acs、dataset、file、user）")
    id: str = Field(..., description="对象全局唯一标识符")
    version: int = Field(
        ...,
        description="对象版本号，在单个对象内单调递增",
    )
    payload: dict[str, Any] | None = Field(None, description="实际数据内容")


class DSPState(BaseModel):
    """
    用于跟踪同步进度的 DSP 客户端状态。
    """

    last_seq: int | None = Field(default=None, description="最后处理的序列号")
    object_versions: dict[str, dict[str, int]] = Field(
        default_factory=dict,
        description="按类型和 ID 分组的对象版本：{type: {id: version}}",
    )
    last_sync_time: datetime | None = Field(default=None, description="最后同步时间")
    needs_snapshot: bool = Field(default=True, description="是否需要完整快照")

    @classmethod
    async def load_from_db(cls, *, require_indexed_skills: bool = False) -> DSPState:
        """从数据库加载同步状态。"""
        try:
            from sqlmodel import func, select

            from app.core.database import get_async_session_context

            async with get_async_session_context() as session:
                agent_rows = (await session.execute(select(Agent.aic, Agent.version, Agent.seq))).all()

                if not agent_rows:
                    return cls()

                last_seq = max(int(seq) for _, _, seq in agent_rows)
                object_versions = {"acs": {str(aic): int(version) for aic, version, _ in agent_rows}}

                needs_snapshot = False
                if require_indexed_skills:
                    skill_count = int((await session.execute(select(func.count()).select_from(Skill))).scalar_one())
                    # `agents` 已存在但 `skills` 派生索引为空时，说明本地读模型已经失配。
                    # 这里仅标记需要 snapshot；是否必须升级为 full snapshot replace 由客户端结合
                    # 当前同步基线统一判断，避免后续检查只看到 `last_seq` 就误以为本地状态可信。
                    needs_snapshot = skill_count == 0

                return cls(
                    last_seq=last_seq,
                    object_versions=object_versions,
                    needs_snapshot=needs_snapshot,
                )
        except SQLAlchemyError:
            return cls()


class SnapshotResponseHeader(BaseModel):
    """快照 API 的响应头信息。"""

    snapshot_id: str
    snapshot_seq: int
    chunk_index: int
    chunk_total: int
    object_count: int


class ChangesResponseHeader(BaseModel):
    """变更 API 的响应头信息。"""

    next_seq: int


class RegistryInfo(BaseModel):
    """来自信息 API 的注册中心服务器信息。"""

    service: str
    version: str
    build: str | None = None
    status: str
    supported_types: list[str]
    retention: dict[str, Any] | None = None
    snapshot: dict[str, Any] | None = None
    changes: dict[str, Any] | None = None


class WebhookNotification(BaseModel):
    """Webhook通知的数据结构"""

    # TODO: webhook_id改为id，跟手册保持一致
    webhook_id: str = Field(..., description="Webhook ID")
    event: str = Field(..., description="事件类型")
    timestamp: str = Field(..., description="时间戳")
    data: dict[str, Any] = Field(..., description="事件数据")


class WebhookCreate(BaseModel):
    """创建Webhook的请求模型"""

    url: str = Field(..., description="回调URL")
    secret: str = Field(..., description="签名密钥")
    types: list[str] = Field(default=["acs"], description="关注的数据类型列表")
    events: list[str] = Field(default=["data_change"], description="关注的事件类型列表")
    description: str | None = Field(default=None, description="Webhook描述")


class WebhookResponse(BaseModel):
    """Webhook响应模型"""

    id: str = Field(..., description="Webhook ID")
    url: str = Field(..., description="回调URL")
    types: list[str] = Field(..., description="关注的数据类型列表")
    events: list[str] = Field(..., description="关注的事件类型列表")
    description: str | None = Field(default=None, description="Webhook描述")
    status: str = Field(..., description="Webhook状态")
    failure_count: int = Field(..., description="失败计数")
    last_triggered_at: datetime | None = Field(default=None, description="最后触发时间")
    last_success_at: datetime | None = Field(default=None, description="最后成功时间")
    last_failure_at: datetime | None = Field(default=None, description="最后失败时间")
    next_retry_at: datetime | None = Field(default=None, description="下次重试时间")
    created_at: datetime = Field(..., description="创建时间")
    updated_at: datetime = Field(..., description="更新时间")


# TODO: 跟文档Envelope对比缺少字段
class Agent(SQLModel, table=True):
    """
    Agent 数据库模型，用于存储从 Registry 同步的 Agent 数据。

    对应 DSP 协议中的 Envelope 数据结构，存储同步过来的 ACS 对象。
    """

    __tablename__ = "agents"

    # 对应 Envelope.id - Agent 的唯一标识符
    aic: str = SQLField(
        sa_column=Column(String(255), primary_key=True, nullable=False),
        description="Agent 唯一标识符，对应 Envelope.id",
    )

    # 对应 Envelope.version - 版本号
    version: int = SQLField(
        sa_column=Column(Integer, nullable=False),
        description="Agent 版本号，对应 Envelope.version",
    )

    # 对应 Envelope.seq - 同步序列号
    seq: int = SQLField(
        sa_column=Column(BigInteger, nullable=False),
        description="同步序列号，对应 Envelope.seq",
    )

    # 对应 Envelope.payload - ACS 数据
    acs: dict[str, Any] | None = SQLField(
        default=None,
        sa_column=Column(JSONB, nullable=True),
        description="ACS 数据，对应 Envelope.payload",
    )

    # 一对多关系：一个 Agent -> 多个技能
    skills: list[Skill] = Relationship(
        sa_relationship=relationship(
            "Skill",
            back_populates="agent",
            cascade="all, delete-orphan",
            passive_deletes=True,
        )
    )

    model_config: ClassVar[SQLModelConfig] = cast("SQLModelConfig", ConfigDict(from_attributes=True))


class Skill(SQLModel, table=True):
    """
    Skill 数据库模型，用于存储 Agent 的技能信息及其向量表示。
    """

    __tablename__ = "skills"

    # 自增主键
    id: int | None = SQLField(
        default=None,
        sa_column=Column(Integer, primary_key=True, autoincrement=True),
        description="Skill 表主键，自增",
    )

    # 对应 Agent 表的 aic 外键
    aic: str = SQLField(
        sa_column=Column(String(255), ForeignKey("agents.aic", ondelete="CASCADE"), nullable=False),
        description="对应 Agent 的 aic 外键",
    )

    # Skill 唯一标识符
    skill_id: str = SQLField(
        sa_column=Column(String(255), nullable=True),
        description="Skill 唯一标识符",
    )

    # Skill 描述文本
    description: str = SQLField(
        sa_column=Column(String, nullable=False),
        description="Skill 描述文本",
    )

    # Skill 描述对应向量，维度由 EMBEDDING_DIM 控制
    embedding: list[float] = SQLField(
        sa_column=Column(Vector(settings.EMBEDDING_DIM)),
        description="Skill 描述对应向量，维度由 EMBEDDING_DIM 控制",
    )
    # 稀疏向量,存储为JSONB格式 {token_id: weight}
    sparse_embedding: dict[str, float] | None = SQLField(
        default=None,
        sa_column=Column(JSONB, nullable=True),
        description="Skill 描述对应稀疏向量,存储为{token_id: weight}格式",
    )

    # 多对一关系：技能对应一个 Agent
    agent: Agent | None = Relationship(
        sa_relationship=relationship(
            "Agent",
            back_populates="skills",
            passive_deletes=True,
        )
    )

    __table_args__ = (
        # HNSW 向量索引（余弦距离）
        Index(
            "skills_embedding_hnsw_idx",
            "embedding",
            postgresql_using="hnsw",
            postgresql_with={"m": 16, "ef_construction": 64},
            postgresql_ops={"embedding": "vector_cosine_ops"},
        ),
        # GIN 稀疏向量索引
        Index(
            "skills_sparse_embedding_gin_idx",
            "sparse_embedding",
            postgresql_using="gin",
            postgresql_ops={"sparse_embedding": "jsonb_path_ops"},
        ),
        Index("idx_skills_aic", "aic"),
    )

    model_config: ClassVar[SQLModelConfig] = cast("SQLModelConfig", ConfigDict(from_attributes=True))
