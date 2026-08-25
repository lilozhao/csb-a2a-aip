from datetime import timedelta
from typing import Any, cast

import jwt
import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.account.exception_auth import AuthError, AuthErrorCode
from app.account.model import Role, RoleType, User
from app.agent import model as _agent_model
from app.core import auth as auth_module
from app.utils.utils import get_beijing_time

pytestmark = pytest.mark.unit


del _agent_model


class DummyAsyncResult:
    def __init__(self, user: User | None) -> None:
        self.user = user

    def scalar_one_or_none(self) -> User | None:
        return self.user


class DummyAsyncSession:
    def __init__(self, user: User | None) -> None:
        self.user = user
        self.executed_statement: object | None = None

    async def execute(self, statement: object) -> DummyAsyncResult:
        self.executed_statement = statement
        return DummyAsyncResult(self.user)


def _as_async_session(session: DummyAsyncSession) -> AsyncSession:
    return cast("AsyncSession", session)


def _statement_loads_roles(statement: object | None) -> bool:
    if statement is None:
        return False

    options = getattr(cast("Any", statement), "_with_options", ())
    return any("roles" in str(getattr(option, "path", "")) for option in options)


def _make_user(*, access_token: str | None = "token", role: RoleType = RoleType.CLIENT) -> User:  # noqa: S107
    user = User(username="demo-user", hashed_password="hashed-password", access_token=access_token, is_active=True)
    user.roles = [Role(name=role, description=f"{role} role")]
    user.token_expires_at = get_beijing_time() + timedelta(minutes=5)
    return user


async def test_get_current_user_returns_user_with_roles_loaded(monkeypatch: pytest.MonkeyPatch) -> None:
    user = _make_user()
    session = DummyAsyncSession(user)

    monkeypatch.setattr(jwt, "decode", lambda token, key, algorithms: {"sub": str(user.id)})

    current_user = await auth_module.get_current_user(token="token", session=_as_async_session(session))

    assert current_user is user
    assert _statement_loads_roles(session.executed_statement) is True


async def test_safe_get_current_user_returns_none_when_token_mismatches(monkeypatch: pytest.MonkeyPatch) -> None:
    user = _make_user(access_token="stored-token")
    session = DummyAsyncSession(user)

    monkeypatch.setattr(jwt, "decode", lambda token, key, algorithms: {"sub": str(user.id)})

    current_user = await auth_module.safe_get_current_user(token="other-token", session=_as_async_session(session))

    assert current_user is None
    assert _statement_loads_roles(session.executed_statement) is True


async def test_check_user_role_rejects_missing_required_role() -> None:
    current_user = _make_user(role=RoleType.CLIENT)
    dependency = auth_module.check_user_role([RoleType.ADMIN])

    with pytest.raises(AuthError) as exc_info:
        await dependency(current_user=current_user)

    assert exc_info.value.error_name == AuthErrorCode.INSUFFICIENT_PERMISSIONS
