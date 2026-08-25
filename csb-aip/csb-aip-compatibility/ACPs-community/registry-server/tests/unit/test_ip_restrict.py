"""针对 ip_restrict.py 的单元测试。

覆盖：parse_allowed_ips（单 IP、CIDR、IPv6、无效、空字符串）；
create_ip_restriction_middleware（允许的 IP 通过、拒绝的 IP 返回 403、
路径前缀不匹配时直接放行）。
"""

from __future__ import annotations

import ipaddress
from unittest.mock import AsyncMock, MagicMock

import pytest

from app.utils.ip_restrict import create_ip_restriction_middleware, parse_allowed_ips

pytestmark = pytest.mark.unit


class TestParseAllowedIps:
    def test_empty_string_returns_empty_list(self) -> None:
        assert parse_allowed_ips("") == []

    def test_single_ipv4_becomes_32_network(self) -> None:
        result = parse_allowed_ips("192.168.1.1")
        assert len(result) == 1
        assert result[0] == ipaddress.ip_network("192.168.1.1/32")

    def test_single_ipv6_becomes_128_network(self) -> None:
        result = parse_allowed_ips("::1")
        assert len(result) == 1
        assert result[0] == ipaddress.ip_network("::1/128")

    def test_cidr_network_parsed_correctly(self) -> None:
        result = parse_allowed_ips("10.0.0.0/8")
        assert len(result) == 1
        assert result[0] == ipaddress.ip_network("10.0.0.0/8")

    def test_multiple_ips_comma_separated(self) -> None:
        result = parse_allowed_ips("192.168.1.1,10.0.0.1")
        assert len(result) == 2

    def test_invalid_ip_skipped_with_warning(self) -> None:
        # 无效 IP 应被跳过，不抛出异常
        result = parse_allowed_ips("not-an-ip")
        assert result == []

    def test_mixed_valid_and_invalid(self) -> None:
        result = parse_allowed_ips("192.168.1.1,bad-ip")
        assert len(result) == 1

    def test_whitespace_around_ips_stripped(self) -> None:
        result = parse_allowed_ips(" 192.168.1.1 , 10.0.0.1 ")
        assert len(result) == 2

    def test_trailing_comma_ignored(self) -> None:
        result = parse_allowed_ips("192.168.1.1,")
        assert len(result) == 1


class TestCreateIpRestrictionMiddleware:
    def _make_request(self, client_ip: str, path: str) -> MagicMock:
        request = MagicMock()
        request.url.path = path
        request.client = MagicMock()
        request.client.host = client_ip
        return request

    async def test_allowed_ip_passes_through(self) -> None:
        networks = parse_allowed_ips("192.168.1.0/24")
        middleware = create_ip_restriction_middleware(networks, "/admin")

        request = self._make_request("192.168.1.50", "/admin/users")
        mock_response = MagicMock()
        call_next = AsyncMock(return_value=mock_response)

        response = await middleware(request, call_next)
        assert response is mock_response
        call_next.assert_called_once_with(request)

    async def test_denied_ip_raises_403(self) -> None:
        networks = parse_allowed_ips("192.168.1.0/24")
        middleware = create_ip_restriction_middleware(networks, "/admin")

        request = self._make_request("10.0.0.1", "/admin/users")
        call_next = AsyncMock()

        response = await middleware(request, call_next)

        assert response.status_code == 403
        call_next.assert_not_called()

    async def test_path_not_matching_prefix_passes_through(self) -> None:
        networks = parse_allowed_ips("192.168.1.0/24")
        middleware = create_ip_restriction_middleware(networks, "/admin")

        request = self._make_request("10.0.0.1", "/api/v1/public")
        mock_response = MagicMock()
        call_next = AsyncMock(return_value=mock_response)

        response = await middleware(request, call_next)
        assert response is mock_response

    async def test_no_client_passes_through(self) -> None:
        """没有 client 信息时应放行（无法判断 IP）。"""
        networks = parse_allowed_ips("192.168.1.0/24")
        middleware = create_ip_restriction_middleware(networks, "/admin")

        request = MagicMock()
        request.url.path = "/admin/users"
        request.client = None

        mock_response = MagicMock()
        call_next = AsyncMock(return_value=mock_response)

        response = await middleware(request, call_next)
        assert response is mock_response

    async def test_localhost_ipv6_loopback_allowed_if_in_list(self) -> None:
        networks = parse_allowed_ips("::1")
        middleware = create_ip_restriction_middleware(networks, "/admin")

        request = self._make_request("::1", "/admin/test")
        mock_response = MagicMock()
        call_next = AsyncMock(return_value=mock_response)

        response = await middleware(request, call_next)
        assert response is mock_response

    async def test_exact_boundary_ip_allowed(self) -> None:
        networks = parse_allowed_ips("192.168.1.100")
        middleware = create_ip_restriction_middleware(networks, "/restricted")

        request = self._make_request("192.168.1.100", "/restricted/data")
        mock_response = MagicMock()
        call_next = AsyncMock(return_value=mock_response)

        response = await middleware(request, call_next)
        assert response is mock_response

    async def test_exact_boundary_ip_denied_for_other(self) -> None:
        networks = parse_allowed_ips("192.168.1.100")
        middleware = create_ip_restriction_middleware(networks, "/restricted")

        request = self._make_request("192.168.1.101", "/restricted/data")
        call_next = AsyncMock()

        response = await middleware(request, call_next)

        assert response.status_code == 403
        call_next.assert_not_called()
