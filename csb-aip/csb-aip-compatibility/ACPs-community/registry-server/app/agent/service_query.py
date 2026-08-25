from __future__ import annotations

import uuid
from datetime import datetime
from typing import TYPE_CHECKING, Literal, cast, overload

from fastapi import status
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Query, Session, joinedload
from sqlalchemy.orm.attributes import QueryableAttribute
from sqlalchemy.sql.elements import ColumnElement

from app.account.model import Role, User
from app.account.schema_account import UserResponse
from app.agent.exception import AgentError, AgentErrorCode
from app.agent.model import Agent, ApprovalStatus
from app.agent.schema import AgentDetailResponse, AgentResponse

if TYPE_CHECKING:
    from app.agent.schema import AgentFilters

type AgentFilterClause = ColumnElement[bool]


AGENT_ID_COL = cast("QueryableAttribute[uuid.UUID]", Agent.id)
AGENT_AIC_COL = cast("QueryableAttribute[str | None]", Agent.aic)
AGENT_NAME_COL = cast("QueryableAttribute[str]", Agent.name)
AGENT_VERSION_COL = cast("QueryableAttribute[str]", Agent.version)
AGENT_CREATED_BY_ID_COL = cast("QueryableAttribute[uuid.UUID]", Agent.created_by_id)
AGENT_PROCESSED_BY_ID_COL = cast("QueryableAttribute[uuid.UUID | None]", Agent.processed_by_id)
AGENT_APPROVAL_STATUS_COL = cast("QueryableAttribute[ApprovalStatus]", Agent.approval_status)
AGENT_IS_ACTIVE_COL = cast("QueryableAttribute[bool]", Agent.is_active)
AGENT_IS_DELETED_COL = cast("QueryableAttribute[bool]", Agent.is_deleted)
AGENT_IS_DISABLED_COL = cast("QueryableAttribute[bool]", Agent.is_disabled)
AGENT_IS_ONTOLOGY_COL = cast("QueryableAttribute[bool]", Agent.is_ontology)
AGENT_CREATED_AT_COL = cast("QueryableAttribute[datetime]", Agent.created_at)
AGENT_PROCESSED_AT_COL = cast("QueryableAttribute[datetime | None]", Agent.processed_at)
AGENT_CREATED_BY_REL = cast("QueryableAttribute[User | None]", Agent.created_by)
AGENT_PROCESSED_BY_REL = cast("QueryableAttribute[User | None]", Agent.processed_by)
USER_ROLES_REL = cast("QueryableAttribute[list[Role]]", User.roles)


def _as_agent_filter_clause(value: ColumnElement[bool] | bool) -> AgentFilterClause:
    return cast("AgentFilterClause", value)


def _apply_agent_user_loads(stmt: Select[tuple[Agent]]) -> Select[tuple[Agent]]:
    return stmt.options(
        joinedload(AGENT_CREATED_BY_REL).selectinload(USER_ROLES_REL),
        joinedload(AGENT_PROCESSED_BY_REL).selectinload(USER_ROLES_REL),
    )


def _apply_agent_user_query_loads(query: Query[Agent]) -> Query[Agent]:
    return query.options(joinedload(AGENT_CREATED_BY_REL), joinedload(AGENT_PROCESSED_BY_REL))


@overload
def create_agent_response(agent: Agent) -> AgentResponse: ...


@overload
def create_agent_response(agent: None) -> None: ...


def create_agent_response(agent: Agent | None) -> AgentResponse | None:
    """将 Agent ORM 对象转换为 AgentResponse。"""
    if not agent:
        return None
    return AgentResponse.model_validate(agent)


@overload
def create_agent_detail_response(agent: Agent) -> AgentDetailResponse: ...


@overload
def create_agent_detail_response(agent: None) -> None: ...


def create_agent_detail_response(agent: Agent | None) -> AgentDetailResponse | None:
    """将 Agent ORM 对象转换为包含完整用户对象的 AgentDetailResponse。"""
    if not agent:
        return None

    response = AgentResponse.model_validate(agent)
    detail_response = AgentDetailResponse(**response.model_dump())

    if agent.created_by:
        detail_response.created_by = UserResponse.model_validate(agent.created_by)

    if agent.processed_by:
        detail_response.processed_by = UserResponse.model_validate(agent.processed_by)

    return detail_response


