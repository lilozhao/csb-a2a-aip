from pathlib import Path

import pytest

from app.core.config import Settings

pytestmark = pytest.mark.unit


def _set_required_env(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setenv(
        "DATABASE_URL",
        "postgresql+asyncpg://registry_test:registry_test@localhost:5432/registry_test",
    )
    monkeypatch.setenv("SECRET_KEY", "test-secret-key")
    monkeypatch.setenv("SM4_ENCRYPTION_KEY", "00112233445566778899aabbccddeeff")
    monkeypatch.setenv("AIC_CRC_SALT", "0x12345678")
    monkeypatch.setenv("APP_ENV", "development")


def test_dsp_retention_settings_default_to_toml(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.delenv("REGISTRY_SERVER_DSP_RETENTION_WINDOW_HOURS", raising=False)
    monkeypatch.delenv("REGISTRY_SERVER_DSP_RETENTION_MAX_RECORDS", raising=False)

    settings = Settings()

    assert settings.dsp_retention_window_hours == 168
    assert settings.dsp_retention_max_records == 100000


def test_dsp_retention_settings_can_be_overridden_by_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("REGISTRY_SERVER_DSP_RETENTION_WINDOW_HOURS", "0")
    monkeypatch.setenv("REGISTRY_SERVER_DSP_RETENTION_MAX_RECORDS", "1")

    settings = Settings()

    assert settings.dsp_retention_window_hours == 0
    assert settings.dsp_retention_max_records == 1


def test_smtp_settings_can_be_overridden_by_env(monkeypatch: pytest.MonkeyPatch) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("SMTP_SERVER", "smtp.example.com")
    monkeypatch.setenv("SMTP_PORT", "587")
    monkeypatch.setenv("EMAIL_ADDRESS", "noreply@example.com")
    monkeypatch.setenv("EMAIL_PASSWORD", "smtp-secret")

    settings = Settings()

    assert settings.smtp_server == "smtp.example.com"
    assert settings.smtp_port == "587"
    assert settings.email_address == "noreply@example.com"
    assert settings.email_password == "smtp-secret"


def test_settings_prefer_cwd_config_for_packaged_runtime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    _set_required_env(monkeypatch)
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("REGISTRY_SERVER_ENABLE_MTLS_LISTENER", raising=False)

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "default.toml").write_text("[server]\nenable_mtls_listener = true\n", encoding="utf-8")
    (config_dir / "production.toml").write_text("[server]\nenable_mtls_listener = false\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    settings = Settings()

    assert settings.enable_mtls_listener is False
