"""开发环境 TLS 路径与运行时校验的单元测试。"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core import dev_tls
from app.core.config import Settings


def _make_settings(tmp_path: Path, *, app_env: str) -> Settings:
    cert_dir = tmp_path / "certs"
    return Settings.model_validate(
        {
            "APP_ENV": app_env,
            "RABBITMQ_MGMT_PASS": "test-pass",
            "TLS_CERT_FILE": str(cert_dir / "server.pem"),
            "TLS_KEY_FILE": str(cert_dir / "server.key"),
            "TLS_CA_CERT_FILE": str(cert_dir / "acps-root-ca.pem"),
        }
    )


class TestEnsureRuntimeTlsAssets:
    """ensure_runtime_tls_assets — 按环境区分证书策略。"""

    def test_existing_tls_files_pass_without_error(self, tmp_path: Path) -> None:
        settings = _make_settings(tmp_path, app_env="development")
        for path in (
            settings.tls_cert_file,
            settings.tls_key_file,
            settings.tls_ca_cert_file,
        ):
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("present", encoding="utf-8")

        dev_tls.ensure_runtime_tls_assets(settings)

    def test_development_mode_requires_synced_tls_files(self, tmp_path: Path) -> None:
        settings = _make_settings(tmp_path, app_env="development")

        with pytest.raises(FileNotFoundError, match="just prep certs"):
            dev_tls.ensure_runtime_tls_assets(settings)

    def test_non_development_mode_requires_existing_tls_files(self, tmp_path: Path) -> None:
        settings = _make_settings(tmp_path, app_env="production")

        with pytest.raises(FileNotFoundError, match="TLS certificate files are required"):
            dev_tls.ensure_runtime_tls_assets(settings)


class TestBuildDevTlsLayout:
    """build_dev_tls_layout — 开发证书布局。"""

    def test_client_certificate_paths_are_derived_from_server_certificate_dir(self, tmp_path: Path) -> None:
        settings = _make_settings(tmp_path, app_env="development")

        layout = dev_tls.build_dev_tls_layout(settings)

        assert layout.server_cert_file == settings.tls_cert_file
        assert layout.ca_cert_file == settings.tls_ca_cert_file
        assert layout.client_cert_file == tmp_path / "certs" / "client.pem"
        assert layout.client_key_file == tmp_path / "certs" / "client.key"
