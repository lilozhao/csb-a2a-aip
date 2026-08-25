from __future__ import annotations

import pytest
from acps_sdk.adp import ErrorDetail
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.base_exception import PROBLEM_JSON_MEDIA_TYPE, AppBaseError
from app.core.exception_handlers import register_exception_handlers
from app.discovery.exception import ADPError

pytestmark = pytest.mark.unit


def _build_test_client() -> TestClient:
    app = FastAPI()
    register_exception_handlers(app)

    @app.get("/app-error")
    async def app_error() -> None:
        raise AppBaseError(
            status_code=409,
            error_group="sync",
            error_name="SYNC_FAIL",
            error_msg="sync failed",
            input_params={"cursor": 12},
        )

    @app.get("/validation")
    async def validation(limit: int) -> dict[str, int]:
        return {"limit": limit}

    @app.get("/adp-error")
    async def adp_error() -> None:
        raise ADPError(ErrorDetail(code=40000, message="BadRequest", data="bad filter"))

    @app.get("/boom")
    async def boom() -> None:
        raise RuntimeError("boom")

    return TestClient(app, raise_server_exceptions=False)


def test_app_base_error_returns_problem_details() -> None:
    client = _build_test_client()

    response = client.get("/app-error")

    assert response.status_code == 409
    assert response.headers["content-type"].startswith(PROBLEM_JSON_MEDIA_TYPE)
    assert response.json() == {
        "type": "urn:acps:error:sync:sync-fail",
        "status": 409,
        "title": "Sync Fail",
        "detail": "sync failed",
        "error_name": "SYNC_FAIL",
        "error_group": "sync",
        "input_params": {"cursor": 12},
    }


def test_validation_error_returns_problem_details() -> None:
    client = _build_test_client()

    response = client.get("/validation", params={"limit": "oops"})

    assert response.status_code == 422
    assert response.headers["content-type"].startswith(PROBLEM_JSON_MEDIA_TYPE)
    payload = response.json()
    assert payload["type"] == "urn:acps:error:validation:request-validation-failed"
    assert payload["status"] == 422
    assert payload["error_name"] == "VALIDATION_FAILED"
    assert payload["errors"]


def test_adp_error_keeps_protocol_response_shape() -> None:
    client = _build_test_client()

    response = client.get("/adp-error")

    assert response.status_code == 400
    assert not response.headers["content-type"].startswith(PROBLEM_JSON_MEDIA_TYPE)
    assert response.json() == {
        "error": {
            "code": 40000,
            "message": "BadRequest",
            "data": "bad filter",
        }
    }


def test_unhandled_exception_returns_problem_details() -> None:
    client = _build_test_client()

    response = client.get("/boom")

    assert response.status_code == 500
    assert response.headers["content-type"].startswith(PROBLEM_JSON_MEDIA_TYPE)
    assert response.json() == {
        "type": "urn:acps:error:application:internal-server-error",
        "status": 500,
        "title": "Internal server error",
        "detail": "An unexpected server error occurred.",
        "error_name": "INTERNAL_SERVER_ERROR",
    }
