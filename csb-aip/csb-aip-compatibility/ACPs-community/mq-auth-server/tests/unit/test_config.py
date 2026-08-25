"""配置模块的单元测试。

覆盖：
- _deep_merge 深度合并逻辑
- load_toml_config 文件加载
- Settings 各属性访问方法
"""

from __future__ import annotations

from pathlib import Path

from pytest import MonkeyPatch

from app.core.config import Settings, _deep_merge, load_toml_config


class TestDeepMerge:
    """_deep_merge — 字典深度合并。"""

    def test_override_replaces_top_level_value(self) -> None:
        result = _deep_merge({"a": 1, "b": 2}, {"b": 3, "c": 4})
        assert result == {"a": 1, "b": 3, "c": 4}

    def test_nested_dict_is_merged_not_replaced(self) -> None:
        base = {"server": {"host": "0.0.0.0", "port": 8080}, "level": "INFO"}
        override = {"server": {"port": 9007}}
        result = _deep_merge(base, override)
        assert result["server"]["host"] == "0.0.0.0"  # 保留
        assert result["server"]["port"] == 9007  # 被覆盖
        assert result["level"] == "INFO"  # 保留

    def test_non_dict_value_replaced_by_override(self) -> None:
        result = _deep_merge({"key": "old"}, {"key": "new"})
        assert result["key"] == "new"

    def test_base_dict_not_mutated(self) -> None:
        base = {"a": {"b": 1}}
        override = {"a": {"c": 2}}
        _deep_merge(base, override)
        # 原始字典不应被修改
        assert "c" not in base["a"]

    def test_new_key_added_from_override(self) -> None:
        result = _deep_merge({"existing": 1}, {"new_key": 2})
        assert result["new_key"] == 2
        assert result["existing"] == 1

    def test_empty_base_returns_override(self) -> None:
        result = _deep_merge({}, {"a": 1})
        assert result == {"a": 1}

    def test_empty_override_returns_base_copy(self) -> None:
        result = _deep_merge({"a": 1}, {})
        assert result == {"a": 1}

    def test_triple_nested_merge(self) -> None:
        base = {"a": {"b": {"c": 1, "d": 2}}}
        override = {"a": {"b": {"d": 99}}}
        result = _deep_merge(base, override)
        assert result["a"]["b"]["c"] == 1  # 保留
        assert result["a"]["b"]["d"] == 99  # 被覆盖


class TestLoadTomlConfig:
    """load_toml_config — TOML 文件加载与合并。"""

    def test_loads_default_config_contains_server_section(self) -> None:
        config = load_toml_config("development")
        assert "server" in config

    def test_development_config_has_expected_ports(self) -> None:
        config = load_toml_config("development")
        server = config.get("server", {})
        assert "group_api_port" in server
        assert "auth_api_port" in server

    def test_nonexistent_env_falls_back_to_default_only(self) -> None:
        # 不存在的 env 文件，只加载 default.toml
        config = load_toml_config("nonexistent-env-xyz")
        assert "server" in config

    def test_testing_env_overrides_log_level(self) -> None:
        # testing.toml 应覆盖日志级别
        config = load_toml_config("testing")
        log = config.get("logging", {})
        assert log.get("level", "").upper() in ("DEBUG", "INFO", "WARNING", "ERROR")

    def test_prefers_cwd_config_for_packaged_runtime(self, monkeypatch: MonkeyPatch, tmp_path: Path) -> None:
        config_dir = tmp_path / "config"
        config_dir.mkdir()
        (config_dir / "default.toml").write_text(
            "[server]\ngroup_api_port = 9007\nauth_api_port = 9008\n",
            encoding="utf-8",
        )
        (config_dir / "production.toml").write_text(
            "[server]\ngroup_api_port = 19007\nauth_api_port = 19008\n",
            encoding="utf-8",
        )
        monkeypatch.chdir(tmp_path)

        config = load_toml_config("production")

        assert config["server"]["group_api_port"] == 19007
        assert config["server"]["auth_api_port"] == 19008


class TestSettingsProperties:
    """Settings 属性访问方法。"""

    def test_group_api_port_default(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test"})
        assert settings.group_api_port == 9007

    def test_auth_api_port_default(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test"})
        assert settings.auth_api_port == 9008

    def test_redis_url_value_returns_plain_string(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test"})
        url = settings.redis_url_value
        assert isinstance(url, str)
        assert url.startswith("redis://")

    def test_redis_url_does_not_leak_in_repr(self) -> None:
        settings = Settings.model_validate(
            {
                "RABBITMQ_MGMT_PASS": "test",
                "REDIS_URL": "redis://:secret@localhost:6379/0",
            }
        )
        # SecretStr 的 repr 应隐藏密码
        assert "secret" not in repr(settings.redis_url)

    def test_rabbitmq_mgmt_password_returns_secret_value(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "my-secret-pass"})
        assert settings.rabbitmq_mgmt_password == "my-secret-pass"

    def test_rabbitmq_mgmt_url_defaults_to_localhost(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test-pass"})
        assert settings.rabbitmq_mgmt_url == "http://localhost:15672"

    def test_development_env_uses_admin_as_rabbitmq_mgmt_user(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test-pass", "APP_ENV": "development"})
        assert settings.rabbitmq_mgmt_user == "admin"

    def test_default_tls_paths_point_to_project_certs_directory(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test-pass"})
        assert settings.tls_cert_file == Path("certs/server.pem")
        assert settings.tls_key_file == Path("certs/server.key")
        assert settings.tls_ca_cert_file == Path("certs/acps-root-ca.pem")

    def test_log_level_is_valid_string(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test"})
        assert settings.log_level.upper() in (
            "DEBUG",
            "INFO",
            "WARNING",
            "ERROR",
            "CRITICAL",
        )

    def test_log_format_is_valid(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test"})
        assert settings.log_format in ("json", "console")

    def test_local_cache_ttl_is_positive_int(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test"})
        assert settings.local_cache_ttl_seconds > 0

    def test_group_acl_key_ttl_is_positive_int(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test"})
        assert settings.group_acl_key_ttl_seconds > 0

    def test_rabbitmq_mgmt_user_is_non_empty_string(self) -> None:
        settings = Settings.model_validate({"RABBITMQ_MGMT_PASS": "test"})
        assert isinstance(settings.rabbitmq_mgmt_user, str)
        assert len(settings.rabbitmq_mgmt_user) > 0
