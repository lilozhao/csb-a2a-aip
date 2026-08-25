"""测试核心异常基座（app.core.base_exception）。"""

from __future__ import annotations

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.base_exception import (
    AppError,
    CoreErrorCode,
    build_problem_details,
    register_exception_handlers,
)

# ---------- build_problem_details ----------


class TestBuildProblemDetails:
    def test_required_fields_present(self) -> None:
        result = build_problem_details(
            status=404,
            title="Not Found",
            detail="Resource not found",
            type_="urn:acps:error:not-found",
        )
        assert result["status"] == 404
        assert result["title"] == "Not Found"
        assert result["detail"] == "Resource not found"
        assert result["type"] == "urn:acps:error:not-found"

    def test_extensions_merged(self) -> None:
        result = build_problem_details(
            status=400,
            title="Bad Request",
            detail="Validation failed",
            type_="urn:acps:error:bad-request",
            extensions={"code": "VALIDATION_FAILED", "extra": "value"},
        )
        assert result["code"] == "VALIDATION_FAILED"
        assert result["extra"] == "value"

    def test_no_extensions(self) -> None:
        result = build_problem_details(
            status=500,
            title="Server Error",
            detail="Internal error",
            type_="urn:acps:error:internal",
        )
        assert "extensions" not in result
        assert len(result) == 4


# ---------- AppError ----------


class TestAppError:
    def test_default_type_generated_from_code(self) -> None:
        exc = AppError(
            code="MY_ERROR_CODE",
            title="My Error",
            detail="Something went wrong",
        )
        assert "my-error-code" in exc.type

    def test_custom_type_stored(self) -> None:
        exc = AppError(
            code="ERR",
            title="Error",
            detail="detail",
            type_="urn:custom:type",
        )
        assert exc.type == "urn:custom:type"

    def test_status_code_default_400(self) -> None:
        exc = AppError(code="ERR", title="T", detail="D")
        assert exc.status_code == 400

    def test_custom_status_code(self) -> None:
        exc = AppError(code="ERR", title="T", detail="D", status_code=503)
        assert exc.status_code == 503

    def test_to_problem_details(self) -> None:
        exc = AppError(code="TEST_ERR", title="Test", detail="test detail", status_code=404)
        body = exc.to_problem_details()
        assert body["status"] == 404
        assert body["title"] == "Test"
        assert body["detail"] == "test detail"
        assert body["code"] == "TEST_ERR"

    def test_error_name_property_alias(self) -> None:
        exc = AppError(code="MY_CODE", title="T", detail="D")
        assert exc.error_name == "MY_CODE"
        exc.error_name = "NEW_CODE"
        assert exc.code == "NEW_CODE"

    def test_error_msg_property_alias(self) -> None:
        exc = AppError(code="C", title="T", detail="original")
        assert exc.error_msg == "original"
        exc.error_msg = "updated"
        assert exc.detail == "updated"

    def test_input_params_property(self) -> None:
        exc = AppError(code="C", title="T", detail="D", extensions={"input_params": {"k": "v"}})
        assert exc.input_params == {"k": "v"}

    def test_input_params_setter(self) -> None:
        exc = AppError(code="C", title="T", detail="D")
        exc.input_params = {"new_key": "new_val"}
        assert exc.extensions["input_params"] == {"new_key": "new_val"}

    def test_empty_input_params_returns_empty_dict(self) -> None:
        exc = AppError(code="C", title="T", detail="D")
        assert exc.input_params == {}

    def test_is_exception(self) -> None:
        exc = AppError(code="C", title="T", detail="D")
        with pytest.raises(AppError):
            raise exc


# ---------- AppError 直接构造（取代已删除的 AppBaseException 测试）----------


class TestAppErrorDirectConstruction:
    def test_default_status_code(self) -> None:
        exc = AppError(code="unknown_error", title="Unknown Error", detail="An error occurred")
        assert exc.status_code == 400

    def test_type_includes_code(self) -> None:
        exc = AppError(code="token_expired", title="Token Expired", detail="Token is expired", status_code=401)
        # AppError 自动将 code 中的 _ 替换为 - 生成 type
        assert "token-expired" in exc.type

    def test_type_explicit(self) -> None:
        exc = AppError(
            code="token_expired",
            title="Token Expired",
            detail="Token is expired",
            type_="urn:acps:error:auth:token_expired",
        )
        assert "auth" in exc.type
        assert "token_expired" in exc.type

    def test_input_params_empty_dict_by_default(self) -> None:
        exc = AppError(code="x", title="X", detail="x")
        assert exc.input_params == {}

    def test_input_params_stored_via_extensions(self) -> None:
        exc = AppError(code="x", title="X", detail="x", extensions={"input_params": {"field": "value"}})
        assert exc.input_params["field"] == "value"


# ---------- Exception handlers via TestClient ----------


class TestExceptionHandlers:
    def _build_app(self) -> TestClient:
        app = FastAPI()
        register_exception_handlers(app)

        @app.get("/error")
        async def raise_app_error():
            raise AppError(code="TEST_ERROR", title="Test Error", detail="test detail", status_code=422)

        @app.post("/validate")
        async def validate_endpoint(body: dict):
            return body

        return TestClient(app, raise_server_exceptions=False)

    def test_app_error_returns_problem_json(self) -> None:
        client = self._build_app()
        resp = client.get("/error")
        assert resp.status_code == 422
        assert "problem+json" in resp.headers.get("content-type", "")
        body = resp.json()
        assert body["code"] == "TEST_ERROR"

    def test_app_error_body_has_required_fields(self) -> None:
        client = self._build_app()
        resp = client.get("/error")
        body = resp.json()
        assert "type" in body
        assert "status" in body
        assert "title" in body
        assert "detail" in body

    def test_validation_error_returns_422(self) -> None:
        client = self._build_app()
        # 向需要 Body 的端点发送错误请求体（非 JSON）
        resp = client.post("/validate", content="not-json", headers={"content-type": "application/json"})
        assert resp.status_code == 422


# ---------- CoreErrorCode ----------


def test_core_error_code_validation_failed() -> None:
    assert CoreErrorCode.VALIDATION_FAILED == "VALIDATION_FAILED"
