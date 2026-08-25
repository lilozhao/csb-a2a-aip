import uuid

import pytest
import structlog
from fastapi import Request
from httpx import AsyncClient

from app import main as app_main
from app.core.config import settings as core_settings

pytestmark = pytest.mark.unit


def _ensure_test_routes() -> None:
    existing_paths = {path for route in app_main.app.routes if (path := getattr(route, "path", None)) is not None}

    if "/__test/request-context" not in existing_paths:

        @app_main.app.get("/__test/request-context")
        async def read_request_context(request: Request) -> dict[str, str]:
            context = structlog.contextvars.get_contextvars()
            return {
                "request_id": str(context.get("request_id", "") or ""),
                "trace_id": str(context.get("trace_id", "") or ""),
                "span_id": str(context.get("span_id", "") or ""),
                "state_request_id": getattr(request.state, "request_id", ""),
                "state_trace_id": getattr(request.state, "trace_id", ""),
                "state_span_id": getattr(request.state, "span_id", ""),
            }


_ensure_test_routes()


async def test_request_id_is_generated_and_echoed(main_app_client: AsyncClient) -> None:
    response = await main_app_client.get("/__test/request-context")

    request_id = response.headers["X-Request-ID"]
    assert str(uuid.UUID(request_id)) == request_id
    assert response.json() == {
        "request_id": request_id,
        "trace_id": "",
        "span_id": "",
        "state_request_id": request_id,
        "state_trace_id": "",
        "state_span_id": "",
    }


async def test_existing_request_id_is_reused(main_app_client: AsyncClient) -> None:
    response = await main_app_client.get("/__test/request-context", headers={"X-Request-ID": "req-123"})

    assert response.headers["X-Request-ID"] == "req-123"
    assert response.json() == {
        "request_id": "req-123",
        "trace_id": "",
        "span_id": "",
        "state_request_id": "req-123",
        "state_trace_id": "",
        "state_span_id": "",
    }


async def test_traceparent_is_bound_into_request_context(main_app_client: AsyncClient) -> None:
    traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

    response = await main_app_client.get("/__test/request-context", headers={"traceparent": traceparent})

    assert response.json()["trace_id"] == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert response.json()["span_id"] == "00f067aa0ba902b7"
    assert response.json()["state_trace_id"] == "4bf92f3577b34da6a3ce929d0e0e4736"
    assert response.json()["state_span_id"] == "00f067aa0ba902b7"


async def test_security_headers_are_applied(main_app_client: AsyncClient) -> None:
    response = await main_app_client.get("/health")

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"


async def test_production_security_headers_are_applied(
    main_app_client: AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(core_settings, "app_env", "production")

    response = await main_app_client.get("/health")

    assert response.headers["Content-Security-Policy"] == "default-src 'none'; frame-ancestors 'none'"
    assert response.headers["Strict-Transport-Security"] == "max-age=31536000"


async def test_metrics_endpoint_is_available(main_app_client: AsyncClient) -> None:
    await main_app_client.get("/health")

    response = await main_app_client.get("/metrics")

    assert response.status_code == 200
    assert response.headers["content-type"].startswith("text/plain")
    assert "http_requests_total" in response.text
