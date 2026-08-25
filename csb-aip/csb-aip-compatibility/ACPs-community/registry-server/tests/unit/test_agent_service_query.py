"""针对 agent/service_query.py 同步查询分支的单元测试。"""

from __future__ import annotations

import uuid
from types import SimpleNamespace
from typing import Any, cast

import pytest

from app.agent import service_query as svc
from app.agent.exception import AgentError, AgentErrorCode
from app.agent.model import ApprovalStatus
from app.agent.schema import AgentFilters
from app.utils.utils import get_beijing_time

pytestmark = pytest.mark.unit


def _build_user(username: str, role_names: list[str]) -> SimpleNamespace:
    now = get_beijing_time()
    return SimpleNamespace(
        id=uuid.uuid4(),
        username=username,
        email=f"{username}@example.com",
        phone=None,
        name=username.title(),
        avatar=None,
        org_name=None,
        org_code=None,
        org_address=None,
        is_active=True,
        roles=[SimpleNamespace(name=role_name) for role_name in role_names],
        created_at=now,
        updated_at=now,
        token_expires_at=None,
    )


def _build_agent(*, created_by: object | None = None, processed_by: object | None = None) -> Any:
    now = get_beijing_time()
    created_by_id = getattr(created_by, "id", uuid.uuid4())
    processed_by_id = getattr(processed_by, "id", None)
    return cast(
        "Any",
        SimpleNamespace(
            id=uuid.uuid4(),
            aic="did:acps:demo",
            name="Demo Agent",
            version="1.0.0",
            description="demo",
            logo_url=None,
            acs={"name": "demo"},
            acs_hash="hash",
            acs_version=1,
            acs_last_seq=7,
            is_active=True,
            is_deleted=False,
            deleted_at=None,
            deleted_reason=None,
            is_disabled=False,
            disabled_at=None,
            disabled_reason=None,
            approval_status=ApprovalStatus.APPROVED,
            created_by_id=created_by_id,
            created_at=now,
            updated_at=now,
            submitted_at=now,
            processed_by_id=processed_by_id,
            processed_at=now,
            process_comments="approved",
            vector_id=None,
            is_ontology=False,
            created_by=created_by,
            processed_by=processed_by,
        ),
    )


class RecordingQuery:
    def __init__(
        self,
        *,
        first_result: object | None = None,
        all_results: list[object] | None = None,
        count_value: int = 0,
    ) -> None:
        self.first_result = first_result
        self.all_results = list(all_results or [])
        self.count_value = count_value
        self.filter_args: tuple[object, ...] = ()
        self.options_args: tuple[object, ...] = ()
        self.order_by_args: tuple[object, ...] = ()
        self.offset_value: int | None = None
        self.limit_value: int | None = None

    def filter(self, *args: object) -> RecordingQuery:
        self.filter_args = args
        return self

    def options(self, *args: object) -> RecordingQuery:
        self.options_args = args
        return self

    def first(self) -> object | None:
        return self.first_result

    def count(self) -> int:
        return self.count_value

    def order_by(self, *args: object) -> RecordingQuery:
        self.order_by_args = args
        return self

    def offset(self, value: int) -> RecordingQuery:
        self.offset_value = value
        return self

    def limit(self, value: int) -> RecordingQuery:
        self.limit_value = value
        return self

    def all(self) -> list[object]:
        return list(self.all_results)


class RecordingDb:
    def __init__(self, query: RecordingQuery) -> None:
        self.query_object = query
        self.models: list[object] = []

    def query(self, model: object) -> RecordingQuery:
        self.models.append(model)
        return self.query_object


def test_create_agent_response_returns_none_for_missing_agent() -> None:
    assert svc.create_agent_response(None) is None


