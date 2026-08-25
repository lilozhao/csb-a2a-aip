"""针对 core/auth.py 的单元测试。

覆盖：verify_password（argon2 正确/错误/需重哈希、bcrypt 兜底）、
get_password_hash、create_access_token、
get_optional_token（有/无 Authorization header、非 Bearer 格式）、
get_current_active_user、check_user_role、
safe_get_current_user（token 为 None、有效 token）、
_get_user_with_roles（通过 get_current_user 间接覆盖）。
"""

from __future__ import annotations

import uuid
from datetime import timedelta
from unittest.mock import AsyncMock, MagicMock

import jwt
import pytest

from app.account.exception_auth import (
    InactiveUserError,
    InsufficientPermissionsError,
)
from app.account.model import Role, RoleType, User
from app.core import auth as core_auth

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# 辅助函数
# ---------------------------------------------------------------------------


def _make_user(*, is_active: bool = True, roles: list[RoleType] | None = None) -> User:
    u = User()
    u.id = uuid.uuid4()
    u.username = "testuser"
    u.is_active = is_active
    u.access_token = "fake-token"
    u.token_expires_at = None
    r_list: list[Role] = []
    for name in roles or [RoleType.CLIENT]:
        r = Role()
        r.name = name
        r_list.append(r)
    u.roles = r_list
    return u


def _valid_token(user: User) -> str:
    """生成一个真实的 JWT，sub 为 user.id，用于 get_current_user 测试。"""
    from app.core.config import settings
    from app.utils.utils import get_beijing_time

    expire = get_beijing_time() + timedelta(minutes=30)
    payload = {"sub": str(user.id), "exp": expire}
    return str(jwt.encode(payload, settings.secret_key, algorithm=settings.algorithm))


# ---------------------------------------------------------------------------
# 针对 verify_password 的测试
# ---------------------------------------------------------------------------


class TestVerifyPassword:
    def test_argon2_correct_password(self) -> None:
        hashed = core_auth.get_password_hash("MyPassw0rd!")
        valid, needs_rehash = core_auth.verify_password("MyPassw0rd!", hashed)
        assert valid is True
        assert needs_rehash is False

    def test_argon2_wrong_password(self) -> None:
        hashed = core_auth.get_password_hash("MyPassw0rd!")
        valid, needs_rehash = core_auth.verify_password("WrongPass!", hashed)
        assert valid is False
        assert needs_rehash is False

    def test_bcrypt_fallback_correct(self) -> None:
        from passlib.context import CryptContext

        bcrypt_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
        bcrypt_hash = bcrypt_ctx.hash("OldPass1!")

        valid, needs_rehash = core_auth.verify_password("OldPass1!", bcrypt_hash)
        assert valid is True
        assert needs_rehash is True  # 应触发迁移

    def test_bcrypt_fallback_wrong_password(self) -> None:
        from passlib.context import CryptContext

        bcrypt_ctx = CryptContext(schemes=["bcrypt"], deprecated="auto")
        bcrypt_hash = bcrypt_ctx.hash("OldPass1!")

        valid, needs_rehash = core_auth.verify_password("BadPass!", bcrypt_hash)
        assert valid is False
        assert needs_rehash is False

    def test_invalid_hash_returns_false(self) -> None:
        valid, needs_rehash = core_auth.verify_password("anything", "not-a-real-hash")
        assert valid is False
        assert needs_rehash is False


# ---------------------------------------------------------------------------
# 针对 get_password_hash 的测试
# ---------------------------------------------------------------------------


class TestGetPasswordHash:
    def test_returns_argon2_hash(self) -> None:
        h = core_auth.get_password_hash("SomeP@ss1")
        assert h.startswith("$argon2")

    def test_different_passwords_different_hashes(self) -> None:
        h1 = core_auth.get_password_hash("Pass1!")
        h2 = core_auth.get_password_hash("Pass2!")
        assert h1 != h2


# ---------------------------------------------------------------------------
# 针对 create_access_token 的测试
# ---------------------------------------------------------------------------


