from __future__ import annotations

from typing import TYPE_CHECKING

import pytest

from app.core import config as config_module

if TYPE_CHECKING:
    from pathlib import Path

pytestmark = pytest.mark.unit


def _assert_float_equal(actual: object, expected: float) -> None:
    assert isinstance(actual, float)
    assert actual == pytest.approx(expected)


def test_load_toml_config_merges_default_and_env(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    (tmp_path / "default.toml").write_text(
        '[app]\nname = "default-name"\n[embedding]\ndimension = 256\n',
        encoding="utf-8",
    )
    (tmp_path / "testing.toml").write_text(
        '[app]\nname = "testing-name"\n[server]\nport = 9100\n',
        encoding="utf-8",
    )

    monkeypatch.setattr(config_module, "_CONFIG_DIR", tmp_path)
    monkeypatch.chdir(tmp_path)

    loaded = config_module._load_toml_config("testing")

    assert loaded["app"]["name"] == "testing-name"
    assert loaded["embedding"]["dimension"] == 256
    assert loaded["server"]["port"] == 9100


def test_resolve_app_env_prefers_environment_variable(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("APP_ENV=testing\n", encoding="utf-8")

    monkeypatch.setattr(config_module, "_ENV_FILE", env_file)
    monkeypatch.setenv("APP_ENV", "production")

    assert config_module._resolve_app_env() == "production"


def test_resolve_app_env_falls_back_to_dotenv(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text("APP_ENV=testing\n", encoding="utf-8")

    monkeypatch.setattr(config_module, "_ENV_FILE", env_file)
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv("APP_ENV", raising=False)

    assert config_module._resolve_app_env() == "testing"


def test_settings_prefer_cwd_config_for_packaged_runtime(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    source_root = tmp_path / "source"
    source_config_dir = source_root / "config"
    source_config_dir.mkdir(parents=True)
    (source_config_dir / "default.toml").write_text(
        '[server]\nport = 9005\n[dsp]\nbase_url = "http://localhost:9001/acps-dsp-v2"\n',
        encoding="utf-8",
    )
    source_env_file = source_root / ".env"
    source_env_file.write_text("APP_ENV=development\n", encoding="utf-8")

    runtime_root = tmp_path / "runtime"
    runtime_config_dir = runtime_root / "config"
    runtime_config_dir.mkdir(parents=True)
    (runtime_config_dir / "default.toml").write_text(
        '[server]\nport = 19105\n[dsp]\nbase_url = "http://localhost:9001/acps-dsp-v2"\n',
        encoding="utf-8",
    )
    (runtime_config_dir / "production.toml").write_text(
        "[server]\nport = 19115\n"
        '[dsp]\nbase_url = "https://registry.internal.example.net/acps-dsp-v2"\n'
        '[dsp.webhook]\nreceive_url = "https://discovery.internal.example.net/admin/dsp/webhooks/receive"\n'
        '[polling]\nserver_url = "https://polling.internal.example.net"\n',
        encoding="utf-8",
    )
    (runtime_root / ".env").write_text("APP_ENV=production\n", encoding="utf-8")

    monkeypatch.setattr(config_module, "_CONFIG_DIR", source_config_dir)
    monkeypatch.setattr(config_module, "_ENV_FILE", source_env_file)
    monkeypatch.chdir(runtime_root)
    monkeypatch.delenv("APP_ENV", raising=False)

    settings = config_module.Settings()

    assert settings.APP_ENV == "production"
    assert settings.UVICORN_PORT == 19115
    assert settings.DSP_BASE_URL == "https://registry.internal.example.net/acps-dsp-v2"


def test_settings_allow_dotenv_to_override_llm_provider_settings(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    runtime_root = tmp_path / "runtime"
    runtime_config_dir = runtime_root / "config"
    runtime_config_dir.mkdir(parents=True)
    (runtime_config_dir / "default.toml").write_text(
        "[embedding.cpu]\n"
        'model_name = "toml-embedding-model"\n'
        'base_url = "https://embedding.toml.example/v1"\n'
        "[llm.discovery]\n"
        'model_name = "toml-discovery-model"\n'
        'base_url = "https://discovery.toml.example/v1"\n',
        encoding="utf-8",
    )
    (runtime_root / ".env").write_text(
        "\n".join(
            [
                "APP_ENV=development",
                "EMBEDDING_API_KEY=dotenv-embedding-key",
                "EMBEDDING_BASE_URL=https://embedding.dotenv.example/v1",
                "EMBEDDING_MODEL_NAME=dotenv-embedding-model",
                "DISCOVERY_LLM_API_KEY=dotenv-discovery-key",
                "DISCOVERY_LLM_BASE_URL=https://discovery.dotenv.example/v1",
                "DISCOVERY_LLM_MODEL_NAME=dotenv-discovery-model",
            ]
        )
        + "\n",
        encoding="utf-8",
    )

    monkeypatch.setattr(config_module, "_CONFIG_DIR", runtime_config_dir)
    monkeypatch.chdir(runtime_root)
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("EMBEDDING_API_KEY", raising=False)
    monkeypatch.delenv("EMBEDDING_BASE_URL", raising=False)
    monkeypatch.delenv("EMBEDDING_MODEL_NAME", raising=False)
    monkeypatch.delenv("DISCOVERY_LLM_API_KEY", raising=False)
    monkeypatch.delenv("DISCOVERY_LLM_BASE_URL", raising=False)
    monkeypatch.delenv("DISCOVERY_LLM_MODEL_NAME", raising=False)

    settings = config_module.Settings()

    assert settings.EMBEDDING_API_KEY == "dotenv-embedding-key"
    assert settings.EMBEDDING_BASE_URL == "https://embedding.dotenv.example/v1"
    assert settings.EMBEDDING_MODEL_NAME == "dotenv-embedding-model"
    assert settings.DISCOVERY_LLM_API_KEY == "dotenv-discovery-key"
    assert settings.DISCOVERY_LLM_BASE_URL == "https://discovery.dotenv.example/v1"
    assert settings.DISCOVERY_LLM_MODEL_NAME == "dotenv-discovery-model"


def test_flatten_toml_settings_prefers_logging_section_and_server_root_path() -> None:
    flattened = config_module._flatten_toml_settings(
        {
            "app": {
                "name": "discovery",
                "log_level": "legacy-info",
                "root_path": "/legacy-root",
            },
            "server": {
                "uvicorn_log_level": "warning",
                "root_path": "/new-root",
            },
            "logging": {
                "level": "DEBUG",
                "format": "console",
            },
        }
    )

    assert flattened["APP_LOG_LEVEL"] == "DEBUG"
    assert flattened["LOG_FORMAT"] == "console"
    assert flattened["APP_ROOT_PATH"] == "/new-root"
    assert flattened["UVICORN_LOG_LEVEL"] == "warning"


def test_flatten_toml_settings_maps_database_pool_options() -> None:
    flattened = config_module._flatten_toml_settings(
        {
            "database": {
                "output_sql": True,
                "pool_size": 12,
                "max_overflow": 8,
                "pool_timeout": 15.5,
                "pool_recycle": 900,
                "pool_pre_ping": False,
            }
        }
    )

    assert flattened["DATABASE_OUTPUT_SQL"] is True
    assert flattened["DATABASE_POOL_SIZE"] == 12
    assert flattened["DATABASE_MAX_OVERFLOW"] == 8
    _assert_float_equal(flattened["DATABASE_POOL_TIMEOUT"], 15.5)
    assert flattened["DATABASE_POOL_RECYCLE"] == 900
    assert flattened["DATABASE_POOL_PRE_PING"] is False


def test_flatten_toml_settings_maps_non_secret_runtime_defaults() -> None:
    flattened = config_module._flatten_toml_settings(
        {
            "discovery": {"mode": "cpu"},
            "embedding": {
                "dimension": 768,
                "batch_size": 16,
                "max_wait_time": 0.2,
                "cpu": {
                    "model_name": "text-embedding-3-small",
                    "base_url": "https://embedding.internal/v1/",
                },
                "gpu": {
                    "model_path": "/models/bge-m3",
                    "devices": "cuda:0,cuda:1",
                    "reranker_url": "http://127.0.0.1:8080",
                },
            },
            "prompt": {
                "planner_file_path": "/prompts/planner_prompt.txt",
                "cluster_file_path": "/prompts/cluster_prompt.txt",
            },
            "llm": {
                "discovery": {
                    "model_name": "qwen-plus",
                    "base_url": "https://llm.internal/v1/",
                }
            },
            "forwarder": {
                "server_url": "http://forwarder.internal/acps-adp-v2",
                "server_enabled": True,
            },
        }
    )

    assert flattened["DISCOVERY_MODE"] == "cpu"
    assert flattened["EMBEDDING_DIM"] == 768
    assert flattened["BGE_BATCH_SIZE"] == 16
    _assert_float_equal(flattened["BGE_MAX_WAIT_TIME"], 0.2)
    assert flattened["EMBEDDING_MODEL_NAME"] == "text-embedding-3-small"
    assert flattened["EMBEDDING_BASE_URL"] == "https://embedding.internal/v1/"
    assert flattened["EMBEDDING_MODEL_PATH"] == "/models/bge-m3"
    assert flattened["EMBEDDING_DEVICES"] == "cuda:0,cuda:1"
    assert flattened["RERANKER_URL"] == "http://127.0.0.1:8080"
    assert flattened["PROMPT_FILE_PATH"] == "/prompts/planner_prompt.txt"
    assert flattened["CLUSTER_PROMPT_FILE_PATH"] == "/prompts/cluster_prompt.txt"
    assert flattened["DISCOVERY_LLM_MODEL_NAME"] == "qwen-plus"
    assert flattened["DISCOVERY_LLM_BASE_URL"] == "https://llm.internal/v1/"
    assert flattened["FORWARDER_SERVER_URL"] == "http://forwarder.internal/acps-adp-v2"
    assert flattened["FORWARDER_SERVER_ENABLED"] is True


def test_settings_allow_localhost_urls_in_production() -> None:
    settings = config_module.Settings(
        APP_ENV="production",
        DSP_BASE_URL="http://localhost:9001/acps-dsp-v2",
        DSP_WEBHOOK_RECEIVE_URL="http://127.0.0.1:9005/admin/dsp/webhooks/receive",
        POLLING_SERVER_URL="http://localhost:8020",
    )

    assert settings.DSP_BASE_URL == "http://localhost:9001/acps-dsp-v2"
    assert settings.DSP_WEBHOOK_RECEIVE_URL == "http://127.0.0.1:9005/admin/dsp/webhooks/receive"
    assert settings.POLLING_SERVER_URL == "http://localhost:8020"


def test_settings_reject_invalid_non_empty_runtime_url_in_any_env() -> None:
    with pytest.raises(ValueError, match=r"dsp\.base_url must be an absolute http\(s\) URL"):
        config_module.Settings(APP_ENV="development", DSP_BASE_URL="registry.internal.example.net/acps-dsp-v2")


def test_settings_allow_empty_optional_runtime_urls() -> None:
    settings = config_module.Settings(
        APP_ENV="production",
        DSP_BASE_URL="",
        DSP_WEBHOOK_RECEIVE_URL="",
        POLLING_SERVER_URL="",
    )

    assert settings.DSP_BASE_URL == ""
    assert settings.DSP_WEBHOOK_RECEIVE_URL == ""
    assert settings.POLLING_SERVER_URL == ""


def test_repository_production_config_can_disable_optional_runtime_urls(
    monkeypatch: pytest.MonkeyPatch,
    tmp_path: Path,
) -> None:
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr(config_module, "_ENV_FILE", tmp_path / ".env")
    monkeypatch.setenv("APP_ENV", "production")
    monkeypatch.delenv("DSP_BASE_URL", raising=False)
    monkeypatch.delenv("DSP_WEBHOOK_RECEIVE_URL", raising=False)
    monkeypatch.delenv("POLLING_SERVER_URL", raising=False)

    settings = config_module.Settings(
        DATABASE_URL="postgresql+asyncpg://db:5432/agent_discovery",
    )

    assert settings.APP_ENV == "production"
    assert settings.DSP_BASE_URL == ""
    assert settings.DSP_WEBHOOK_RECEIVE_URL == ""
    assert settings.POLLING_SERVER_URL == ""
