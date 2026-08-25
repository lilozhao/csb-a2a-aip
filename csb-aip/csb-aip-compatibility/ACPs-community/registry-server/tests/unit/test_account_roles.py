from typing import cast

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.account import service_account
from app.account.model import Role, RoleType
from app.account.service_account import create_role, delete_role, update_role
from app.agent import model as _agent_model

pytestmark = pytest.mark.unit


del _agent_model


class DummyDb:
    def __init__(self, role: Role | None = None) -> None:
        self.role = role
        self.added: list[object] = []
        self.deleted: list[object] = []
        self.flushed = False
        self.committed = False

    def add(self, item: object) -> None:
        self.added.append(item)
        if isinstance(item, Role):
            self.role = item

    async def delete(self, item: object) -> None:
        self.deleted.append(item)

    async def flush(self) -> None:
        self.flushed = True


def _as_async_session(db: DummyDb) -> AsyncSession:
    return cast("AsyncSession", db)


async def test_create_role_flushes_without_commit() -> None:
    db = DummyDb()

    role = await create_role(_as_async_session(db), RoleType.CLIENT, "client")

    assert role.name == RoleType.CLIENT
    assert role.description == "client"
    assert db.flushed is True
    assert db.committed is False


async def test_update_role_flushes_without_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    role = Role(name=RoleType.CLIENT, description="before")
    db = DummyDb(role=role)

    async def _get_role(*args: object, **kwargs: object) -> Role:
        del args, kwargs
        return role

    monkeypatch.setattr(service_account, "get_role", _get_role)

    updated_role = await update_role(_as_async_session(db), role.id, name=RoleType.ADMIN, description="after")

    assert updated_role.name == RoleType.ADMIN
    assert updated_role.description == "after"
    assert db.flushed is True
    assert db.committed is False


async def test_delete_role_flushes_without_commit(monkeypatch: pytest.MonkeyPatch) -> None:
    role = Role(name=RoleType.CLIENT, description="client")
    db = DummyDb(role=role)

    async def _get_role(*args: object, **kwargs: object) -> Role:
        del args, kwargs
        return role

    monkeypatch.setattr(service_account, "get_role", _get_role)

    result = await delete_role(_as_async_session(db), role.id)

    assert result is True
    assert db.deleted == [role]
    assert db.flushed is True
    assert db.committed is False
