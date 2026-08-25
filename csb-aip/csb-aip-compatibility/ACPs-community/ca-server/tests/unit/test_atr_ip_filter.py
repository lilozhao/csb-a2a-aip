"""测试 ATR IP 过滤中间件（app.core.atr_ip_filter）。"""

from __future__ import annotations

import ipaddress
from ipaddress import IPv4Address, IPv4Network, IPv6Address, IPv6Network
from unittest.mock import MagicMock, patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.core.atr_ip_filter import ATRManagementIPFilterMiddleware

# ---------- _parse_ip_list ----------


class TestParseIPList:
    def _make_middleware(self) -> ATRManagementIPFilterMiddleware:
        with patch("app.core.atr_ip_filter.get_settings"):
            app = FastAPI()
            return ATRManagementIPFilterMiddleware(app)

    def test_single_ipv4(self) -> None:
        mw = self._make_middleware()
        result = mw._parse_ip_list(["192.168.1.1"])
        assert len(result) == 1
        assert isinstance(result[0], ipaddress.IPv4Address)

    def test_ipv4_cidr(self) -> None:
        mw = self._make_middleware()
        result = mw._parse_ip_list(["10.0.0.0/8"])
        assert len(result) == 1
        assert isinstance(result[0], ipaddress.IPv4Network)

    def test_ipv6_address(self) -> None:
        mw = self._make_middleware()
        result = mw._parse_ip_list(["::1"])
        assert len(result) == 1
        assert isinstance(result[0], ipaddress.IPv6Address)

    def test_invalid_ip_skipped(self) -> None:
        mw = self._make_middleware()
        result = mw._parse_ip_list(["not-an-ip", "192.168.1.1"])
        assert len(result) == 1  # 无效 IP 被跳过，有效 IP 保留

    def test_empty_list(self) -> None:
        mw = self._make_middleware()
        result = mw._parse_ip_list([])
        assert result == []

    def test_mixed_valid_invalid(self) -> None:
        mw = self._make_middleware()
        result = mw._parse_ip_list(["192.168.1.1", "bad-ip", "10.0.0.0/24"])
        assert len(result) == 2


# ---------- _is_ip_allowed ----------


class TestIsIPAllowed:
    def _make_middleware(self) -> ATRManagementIPFilterMiddleware:
        with patch("app.core.atr_ip_filter.get_settings"):
            app = FastAPI()
            return ATRManagementIPFilterMiddleware(app)

    def test_exact_ip_allowed(self) -> None:
        mw = self._make_middleware()
        allowed: list[IPv4Address | IPv6Address | IPv4Network | IPv6Network] = [ipaddress.ip_address("192.168.1.100")]
        assert mw._is_ip_allowed("192.168.1.100", allowed) is True

    def test_ip_not_in_list_denied(self) -> None:
        mw = self._make_middleware()
        allowed: list[IPv4Address | IPv6Address | IPv4Network | IPv6Network] = [ipaddress.ip_address("192.168.1.100")]
        assert mw._is_ip_allowed("10.0.0.1", allowed) is False

    def test_ip_in_cidr_allowed(self) -> None:
        mw = self._make_middleware()
        allowed: list[IPv4Address | IPv6Address | IPv4Network | IPv6Network] = [ipaddress.ip_network("10.0.0.0/8")]
        assert mw._is_ip_allowed("10.1.2.3", allowed) is True

    def test_ip_outside_cidr_denied(self) -> None:
        mw = self._make_middleware()
        allowed: list[IPv4Address | IPv6Address | IPv4Network | IPv6Network] = [ipaddress.ip_network("10.0.0.0/8")]
        assert mw._is_ip_allowed("192.168.1.1", allowed) is False

    def test_empty_allowed_list_denied(self) -> None:
        mw = self._make_middleware()
        assert mw._is_ip_allowed("192.168.1.1", []) is False

    def test_invalid_client_ip_denied(self) -> None:
        mw = self._make_middleware()
        allowed: list[IPv4Address | IPv6Address | IPv4Network | IPv6Network] = [ipaddress.ip_address("192.168.1.1")]
        assert mw._is_ip_allowed("not-an-ip", allowed) is False

    def test_ipv6_loopback_allowed(self) -> None:
        mw = self._make_middleware()
        allowed: list[IPv4Address | IPv6Address | IPv4Network | IPv6Network] = [ipaddress.ip_address("::1")]
        assert mw._is_ip_allowed("::1", allowed) is True


