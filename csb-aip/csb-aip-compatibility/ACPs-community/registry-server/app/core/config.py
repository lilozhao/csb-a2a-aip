"""配置加载与管理。

使用 tomllib 读取 config/ 下的 TOML 文件，使用 pydantic-settings 加载环境变量中的敏感配置。
加载顺序：default.toml → {APP_ENV}.toml，后者覆盖前者中的同名项。

敏感配置通过环境变量或 .env 文件提供；非敏感运行时配置通过 TOML 管理，必要时允许环境变量覆写。
"""

from __future__ import annotations

import tomllib
from functools import lru_cache
from pathlib import Path
from typing import Any
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

_SOURCE_CONFIG_DIR = Path(__file__).resolve().parents[2] / "config"


def _resolve_config_dir() -> Path:
    """解析运行时 config 目录，兼容源码树与 wheel 安装目录。"""

    working_dir_config = Path.cwd() / "config"
    if working_dir_config.is_dir():
        return working_dir_config

    return _SOURCE_CONFIG_DIR


def _deep_merge(base: dict[str, Any], override: dict[str, Any]) -> dict[str, Any]:
    """深度合并两个字典，override 覆盖 base 中的同名项。"""
    merged = base.copy()
    for key, value in override.items():
        if key in merged and isinstance(merged[key], dict) and isinstance(value, dict):
            merged[key] = _deep_merge(merged[key], value)
        else:
            merged[key] = value
    return merged


def load_toml_config(env: str = "development") -> dict[str, Any]:
    """加载 TOML 配置文件：default.toml → {env}.toml。"""
    config_dir = _resolve_config_dir()
    default_path = config_dir / "default.toml"
    env_path = config_dir / f"{env}.toml"

    config: dict[str, Any] = {}
    if default_path.exists():
        with default_path.open("rb") as f:
            config = tomllib.load(f)
    if env_path.exists():
        with env_path.open("rb") as f:
            env_config = tomllib.load(f)
        config = _deep_merge(config, env_config)
    return config


def _validate_timezone_name(value: str) -> str:
    """校验 IANA 时区名称。"""

    normalized = value.strip()
    if not normalized:
        raise ValueError("database.session_timezone must not be empty")

    try:
        ZoneInfo(normalized)
    except ZoneInfoNotFoundError as exc:
        raise ValueError(f"Invalid database.session_timezone: {normalized}") from exc

    return normalized


