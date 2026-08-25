"""真实数据库测试辅助函数。"""

from __future__ import annotations

import json
from collections.abc import Sequence

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession
from sqlmodel import SQLModel

from app.account.model import Role, RoleType, User
from app.agent.model import Agent, ApprovalStatus
from app.core.auth import get_password_hash
from app.core.db_session import async_engine
from app.sync.service import create_change_log_async
from app.utils.utils import sha256

TRUNCATE_TABLE_NAMES = tuple(
    table.name for table in reversed(SQLModel.metadata.sorted_tables) if table.name != "alembic_version"
)


async def _drop_dynamic_snapshot_tables(connection: AsyncConnection) -> None:
    result = await connection.execute(
        text(
            """
            SELECT tablename
            FROM pg_tables
            WHERE schemaname = 'public'
              AND tablename LIKE 'snapshot_%'
              AND tablename <> 'snapshot'
            """
        )
    )

    for table_name in result.scalars().all():
        await connection.execute(text(f'DROP TABLE IF EXISTS "{table_name}" CASCADE'))


async def reset_database_state() -> None:
    """清空测试数据库中的业务表。"""

    await async_engine.dispose()
    async with async_engine.begin() as connection:
        await _drop_dynamic_snapshot_tables(connection)

        if TRUNCATE_TABLE_NAMES:
            joined_table_names = ", ".join(f'"{table_name}"' for table_name in TRUNCATE_TABLE_NAMES)
            await connection.execute(text(f"TRUNCATE TABLE {joined_table_names} RESTART IDENTITY CASCADE"))

        await connection.execute(text("ALTER SEQUENCE global_seq RESTART WITH 1"))
    await async_engine.dispose()


async def ensure_role(session: AsyncSession, role_name: RoleType) -> Role:
    """确保测试所需角色存在。"""

    result = await session.execute(select(Role).filter_by(name=role_name).limit(1))
    role = result.scalar_one_or_none()
    if role is not None:
        return role

    role = Role(name=role_name, description=f"{role_name.value} role")
    session.add(role)
    await session.flush()
    return role


async def create_user(
    session: AsyncSession,
    *,
    username: str,
    password: str | None = None,
    roles: Sequence[RoleType] = (RoleType.CLIENT,),
    email: str | None = None,
    phone: str | None = None,
    name: str | None = None,
) -> User:
    """创建测试用户，并附加指定角色。"""

    user_roles = [await ensure_role(session, role_name) for role_name in roles]
    user = User(
        username=username,
        email=email,
        phone=phone,
        name=name or username,
        hashed_password=get_password_hash(password) if password is not None else None,
        is_active=True,
    )
    user.roles = user_roles
    session.add(user)
    await session.flush()
    return user


def build_acs_payload(
    *,
    aic: str,
    name: str,
    version: str = "1.0.0",
    active: bool = True,
    end_points: list[dict[str, object]] | None = None,
    entity_meta: dict[str, object] | None = None,
) -> dict[str, object]:
    """生成最小可用的 ACS 测试数据。"""

    payload: dict[str, object] = {
        "aic": aic,
        "active": active,
        "name": name,
        "version": version,
        "securitySchemes": {"mtls": {}},
        "capabilities": {},
        "skills": [],
    }

    if end_points is not None:
        payload["endPoints"] = end_points
    if entity_meta is not None:
        payload["entityMeta"] = entity_meta

    return payload


async def create_agent_with_change_log(
    session: AsyncSession,
    *,
    aic: str,
    name: str,
    created_by: User,
    version: str = "1.0.0",
    description: str | None = None,
    is_ontology: bool = False,
    approval_status: ApprovalStatus = ApprovalStatus.APPROVED,
    is_active: bool = True,
    is_disabled: bool = False,
    is_deleted: bool = False,
    end_points: list[dict[str, object]] | None = None,
    entity_meta: dict[str, object] | None = None,
) -> Agent:
    """创建带 ACS 与 changelog 的 Agent。"""

    acs = build_acs_payload(
        aic=aic,
        name=name,
        version=version,
        active=is_active,
        end_points=end_points,
        entity_meta=entity_meta,
    )
    change_log = await create_change_log_async(
        session=session,
        data_type="acs",
        object_id=aic,
        version=1,
        payload=acs,
        op="upsert",
    )

    agent = Agent(
        aic=aic,
        name=name,
        version=version,
        description=description,
        acs=acs,
        acs_hash=sha256(json.dumps(acs, ensure_ascii=False)),
        acs_version=1,
        acs_last_seq=change_log.seq,
        is_ontology=is_ontology,
        is_active=is_active,
        is_disabled=is_disabled,
        is_deleted=is_deleted,
        created_by_id=created_by.id,
        approval_status=approval_status,
        submitted_at=created_by.created_at,
        processed_by_id=created_by.id,
        processed_at=created_by.created_at,
        process_comments="created-for-test",
    )
    session.add(agent)
    await session.flush()
    return agent