# ---------- _is_atr_management_path ----------


class TestIsATRManagementPath:
    def _make_middleware(self) -> ATRManagementIPFilterMiddleware:
        with patch("app.core.atr_ip_filter.get_settings"):
            app = FastAPI()
            return ATRManagementIPFilterMiddleware(app)

    def test_mgmt_path_detected(self) -> None:
        mw = self._make_middleware()
        assert mw._is_atr_management_path("/acps-atr-v2/mgmt/agents") is True

    def test_admin_certificate_path_detected(self) -> None:
        mw = self._make_middleware()
        assert mw._is_atr_management_path("/admin/certificates/root") is True

    def test_internal_retrieve_path_detected(self) -> None:
        mw = self._make_middleware()
        assert mw._is_atr_management_path("/acps-atr-v2/ca/retrieve/aic/") is True

    def test_public_trust_bundle_path_not_detected(self) -> None:
        mw = self._make_middleware()
        assert mw._is_atr_management_path("/acps-atr-v2/ca/trust-bundle") is False

    def test_non_mgmt_path_not_detected(self) -> None:
        mw = self._make_middleware()
        assert mw._is_atr_management_path("/acps-atr-v2/acme/directory") is False

    def test_root_path_not_mgmt(self) -> None:
        mw = self._make_middleware()
        assert mw._is_atr_management_path("/") is False

    def test_custom_prefix_detected(self) -> None:
        with patch("app.core.atr_ip_filter.get_settings"):
            app = FastAPI()
            mw = ATRManagementIPFilterMiddleware(app, atr_mgmt_paths=["/custom/admin"])
        assert mw._is_atr_management_path("/custom/admin/users") is True
        assert mw._is_atr_management_path("/acps-atr-v2/mgmt/agents") is False


# ---------- dispatch via TestClient ----------


