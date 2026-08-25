"""RabbitMQ Management API client."""

from __future__ import annotations

from urllib.parse import quote

import httpx
import structlog

logger = structlog.get_logger()


class RabbitMqManagementClient:
    """Minimal RabbitMQ Management API wrapper."""

    def __init__(
        self,
        *,
        base_url: str,
        username: str,
        password: str,
        http_client: httpx.AsyncClient | None = None,
    ) -> None:
        self._owned_client = http_client is None
        self._http_client = http_client or httpx.AsyncClient(
            base_url=base_url.rstrip("/"),
            auth=httpx.BasicAuth(username, password),
            timeout=httpx.Timeout(10.0),
        )

    async def delete_connections_by_username(self, *, username: str, reason: str) -> None:
        """Close all RabbitMQ connections for the given username."""

        logger.info(
            "rabbitmq_mgmt_delete_connections",
            username=username,
            reason=reason,
        )
        response = await self._http_client.delete(
            f"/api/connections/username/{quote(username, safe='')}",
            headers={"X-Reason": reason},
        )
        if response.status_code in {204, 404}:
            logger.info(
                "rabbitmq_mgmt_delete_connections_done",
                username=username,
                status=response.status_code,
            )
            return
        logger.warning(
            "rabbitmq_mgmt_delete_connections_failed",
            username=username,
            status=response.status_code,
            body=response.text,
        )
        response.raise_for_status()

    async def aclose(self) -> None:
        """Close the underlying HTTP client when owned by this instance."""

        if self._owned_client:
            logger.info("rabbitmq_mgmt_client_close")
            await self._http_client.aclose()
