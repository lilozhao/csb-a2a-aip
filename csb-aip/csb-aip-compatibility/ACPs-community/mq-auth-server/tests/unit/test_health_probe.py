"""mTLS 健康探针路径解析的单元测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core import health_probe


class TestResolveProbeTlsFiles:
    """resolve_probe_tls_files — 按环境解析探针证书。"""

    def test_development_defaults_to_generated_client_cert(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        cert_dir = tmp_path / "certs"
        monkeypatch.setenv("APP_ENV", "development")
        monkeypatch.setenv("RABBITMQ_MGMT_PASS", "test-pass")
        monkeypatch.setenv("TLS_CERT_FILE", str(cert_dir / "server.pem"))
        monkeypatch.setenv("TLS_KEY_FILE", str(cert_dir / "server.key"))
        monkeypatch.setenv("TLS_CA_CERT_FILE", str(cert_dir / "acps-root-ca.pem"))

        cert_file, key_file, ca_file = health_probe.resolve_probe_tls_files()

        assert cert_file == cert_dir / "client.pem"
        assert key_file == cert_dir / "client.key"
        assert ca_file == cert_dir / "acps-root-ca.pem"

    def test_non_development_requires_explicit_probe_client_cert(self, monkeypatch: pytest.MonkeyPatch) -> None:
        monkeypatch.setenv("APP_ENV", "production")
        monkeypatch.delenv("HEALTHCHECK_TLS_CERT_FILE", raising=False)
        monkeypatch.delenv("HEALTHCHECK_TLS_KEY_FILE", raising=False)

        with pytest.raises(FileNotFoundError, match="HEALTHCHECK_TLS_CERT_FILE"):
            health_probe.resolve_probe_tls_files()

    def test_explicit_probe_files_override_development_defaults(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        cert_file = tmp_path / "probe-client.pem"
        key_file = tmp_path / "probe-client-key.pem"
        ca_file = tmp_path / "ca.pem"
        monkeypatch.setenv("APP_ENV", "development")
        monkeypatch.setenv("HEALTHCHECK_TLS_CERT_FILE", str(cert_file))
        monkeypatch.setenv("HEALTHCHECK_TLS_KEY_FILE", str(key_file))
        monkeypatch.setenv("HEALTHCHECK_TLS_CA_CERT_FILE", str(ca_file))

        resolved_cert, resolved_key, resolved_ca = health_probe.resolve_probe_tls_files()

        assert resolved_cert == cert_file
        assert resolved_key == key_file
        assert resolved_ca == ca_file
