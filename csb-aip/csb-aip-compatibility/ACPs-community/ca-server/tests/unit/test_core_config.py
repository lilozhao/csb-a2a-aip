from pathlib import Path

import pytest

from app.core.config import Settings

pytestmark = pytest.mark.unit


def test_settings_prefer_cwd_config_for_packaged_runtime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setenv("APP_ENV", "development")

    config_dir = tmp_path / "config"
    config_dir.mkdir()
    (config_dir / "default.toml").write_text("[server]\nport = 9003\n", encoding="utf-8")
    (config_dir / "development.toml").write_text("[server]\nport = 19103\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    settings = Settings()

    assert settings.uvicorn_port == 19103
