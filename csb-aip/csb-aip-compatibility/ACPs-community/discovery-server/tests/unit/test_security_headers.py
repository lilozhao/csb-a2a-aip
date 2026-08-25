from __future__ import annotations

import pytest
from fastapi import Request, Response

from app.core import security_headers as security_headers_module
from app.core.config import settings as config_settings

pytestmark = pytest.mark.unit


def test_build_security_headers_for_development() -> None:
    headers = security_headers_module.build_security_headers("development")

    assert headers["X-Content-Type-Options"] == "nosniff"
    assert headers["X-Frame-Options"] == "DENY"
    assert headers["Referrer-Policy"] == "no-referrer"
    assert "Strict-Transport-Security" not in headers


def test_build_security_headers_for_production() -> None:
    headers = security_headers_module.build_security_headers("production")

    assert headers["Strict-Transport-Security"] == "max-age=63072000; includeSubDomains"


async def test_security_headers_middleware_sets_headers(monkeypatch: pytest.MonkeyPatch) -> None:
    scope = {
        "type": "http",
        "method": "GET",
        "path": "/health",
        "headers": [],
    }
    request = Request(scope)

    async def call_next(_: Request) -> Response:
        return Response()

    monkeypatch.setattr(config_settings, "APP_ENV", "production")

    response = await security_headers_module.security_headers_middleware(request, call_next)

    assert response.headers["X-Content-Type-Options"] == "nosniff"
    assert response.headers["X-Frame-Options"] == "DENY"
    assert response.headers["Referrer-Policy"] == "no-referrer"
    assert response.headers["Strict-Transport-Security"] == "max-age=63072000; includeSubDomains"
