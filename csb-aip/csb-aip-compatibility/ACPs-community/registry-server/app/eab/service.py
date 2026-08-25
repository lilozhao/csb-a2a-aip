import base64
import secrets
import uuid
from datetime import timedelta
from typing import Any, cast

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.agent.model import Agent
from app.core.config import settings
from app.core.crypto import sm4_decrypt, sm4_encrypt
from app.eab.exception import (
    AgentAicInactiveError,
    AgentAicNotOwnedError,
    EabCredentialAlreadyConsumedError,
    EabCredentialExpiredError,
    EabCredentialNotFoundError,
)
from app.eab.model import EabCredential
from app.eab.schema import EabConsumeResponse, EabCredentialResponse
from app.utils.utils import get_beijing_time

AGENT_AIC_COLUMN = cast("Any", Agent.aic)
EAB_KEY_ID_COLUMN = cast("Any", EabCredential.key_id)


def _generate_key_id() -> str:
    return uuid.uuid4().hex


def _generate_mac_key() -> str:
    return base64.urlsafe_b64encode(secrets.token_bytes(32)).decode("ascii").rstrip("=")


async def _get_agent_by_aic(session: AsyncSession, agent_aic: str) -> Agent | None:
    stmt = select(Agent).where(agent_aic == AGENT_AIC_COLUMN).limit(1)
    result = await session.execute(stmt)
    return result.scalar_one_or_none()


async def generate_eab_credential(
    session: AsyncSession,
    user_id: uuid.UUID,
    agent_aic: str,
) -> EabCredentialResponse:
    """为当前用户拥有且处于 active 状态的 AIC 创建一次性 EAB 凭据。"""
    normalized_aic = agent_aic.strip().upper()
    agent = await _get_agent_by_aic(session, normalized_aic)

    if agent is None or agent.created_by_id != user_id:
        raise AgentAicNotOwnedError(agent_aic=normalized_aic, user_id=str(user_id))

    if not agent.is_active or agent.is_deleted or agent.is_disabled:
        raise AgentAicInactiveError(agent_aic=normalized_aic)

    key_id = _generate_key_id()
    mac_key = _generate_mac_key()
    expires_at = get_beijing_time() + timedelta(hours=settings.eab_credential_expire_hours)

    credential = EabCredential(
        key_id=key_id,
        mac_key_encrypted=sm4_encrypt(mac_key, settings.sm4_encryption_key),
        aic=normalized_aic,
        user_id=user_id,
        expires_at=expires_at,
    )
    session.add(credential)
    await session.flush()

    return EabCredentialResponse(
        key_id=key_id,
        mac_key=mac_key,
        aic=normalized_aic,
        expires_at=expires_at,
    )


async def consume_eab_credential(session: AsyncSession, key_id: str) -> EabConsumeResponse:
    """消费一次性 EAB 凭据，并返回明文 macKey 与 AIC。"""
    stmt = select(EabCredential).where(key_id == EAB_KEY_ID_COLUMN).with_for_update().limit(1)
    result = await session.execute(stmt)
    credential = result.scalar_one_or_none()

    if credential is None:
        raise EabCredentialNotFoundError(key_id=key_id)

    if credential.is_consumed:
        raise EabCredentialAlreadyConsumedError(key_id=key_id)

    if credential.expires_at <= get_beijing_time():
        raise EabCredentialExpiredError(key_id=key_id)

    credential.is_consumed = True
    credential.consumed_at = get_beijing_time()
    session.add(credential)
    await session.flush()

    return EabConsumeResponse(
        mac_key=sm4_decrypt(
            credential.mac_key_encrypted,
            settings.sm4_encryption_key,
        ),
        aic=credential.aic,
    )
