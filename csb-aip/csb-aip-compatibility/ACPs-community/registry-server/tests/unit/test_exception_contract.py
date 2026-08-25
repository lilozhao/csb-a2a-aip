import asyncio
from types import SimpleNamespace
from typing import Literal

import pytest
from fastapi import Query
from httpx import AsyncClient
from pydantic import BaseModel, field_validator
from sqlalchemy.exc import OperationalError

from app import main as app_main
from app.core.acps_exception import AcpsError
from app.core.base_exception import AppError

pytestmark = pytest.mark.unit


class _ReadySession:
    def __init__(self, fail: bool = False) -> None:
        self._fail = fail

    async def __aenter__(self) -> _ReadySession:
        return self

    async def __aexit__(self, exc_type: object, exc: object, tb: object) -> Literal[False]:
        del exc_type, exc, tb
        return False

    async def execute(self, statement: object) -> SimpleNamespace:
        del statement
        await asyncio.sleep(0)
        if self._fail:
            raise OperationalError("SELECT 1", {}, ConnectionError("db down"))
        return SimpleNamespace()


class _WhitespaceRejectedBody(BaseModel):
    value: str

    @field_validator("value", mode="before")
    @classmethod
    def reject_blank_value(cls, raw_value: object) -> object:
        if not isinstance(raw_value, str):
            return raw_value

        normalized = raw_value.strip()
        if not normalized:
            raise ValueError("Field cannot be blank")
        return normalized


def _ensure_test_routes() -> None:
    existing_paths = {path for route in app_main.app.routes if (path := getattr(route, "path", None)) is not None}

    if "/__test/app-error" not in existing_paths:

        @app_main.app.get("/__test/app-error")
        async def raise_app_error() -> None:
            raise AppError(
                code="TEAPOT",
                title="Teapot",
                detail="i am teapot",
                status_code=418,
                type_="urn:acps:error:testing:teapot",
                extensions={
                    "error_group": "testing",
                    "input_params": {"source": "test"},
                },
            )

    if "/__test/acps-exception" not in existing_paths:

        @app_main.app.get("/__test/acps-exception")
        async def raise_acps_exception() -> None:
            raise AcpsError(
                protocol="atr",
                code=40001,
                message="invalid request",
                http_status=400,
                data={"field": "agentAic"},
            )

    if "/__test/validation-error" not in existing_paths:

        @app_main.app.get("/__test/validation-error")
        async def trigger_validation_error(value: int = Query(...)) -> dict[str, int]:
            return {"value": value}

    if "/__test/body-validation-error" not in existing_paths:

        @app_main.app.post("/__test/body-validation-error")
        async def trigger_body_validation_error(payload: _WhitespaceRejectedBody) -> dict[str, str]:
            return {"value": payload.value}


_ensure_test_routes()


async def test_app_error_uses_problem_details(main_app_client: AsyncClient) -> None:
    response = await main_app_client.get("/__test/app-error")

    assert response.status_code == 418
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json() == {
        "type": "urn:acps:error:testing:teapot",
        "status": 418,
        "title": "Teapot",
        "detail": "i am teapot",
        "error_group": "testing",
        "error_name": "TEAPOT",
        "input_params": {"source": "test"},
    }


async def test_acps_exception_preserves_protocol_payload(main_app_client: AsyncClient) -> None:
    response = await main_app_client.get("/__test/acps-exception")

    assert response.status_code == 400
    assert response.headers["content-type"].startswith("application/json")
    assert response.json() == {
        "status": "error",
        "error": {
            "code": 40001,
            "message": "invalid request",
            "data": {"field": "agentAic"},
        },
    }


async def test_request_validation_error_uses_problem_details(main_app_client: AsyncClient) -> None:
    response = await main_app_client.get("/__test/validation-error", params={"value": "nope"})

    assert response.status_code == 422
    assert response.headers["content-type"].startswith("application/problem+json")
    payload = response.json()
    assert payload["type"] == "urn:acps:error:validation:request-validation-failed"
    assert payload["status"] == 422
    assert payload["title"] == "Request validation failed"
    assert payload["detail"] == "Request body, query, or path parameters failed validation."
    assert payload["error_name"] == "VALIDATION_FAILED"
    assert payload["errors"]


async def test_request_validation_error_serializes_custom_validator_context(main_app_client: AsyncClient) -> None:
    response = await main_app_client.post("/__test/body-validation-error", json={"value": "   "})

    assert response.status_code == 422
    payload = response.json()
    assert payload["error_name"] == "VALIDATION_FAILED"
    assert payload["errors"][0]["ctx"]["error"] == "Field cannot be blank"


async def test_ready_failure_uses_problem_details(
    main_app_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(app_main, "AsyncSessionLocal", lambda: _ReadySession(fail=True))

    response = await main_app_client.get("/ready")

    assert response.status_code == 503
    assert response.headers["content-type"].startswith("application/problem+json")
    assert response.json() == {
        "type": "urn:acps:error:dependencies:dependency-unavailable",
        "status": 503,
        "title": "Dependency unavailable",
        "detail": "Database connectivity check failed",
        "error_name": "DEPENDENCY_UNAVAILABLE",
    }