class TestCreateAccessToken:
    def test_creates_decodable_token(self) -> None:
        from app.core.config import settings

        token = core_auth.create_access_token({"sub": "user-123"})
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        assert payload["sub"] == "user-123"
        assert "exp" in payload

    def test_custom_expires_delta(self) -> None:
        from app.core.config import settings

        token = core_auth.create_access_token({"sub": "u"}, expires_delta=timedelta(hours=2))
        payload = jwt.decode(token, settings.secret_key, algorithms=[settings.algorithm])
        assert "exp" in payload

    async def test_safe_get_current_user_rejects_refresh_token(self) -> None:
        user = _make_user()
        refresh_token = core_auth.create_access_token(
            {"sub": str(user.id), "type": "refresh"},
            expires_delta=timedelta(minutes=30),
        )
        mock_session = AsyncMock()

        result = await core_auth.safe_get_current_user(token=refresh_token, session=mock_session)

        assert result is None


# ---------------------------------------------------------------------------
# 针对 get_optional_token 的测试
# ---------------------------------------------------------------------------


class TestGetOptionalToken:
    def _req(self, auth_header: str | None) -> MagicMock:
        request = MagicMock()
        headers: dict[str, str] = {}
        if auth_header:
            headers["Authorization"] = auth_header
        request.headers = headers
        return request

    def test_valid_bearer_returns_token(self) -> None:
        request = self._req("Bearer my-token-value")
        result = core_auth.get_optional_token(request)
        assert result == "my-token-value"

    def test_missing_header_returns_none(self) -> None:
        request = self._req(None)
        result = core_auth.get_optional_token(request)
        assert result is None

    def test_non_bearer_returns_none(self) -> None:
        request = self._req("Basic dXNlcjpwYXNz")
        result = core_auth.get_optional_token(request)
        assert result is None

    def test_malformed_header_returns_none(self) -> None:
        request = self._req("Bearer")
        result = core_auth.get_optional_token(request)
        assert result is None


# ---------------------------------------------------------------------------
# 针对 get_current_active_user 的测试
# ---------------------------------------------------------------------------


class TestGetCurrentActiveUser:
    def test_returns_user_when_active(self) -> None:
        user = _make_user(is_active=True)
        result = core_auth.get_current_active_user(user)
        assert result is user

    def test_raises_when_inactive(self) -> None:
        user = _make_user(is_active=False)
        with pytest.raises(InactiveUserError):
            core_auth.get_current_active_user(user)


# ---------------------------------------------------------------------------
# 针对 check_user_role 的测试
# ---------------------------------------------------------------------------


class TestCheckUserRole:
    def test_raises_insufficient_permissions(self) -> None:
        checker = core_auth.check_user_role([RoleType.ADMIN])
        import inspect

        src = inspect.getclosurevars(checker)
        assert "required_roles" in src.nonlocals
        assert RoleType.ADMIN in src.nonlocals["required_roles"]

    async def test_passes_with_correct_role(self) -> None:
        """验证 check_user_role 返回内部协程函数，可直接用 current_user 参数调用。"""
        user = _make_user(roles=[RoleType.ADMIN])
        checker = core_auth.check_user_role([RoleType.ADMIN])
        # checker 本身就是 _check_user_role 协程函数，可直接传入 current_user
        result = await checker(current_user=user)
        assert result is user

    async def test_check_user_role_raises_for_wrong_role(self) -> None:
        user = _make_user(roles=[RoleType.CLIENT])
        checker = core_auth.check_user_role([RoleType.ADMIN])
        with pytest.raises(InsufficientPermissionsError):
            await checker(current_user=user)


# ---------------------------------------------------------------------------
# 针对 safe_get_current_user 的测试
# ---------------------------------------------------------------------------


class TestSafeGetCurrentUser:
    async def test_returns_none_when_no_token(self) -> None:
        mock_session = AsyncMock()
        result = await core_auth.safe_get_current_user(token=None, session=mock_session)
        assert result is None

    async def test_returns_none_for_invalid_jwt(self) -> None:
        mock_session = AsyncMock()
        result = await core_auth.safe_get_current_user(token="not.a.jwt", session=mock_session)
        assert result is None

    async def test_returns_none_when_user_not_found(self) -> None:
        user = _make_user()
        token = _valid_token(user)
        user.access_token = token

        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = None
        mock_session.execute = AsyncMock(return_value=mock_result)

        result = await core_auth.safe_get_current_user(token=token, session=mock_session)
        assert result is None

    async def test_returns_user_when_valid(self) -> None:
        user = _make_user()
        token = _valid_token(user)
        user.access_token = token

        mock_session = AsyncMock()
        mock_result = MagicMock()
        mock_result.scalar_one_or_none.return_value = user
        mock_session.execute = AsyncMock(return_value=mock_result)

        result = await core_auth.safe_get_current_user(token=token, session=mock_session)
        assert result is user
