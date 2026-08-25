"""针对 eab/service.py 和 verification/service.py 的单元测试。"""

from __future__ import annotations

import asyncio
import uuid
from datetime import timedelta
from typing import Any, cast
from unittest.mock import MagicMock, patch

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

import app.eab.service as eab_svc
import app.verification.service as ver_svc
from app.eab.exception import (
    AgentAicInactiveError,
    AgentAicNotOwnedError,
    EabCredentialAlreadyConsumedError,
    EabCredentialExpiredError,
    EabCredentialNotFoundError,
)
from app.eab.model import EabCredential
from app.utils.utils import get_beijing_time
from app.verification.exception import (
    IdentityAlreadyVerifiedError,
    IdentityVerificationPendingError,
    IdentityVerificationRequiredError,
    OrganizationAlreadyVerifiedError,
    OrganizationVerificationPendingError,
)
from app.verification.model import VerificationStatus

pytestmark = pytest.mark.unit


# ---------------------------------------------------------------------------
# 通用辅助
# ---------------------------------------------------------------------------


class DummyExecuteResult:
    def __init__(self, value: Any | None = None) -> None:
        self._value = value

    def scalar_one_or_none(self) -> Any | None:
        return self._value


class DummyAsyncSession:
    def __init__(self) -> None:
        self.added: list[Any] = []
        self.flushed = False
        self._queue: list[Any] = []
        self.executed_statements: list[Any] = []

    def queue(self, value: Any | None) -> None:
        self._queue.append(DummyExecuteResult(value))

    def add(self, item: Any) -> None:
        self.added.append(item)

    async def flush(self) -> None:
        await asyncio.sleep(0)
        self.flushed = True

    async def execute(self, statement: Any) -> DummyExecuteResult:
        self.executed_statements.append(statement)
        await asyncio.sleep(0)
        return self._queue.pop(0) if self._queue else DummyExecuteResult(None)


def _as_async_session(session: DummyAsyncSession) -> AsyncSession:
    return cast("AsyncSession", session)


# ---------------------------------------------------------------------------
# 针对 eab/service.py 的测试
# ---------------------------------------------------------------------------


def _make_agent(
    user_id: uuid.UUID, *, is_active: bool = True, is_deleted: bool = False, is_disabled: bool = False
) -> MagicMock:
    agent = MagicMock()
    agent.created_by_id = user_id
    agent.is_active = is_active
    agent.is_deleted = is_deleted
    agent.is_disabled = is_disabled
    return agent


def _make_credential(
    *,
    key_id: str = "test-key-id",
    is_consumed: bool = False,
    expired: bool = False,
) -> EabCredential:
    from app.utils.utils import get_beijing_time

    cred = EabCredential()
    cred.key_id = key_id
    cred.is_consumed = is_consumed
    cred.mac_key_encrypted = "encrypted-key"
    cred.aic = "1.2.156.3088.1.0001.00001.ABCDEF.000000.0000"  # 假值，不校验
    if expired:
        cred.expires_at = get_beijing_time() - timedelta(hours=1)
    else:
        cred.expires_at = get_beijing_time() + timedelta(hours=24)
    return cred


class TestGenerateEabCredential:
    async def test_raises_when_agent_not_found(self) -> None:
        session = DummyAsyncSession()
        session.queue(None)  # agent not found

        with pytest.raises(AgentAicNotOwnedError):
            await eab_svc.generate_eab_credential(_as_async_session(session), uuid.uuid4(), "SOME.AIC")

    async def test_raises_when_agent_not_owned(self) -> None:
        session = DummyAsyncSession()
        other_user = uuid.uuid4()
        agent = _make_agent(other_user)
        session.queue(agent)

        with pytest.raises(AgentAicNotOwnedError):
            await eab_svc.generate_eab_credential(_as_async_session(session), uuid.uuid4(), "SOME.AIC")

    async def test_raises_when_agent_inactive(self) -> None:
        session = DummyAsyncSession()
        user_id = uuid.uuid4()
        agent = _make_agent(user_id, is_active=False)
        session.queue(agent)

        with pytest.raises(AgentAicInactiveError):
            await eab_svc.generate_eab_credential(_as_async_session(session), user_id, "SOME.AIC")

    async def test_raises_when_agent_disabled(self) -> None:
        session = DummyAsyncSession()
        user_id = uuid.uuid4()
        agent = _make_agent(user_id, is_disabled=True)
        session.queue(agent)

        with pytest.raises(AgentAicInactiveError):
            await eab_svc.generate_eab_credential(_as_async_session(session), user_id, "SOME.AIC")

    async def test_creates_credential_successfully(self) -> None:
        session = DummyAsyncSession()
        user_id = uuid.uuid4()
        agent = _make_agent(user_id)
        session.queue(agent)

        with patch("app.eab.service.sm4_encrypt", return_value="encrypted-key"):
            result = await eab_svc.generate_eab_credential(_as_async_session(session), user_id, "TEST.AIC")

        assert result.key_id is not None
        assert result.mac_key is not None
        assert session.flushed


