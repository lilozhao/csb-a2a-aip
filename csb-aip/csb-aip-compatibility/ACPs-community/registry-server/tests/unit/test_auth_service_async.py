import uuid
from typing import TYPE_CHECKING, Any, cast

import pytest

from app.account import service_account, service_auth
from app.account.model import Role, RoleType, User
from app.account.schema_auth import RegisterRequest
from app.agent import model as _agent_model

if TYPE_CHECKING:
    from sqlalchemy.ext.asyncio import AsyncSession

pytestmark = pytest.mark.unit


del _agent_model


class DummyAsyncResult:
    def __init__(self, value: object | None) -> None:
        self.value = value

    def scalar_one_or_none(self) -> object | None:
        return self.value


class DummyAsyncSession:
    def __init__(self) -> None:
        self.added: list[object] = []
        self.flushed = False
        self.executed_statements: list[object] = []

    def add(self, item: object) -> None:
        self.added.append(item)

    async def flush(self) -> None:
        self.flushed = True

    async def execute(self, statement: object) -> DummyAsyncResult:
        self.executed_statements.append(statement)
        return DummyAsyncResult(None)


def _as_async_session(session: DummyAsyncSession) -> AsyncSession:
    return cast("AsyncSession", session)


def _build_user(*, role: RoleType = RoleType.CLIENT) -> User:
    user = User(username=f"user-{uuid.uuid4().hex[:8]}", hashed_password="stored-hash", is_active=True)
    user.roles = [Role(name=role, description=f"{role} role")]
    return user


async def test_register_user_async_creates_default_role_and_user(monkeypatch: pytest.MonkeyPatch) -> None:
    session = DummyAsyncSession()

    async def _none_user(*args: object, **kwargs: object) -> None:
        del args, kwargs
        return

    monkeypatch.setattr(service_auth, "get_user_by_username_async", _none_user)
    monkeypatch.setattr(service_auth, "get_user_by_phone_async", _none_user)
    monkeypatch.setattr(service_auth, "get_role_by_name_async", _none_user)
    monkeypatch.setattr(service_auth, "get_password_hash", lambda password: f"hashed:{password}")

    user = await service_auth.register_user(
        _as_async_session(session),
        RegisterRequest(username="demo-user", password="new-password", name="Demo User"),
    )

    assert user.username == "demo-user"
    assert user.hashed_password == "hashed:new-password"
    assert len(user.roles) == 1
    assert user.roles[0].name == RoleType.CLIENT
    assert session.flushed is True
    assert any(isinstance(item, Role) for item in session.added)
    assert any(isinstance(item, User) for item in session.added)


async def test_authenticate_user_async_rehashes_password_when_needed(monkeypatch: pytest.MonkeyPatch) -> None:
    session = DummyAsyncSession()
    user = _build_user()

    async def _get_user(*args: object, **kwargs: object) -> User:
        del args, kwargs
        return user

    monkeypatch.setattr(service_auth, "get_user_by_username_async", _get_user)
    monkeypatch.setattr(service_auth, "verify_password", lambda plain, hashed: (True, True))
    monkeypatch.setattr(service_auth, "get_password_hash", lambda password: f"rehash:{password}")

    current_user = await service_auth.authenticate_user(
        _as_async_session(session), user.username or "", "secret", raise_exception=True
    )

    assert current_user is user
    assert user.hashed_password == "rehash:secret"
    assert session.added == [user]


async def test_async_helpers_eager_load_roles(monkeypatch: pytest.MonkeyPatch) -> None:
    session = DummyAsyncSession()
    user = _build_user()

    async def _execute(statement: object) -> DummyAsyncResult:
        session.executed_statements.append(statement)
        return DummyAsyncResult(user)

    monkeypatch.setattr(session, "execute", _execute)

    loaded_user = await service_account.get_user_by_username_async(_as_async_session(session), user.username or "")

    assert loaded_user is user
    options = getattr(cast("Any", session.executed_statements[0]), "_with_options", ())
    assert any("roles" in str(getattr(option, "path", "")) for option in options)
