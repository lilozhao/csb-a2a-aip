"""
转发服务器配置管理模块。
用于管理转发服务器的配置，支持从环境变量加载。
"""

from pydantic import BaseModel, Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class ForwarderConfig(BaseSettings):
    """转发服务器配置。"""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="",
        case_sensitive=False,
        extra="ignore",
    )

    forwarder_server_url: str | None = Field(
        default=None,
        description="转发服务器的基础 URL，例如: http://127.0.0.1:8005/acps-adp-v2",
    )
    forwarder_server_timeout: float = Field(
        default=30.0,
        description="请求转发服务器的超时时间（秒）",
    )
    forwarder_server_enabled: bool = Field(
        default=False,
        description="是否启用转发服务器",
    )
    forwarder_health_check_interval: int = Field(
        default=600,
        description="转发服务器健康检查间隔（秒）",
    )
    forwarder_request_retries: int = Field(
        default=0,
        description="转发服务器请求失败时的重试次数",
    )
    forwarder_fallback_to_local: bool = Field(
        default=True,
        description="转发服务器失败时是否回退到本地处理",
    )


class ForwarderStats(BaseModel):
    """转发统计信息。"""

    total_requests: int = 0
    forwarder_requests: int = 0
    forwarder_success: int = 0
    forwarder_failures: int = 0
    local_fallback: int = 0

    @property
    def forwarder_success_rate(self) -> float:
        if self.forwarder_requests == 0:
            return 0.0
        return self.forwarder_success / self.forwarder_requests * 100

    @property
    def forwarder_usage_rate(self) -> float:
        if self.total_requests == 0:
            return 0.0
        return self.forwarder_requests / self.total_requests * 100


_config: ForwarderConfig | None = None
_stats = ForwarderStats()


def load_config() -> ForwarderConfig:
    global _config
    if _config is None:
        _config = ForwarderConfig()
    return _config


def get_config() -> ForwarderConfig:
    if _config is None:
        return load_config()
    return _config


def get_stats() -> ForwarderStats:
    return _stats


def record_request(used_forwarder: bool, success: bool) -> None:
    """记录请求统计。"""
    global _stats
    _stats.total_requests += 1

    if used_forwarder:
        _stats.forwarder_requests += 1
        if success:
            _stats.forwarder_success += 1
        else:
            _stats.forwarder_failures += 1
            _stats.local_fallback += 1