class Settings(BaseSettings):
    """应用设置。环境变量承载敏感数据与少量部署覆写，TOML 承载非敏感业务配置。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=True,
    )

    # ── 敏感配置（从环境变量 / .env 加载） ──

    database_url: str = Field(validation_alias="DATABASE_URL")
    secret_key: str = Field(validation_alias="SECRET_KEY")
    sm4_encryption_key: str = Field(validation_alias="SM4_ENCRYPTION_KEY")
    aic_crc_salt: str = Field(validation_alias="AIC_CRC_SALT")
    ca_server_mock_override: bool | None = Field(default=None, validation_alias="CA_SERVER_MOCK")
    registry_server_internal_api_token: str = Field(
        default="",
        validation_alias="REGISTRY_SERVER_INTERNAL_API_TOKEN",
    )
    app_env: str = Field(default="development", validation_alias="APP_ENV")

    # ── 非敏感运行时配置的可选环境变量覆写 ──

    upload_base_path_override: str | None = Field(default=None, validation_alias="UPLOAD_BASE_PATH")
    ca_server_base_url_override: str | None = Field(default=None, validation_alias="CA_SERVER_BASE_URL")
    root_path_override: str | None = Field(default=None, validation_alias="ROOT_PATH")
    smtp_server_override: str | None = Field(default=None, validation_alias="SMTP_SERVER")
    smtp_port_override: str | None = Field(default=None, validation_alias="SMTP_PORT")
    email_address_override: str | None = Field(default=None, validation_alias="EMAIL_ADDRESS")
    email_password_override: str | None = Field(default=None, validation_alias="EMAIL_PASSWORD")
    dsp_retention_window_hours_override: int | None = Field(
        default=None,
        validation_alias="REGISTRY_SERVER_DSP_RETENTION_WINDOW_HOURS",
    )
    dsp_retention_max_records_override: int | None = Field(
        default=None,
        validation_alias="REGISTRY_SERVER_DSP_RETENTION_MAX_RECORDS",
    )
    mtls_cert_file: Path | None = Field(default=None, validation_alias="REGISTRY_SERVER_MTLS_CERT_FILE")
    mtls_key_file: Path | None = Field(default=None, validation_alias="REGISTRY_SERVER_MTLS_KEY_FILE")
    mtls_ca_cert_file: Path | None = Field(default=None, validation_alias="REGISTRY_SERVER_MTLS_CA_CERT_FILE")
    enable_mtls_listener_override: bool | None = Field(
        default=None,
        validation_alias="REGISTRY_SERVER_ENABLE_MTLS_LISTENER",
    )
    mtls_port_override: int | None = Field(default=None, validation_alias="REGISTRY_SERVER_MTLS_PORT")

    # ── TOML 配置（运行时从文件加载） ──
    _toml: dict[str, Any] = {}

    def model_post_init(self, __context: Any) -> None:
        """加载并合并 TOML 配置。"""
        object.__setattr__(self, "_toml", load_toml_config(self.app_env))

    # ── validators ──

    @field_validator("aic_crc_salt", mode="before")
    @classmethod
    def validate_hex_str(cls, v: Any) -> Any:
        if isinstance(v, str):
            if not v.startswith("0x") and not v.startswith("0X"):
                raise ValueError("Hex string must start with 0x")
            try:
                int(v, 16)
                if len(v) <= 4:
                    raise ValueError("Hex string must be longer than 1 byte")
                return v
            except ValueError as exc:
                raise ValueError("Invalid hex string") from exc
        return v

    @field_validator("sm4_encryption_key", mode="before")
    @classmethod
    def validate_sm4_key(cls, v: Any) -> Any:
        if not isinstance(v, str):
            return v
        normalized = v.removeprefix("0x").removeprefix("0X")
        if len(normalized) != 32:
            raise ValueError("SM4_ENCRYPTION_KEY must be 32 hex characters")
        try:
            bytes.fromhex(normalized)
        except ValueError as exc:
            raise ValueError("SM4_ENCRYPTION_KEY must be valid hexadecimal") from exc
        return normalized.lower()

    @field_validator(
        "smtp_server_override",
        "smtp_port_override",
        "email_address_override",
        "email_password_override",
        mode="before",
    )
    @classmethod
    def normalize_optional_override(cls, v: Any) -> Any:
        if isinstance(v, str) and not v.strip():
            return None
        return v

    @property
    def api_v1_str(self) -> str:
        return str(self._toml.get("api", {}).get("v1_str", "/api/v1"))

    @property
    def api_title(self) -> str:
        return str(self._toml.get("api", {}).get("title", "Agent Internet Backend API"))

    @property
    def algorithm(self) -> str:
        return str(self._toml.get("jwt", {}).get("algorithm", "HS256"))

    @property
    def access_token_expire_minutes(self) -> int:
        return int(self._toml.get("jwt", {}).get("access_token_expire_minutes", 10080))

    @property
    def refresh_token_expire_minutes(self) -> int:
        return int(self._toml.get("jwt", {}).get("refresh_token_expire_minutes", 10080))

    @property
    def cors_enabled(self) -> bool:
        return bool(self._toml.get("cors", {}).get("enabled", False))

    @property
    def cors_origins(self) -> list[str]:
        raw_origins = self._toml.get("cors", {}).get("origins", [])
        if not isinstance(raw_origins, list):
            return []
        return [str(origin) for origin in raw_origins]

    @property
    def cors_allow_origin_regex(self) -> str:
        return str(self._toml.get("cors", {}).get("allow_origin_regex", ""))

    @property
    def cors_allow_credentials(self) -> bool:
        return bool(self._toml.get("cors", {}).get("allow_credentials", False))

    @property
    def cors_allow_methods(self) -> list[str]:
        raw_methods = self._toml.get("cors", {}).get("allow_methods", ["*"])
        if not isinstance(raw_methods, list):
            return ["*"]
        return [str(method) for method in raw_methods]

    @property
    def cors_allow_headers(self) -> list[str]:
        raw_headers = self._toml.get("cors", {}).get("allow_headers", ["*"])
        if not isinstance(raw_headers, list):
            return ["*"]
        return [str(header) for header in raw_headers]

    @property
    def cors_expose_headers(self) -> list[str]:
        raw_headers = self._toml.get("cors", {}).get("expose_headers", [])
        if not isinstance(raw_headers, list):
            return []
        return [str(header) for header in raw_headers]

    @property
    def cors_max_age(self) -> int:
        return int(self._toml.get("cors", {}).get("max_age", 600))

    @property
    def rate_limit_enabled(self) -> bool:
        return bool(self._toml.get("rate_limit", {}).get("enabled", True))

    @property
    def rate_limit_health(self) -> str:
        return str(self._toml.get("rate_limit", {}).get("health", "60/minute"))

    @property
    def rate_limit_auth(self) -> str:
        return str(self._toml.get("rate_limit", {}).get("auth", "20/minute"))

    @property
    def rate_limit_public_read(self) -> str:
        return str(self._toml.get("rate_limit", {}).get("public_read", "120/minute"))

    @property
    def log_level(self) -> str:
        return str(self._toml.get("logging", {}).get("level", "INFO"))

    @property
    def log_format(self) -> str:
        return str(self._toml.get("logging", {}).get("format", "json"))

    @property
    def otel_enabled(self) -> bool:
        return bool(self._toml.get("otel", {}).get("enabled", False))

    @property
    def otel_endpoint(self) -> str:
        return str(self._toml.get("otel", {}).get("endpoint", "http://localhost:4317"))

    @property
    def otel_service_name(self) -> str:
        return str(self._toml.get("otel", {}).get("service_name", "registry-server"))

    @property
    def atr_base_path(self) -> str:
        return str(self._toml.get("atr", {}).get("base_path", "/acps-atr-v2"))

    @property
    def atr_allow_ip_list(self) -> str:
        return str(
            self._toml.get("atr", {}).get(
                "allow_ip_list",
                "127.0.0.1,::1,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
            )
        )

    @property
    def enable_mtls_listener(self) -> bool:
        if self.enable_mtls_listener_override is not None:
            return self.enable_mtls_listener_override

        return bool(self._toml.get("server", {}).get("enable_mtls_listener", True))

    @property
    def mtls_port(self) -> int:
        if self.mtls_port_override is not None:
            return int(self.mtls_port_override)

        return int(self._toml.get("server", {}).get("mtls_port", 9002))

    @property
    def eab_credential_expire_hours(self) -> int:
        return int(self._toml.get("eab", {}).get("credential_expire_hours", 24))

    @property
    def auto_approve_identity_verification(self) -> bool:
        return bool(self._toml.get("verification", {}).get("auto_approve_identity", False))

    @property
    def auto_approve_org_verification(self) -> bool:
        return bool(self._toml.get("verification", {}).get("auto_approve_org", False))

    @property
    def verification_code_bypass(self) -> str:
        return str(self._toml.get("verification", {}).get("code_bypass", ""))

    @property
    def ca_server_mock(self) -> bool:
        if self.ca_server_mock_override is not None:
            return self.ca_server_mock_override

        return bool(self._toml.get("ca_server", {}).get("mock", False))

    @property
    def upload_base_path(self) -> str:
        if self.upload_base_path_override:
            return self.upload_base_path_override

        return str(self._toml.get("file", {}).get("upload_base_path", "./data/uploads"))

    @property
    def ca_server_base_url(self) -> str:
        if self.ca_server_base_url_override:
            return self.ca_server_base_url_override

        return str(self._toml.get("ca_server", {}).get("base_url", "http://localhost:9003"))

    @property
    def ca_server_atr_base_url(self) -> str:
        atr_path = self._toml.get("atr", {}).get("base_path", "/acps-atr-v2")
        return f"{self.ca_server_base_url.rstrip('/')}{atr_path}"

    @property
    def root_path(self) -> str:
        if self.root_path_override is not None:
            return self.root_path_override

        return str(self._toml.get("server", {}).get("root_path", ""))

    @property
    def dsp_base_path(self) -> str:
        return str(self._toml.get("dsp", {}).get("base_path", "/acps-dsp-v2"))

    @property
    def project_name(self) -> str:
        return str(self._toml.get("project", {}).get("name", "agent-registry"))

    @property
    def project_version(self) -> str:
        return str(self._toml.get("project", {}).get("version", "1.0.0"))

    @property
    def dsp_retention_window_hours(self) -> int:
        if self.dsp_retention_window_hours_override is not None:
            return int(self.dsp_retention_window_hours_override)
        return int(self._toml.get("dsp", {}).get("retention_window_hours", 168))

    @property
    def dsp_retention_max_records(self) -> int:
        if self.dsp_retention_max_records_override is not None:
            return int(self.dsp_retention_max_records_override)
        return int(self._toml.get("dsp", {}).get("retention_max_records", 100000))

    @property
    def dsp_snapshot_access_timeout_hours(self) -> int:
        return int(self._toml.get("dsp", {}).get("snapshot_access_timeout_hours", 2))

    @property
    def dsp_snapshot_max_lifetime_hours(self) -> int:
        return int(self._toml.get("dsp", {}).get("snapshot_max_lifetime_hours", 24))

    @property
    def dsp_snapshot_cleanup_interval_hours(self) -> int:
        return int(self._toml.get("dsp", {}).get("snapshot_cleanup_interval_hours", 1))

    @property
    def dsp_changes_max_limit(self) -> int:
        return int(self._toml.get("dsp", {}).get("changes_max_limit", 10000))

    @property
    def dsp_changes_default_limit(self) -> int:
        return int(self._toml.get("dsp", {}).get("changes_default_limit", 1000))

    @property
    def dsp_webhook_batch_window_seconds(self) -> int:
        return int(self._toml.get("dsp", {}).get("webhook_batch_window_seconds", 5))

    @property
    def database_pool_size(self) -> int:
        return int(self._toml.get("database", {}).get("pool_size", 5))

    @property
    def database_max_overflow(self) -> int:
        return int(self._toml.get("database", {}).get("max_overflow", 10))

    @property
    def database_pool_recycle(self) -> int:
        return int(self._toml.get("database", {}).get("pool_recycle", 1800))

    @property
    def database_pool_timeout(self) -> int:
        return int(self._toml.get("database", {}).get("pool_timeout", 30))

    @property
    def database_session_timezone(self) -> str:
        raw = str(self._toml.get("database", {}).get("session_timezone", "Asia/Shanghai"))
        return _validate_timezone_name(raw)

    @property
    def uvicorn_host(self) -> str:
        return str(self._toml.get("server", {}).get("host", "0.0.0.0"))  # noqa: S104

    @property
    def uvicorn_port(self) -> int:
        return int(self._toml.get("server", {}).get("port", 9001))

    @property
    def uvicorn_reload(self) -> bool:
        return bool(self._toml.get("server", {}).get("reload", False))

    @property
    def uvicorn_log_level(self) -> str:
        return str(self._toml.get("server", {}).get("uvicorn_log_level", "info"))

    @property
    def smtp_server(self) -> str:
        if self.smtp_server_override is not None:
            return self.smtp_server_override
        return str(self._toml.get("smtp", {}).get("smtp_server", ""))

    @property
    def smtp_port(self) -> str:
        if self.smtp_port_override is not None:
            return str(self.smtp_port_override)
        return str(self._toml.get("smtp", {}).get("smtp_port", 465))

    @property
    def email_address(self) -> str:
        if self.email_address_override is not None:
            return self.email_address_override
        return str(self._toml.get("smtp", {}).get("email_address", ""))

    @property
    def email_password(self) -> str:
        if self.email_password_override is not None:
            return self.email_password_override
        return str(self._toml.get("smtp", {}).get("email_password", ""))


@lru_cache
def get_settings() -> Settings:
    """获取全局配置单例（带缓存）。"""
    return Settings()  # pyright: ignore[reportCallIssue]


# 向后兼容的模块级单例（现有代码通过 `from app.core.config import settings` 访问）
settings = get_settings()
