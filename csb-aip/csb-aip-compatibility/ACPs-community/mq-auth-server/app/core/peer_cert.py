"""Peer certificate registry and Uvicorn protocol integration."""

from __future__ import annotations

import asyncio
import threading
from dataclasses import dataclass
from typing import Any

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response
from uvicorn.protocols.http.h11_impl import H11Protocol

from app.core.validation import extract_common_name

PeerKey = tuple[str, int, str, int]


@dataclass(frozen=True)
class PeerCertificateInfo:
    """Peer certificate information attached to an active TLS connection."""

    common_name: str | None
    certificate: dict[str, Any] | None


class PeerCertificateRegistry:
    """Thread-safe registry keyed by client/server socket tuples."""

    def __init__(self) -> None:
        self._entries: dict[PeerKey, PeerCertificateInfo] = {}
        self._lock = threading.Lock()

    def register(
        self,
        client: tuple[str, int],
        server: tuple[str, int],
        certificate: dict[str, Any] | None,
    ) -> None:
        key = (client[0], client[1], server[0], server[1])
        info = PeerCertificateInfo(
            common_name=extract_common_name(certificate),
            certificate=certificate,
        )
        with self._lock:
            self._entries[key] = info

    def unregister(self, client: tuple[str, int], server: tuple[str, int]) -> None:
        key = (client[0], client[1], server[0], server[1])
        with self._lock:
            self._entries.pop(key, None)

    def lookup(
        self,
        client: tuple[str, int],
        server: tuple[str, int],
    ) -> PeerCertificateInfo | None:
        key = (client[0], client[1], server[0], server[1])
        with self._lock:
            return self._entries.get(key)


registry = PeerCertificateRegistry()


class PeerCertH11Protocol(H11Protocol):
    """Uvicorn H11 protocol that records peer certificates for each TLS socket."""

    def connection_made(self, transport: asyncio.Transport) -> None:  # type: ignore[override]
        super().connection_made(transport)
        ssl_object = transport.get_extra_info("ssl_object")
        peer_certificate: dict[str, Any] | None = None
        if ssl_object is not None:
            peer_certificate = ssl_object.getpeercert()
        if self.client is not None and self.server is not None and self.server[1] is not None:
            registry.register(
                self.client,
                (self.server[0], self.server[1]),
                peer_certificate,
            )

    def connection_lost(self, exc: Exception | None) -> None:
        if self.client is not None and self.server is not None and self.server[1] is not None:
            registry.unregister(
                self.client,
                (self.server[0], self.server[1]),
            )
        super().connection_lost(exc)


class PeerCertificateMiddleware(BaseHTTPMiddleware):
    """Populate request.state with peer certificate metadata."""

    async def dispatch(
        self,
        request: Request,
        call_next: RequestResponseEndpoint,
    ) -> Response:
        client = request.scope.get("client")
        server = request.scope.get("server")
        if isinstance(client, tuple) and isinstance(server, tuple):
            info = registry.lookup(
                (str(client[0]), int(client[1])),
                (str(server[0]), int(server[1])),
            )
        else:
            info = None
        if getattr(request.state, "peer_certificate", None) is None:
            request.state.peer_certificate = info.certificate if info else None
        if getattr(request.state, "peer_common_name", None) is None:
            request.state.peer_common_name = info.common_name if info else None
        return await call_next(request)