def _build_agent_filter_clauses(filters: AgentFilters) -> list[AgentFilterClause]:
    clauses: list[AgentFilterClause] = []

    if filters.is_active is not None:
        clauses.append(_as_agent_filter_clause(filters.is_active == AGENT_IS_ACTIVE_COL))
    if filters.is_deleted is not None:
        clauses.append(_as_agent_filter_clause(filters.is_deleted == AGENT_IS_DELETED_COL))
    if filters.is_disabled is not None:
        clauses.append(_as_agent_filter_clause(filters.is_disabled == AGENT_IS_DISABLED_COL))
    if filters.create_by_ids:
        clauses.append(_as_agent_filter_clause(AGENT_CREATED_BY_ID_COL.in_(filters.create_by_ids)))
    if not filters.create_by_ids and filters.create_by_id:
        clauses.append(_as_agent_filter_clause(filters.create_by_id == AGENT_CREATED_BY_ID_COL))
    if filters.process_by_id:
        clauses.append(_as_agent_filter_clause(filters.process_by_id == AGENT_PROCESSED_BY_ID_COL))
    if filters.statuses:
        clauses.append(AGENT_APPROVAL_STATUS_COL.in_(filters.statuses))
    if filters.name:
        clauses.append(_as_agent_filter_clause(filters.name == AGENT_NAME_COL))
    if filters.version:
        clauses.append(_as_agent_filter_clause(filters.version == AGENT_VERSION_COL))
    if filters.aic:
        clauses.append(_as_agent_filter_clause(filters.aic == AGENT_AIC_COL))
    if filters.name_like:
        clauses.append(AGENT_NAME_COL.ilike(f"%{filters.name_like}%"))
    if filters.version_like:
        clauses.append(AGENT_VERSION_COL.ilike(f"%{filters.version_like}%"))
    if filters.aic_like:
        clauses.append(AGENT_AIC_COL.ilike(f"%{filters.aic_like}%"))
    if filters.is_ontology is not None:
        clauses.append(_as_agent_filter_clause(filters.is_ontology == AGENT_IS_ONTOLOGY_COL))

    return clauses


@overload
async def get_agent_async(
    session: AsyncSession,
    agent_id: uuid.UUID,
    with_users: bool = True,
    raise_exception: Literal[True] = True,
) -> Agent: ...


@overload
async def get_agent_async(
    session: AsyncSession,
    agent_id: uuid.UUID,
    with_users: bool = True,
    raise_exception: Literal[False] = False,
) -> Agent | None: ...


async def get_agent_async(
    session: AsyncSession,
    agent_id: uuid.UUID,
    with_users: bool = True,
    raise_exception: bool = False,
) -> Agent | None:
    """获取 Agent 详情（异步读取路径）。"""
    stmt = select(Agent).where(_as_agent_filter_clause(agent_id == AGENT_ID_COL)).limit(1)

    if with_users:
        stmt = _apply_agent_user_loads(stmt)

    result = await session.execute(stmt)
    agent = result.scalar_one_or_none()

    if not agent and raise_exception:
        raise AgentError(
            status_code=status.HTTP_404_NOT_FOUND,
            error_name=AgentErrorCode.AGENT_NOT_FOUND,
            error_msg="Agent not found",
            input_params={"agent_id": str(agent_id)},
        )

    return agent


async def get_agent_by_aic_async(
    session: AsyncSession,
    agent_aic: str,
    raise_exception: bool = False,
) -> Agent | None:
    """根据 AIC 获取 Agent（异步读取路径）。"""
    stmt = select(Agent).where(_as_agent_filter_clause(agent_aic == AGENT_AIC_COL)).limit(1)
    result = await session.execute(stmt)
    agent = result.scalar_one_or_none()

    if not agent and raise_exception:
        raise AgentError(
            status_code=status.HTTP_404_NOT_FOUND,
            error_name=AgentErrorCode.AGENT_NOT_FOUND,
            error_msg="Agent not found with the provided AIC",
            input_params={"agent_aic": agent_aic},
        )

    return agent


