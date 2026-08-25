"""测试 ACME 错误处理中间件（app.acme.error_handler）。"""

from __future__ import annotations

from fastapi import HTTPException
from fastapi.testclient import TestClient

from app.acme.error_handler import ACMEErrorHandler, create_acme_error_response
from app.acme.exception import AcmeError, AcmeException

# ---------- create_acme_error_response ----------


class TestCreateAcmeErrorResponse:
    def test_basic_structure(self) -> None:
        resp = create_acme_error_response(AcmeError.BAD_NONCE, "bad nonce", 400)
        assert "type" in resp
        assert "detail" in resp
        assert "status" in resp

    def test_type_has_acme_urn_prefix(self) -> None:
        resp = create_acme_error_response(AcmeError.MALFORMED, "detail", 400)
        assert resp["type"].startswith("urn:ietf:params:acme:error:")

    def test_error_name_in_type(self) -> None:
        resp = create_acme_error_response(AcmeError.UNAUTHORIZED, "detail", 403)
        assert AcmeError.UNAUTHORIZED in resp["type"]

    def test_status_code_stored(self) -> None:
        resp = create_acme_error_response(AcmeError.RATE_LIMITED, "too many", 429)
        assert resp["status"] == 429

    def test_detail_stored(self) -> None:
        resp = create_acme_error_response(AcmeError.SERVER_INTERNAL, "server error", 500)
        assert resp["detail"] == "server error"

    def test_extra_kwargs_included(self) -> None:
        resp = create_acme_error_response(AcmeError.MALFORMED, "detail", 400, identifier={"type": "dns"})
        assert resp.get("identifier") == {"type": "dns"}

    def test_default_status_is_400(self) -> None:
        resp = create_acme_error_response(AcmeError.MALFORMED, "detail")
        assert resp["status"] == 400


# ---------- ACMEErrorHandler._map_http_status_to_acme_error ----------


class TestMapHttpStatusToAcmeError:
    def setup_method(self) -> None:
        from fastapi import FastAPI

        self.handler = ACMEErrorHandler(app=FastAPI())

    def test_400_maps_to_malformed(self) -> None:
        assert self.handler._map_http_status_to_acme_error(400) == AcmeError.MALFORMED

    def test_401_maps_to_unauthorized(self) -> None:
        assert self.handler._map_http_status_to_acme_error(401) == AcmeError.UNAUTHORIZED

    def test_403_maps_to_unauthorized(self) -> None:
        assert self.handler._map_http_status_to_acme_error(403) == AcmeError.UNAUTHORIZED

    def test_404_maps_to_malformed(self) -> None:
        assert self.handler._map_http_status_to_acme_error(404) == AcmeError.MALFORMED

    def test_429_maps_to_rate_limited(self) -> None:
        assert self.handler._map_http_status_to_acme_error(429) == AcmeError.RATE_LIMITED

    def test_500_maps_to_server_internal(self) -> None:
        assert self.handler._map_http_status_to_acme_error(500) == AcmeError.SERVER_INTERNAL

    def test_503_maps_to_server_internal(self) -> None:
        assert self.handler._map_http_status_to_acme_error(503) == AcmeError.SERVER_INTERNAL

    def test_unknown_code_maps_to_server_internal(self) -> None:
        assert self.handler._map_http_status_to_acme_error(418) == AcmeError.SERVER_INTERNAL


# ---------- ACMEErrorHandler dispatch（via TestClient）----------


class TestACMEErrorHandlerDispatch:
    def _build_app_with_route(self, exc_factory) -> TestClient:
        """构建一个包含会抛出特定异常的 ACME 路由的测试应用。"""
        from fastapi import FastAPI

        app = FastAPI()
        app.add_middleware(ACMEErrorHandler)

        @app.get("/acps-atr-v2/acme/test")
        async def acme_route():
            raise exc_factory()

        return TestClient(app, raise_server_exceptions=False)

    def test_acme_exception_returns_problem_json(self) -> None:
        client = self._build_app_with_route(
            lambda: AcmeException(status_code=400, error_name=AcmeError.BAD_NONCE, error_msg="bad nonce")
        )
        resp = client.get("/acps-atr-v2/acme/test")
        assert resp.status_code == 400
        body = resp.json()
        assert "type" in body
        assert AcmeError.BAD_NONCE in body["type"]

    def test_acme_exception_content_type(self) -> None:
        client = self._build_app_with_route(
            lambda: AcmeException(status_code=400, error_name=AcmeError.MALFORMED, error_msg="bad")
        )
        resp = client.get("/acps-atr-v2/acme/test")
        assert "problem+json" in resp.headers.get("content-type", "")

    def test_http_exception_on_acme_path_returns_fastapi_default(self) -> None:
        # FastAPI 内置处理器在中间件 try/except 之前处理 HTTPException
        # 所以 ACME 路径上的 HTTPException 按 FastAPI 默认方式返回
        client = self._build_app_with_route(lambda: HTTPException(status_code=404, detail="not found"))
        resp = client.get("/acps-atr-v2/acme/test")
        assert resp.status_code == 404

    def test_generic_exception_returns_500(self) -> None:
        client = self._build_app_with_route(lambda: RuntimeError("unexpected"))
        resp = client.get("/acps-atr-v2/acme/test")
        assert resp.status_code == 500
        body = resp.json()
        assert AcmeError.SERVER_INTERNAL in body["type"]

    def test_non_acme_path_not_intercepted(self) -> None:
        """非 ACME 路径的异常不应被 ACME 格式转换。"""
        from fastapi import FastAPI

        app = FastAPI()
        app.add_middleware(ACMEErrorHandler)

        @app.get("/api/v1/other")
        async def other_route():
            raise HTTPException(status_code=401, detail="unauthorized")

        client = TestClient(app, raise_server_exceptions=False)
        resp = client.get("/api/v1/other")
        assert resp.status_code == 401
        # 非 ACME 路径走 FastAPI 原生 HTTP 异常处理，不包含 ACME type 字段
        body = resp.json()
        assert "urn:ietf:params:acme:error:" not in str(body)
