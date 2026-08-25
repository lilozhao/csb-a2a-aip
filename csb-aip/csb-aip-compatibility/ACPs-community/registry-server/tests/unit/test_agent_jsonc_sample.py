import pytest

from app.agent.service import generate_jsonc_sample_from_schema

pytestmark = pytest.mark.unit


def test_generate_jsonc_sample_resolves_ref_and_prefers_local_description() -> None:
    root_schema = {
        "definitions": {
            "title": {
                "type": "string",
                "description": "Resolved description",
                "examples": ["demo-agent"],
            }
        }
    }
    schema = {"$ref": "#/definitions/title", "description": "Override description"}

    value, description = generate_jsonc_sample_from_schema(schema, root_schema)

    assert value == '"demo-agent"'
    assert description == "Override description"


def test_generate_jsonc_sample_renders_object_comments_for_nested_properties() -> None:
    schema = {
        "type": "object",
        "description": "Agent example",
        "properties": {
            "name": {"type": "string", "description": "Agent name"},
            "config": {
                "type": "object",
                "description": "Nested configuration",
                "properties": {"enabled": {"type": "boolean", "description": "Whether the feature is enabled"}},
            },
        },
    }

    value, description = generate_jsonc_sample_from_schema(schema)

    assert description == "Agent example"
    assert '"name": "string", // Agent name' in value
    assert "// Nested configuration" in value
    assert '"enabled": true // Whether the feature is enabled' in value


def test_generate_jsonc_sample_renders_array_examples() -> None:
    schema = {
        "type": "array",
        "description": "String array",
        "items": {"type": "string"},
        "examples": [["alpha", "beta"]],
    }

    value, description = generate_jsonc_sample_from_schema(schema)

    assert description == "String array"
    assert value == '[\n  "alpha",\n  "beta"\n]'