def test_create_agent_detail_response_embeds_user_objects() -> None:
    created_by = _build_user("creator", ["CLIENT"])
    processed_by = _build_user("reviewer", ["STAFF"])

    detail = svc.create_agent_detail_response(_build_agent(created_by=created_by, processed_by=processed_by))

    assert detail is not None
    assert detail.created_by is not None
    assert detail.created_by.username == "creator"
    assert detail.created_by.roles == ["CLIENT"]
    assert detail.processed_by is not None
    assert detail.processed_by.username == "reviewer"
    assert detail.processed_by.roles == ["STAFF"]


def test_build_agent_filter_clauses_returns_empty_for_default_filters() -> None:
    assert svc._build_agent_filter_clauses(AgentFilters()) == []


def test_build_agent_filter_clauses_keeps_false_booleans_and_text_filters() -> None:
    filters = AgentFilters(
        is_active=False,
        is_deleted=False,
        is_disabled=False,
        name="demo",
        version="1.0.0",
        aic="did:acps:demo",
        name_like="agent",
        version_like="1.0",
        aic_like="acps",
        statuses=[ApprovalStatus.APPROVED],
        is_ontology=False,
        create_by_id=uuid.uuid4(),
        process_by_id=uuid.uuid4(),
    )

    clauses = svc._build_agent_filter_clauses(filters)
    clause_texts = [str(clause) for clause in clauses]

    assert len(clauses) == 13
    assert any("agent.is_active" in text for text in clause_texts)
    assert any("agent.is_deleted" in text for text in clause_texts)
    assert any("agent.is_disabled" in text for text in clause_texts)
    assert any("agent.name" in text for text in clause_texts)
    assert any("agent.version" in text for text in clause_texts)
    assert any("agent.aic" in text for text in clause_texts)


def test_get_agent_applies_user_loads_when_requested() -> None:
    agent = _build_agent()
    query = RecordingQuery(first_result=agent)
    db = RecordingDb(query)

    result = svc.get_agent(cast("Any", db), agent.id, with_users=True, raise_exception=True)

    assert result is agent
    assert len(query.options_args) == 2
    assert len(query.filter_args) == 1


def test_get_agent_raises_not_found_when_requested() -> None:
    query = RecordingQuery(first_result=None)
    db = RecordingDb(query)
    agent_id = uuid.uuid4()

    with pytest.raises(AgentError) as exc_info:
        svc.get_agent(cast("Any", db), agent_id, raise_exception=True)

    assert exc_info.value.error_name == AgentErrorCode.AGENT_NOT_FOUND
    assert exc_info.value.input_params == {"agent_id": str(agent_id)}


def test_get_agent_by_aic_raises_not_found_when_requested() -> None:
    query = RecordingQuery(first_result=None)
    db = RecordingDb(query)

    with pytest.raises(AgentError) as exc_info:
        svc.get_agent_by_aic(cast("Any", db), "did:acps:missing", raise_exception=True)

    assert exc_info.value.error_name == AgentErrorCode.AGENT_NOT_FOUND
    assert exc_info.value.input_params == {"agent_aic": "did:acps:missing"}


def test_get_agents_applies_filters_pagination_and_optional_user_loads() -> None:
    agent = _build_agent()
    query = RecordingQuery(all_results=[agent], count_value=11)
    db = RecordingDb(query)
    filters = AgentFilters(
        page_num=3,
        page_size=10,
        with_users=True,
        statuses=[ApprovalStatus.APPROVED],
        name_like="demo",
    )

    items, total = svc.get_agents(cast("Any", db), filters)

    assert items == [agent]
    assert total == 11
    assert len(query.options_args) == 2
    assert len(query.filter_args) == 2
    assert query.offset_value == 20
    assert query.limit_value == 10
    assert len(query.order_by_args) == 1


def test_get_recent_agents_returns_items_and_applies_limit() -> None:
    agent = _build_agent()
    query = RecordingQuery(all_results=[agent])
    db = RecordingDb(query)

    items = svc.get_recent_agents(cast("Any", db), limit=7, with_users=True)

    assert items == [agent]
    assert len(query.options_args) == 2
    assert len(query.filter_args) == 2
    assert query.limit_value == 7