class TestConsumeEabCredential:
    async def test_uses_for_update_lock(self) -> None:
        session = DummyAsyncSession()
        cred = _make_credential()
        session.queue(cred)

        with patch("app.eab.service.sm4_decrypt", return_value="plain-mac-key"):
            await eab_svc.consume_eab_credential(_as_async_session(session), cred.key_id)

        assert session.executed_statements
        assert getattr(session.executed_statements[0], "_for_update_arg", None) is not None

    async def test_raises_when_credential_not_found(self) -> None:
        session = DummyAsyncSession()
        session.queue(None)

        with pytest.raises(EabCredentialNotFoundError):
            await eab_svc.consume_eab_credential(_as_async_session(session), "missing-key")

    async def test_raises_when_already_consumed(self) -> None:
        session = DummyAsyncSession()
        cred = _make_credential(is_consumed=True)
        session.queue(cred)

        with pytest.raises(EabCredentialAlreadyConsumedError):
            await eab_svc.consume_eab_credential(_as_async_session(session), cred.key_id)

    async def test_raises_when_expired(self) -> None:
        session = DummyAsyncSession()
        cred = _make_credential(expired=True)
        session.queue(cred)

        with pytest.raises(EabCredentialExpiredError):
            await eab_svc.consume_eab_credential(_as_async_session(session), cred.key_id)

    async def test_raises_when_expired_at_current_time_boundary(self) -> None:
        session = DummyAsyncSession()
        current_time = get_beijing_time()
        cred = _make_credential()
        cred.expires_at = current_time
        session.queue(cred)

        with (
            patch("app.eab.service.get_beijing_time", return_value=current_time),
            pytest.raises(EabCredentialExpiredError),
        ):
            await eab_svc.consume_eab_credential(_as_async_session(session), cred.key_id)

    async def test_prioritizes_already_consumed_before_expired(self) -> None:
        session = DummyAsyncSession()
        cred = _make_credential(is_consumed=True, expired=True)
        session.queue(cred)

        with pytest.raises(EabCredentialAlreadyConsumedError):
            await eab_svc.consume_eab_credential(_as_async_session(session), cred.key_id)

    async def test_consumes_credential_successfully(self) -> None:
        session = DummyAsyncSession()
        cred = _make_credential()
        session.queue(cred)

        with patch("app.eab.service.sm4_decrypt", return_value="plain-mac-key"):
            result = await eab_svc.consume_eab_credential(_as_async_session(session), cred.key_id)

        assert result.mac_key == "plain-mac-key"
        assert cred.is_consumed is True
        assert session.flushed


# ---------------------------------------------------------------------------
# 针对 verification/service.py 的测试
# ---------------------------------------------------------------------------


def _make_user(
    *,
    identity_verified: bool = False,
    org_verified: bool = False,
) -> MagicMock:
    user = MagicMock()
    user.id = uuid.uuid4()
    user.identity_verified = identity_verified
    user.org_verified = org_verified
    return user


def _make_identity_request() -> MagicMock:
    req = MagicMock()
    req.id_type = "ID_CARD"
    req.id_number = "110101199001011234"
    req.real_name = "张三"
    return req


def _make_org_request() -> MagicMock:
    req = MagicMock()
    req.org_name = "测试公司"
    req.usci = "91110000000000000X"
    req.org_registration_number = None
    req.legal_rep_name = "李四"
    req.legal_rep_id_number = "110101199001011235"
    return req