async def get_agents_async(session: AsyncSession, filters: AgentFilters) -> tuple[list[Agent], int]:
    """获取 Agent 列表（异步读取路径）。"""
    clauses = _build_agent_filter_clauses(filters)

    skip = (filters.page_num - 1) * filters.page_size

    stmt = select(Agent)
    if filters.with_users:
        stmt = _apply_agent_user_loads(stmt)
    if clauses:
        stmt = stmt.where(*clauses)
    stmt = stmt.order_by(AGENT_CREATED_AT_COL.desc()).offset(skip).limit(filters.page_size)

    count_stmt = select(func.count()).select_from(Agent)
    if clauses:
        count_stmt = count_stmt.where(*clauses)

    result = await session.execute(stmt)
    count_result = await session.execute(count_stmt)

    agents = list(result.scalars().all())
    total = int(count_result.scalar_one())
    return agents, total


async def get_recent_agents_async(
    session: AsyncSession,
    limit: int = 5,
    with_users: bool = False,
) -> list[Agent]:
    """获取最近审批通过的 Agent（异步读取路径）。"""
    stmt = select(Agent).where(
        _as_agent_filter_clause(AGENT_APPROVAL_STATUS_COL == ApprovalStatus.APPROVED),
        AGENT_IS_ACTIVE_COL.is_(True),
    )

    if with_users:
        stmt = _apply_agent_user_loads(stmt)

    stmt = stmt.order_by(AGENT_PROCESSED_AT_COL.desc()).limit(limit)
    result = await session.execute(stmt)
    return list(result.scalars().all())


@overload
def get_agent(
    db: Session,
    agent_id: uuid.UUID,
    with_users: bool = True,
    raise_exception: Literal[True] = True,
) -> Agent: ...


@overload
def get_agent(
    db: Session,
    agent_id: uuid.UUID,
    with_users: bool = True,
    raise_exception: Literal[False] = False,
) -> Agent | None: ...


def get_agent(
    db: Session,
    agent_id: uuid.UUID,
    with_users: bool = True,
    raise_exception: bool = False,
) -> Agent | None:
    """获取 Agent 详情。"""
    query = db.query(Agent).filter(_as_agent_filter_clause(agent_id == AGENT_ID_COL))

    if with_users:
        query = _apply_agent_user_query_loads(query)

    agent = query.first()

    if not agent and raise_exception:
        raise AgentError(
            status_code=status.HTTP_404_NOT_FOUND,
            error_name=AgentErrorCode.AGENT_NOT_FOUND,
            error_msg="Agent not found",
            input_params={"agent_id": str(agent_id)},
        )

    return agent


def get_agent_by_aic(
    db: Session,
    agent_aic: str,
    raise_exception: bool = False,
) -> Agent | None:
    """根据 AIC 获取 Agent 详情。"""
    agent = db.query(Agent).filter(_as_agent_filter_clause(agent_aic == AGENT_AIC_COL)).first()

    if not agent and raise_exception:
        raise AgentError(
            status_code=status.HTTP_404_NOT_FOUND,
            error_name=AgentErrorCode.AGENT_NOT_FOUND,
            error_msg="Agent not found with the provided AIC",
            input_params={"agent_aic": agent_aic},
        )

    return agent


def get_agents(db: Session, filters: AgentFilters) -> tuple[list[Agent], int]:
    """获取 Agent 列表，带过滤和分页。"""
    query = db.query(Agent)
    clauses = _build_agent_filter_clauses(filters)

    if filters.with_users:
        query = _apply_agent_user_query_loads(query)

    if clauses:
        query = query.filter(*clauses)

    total = query.count()

    skip = (filters.page_num - 1) * filters.page_size
    agents = query.order_by(AGENT_CREATED_AT_COL.desc()).offset(skip).limit(filters.page_size).all()

    return agents, total


def get_recent_agents(db: Session, limit: int = 5, with_users: bool = False) -> list[Agent]:
    """获取最近批准的 Agent。"""
    query = db.query(Agent).filter(
        _as_agent_filter_clause(AGENT_APPROVAL_STATUS_COL == ApprovalStatus.APPROVED),
        AGENT_IS_ACTIVE_COL.is_(True),
    )

    if with_users:
        query = _apply_agent_user_query_loads(query)

    return query.order_by(AGENT_PROCESSED_AT_COL.desc()).limit(limit).all()
