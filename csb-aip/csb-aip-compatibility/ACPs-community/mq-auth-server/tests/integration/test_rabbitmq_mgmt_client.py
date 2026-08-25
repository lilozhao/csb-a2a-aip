"""RabbitMqManagementClient 的集成测试（使用 httpx mock）。

通过注入 mock 的 httpx.AsyncClient 验证 HTTP 交互逻辑，无需真实 RabbitMQ：
- 204 → 静默成功
- 404 → 视为"无连接"，静默成功
- 5xx → 透传 HTTPStatusError

运行方式：
    uv run pytest tests/integration/test_rabbitmq_mgmt_client.py -v
"""

from __future__ import annotations

from unittest.mock import AsyncMock, MagicMock

import httpx
import pytest

from app.services.rabbitmq_mgmt import RabbitMqManagementClient


def _make_mock_http_client(status_code: int, body: str = "") -> AsyncMock:
    """创建返回指定状态码的 mock httpx.AsyncClient。"""
    mock_response = MagicMock(spec=httpx.Response)
    mock_response.status_code = status_code
    mock_response.text = body

    if status_code >= 400:
        mock_response.raise_for_status.side_effect = httpx.HTTPStatusError(
            message=f"HTTP Error {status_code}",
            request=MagicMock(spec=httpx.Request),
            response=mock_response,
        )
    else:
        mock_response.raise_for_status.return_value = None

    mock_client = AsyncMock(spec=httpx.AsyncClient)
    mock_client.delete.return_value = mock_response
    return mock_client


def _make_client(mock_http: AsyncMock) -> RabbitMqManagementClient:
    return RabbitMqManagementClient(
        base_url="http://localhost:15672",
        username="mq-auth-svc",
        password="test-pass",
        http_client=mock_http,
    )


class TestDeleteConnectionsByUsername:
    """delete_connections_by_username — HTTP 交互行为。"""

    async def test_204_returns_successfully(self) -> None:
        mock_http = _make_mock_http_client(204)
        client = _make_client(mock_http)
        # 不应抛异常
        await client.delete_connections_by_username(username="test-user", reason="test")

    async def test_204_calls_delete_with_correct_path(self) -> None:
        mock_http = _make_mock_http_client(204)
        client = _make_client(mock_http)
        await client.delete_connections_by_username(username="test-user", reason="removed")
        mock_http.delete.assert_called_once()
        call_args = mock_http.delete.call_args
        # 验证路径包含 URL 编码的 username
        assert "test-user" in str(call_args)

    async def test_204_passes_x_reason_header(self) -> None:
        mock_http = _make_mock_http_client(204)
        client = _make_client(mock_http)
        reason = "Removed from group by leader"
        await client.delete_connections_by_username(username="test-user", reason=reason)
        _, kwargs = mock_http.delete.call_args
        assert kwargs.get("headers", {}).get("X-Reason") == reason

    async def test_404_treated_as_success(self) -> None:
        """404 表示该用户没有活跃连接，应视为成功。"""
        mock_http = _make_mock_http_client(404)
        client = _make_client(mock_http)
        # 不应抛异常
        await client.delete_connections_by_username(username="offline-user", reason="evict")

    async def test_500_raises_http_status_error(self) -> None:
        mock_http = _make_mock_http_client(500, "Internal Server Error")
        client = _make_client(mock_http)
        with pytest.raises(httpx.HTTPStatusError):
            await client.delete_connections_by_username(username="test-user", reason="evict")

    async def test_503_raises_http_status_error(self) -> None:
        mock_http = _make_mock_http_client(503, "Service Unavailable")
        client = _make_client(mock_http)
        with pytest.raises(httpx.HTTPStatusError):
            await client.delete_connections_by_username(username="test-user", reason="evict")

    async def test_username_with_special_chars_is_url_encoded(self) -> None:
        """用户名中的特殊字符（如 "/"）应被 URL 编码。"""
        mock_http = _make_mock_http_client(204)
        client = _make_client(mock_http)
        await client.delete_connections_by_username(username="user/with/slashes", reason="test")
        call_args = mock_http.delete.call_args
        # URL 编码后不应含原始斜杠
        called_path = str(call_args[0][0] if call_args[0] else call_args)
        assert "user/with/slashes" not in called_path


class TestAclose:
    """aclose — owned client 时关闭 httpx，非 owned 时不关闭。"""

    async def test_aclose_owned_client_calls_aclose(self) -> None:
        """非注入方式构建时，aclose 应关闭 httpx 客户端。"""
        client = RabbitMqManagementClient(
            base_url="http://localhost:15672",
            username="user",
            password="pass",
        )
        # 将内部 client 替换为 mock
        mock_http = AsyncMock(spec=httpx.AsyncClient)
        client._http_client = mock_http
        await client.aclose()
        mock_http.aclose.assert_called_once()

    async def test_aclose_injected_client_not_closed(self) -> None:
        """外部注入的 http_client 不应在 aclose 时被关闭。"""
        mock_http = AsyncMock(spec=httpx.AsyncClient)
        client = RabbitMqManagementClient(
            base_url="http://localhost:15672",
            username="user",
            password="pass",
            http_client=mock_http,
        )
        await client.aclose()
        mock_http.aclose.assert_not_called()