class TestSubmitIdentityVerification:
    async def test_raises_when_already_verified(self) -> None:
        session = DummyAsyncSession()
        user = _make_user(identity_verified=True)

        with pytest.raises(IdentityAlreadyVerifiedError):
            await ver_svc.submit_identity_verification(_as_async_session(session), user, _make_identity_request())

    async def test_raises_when_pending_exists(self) -> None:
        session = DummyAsyncSession()
        user = _make_user()
        pending = MagicMock()
        pending.status = VerificationStatus.PENDING
        pending.id = uuid.uuid4()
        session.queue(pending)

        with pytest.raises(IdentityVerificationPendingError):
            await ver_svc.submit_identity_verification(_as_async_session(session), user, _make_identity_request())

    async def test_creates_verification_successfully(self) -> None:
        session = DummyAsyncSession()
        user = _make_user()
        session.queue(None)  # no existing pending verification

        with (
            patch("app.verification.service.settings") as ms,
            patch("app.verification.service.generate_sm3_salt", return_value="salt"),
            patch("app.verification.service.sm3_hash", return_value="hash"),
            patch("app.verification.service.sm4_encrypt", return_value="encrypted"),
        ):
            ms.auto_approve_identity_verification = False
            ms.sm4_encryption_key = "key"
            record = await ver_svc.submit_identity_verification(
                _as_async_session(session), user, _make_identity_request()
            )

        assert record.status == VerificationStatus.PENDING
        assert session.flushed

    async def test_auto_approves_when_setting_enabled(self) -> None:
        session = DummyAsyncSession()
        user = _make_user()
        session.queue(None)

        with (
            patch("app.verification.service.settings") as ms,
            patch("app.verification.service.generate_sm3_salt", return_value="salt"),
            patch("app.verification.service.sm3_hash", return_value="hash"),
            patch("app.verification.service.sm4_encrypt", return_value="encrypted"),
        ):
            ms.auto_approve_identity_verification = True
            ms.sm4_encryption_key = "key"
            record = await ver_svc.submit_identity_verification(
                _as_async_session(session), user, _make_identity_request()
            )

        assert record.status == VerificationStatus.APPROVED
        assert user.identity_verified is True


class TestSubmitOrgVerification:
    async def test_raises_when_identity_not_verified(self) -> None:
        session = DummyAsyncSession()
        user = _make_user(identity_verified=False)

        with pytest.raises(IdentityVerificationRequiredError):
            await ver_svc.submit_org_verification(_as_async_session(session), user, _make_org_request())

    async def test_raises_when_org_already_verified(self) -> None:
        session = DummyAsyncSession()
        user = _make_user(identity_verified=True, org_verified=True)

        with pytest.raises(OrganizationAlreadyVerifiedError):
            await ver_svc.submit_org_verification(_as_async_session(session), user, _make_org_request())

    async def test_raises_when_org_pending_exists(self) -> None:
        session = DummyAsyncSession()
        user = _make_user(identity_verified=True)
        pending = MagicMock()
        pending.status = VerificationStatus.PENDING
        pending.id = uuid.uuid4()
        session.queue(pending)

        with pytest.raises(OrganizationVerificationPendingError):
            await ver_svc.submit_org_verification(_as_async_session(session), user, _make_org_request())

    async def test_creates_org_verification(self) -> None:
        session = DummyAsyncSession()
        user = _make_user(identity_verified=True)
        session.queue(None)

        with (
            patch("app.verification.service.settings") as ms,
            patch("app.verification.service.generate_sm3_salt", return_value="salt"),
            patch("app.verification.service.sm3_hash", return_value="hash"),
            patch("app.verification.service.sm4_encrypt", return_value="encrypted"),
        ):
            ms.auto_approve_org_verification = False
            ms.sm4_encryption_key = "key"
            record = await ver_svc.submit_org_verification(_as_async_session(session), user, _make_org_request())

        assert record.status == VerificationStatus.PENDING
        assert session.flushed

    async def test_auto_approves_org_when_setting_enabled(self) -> None:
        session = DummyAsyncSession()
        user = _make_user(identity_verified=True)
        session.queue(None)

        with (
            patch("app.verification.service.settings") as ms,
            patch("app.verification.service.generate_sm3_salt", return_value="salt"),
            patch("app.verification.service.sm3_hash", return_value="hash"),
            patch("app.verification.service.sm4_encrypt", return_value="encrypted"),
        ):
            ms.auto_approve_org_verification = True
            ms.sm4_encryption_key = "key"
            record = await ver_svc.submit_org_verification(_as_async_session(session), user, _make_org_request())

        assert record.status == VerificationStatus.APPROVED
        assert user.org_verified is True
