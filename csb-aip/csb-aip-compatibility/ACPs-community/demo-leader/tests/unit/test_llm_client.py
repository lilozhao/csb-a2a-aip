"""Leader LLM client structured parsing tests."""

import sys
from pathlib import Path
from unittest.mock import MagicMock

import pytest
from pydantic import BaseModel

_current_dir = Path(__file__).parent
_tests_root = _current_dir.parent
_project_root = _tests_root.parent
_leader_dir = _project_root / "leader"

if str(_leader_dir) not in sys.path:
    sys.path.insert(0, str(_leader_dir))
if str(_project_root) not in sys.path:
    sys.path.insert(0, str(_project_root))


from assistant.llm.client import LLMClient
from assistant.models.exceptions import LLMParseError


class ExampleStructuredResponse(BaseModel):
    message: str


def make_client() -> LLMClient:
    client = object.__new__(LLMClient)
    client.call = MagicMock()
    return client


class TestLLMClientStructuredRetries:
    def test_parse_structured_response_accepts_balanced_json_prefix(self):
        client = make_client()

        result = client._parse_structured_response(
            '{"message": "ok"}\n}',
            ExampleStructuredResponse,
        )

        assert result.message == "ok"

    def test_call_structured_retries_after_parse_error(self):
        client = make_client()
        client.call.side_effect = [
            '{"message": "missing quote}',
            '{"message": "ok"}',
        ]

        result = client.call_structured(
            profile_name="llm.default",
            system_prompt="system",
            user_message="user",
            response_model=ExampleStructuredResponse,
            parse_retry_count=1,
        )

        assert result.message == "ok"
        assert client.call.call_count == 2
        assert "未通过系统 JSON 解析" in client.call.call_args_list[1].kwargs["user_message"]

    def test_call_structured_raises_after_parse_retries_exhausted(self):
        client = make_client()
        client.call.return_value = '{"message": "broken"'

        with pytest.raises(LLMParseError):
            client.call_structured(
                profile_name="llm.default",
                system_prompt="system",
                user_message="user",
                response_model=ExampleStructuredResponse,
                parse_retry_count=1,
            )

        assert client.call.call_count == 2
