import pytest

from app.agent.schema import AgentResponse

pytestmark = pytest.mark.unit


def test_normalize_acs_parses_json_object_string() -> None:
    result = AgentResponse.normalize_acs('{"name": "demo-agent"}')

    assert result == {"name": "demo-agent"}


def test_normalize_acs_keeps_non_object_json_as_raw_string() -> None:
    result = AgentResponse.normalize_acs('["demo-agent"]')

    assert result == '["demo-agent"]'
