"""针对 service_auth.py 的核心业务逻辑单元测试。

覆盖：validate_password_complexity、authenticate_user、authenticate_by_phone、
create_user_token、reset_password、verify_code / store_verification_code、
register_user（电话注册路径）等。
"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from typing import Any, cast
from unittest.mock import AsyncMock

import jwt
import pytest

from app.account import service_auth
from app.account.exception_account import AccountError, AccountErrorCode
from app.account.model import Role, RoleType, User, VerificationCode
from app.account.schema_auth import RegisterRequest
from app.core.config import settings
from app.utils.utils import get_beijing_time

pytestmark = pytest.mark.unit

TEST_STORED_HASH = "argon2-hash"
TEST_JWT_VALUE = "test-jwt-token-abc123"
TEST_REGISTRATION_VALUE = "Pass@1234"


# ---------------------------------------------------------------------------
# 通用辅助
# ---------------------------------------------------------------------------


class DummyAsyncResult:
    def __init__(self, value: object | None) -> None:
        self.value = value

    def scalar_one_or_none(self) -> object | None:
        return self.value


class DummyAsyncSession:
    def __init__(self, user: User | None = None) -> None:
        self.added: list[object] = []
        self.deleted: list[object] = []
        self.flushed = False
        self.executed_statements: list[object] = []
        self._execute_queue: list[object | None] = []
        self._user = user

    def add(self, item: object) -> None:
        self.added.append(item)

    def queue_result(self, value: object | None) -> None:
        self._execute_queue.append(value)

    async def flush(self) -> None:
        await asyncio.sleep(0)
        self.flushed = True

    async def delete(self, item: object) -> None:
        await asyncio.sleep(0)
        self.deleted.append(item)

    async def execute(self, statement: object) -> DummyAsyncResult:
        self.executed_statements.append(statement)
        await asyncio.sleep(0)
        if self._execute_queue:
            return DummyAsyncResult(self._execute_queue.pop(0))
        return DummyAsyncResult(self._user)


def _build_verification_code(
    *,
    phone: str,
    code: str,
    expires_at: Any | None = None,
) -> VerificationCode:
    return VerificationCode(
        phone=phone,
        code=code,
        expires_at=expires_at or (get_beijing_time() + timedelta(minutes=5)),
    )


def _build_user(
    *,
    role: RoleType = RoleType.CLIENT,
    is_active: bool = True,
    stored_hash: str | None = None,
    phone: str | None = None,
    refresh_token: str | None = None,
    token_expires_at: Any = None,
) -> User:
    resolved_hash = TEST_STORED_HASH if stored_hash is None else stored_hash
    user = User(
        id=uuid.uuid4(),
        username=f"user-{uuid.uuid4().hex[:8]}",
        hashed_password=resolved_hash,
        is_active=is_active,
        phone=phone,
    )
    user.refresh_token = refresh_token
    user.token_expires_at = token_expires_at
    user.roles = [Role(name=role, description=f"{role} role")]
    return user


# ---------------------------------------------------------------------------
# 针对 validate_password_complexity 的测试
# ---------------------------------------------------------------------------


class TestValidatePasswordComplexity:
    def test_valid_password_passes(self) -> None:
        # 应不抛出异常
        service_auth.validate_password_complexity("Secret@1")

    @pytest.mark.parametrize(
        "password,reason",
        [
            ("sh0rT!", "太短（< 8 字符）"),
            ("a" * 21, "太长（> 20 字符）"),
            ("nouppercase1!", "无大写字母"),
            ("NOLOWERCASE1!", "无小写字母"),
            ("NoDigitsHere!", "无数字"),
            ("NoSpecialChar1", "无特殊字符"),
        ],
    )
    def test_invalid_password_raises(self, password: str, reason: str) -> None:
        with pytest.raises(AccountError) as exc_info:
            service_auth.validate_password_complexity(password)
        assert exc_info.value.error_name == AccountErrorCode.PASSWORD_COMPLEXITY_ERROR, reason


# ---------------------------------------------------------------------------
# 针对 verify_code / store_verification_code 的测试
# ---------------------------------------------------------------------------


class TestVerifyCode:
    async def test_send_verification_code_stores_generated_code(self, monkeypatch: pytest.MonkeyPatch) -> None:
        session = DummyAsyncSession()
        session.queue_result(None)
        session.queue_result(None)
        monkeypatch.setattr(service_auth, "generate_verification_code", lambda: "654321")

        code = await service_auth.send_verification_code(cast("Any", session), "13900000002")

        assert code == "654321"
        stored = session.added[0]
        assert isinstance(stored, VerificationCode)
        assert stored.phone == "13900000002"
        assert stored.code == "654321"
        assert session.flushed is True

    async def test_testing_bypass_code_is_valid_when_configured(self) -> None:
        session = DummyAsyncSession()
        assert await service_auth.verify_code(cast("Any", session), "13900000001", "123456") is True

    async def test_bypass_code_is_invalid_when_config_is_empty(self, monkeypatch: pytest.MonkeyPatch) -> None:
        session = DummyAsyncSession()
        monkeypatch.setitem(settings._toml.setdefault("verification", {}), "code_bypass", "")
        session.queue_result(None)
        assert await service_auth.verify_code(cast("Any", session), "13900000001", "123456") is False

    async def test_stored_code_validates_correctly(self) -> None:
        session = DummyAsyncSession()
        stored_code = _build_verification_code(phone="13900000002", code="654321")
        session.queue_result(stored_code)

        assert await service_auth.verify_code(cast("Any", session), "13900000002", "654321") is True
        assert session.deleted == [stored_code]
        assert session.flushed is True

    async def test_wrong_code_returns_false(self) -> None:
        session = DummyAsyncSession()
        stored_code = _build_verification_code(phone="13900000003", code="111111")
        session.queue_result(stored_code)

        assert await service_auth.verify_code(cast("Any", session), "13900000003", "999999") is False
        assert session.deleted == []

    async def test_expired_code_returns_false(self) -> None:
        session = DummyAsyncSession()
        expired_code = _build_verification_code(
            phone="13900000004",
            code="777777",
            expires_at=get_beijing_time() - timedelta(seconds=1),
        )
        session.queue_result(expired_code)

        assert await service_auth.verify_code(cast("Any", session), "13900000004", "777777") is False
        assert session.deleted == [expired_code]
        assert session.flushed is True

    async def test_unknown_phone_returns_false(self) -> None:
        session = DummyAsyncSession()
        session.queue_result(None)
        assert await service_auth.verify_code(cast("Any", session), "00000000000", "000000") is False


# ---------------------------------------------------------------------------
# 针对 authenticate_user 的测试
# ---------------------------------------------------------------------------


class TestAuthenticateUser:
    async def test_valid_credentials_return_user(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user()
        session = DummyAsyncSession()

        monkeypatch.setattr(service_auth, "get_user_by_username_async", AsyncMock(return_value=user))
        monkeypatch.setattr(service_auth, "verify_password", lambda plain, hashed: (True, False))

        result = await service_auth.authenticate_user(
            cast("Any", session), user.username or "", "correctpassword", raise_exception=True
        )
        assert result is user

    async def test_user_not_found_raises_when_requested(self, monkeypatch: pytest.MonkeyPatch) -> None:
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_username_async", AsyncMock(return_value=None))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.authenticate_user(cast("Any", session), "unknown", "pw", raise_exception=True)
        assert exc_info.value.error_name == AccountErrorCode.USER_NOT_FOUND

    async def test_user_not_found_returns_none_without_exception(self, monkeypatch: pytest.MonkeyPatch) -> None:
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_username_async", AsyncMock(return_value=None))

        result = await service_auth.authenticate_user(cast("Any", session), "unknown", "pw", raise_exception=False)
        assert result is None

    async def test_inactive_user_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user(is_active=False)
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_username_async", AsyncMock(return_value=user))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.authenticate_user(cast("Any", session), user.username or "", "pw", raise_exception=True)
        assert exc_info.value.error_name == AccountErrorCode.INVALID_CREDENTIALS

    async def test_no_hashed_password_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user(stored_hash="")
        user.hashed_password = None
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_username_async", AsyncMock(return_value=user))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.authenticate_user(cast("Any", session), user.username or "", "pw", raise_exception=True)
        assert exc_info.value.error_name == AccountErrorCode.INVALID_CREDENTIALS

    async def test_wrong_password_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user()
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_username_async", AsyncMock(return_value=user))
        monkeypatch.setattr(service_auth, "verify_password", lambda plain, hashed: (False, False))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.authenticate_user(
                cast("Any", session), user.username or "", "wrong", raise_exception=True
            )
        assert exc_info.value.error_name == AccountErrorCode.INVALID_CREDENTIALS

    async def test_rehash_is_triggered_on_success(self, monkeypatch: pytest.MonkeyPatch) -> None:
        """验证 bcrypt 哈希成功后应触发 rehash。"""
        user = _build_user()
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_username_async", AsyncMock(return_value=user))
        monkeypatch.setattr(service_auth, "verify_password", lambda plain, hashed: (True, True))
        monkeypatch.setattr(service_auth, "get_password_hash", lambda pw: f"rehash:{pw}")

        result = await service_auth.authenticate_user(
            cast("Any", session), user.username or "", "pw", raise_exception=True
        )
        assert result is user
        assert user.hashed_password == "rehash:pw"
        assert user in session.added


# ---------------------------------------------------------------------------
# 针对 authenticate_by_phone 的测试
# ---------------------------------------------------------------------------


class TestAuthenticateByPhone:
    async def test_valid_phone_and_code_return_user(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user(phone="13912345678")
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_phone_async", AsyncMock(return_value=user))
        monkeypatch.setattr(service_auth, "verify_code", AsyncMock(return_value=True))

        result = await service_auth.authenticate_by_phone(
            cast("Any", session), "13912345678", "123456", raise_exception=True
        )
        assert result is user

    async def test_unknown_phone_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_phone_async", AsyncMock(return_value=None))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.authenticate_by_phone(
                cast("Any", session), "00000000000", "123456", raise_exception=True
            )
        assert exc_info.value.error_name == AccountErrorCode.INVALID_CREDENTIALS

    async def test_invalid_code_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user(phone="13912345678")
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_phone_async", AsyncMock(return_value=user))
        monkeypatch.setattr(service_auth, "verify_code", AsyncMock(return_value=False))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.authenticate_by_phone(
                cast("Any", session), "13912345678", "000000", raise_exception=True
            )
        assert exc_info.value.error_name == AccountErrorCode.INVALID_VERIFICATION_CODE

    async def test_inactive_user_returns_none(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user(phone="13912345678", is_active=False)
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_phone_async", AsyncMock(return_value=user))

        result = await service_auth.authenticate_by_phone(
            cast("Any", session), "13912345678", "123456", raise_exception=False
        )
        assert result is None


# ---------------------------------------------------------------------------
# 针对 create_user_token 的测试
# ---------------------------------------------------------------------------


class TestCreateUserToken:
    def test_returns_token_dict_with_required_keys(self) -> None:
        user = _build_user()
        token_data = service_auth.create_user_token(user)

        assert "access_token" in token_data
        assert token_data["token_type"] == "bearer"
        assert "refresh_token" in token_data
        assert "expires_at" in token_data

    def test_access_and_refresh_tokens_are_distinct_and_typed(self) -> None:
        user = _build_user()
        token_data = service_auth.create_user_token(user)

        assert token_data["access_token"] != token_data["refresh_token"]

        access_payload = jwt.decode(token_data["access_token"], settings.secret_key, algorithms=[settings.algorithm])
        refresh_payload = jwt.decode(
            token_data["refresh_token"],
            settings.secret_key,
            algorithms=[settings.algorithm],
        )

        assert access_payload["type"] == service_auth.ACCESS_TOKEN_TYPE
        assert refresh_payload["type"] == service_auth.REFRESH_TOKEN_TYPE

    def test_updates_user_token_fields(self) -> None:
        user = _build_user()
        service_auth.create_user_token(user)

        assert user.access_token is not None
        assert user.refresh_token is not None
        assert user.token_expires_at is not None


# ---------------------------------------------------------------------------
# 针对 refresh_access_token 的测试
# ---------------------------------------------------------------------------


class TestRefreshAccessToken:
    async def test_refresh_token_rotates_tokens(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user()
        session = DummyAsyncSession()
        original_token_data = service_auth.create_user_token(user)
        monkeypatch.setattr(service_auth, "get_user_async", AsyncMock(return_value=user))

        refreshed = await service_auth.refresh_access_token(
            cast("Any", session),
            original_token_data["refresh_token"],
            raise_exception=True,
        )

        assert refreshed["access_token"] != original_token_data["access_token"]
        assert refreshed["refresh_token"] != original_token_data["refresh_token"]
        assert user.access_token == refreshed["access_token"]
        assert user.refresh_token == refreshed["refresh_token"]

    async def test_access_token_cannot_be_used_as_refresh_token(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user()
        session = DummyAsyncSession()
        token_data = service_auth.create_user_token(user)
        monkeypatch.setattr(service_auth, "get_user_async", AsyncMock(return_value=user))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.refresh_access_token(
                cast("Any", session),
                token_data["access_token"],
                raise_exception=True,
            )

        assert exc_info.value.error_name == AccountErrorCode.INVALID_REFRESH_TOKEN

    async def test_inactive_user_preserves_user_not_found_error(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user(is_active=False)
        session = DummyAsyncSession()
        token_data = service_auth.create_user_token(user)
        monkeypatch.setattr(service_auth, "get_user_async", AsyncMock(return_value=user))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.refresh_access_token(
                cast("Any", session),
                token_data["refresh_token"],
                raise_exception=True,
            )

        assert exc_info.value.error_name == AccountErrorCode.USER_NOT_FOUND


# ---------------------------------------------------------------------------
# 针对 reset_password 的测试
# ---------------------------------------------------------------------------


class TestResetPassword:
    async def test_successful_reset(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user(phone="13900001111")
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_phone_async", AsyncMock(return_value=user))
        monkeypatch.setattr(service_auth, "verify_code", AsyncMock(return_value=True))
        monkeypatch.setattr(service_auth, "get_password_hash", lambda pw: f"hashed:{pw}")

        result = await service_auth.reset_password(cast("Any", session), "13900001111", "123456", "NewPass@1")
        assert result is True
        assert user.hashed_password == "hashed:NewPass@1"

    async def test_user_not_found_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_phone_async", AsyncMock(return_value=None))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.reset_password(cast("Any", session), "00000000000", "123456", "NewPass@1")
        assert exc_info.value.error_name == AccountErrorCode.USER_NOT_FOUND

    async def test_invalid_code_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        user = _build_user(phone="13900001111")
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_phone_async", AsyncMock(return_value=user))
        monkeypatch.setattr(service_auth, "verify_code", AsyncMock(return_value=False))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.reset_password(cast("Any", session), "13900001111", "000000", "NewPass@1")
        assert exc_info.value.error_name == AccountErrorCode.INVALID_VERIFICATION_CODE


# ---------------------------------------------------------------------------
# 针对 register_user（电话注册路径）的测试
# ---------------------------------------------------------------------------


class TestRegisterUserPhonePath:
    async def test_phone_already_registered_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        existing_user = _build_user(phone="13900002222")
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_phone_async", AsyncMock(return_value=existing_user))
        monkeypatch.setattr(service_auth, "get_user_by_username_async", AsyncMock(return_value=None))
        monkeypatch.setattr(service_auth, "get_role_by_name_async", AsyncMock(return_value=None))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.register_user(
                cast("Any", session),
                RegisterRequest(
                    phone="13900002222",
                    verify_code="123456",
                    username="new-user",
                    password=TEST_REGISTRATION_VALUE,
                ),
            )
        assert exc_info.value.error_name == AccountErrorCode.PHONE_ALREADY_REGISTERED

    async def test_invalid_verification_code_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_phone_async", AsyncMock(return_value=None))
        monkeypatch.setattr(service_auth, "verify_code", AsyncMock(return_value=False))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.register_user(
                cast("Any", session),
                RegisterRequest(phone="13900002223", verify_code="999999", username="new-user"),
            )
        assert exc_info.value.error_name == AccountErrorCode.INVALID_VERIFICATION_CODE

    async def test_no_username_in_non_phone_path_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        session = DummyAsyncSession()

        with pytest.raises(AccountError) as exc_info:
            await service_auth.register_user(
                cast("Any", session),
                RegisterRequest(name="Some User"),
            )
        assert exc_info.value.error_name == AccountErrorCode.INVALID_REQUEST

    async def test_missing_password_in_non_phone_path_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        del monkeypatch
        session = DummyAsyncSession()

        with pytest.raises(AccountError) as exc_info:
            await service_auth.register_user(
                cast("Any", session),
                RegisterRequest(username="missing-password"),
            )
        assert exc_info.value.error_name == AccountErrorCode.INVALID_REQUEST

    async def test_username_already_taken_raises(self, monkeypatch: pytest.MonkeyPatch) -> None:
        existing_user = _build_user()
        session = DummyAsyncSession()
        monkeypatch.setattr(service_auth, "get_user_by_username_async", AsyncMock(return_value=existing_user))

        with pytest.raises(AccountError) as exc_info:
            await service_auth.register_user(
                cast("Any", session),
                RegisterRequest(username="taken-user", password=TEST_REGISTRATION_VALUE),
            )
        assert exc_info.value.error_name == AccountErrorCode.USERNAME_ALREADY_TAKEN
