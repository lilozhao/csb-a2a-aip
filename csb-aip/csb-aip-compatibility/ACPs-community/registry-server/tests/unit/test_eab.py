from __future__ import annotations

import uuid
from datetime import timedelta
from types import SimpleNamespace
from typing import TYPE_CHECKING, Any, cast

import pytest
from fastapi.routing import APIRoute
from sqlalchemy.ext.asyncio import AsyncSession

if TYPE_CHECKING:
    from app.agent.model import Agent
from app.account.exception_auth import TokenValidationError
from app.core.base_exception import PROBLEM_JSON_MEDIA_TYPE
from app.core.config import settings as core_settings
from app.core.crypto import sm3_hash, sm4_decrypt, sm4_encrypt
from app.eab import api as eab_api
from app.eab import service as eab_service
from app.eab.exception import EabError, EabErrorCode
from app.eab.model import EabCredential
from app.utils.utils import get_beijing_time

pytestmark = pytest.mark.unit


def _find_route(router: object, path: str, method: str) -> APIRoute:
    for route in cast("Any", router).routes:
        if isinstance(route, APIRoute) and route.path == path and method in route.methods:
            return route
    raise AssertionError(f"Route not found: {method} {path}")


def _dependency_names(route: APIRoute) -> set[str]:
    return {dependency.call.__name__ for dependency in route.dependant.dependencies if dependency.call is not None}


def test_eab_api_routes_define_status_summary_and_problem_responses() -> None:
    for router in (eab_api.router_atr, eab_api.router_internal):
        for route in router.routes:
            if not isinstance(route, APIRoute):
                continue

            assert route.summary
            assert route.status_code is not None
            assert route.responses

            for response in route.responses.values():
                assert response["content"][PROBLEM_JSON_MEDIA_TYPE] == {}


def test_eab_internal_consume_route_requires_service_token_not_user_role() -> None:
    create_route = _find_route(eab_api.router_atr, "/eab/{agent_aic}", "POST")
    consume_route = _find_route(eab_api.router_internal, "/internal/eab/consume", "POST")

    create_dependency_names = _dependency_names(create_route)
    consume_dependency_names = _dependency_names(consume_route)

    assert create_dependency_names == {"_check_user_role", "get_session"}
    assert consume_dependency_names == {"get_session", "require_internal_service_token"}


def test_internal_service_token_dependency_accepts_matching_bearer_token() -> None:
    request = cast(
        "Any",
        SimpleNamespace(headers={"Authorization": f"Bearer {core_settings.registry_server_internal_api_token}"}),
    )

    eab_api.require_internal_service_token(request)


def test_internal_service_token_dependency_rejects_missing_bearer_token() -> None:
    request = cast("Any", SimpleNamespace(headers={}))

    with pytest.raises(TokenValidationError) as exc_info:
        eab_api.require_internal_service_token(request)

    assert exc_info.value.error_name == "TOKEN_VALIDATION_ERROR"


class DummyDb:
    def __init__(self, credential: EabCredential | None = None) -> None:
        self.credential = credential
        self.added: list[object] = []
        self.committed = False
        self.flushed = False

    def add(self, item: object) -> None:
        self.added.append(item)
        if isinstance(item, EabCredential):
            self.credential = item

    def commit(self) -> None:
        self.committed = True

    async def flush(self) -> None:
        self.flushed = True

    async def execute(self, statement: object) -> DummyAsyncResult:
        entity = cast("Any", statement).column_descriptions[0].get("entity")
        if entity is EabCredential:
            return DummyAsyncResult(self.credential)
        return DummyAsyncResult(None)


class DummyAsyncResult:
    def __init__(self, value: object | None) -> None:
        self.value = value

    def scalar_one_or_none(self) -> object | None:
        return self.value


def _as_async_session(db: DummyDb) -> AsyncSession:
    return cast("AsyncSession", db)


def test_sm4_encrypt_round_trip() -> None:
    plaintext = "test-mac-key"
    key_hex = "0123456789abcdeffedcba9876543210"

    ciphertext = sm4_encrypt(plaintext, key_hex)

    assert ciphertext != plaintext
    assert sm4_decrypt(ciphertext, key_hex) == plaintext


def test_sm3_hash_is_stable_for_same_inputs() -> None:
    assert sm3_hash("310101199001011234", "salt-1") == sm3_hash("310101199001011234", "salt-1")


async def test_generate_eab_credential_encrypts_mac_key(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent = cast(
        "Agent",
        SimpleNamespace(
            created_by_id=uuid.uuid4(),
            is_active=True,
            is_deleted=False,
            is_disabled=False,
        ),
    )
    db = DummyDb()

    async def _get_agent(*args: object, **kwargs: object) -> Agent:
        del args, kwargs
        return agent

    monkeypatch.setattr(eab_service, "_get_agent_by_aic", _get_agent)

    response = await eab_service.generate_eab_credential(_as_async_session(db), agent.created_by_id, "aic-1")

    assert db.flushed is True
    assert db.committed is False
    assert isinstance(db.credential, EabCredential)
    assert db.credential.aic == "AIC-1"
    assert db.credential.mac_key_encrypted != response.mac_key
    assert (
        sm4_decrypt(
            db.credential.mac_key_encrypted,
            core_settings.sm4_encryption_key,
        )
        == response.mac_key
    )


async def test_generate_eab_credential_rejects_non_owner(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    agent = cast(
        "Agent",
        SimpleNamespace(
            created_by_id=uuid.uuid4(),
            is_active=True,
            is_deleted=False,
            is_disabled=False,
        ),
    )
    requester_id = uuid.uuid4()

    async def _get_agent(*args: object, **kwargs: object) -> Agent:
        del args, kwargs
        return agent

    monkeypatch.setattr(eab_service, "_get_agent_by_aic", _get_agent)

    with pytest.raises(EabError) as exc_info:
        await eab_service.generate_eab_credential(_as_async_session(DummyDb()), requester_id, "aic-1")

    assert exc_info.value.error_name == EabErrorCode.AIC_NOT_OWNED


async def test_consume_eab_credential_marks_record_consumed() -> None:
    credential = EabCredential(
        key_id="key-1",
        mac_key_encrypted=sm4_encrypt(
            "plain-mac",
            core_settings.sm4_encryption_key,
        ),
        aic="AIC-1",
        user_id=uuid.uuid4(),
        expires_at=get_beijing_time() + timedelta(hours=1),
    )
    db = DummyDb(credential=credential)

    response = await eab_service.consume_eab_credential(_as_async_session(db), "key-1")

    assert db.flushed is True
    assert db.committed is False
    assert credential.is_consumed is True
    assert credential.consumed_at is not None
    assert response.mac_key == "plain-mac"
    assert response.aic == "AIC-1"