class TestATRIPFilterDispatch:
    def _build_app(self, allowed_ips: list[str]) -> TestClient:
        settings_mock = MagicMock()
        settings_mock.atr_mgmt_allow_ip_list_parsed = allowed_ips

        app = FastAPI()
        with patch("app.core.atr_ip_filter.get_settings", return_value=settings_mock):
            app.add_middleware(ATRManagementIPFilterMiddleware)

        @app.get("/acps-atr-v2/mgmt/agents")
        async def mgmt_route():
            return {"ok": True}

        @app.get("/acps-atr-v2/acme/directory")
        async def acme_route():
            return {"ok": True}

        return TestClient(app, raise_server_exceptions=False)

    def test_non_mgmt_path_passes_without_ip_check(self) -> None:
        # ACME 路径不受 IP 过滤影响
        app = FastAPI()
        settings_mock = MagicMock()
        settings_mock.atr_mgmt_allow_ip_list_parsed = []

        with patch("app.core.atr_ip_filter.get_settings", return_value=settings_mock):
            mw = ATRManagementIPFilterMiddleware(app)

        @app.get("/acps-atr-v2/acme/directory")
        async def acme_route():
            return {"ok": True}

        # 只测试路径逻辑，不通过中间件
        assert mw._is_atr_management_path("/acps-atr-v2/acme/directory") is False

    def test_empty_allowed_list_returns_403(self) -> None:
        app = FastAPI()
        settings_mock = MagicMock()
        settings_mock.atr_mgmt_allow_ip_list_parsed = []

        @app.get("/acps-atr-v2/mgmt/agents")
        async def mgmt_route():
            return {"ok": True}

        with patch("app.core.atr_ip_filter.get_settings", return_value=settings_mock):
            app.add_middleware(ATRManagementIPFilterMiddleware)
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get("/acps-atr-v2/mgmt/agents")

        assert resp.status_code == 403

    def test_allowed_ip_passes(self) -> None:
        app = FastAPI()
        settings_mock = MagicMock()
        settings_mock.atr_mgmt_allow_ip_list_parsed = ["127.0.0.1"]

        @app.get("/acps-atr-v2/mgmt/agents")
        async def mgmt_route():
            return {"ok": True}

        with patch("app.core.atr_ip_filter.get_settings", return_value=settings_mock):
            app.add_middleware(ATRManagementIPFilterMiddleware)
            client = TestClient(app, raise_server_exceptions=False)
            # TestClient 中 client_host 为 "testclient"，middleware 会映射到 127.0.0.1
            resp = client.get("/acps-atr-v2/mgmt/agents")

        assert resp.status_code == 200

    def test_forwarded_headers_do_not_override_direct_client_ip(self) -> None:
        app = FastAPI()
        settings_mock = MagicMock()
        settings_mock.atr_mgmt_allow_ip_list_parsed = ["127.0.0.1"]

        @app.get("/acps-atr-v2/mgmt/agents")
        async def mgmt_route():
            return {"ok": True}

        with patch("app.core.atr_ip_filter.get_settings", return_value=settings_mock):
            app.add_middleware(ATRManagementIPFilterMiddleware)
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get("/acps-atr-v2/mgmt/agents", headers={"X-Forwarded-For": "192.168.1.50, 10.0.0.1"})

        assert resp.status_code == 200

    def test_forwarded_headers_cannot_bypass_ip_filter(self) -> None:
        app = FastAPI()
        settings_mock = MagicMock()
        settings_mock.atr_mgmt_allow_ip_list_parsed = ["10.0.5.5"]

        @app.get("/acps-atr-v2/mgmt/agents")
        async def mgmt_route():
            return {"ok": True}

        with patch("app.core.atr_ip_filter.get_settings", return_value=settings_mock):
            app.add_middleware(ATRManagementIPFilterMiddleware)
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get(
                "/acps-atr-v2/mgmt/agents",
                headers={"X-Forwarded-For": "10.0.5.5", "X-Real-IP": "10.0.5.5"},
            )

        assert resp.status_code == 403

    def test_disallowed_ip_returns_403(self) -> None:
        app = FastAPI()
        settings_mock = MagicMock()
        settings_mock.atr_mgmt_allow_ip_list_parsed = ["10.10.10.10"]

        @app.get("/acps-atr-v2/mgmt/agents")
        async def mgmt_route():
            return {"ok": True}

        with patch("app.core.atr_ip_filter.get_settings", return_value=settings_mock):
            app.add_middleware(ATRManagementIPFilterMiddleware)
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get("/acps-atr-v2/mgmt/agents")

        assert resp.status_code == 403

    def test_admin_certificate_path_is_filtered(self) -> None:
        app = FastAPI()
        settings_mock = MagicMock()
        settings_mock.atr_mgmt_allow_ip_list_parsed = []

        @app.get("/admin/certificates/root")
        async def admin_route():
            return {"ok": True}

        with patch("app.core.atr_ip_filter.get_settings", return_value=settings_mock):
            app.add_middleware(ATRManagementIPFilterMiddleware)
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get("/admin/certificates/root")

        assert resp.status_code == 403

    def test_internal_retrieve_path_is_filtered(self) -> None:
        app = FastAPI()
        settings_mock = MagicMock()
        settings_mock.atr_mgmt_allow_ip_list_parsed = []

        @app.get("/acps-atr-v2/ca/retrieve/aic/")
        async def retrieve_route():
            return {"ok": True}

        with patch("app.core.atr_ip_filter.get_settings", return_value=settings_mock):
            app.add_middleware(ATRManagementIPFilterMiddleware)
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get("/acps-atr-v2/ca/retrieve/aic/")

        assert resp.status_code == 403

    def test_public_trust_bundle_path_bypasses_filter(self) -> None:
        app = FastAPI()
        settings_mock = MagicMock()
        settings_mock.atr_mgmt_allow_ip_list_parsed = []

        @app.get("/acps-atr-v2/ca/trust-bundle")
        async def trust_bundle_route():
            return {"ok": True}

        with patch("app.core.atr_ip_filter.get_settings", return_value=settings_mock):
            app.add_middleware(ATRManagementIPFilterMiddleware)
            client = TestClient(app, raise_server_exceptions=False)
            resp = client.get("/acps-atr-v2/ca/trust-bundle")

        assert resp.status_code == 200
