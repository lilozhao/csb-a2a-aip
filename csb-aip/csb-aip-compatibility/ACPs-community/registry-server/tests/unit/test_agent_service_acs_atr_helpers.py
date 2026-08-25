"""针对 agent/service_acs.py 与 service_atr.py 边界分支的单元测试。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any, Literal, cast
from unittest.mock import AsyncMock

import pytest
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import Session

from app.agent import service_acs, service_atr
from app.agent.exception import AgentError, AgentErrorCode, AtrError, AtrErrorCode
from app.agent.model import ApprovalStatus

pytestmark = pytest.mark.unit


def _as_async_session(session: object) -> AsyncSession:
    return cast("AsyncSession", session)


def _as_session(db: object) -> Session:
    return cast("Session", db)


def _build_agent(
    *,
    acs: object,
    aic: str | None = None,
    is_active: bool = True,
    status: ApprovalStatus = ApprovalStatus.APPROVED,
) -> Any:
    return SimpleNamespace(
        id=uuid.uuid4(),
        acs=acs,
        aic=aic,
        is_active=is_active,
        is_ontology=False,
        approval_status=status,
        updated_at=None,
    )


def test_load_agent_acs_data_rejects_non_string_non_dict() -> None:
    with pytest.raises(AgentError) as exc_info:
        service_acs._load_agent_acs_data(_build_agent(acs=123))

    assert exc_info.value.error_name == AgentErrorCode.INVALID_ACS


def test_load_agent_acs_data_rejects_invalid_json_string() -> None:
    with pytest.raises(AgentError) as exc_info:
        service_acs._load_agent_acs_data(_build_agent(acs="{invalid-json}"))

    assert exc_info.value.error_name == AgentErrorCode.INVALID_ACS


def test_load_agent_acs_data_rejects_non_object_json() -> None:
    with pytest.raises(AgentError) as exc_info:
        service_acs._load_agent_acs_data(_build_agent(acs='["not", "object"]'))

    assert exc_info.value.error_name == AgentErrorCode.INVALID_ACS


@pytest.mark.asyncio
async def test_generate_aic_for_agent_async_retries_after_sqlalchemy_error(monkeypatch: pytest.MonkeyPatch) -> None:
    class Nested:
        async def __aenter__(self) -> Nested:
            return self

        async def __aexit__(self, exc_type: object, exc: object, tb: object) -> Literal[False]:
            del exc_type, exc, tb
            return False

    class RetrySession:
        def __init__(self) -> None:
            self.begin_nested_calls = 0
            self.flush_calls = 0
            self.added: list[object] = []

        def begin_nested(self) -> Nested:
            self.begin_nested_calls += 1
            return Nested()

        def add(self, item: object) -> None:
            self.added.append(item)

        async def flush(self) -> None:
            self.flush_calls += 1
            if self.flush_calls == 1:
                raise SQLAlchemyError("conflict")

    agent = _build_agent(acs={"name": "demo"}, aic=None)
    session = RetrySession()
    update_mock = AsyncMock()
    sleep_calls: list[float] = []

    monkeypatch.setattr(service_acs, "update_agent_acs_data_async", update_mock)
    monkeypatch.setattr("app.agent.service_acs.aic.generate_aic", lambda: "aic-retried")
    monkeypatch.setattr(
        service_acs,
        "get_beijing_time",
        lambda: SimpleNamespace(isoformat=lambda: "2024-01-01T00:00:00+00:00"),
    )

    async def fake_sleep(delay: float) -> None:
        sleep_calls.append(delay)

    monkeypatch.setattr("app.agent.service_acs.asyncio.sleep", fake_sleep)

    result = await service_acs.generate_aic_for_agent_async(_as_async_session(session), agent)

    assert result is agent
    assert agent.aic == "aic-retried"
    assert session.begin_nested_calls == 2
    assert session.flush_calls == 2
    assert sleep_calls == [0.002]
    assert update_mock.await_count == 2


def test_generate_aic_for_agent_retries_after_sqlalchemy_error(monkeypatch: pytest.MonkeyPatch) -> None:
    class Nested:
        def __enter__(self) -> Nested:
            return self

        def __exit__(self, exc_type: object, exc: object, tb: object) -> Literal[False]:
            del exc_type, exc, tb
            return False

    class RetryDb:
        def __init__(self) -> None:
            self.begin_nested_calls = 0
            self.flush_calls = 0
            self.added: list[object] = []

        def begin_nested(self) -> Nested:
            self.begin_nested_calls += 1
            return Nested()

        def add(self, item: object) -> None:
            self.added.append(item)

        def flush(self) -> None:
            self.flush_calls += 1
            if self.flush_calls == 1:
                raise SQLAlchemyError("conflict")

    agent = _build_agent(acs={"name": "demo"}, aic=None)
    db = RetryDb()
    update_calls: list[str] = []
    sleep_calls: list[float] = []

    monkeypatch.setattr(
        service_acs,
        "update_agent_acs_data",
        lambda current_agent, current_db=None: update_calls.append("updated"),
    )
    monkeypatch.setattr("app.agent.service_acs.aic.generate_aic", lambda: "aic-retried")
    monkeypatch.setattr(service_acs, "get_beijing_time", lambda: "fixed-time")
    monkeypatch.setattr("app.agent.service_acs.time.sleep", lambda delay: sleep_calls.append(delay))

    result = service_acs.generate_aic_for_agent(_as_session(db), agent)

    assert result is agent
    assert agent.aic == "aic-retried"
    assert agent.updated_at == "fixed-time"
    assert db.begin_nested_calls == 2
    assert db.flush_calls == 2
    assert sleep_calls == [0.002]
    assert update_calls == ["updated", "updated"]


@pytest.mark.parametrize(
    ("ontology_agent", "expected_code"),
    [
        (None, AtrErrorCode.ONTOLOGY_NOT_FOUND),
        (
            SimpleNamespace(
                is_active=False,
                is_disabled=False,
                is_deleted=False,
                is_ontology=True,
                approval_status=ApprovalStatus.APPROVED,
            ),
            AtrErrorCode.ONTOLOGY_INACTIVE,
        ),
        (
            SimpleNamespace(
                is_active=True,
                is_disabled=True,
                is_deleted=False,
                is_ontology=True,
                approval_status=ApprovalStatus.APPROVED,
            ),
            AtrErrorCode.ONTOLOGY_INACTIVE,
        ),
        (
            SimpleNamespace(
                is_active=True,
                is_disabled=False,
                is_deleted=True,
                is_ontology=True,
                approval_status=ApprovalStatus.APPROVED,
            ),
            AtrErrorCode.ONTOLOGY_INACTIVE,
        ),
        (
            SimpleNamespace(
                is_active=True,
                is_disabled=False,
                is_deleted=False,
                is_ontology=False,
                approval_status=ApprovalStatus.APPROVED,
            ),
            AtrErrorCode.INVALID_REQUEST,
        ),
        (
            SimpleNamespace(
                is_active=True,
                is_disabled=False,
                is_deleted=False,
                is_ontology=True,
                approval_status=ApprovalStatus.PENDING,
            ),
            AtrErrorCode.ONTOLOGY_INACTIVE,
        ),
    ],
)
def test_ensure_registrable_ontology_agent_rejects_invalid_states(
    ontology_agent: Any,
    expected_code: AtrErrorCode,
) -> None:
    with pytest.raises(AtrError) as exc_info:
        service_atr._ensure_registrable_ontology_agent(ontology_agent, "onto-aic")

    assert exc_info.value.code == expected_code


def test_ensure_entity_endpoints_available_raises_conflict() -> None:
    class ConflictResult:
        def fetchone(self) -> tuple[str]:
            return ("existing-aic",)

    class ConflictDb:
        def execute(self, query: object, params: dict[str, object]) -> ConflictResult:
            del query, params
            return ConflictResult()

    with pytest.raises(AtrError) as exc_info:
        service_atr._ensure_entity_endpoints_available(
            _as_session(ConflictDb()),
            ontology_aic="onto-aic",
            end_points=[{"url": "https://conflict.example.com"}],
        )

    assert exc_info.value.code == AtrErrorCode.ENDPOINT_CONFLICT


def test_generate_entity_aic_or_raise_rejects_empty_result(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.agent.service_atr.aic.generate_entity_aic_from_ontology", lambda ontology_aic: None)

    with pytest.raises(AtrError) as exc_info:
        service_atr._generate_entity_aic_or_raise("onto-aic")

    assert exc_info.value.code == AtrErrorCode.GENERATE_AIC_FAILED


def test_generate_unique_entity_aic_retries_until_unique(monkeypatch: pytest.MonkeyPatch) -> None:
    existing = object()
    generated = iter(["dup-aic", "final-aic"])

    class Query:
        def __init__(self, result: object | None) -> None:
            self.result = result

        def filter(self, *args: object, **kwargs: object) -> Query:
            del args, kwargs
            return self

        def first(self) -> object | None:
            return self.result

    class RetryDb:
        def __init__(self) -> None:
            self.calls = 0

        def query(self, model: object) -> Query:
            del model
            self.calls += 1
            return Query(existing if self.calls == 1 else None)

    monkeypatch.setattr(service_atr, "_generate_entity_aic_or_raise", lambda ontology_aic: next(generated))

    result = service_atr._generate_unique_entity_aic(_as_session(RetryDb()), "onto-aic")

    assert result == "final-aic"


def test_build_derived_entity_name_appends_serial_suffix(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr("app.agent.service_atr.aic.get_instance_serial", lambda entity_aic: "000012345678")

    result = service_atr._build_derived_entity_name("Ontology Entity", "entity-aic")

    assert result.endswith("12345678")
    assert result.startswith("Ontology Entity-")
