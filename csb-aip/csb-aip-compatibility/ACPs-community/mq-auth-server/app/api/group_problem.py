"""Problem Details responses for Group API only."""

from __future__ import annotations

from dataclasses import dataclass

from fastapi import Request
from fastapi.responses import JSONResponse


@dataclass(frozen=True)
class GroupApiError(Exception):
    """Structured Group API error mapped to Problem Details JSON."""

    status_code: int
    code: str
    title: str
    detail: str


def group_api_exception_handler(request: Request, exc: Exception) -> JSONResponse:
    """Render Group API errors as Problem Details JSON."""

    if not isinstance(exc, GroupApiError):
        raise TypeError("group_api_exception_handler received a non-GroupApiError")

    return JSONResponse(
        status_code=exc.status_code,
        media_type="application/problem+json",
        content={
            "type": "about:blank",
            "status": exc.status_code,
            "code": exc.code,
            "title": exc.title,
            "detail": exc.detail,
            "instance": request.url.path,
        },
    )
