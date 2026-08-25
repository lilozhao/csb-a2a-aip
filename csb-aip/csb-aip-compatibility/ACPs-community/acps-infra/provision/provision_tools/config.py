"""配置文件解析与运行时参数管理。"""

from __future__ import annotations

import os
import re
import tempfile
from contextlib import contextmanager
from typing import Iterator

from .utils import strip_trailing_slash

# ─── conf 文件解析 ────────────────────────────────────────────────────────────

_CONF_LINE_RE = re.compile(r"^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)(?:\s*#.*)?$")


def _parse_conf_file(path: str) -> dict[str, str]:
    """解析 KEY = VALUE 格式的 conf 文件。

    Args:
        path: conf 文件路径。

    Returns:
        键值对字典（值已去除首尾空格和包裹引号）。
    """
    result: dict[str, str] = {}
    with open(path, encoding="utf-8") as f:
        for line in f:
            stripped = line.lstrip()
            if not stripped or stripped.startswith("#"):
                continue
            m = _CONF_LINE_RE.match(line)
            if m:
                result[m.group(1)] = _strip_wrapping_quotes(m.group(2).strip())
    return result


def _strip_wrapping_quotes(value: str) -> str:
    if len(value) >= 2:
        if (value[0] == '"' and value[-1] == '"') or (
            value[0] == "'" and value[-1] == "'"
        ):
            return value[1:-1]
    return value


def _toml_quote(value: str) -> str:
    escaped = value.replace("\\", "\\\\").replace('"', '\\"')
    return f'"{escaped}"'


def _strip_registry_api_suffix(url: str) -> str:
    normalized = strip_trailing_slash(url)
    for suffix in ("/api/v1", "/api"):
        if normalized.endswith(suffix):
            return normalized[: -len(suffix)]
    return normalized


# ─── RuntimeConfig ────────────────────────────────────────────────────────────


class RuntimeConfig:
    """运行时配置，从 conf 文件和环境变量合并构建。

    优先级：环境变量 > conf 文件 > 代码默认值。
    非容器模式下，自动将 conf 中的 `host.docker.internal` 规范化为 `localhost`。

    Attributes:
        conf_path: conf 文件的绝对路径。
        container_mode: 是否在容器内运行。
    """

    def __init__(self, conf_path: str, container_mode: bool = False) -> None:
        self.conf_path = conf_path
        self.container_mode = container_mode
        self._raw: dict[str, str] = {}
        if os.path.isfile(conf_path):
            self._raw = _parse_conf_file(conf_path)

    def get(self, key: str, default: str = "") -> str:
        """读取配置值（环境变量优先）。

        Args:
            key: 配置键名。
            default: 未找到时的默认值。

        Returns:
            配置值字符串。
        """
        env_val = os.environ.get(key, "")
        if env_val:
            return env_val
        return self._raw.get(key, default)

    # ─── URL 属性 ───────────────────────────────────────────────────────────

    def registry_api_base_url(self) -> str:
        """返回 Registry API 基础 URL（已规范化）。"""
        return strip_trailing_slash(self._normalize(self.get("REGISTRY_API_BASE_URL")))

    def ca_server_base_url(self) -> str:
        """返回 CA Server 基础 URL（已规范化）。"""
        return strip_trailing_slash(self._normalize(self.get("CA_SERVER_BASE_URL")))

    def discovery_gateway_url(self) -> str:
        """返回 Discovery 网关 URL（已规范化）。

        若未配置，使用默认值 `http://host.docker.internal:9000/discovery`。
        """
        url = self.get("DISCOVERY_GATEWAY_URL")
        if not url:
            url = "http://host.docker.internal:9000/discovery"
        return strip_trailing_slash(self._normalize(url))

    def registry_base_url(self) -> str:
        """返回 acps-cli 所需的 Registry 服务根 URL。"""
        return _strip_registry_api_suffix(self.registry_api_base_url())

    def cli_env(self) -> dict[str, str]:
        """返回供 acps-cli 使用的凭据环境变量。"""
        env: dict[str, str] = {}
        for key in (
            "REGISTRY_CLIENT_USERNAME",
            "REGISTRY_CLIENT_PASSWORD",
            "REGISTRY_ADMIN_USERNAME",
            "REGISTRY_ADMIN_PASSWORD",
        ):
            value = self.get(key)
            if value:
                env[key] = value
        return env

    def build_cli_toml(self) -> str:
        """构建运行期 acps-cli.toml 内容。"""
        config_dir = os.path.dirname(os.path.abspath(self.conf_path))
        user_token_file = os.path.join(
            config_dir, ".acps-cli", "tokens", "registry-user.json"
        )
        admin_token_file = os.path.join(
            config_dir, ".acps-cli", "tokens", "registry-admin.json"
        )

        return "\n".join(
            [
                "[registry]",
                f"base_url = {_toml_quote(self.registry_base_url())}",
                "",
                "[auth]",
                f"user_token_file = {_toml_quote(user_token_file)}",
                f"admin_token_file = {_toml_quote(admin_token_file)}",
                "",
                "[ca]",
                f"base_url = {_toml_quote(self.ca_server_base_url())}",
                "",
                "[discovery]",
                f"base_url = {_toml_quote(self.discovery_gateway_url())}",
                "",
            ]
        )

    def _normalize(self, url: str) -> str:
        """非容器模式下将 host.docker.internal 替换为 localhost。"""
        if not self.container_mode and "host.docker.internal" in url:
            return url.replace("host.docker.internal", "localhost")
        return url

    # ─── CLI conf 路径管理 ─────────────────────────────────────────────────

    @contextmanager
    def runtime_conf_path(self) -> Iterator[str]:
        """返回可直接传给 acps-cli --config 参数的文件路径。

        将 provision.conf 转换为临时 acps-cli.toml，并在上下文期间注入
        registry 登录所需环境变量。

        Yields:
            有效的 conf 文件路径字符串。
        """
        tmp_path: str | None = None
        original_env: dict[str, str | None] = {}
        try:
            for key, value in self.cli_env().items():
                original_env[key] = os.environ.get(key)
                os.environ[key] = value

            cli_toml = self.build_cli_toml()
            with tempfile.NamedTemporaryFile(
                mode="w",
                suffix=".toml",
                delete=False,
                encoding="utf-8",
            ) as tmp:
                tmp.write(cli_toml)
                tmp_path = tmp.name

            yield tmp_path
        finally:
            if tmp_path is not None and os.path.exists(tmp_path):
                os.unlink(tmp_path)
            for key, previous in original_env.items():
                if previous is None:
                    os.environ.pop(key, None)
                else:
                    os.environ[key] = previous


# ─── URL 派生工具 ─────────────────────────────────────────────────────────────


def derive_registry_health_url(base_url: str) -> str:
    """从 Registry API base URL 派生健康检查 URL。

    Args:
        base_url: Registry API 基础 URL（如 `.../registry/api`）。

    Returns:
        健康检查 URL（如 `.../registry/health`）。
    """
    base = strip_trailing_slash(base_url)
    if base.endswith("/api"):
        return base[:-4] + "/health"
    return base + "/health"


def derive_ca_trust_bundle_url(base_url: str) -> str:
    """从 CA Server base URL 派生 trust bundle URL。

    Args:
        base_url: CA Server 基础 URL。

    Returns:
        Trust bundle URL。
    """
    return strip_trailing_slash(base_url) + "/acps-atr-v2/ca/trust-bundle"
