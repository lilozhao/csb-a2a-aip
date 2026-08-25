"""认证核心契约测试。"""

import pytest
from passlib.context import CryptContext

from app.core import auth as auth_module

pytestmark = pytest.mark.unit

_legacy_bcrypt_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


def test_get_password_hash_always_returns_argon2_hash() -> None:
    password_hash = auth_module.get_password_hash("secret")

    assert password_hash.startswith("$argon2")


def test_verify_password_marks_argon2_hash_for_rehash_when_parameters_are_outdated(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    class _HasherStub:
        def verify(self, hashed_password: str, plain_password: str) -> bool:
            assert hashed_password == "argon-hash"
            assert plain_password == "secret"
            return True

        def check_needs_rehash(self, hashed_password: str) -> bool:
            assert hashed_password == "argon-hash"
            return True

    monkeypatch.setattr(auth_module, "_ph", _HasherStub())

    assert auth_module.verify_password("secret", "argon-hash") == (True, True)


def test_verify_password_accepts_legacy_bcrypt_hash_and_requests_rehash() -> None:
    legacy_hash = _legacy_bcrypt_context.hash("secret")

    assert auth_module.verify_password("secret", legacy_hash) == (True, True)
