"""
发现模块模式定义。

外部协议模型使用 acps_sdk.adp，
内部数据库过滤层继续使用 legacy DiscoveryFilters。
"""

from typing import Any

from acps_sdk.adp import (
    DiscoveryAgentGroup,
    DiscoveryAgentSkill,
    DiscoveryContext,
    DiscoveryFilter,
    DiscoveryResponse,
    DiscoveryResult,
    DiscoveryRoute,
    ErrorDetail,
    FilterCondition,
    FilterOperator,
)
from pydantic import BaseModel, ConfigDict, Field

__all__ = [
    "DiscoveryAgentGroup",
    "DiscoveryAgentSkill",
    "DiscoveryContext",
    "DiscoveryFilter",
    "DiscoveryFilters",
    "DiscoveryResponse",
    "DiscoveryResult",
    "DiscoveryRoute",
    "ErrorDetail",
    "convert_filter_to_legacy",
]


class DiscoveryCapabilityFlags(BaseModel):
    """AgentCapabilities 的过滤项（内部使用）。"""

    streaming: bool | None = Field(default=None, description="是否需要流式响应能力")
    notification: bool | None = Field(default=None, description="是否需要异步通知能力")
    messageQueue: list[str] | None = Field(default=None, description="必须支持的消息队列协议版本")  # noqa: N815
    messageQueue_reject: list[str] | None = Field(default=None, description="必须排除的消息队列协议版本")  # noqa: N815


class DiscoveryFilters(BaseModel):
    """数据库过滤层使用的固定字段过滤器。"""

    protocolVersions: list[str] | None = Field(default=None)  # noqa: N815
    protocolVersions_reject: list[str] | None = Field(default=None)  # noqa: N815
    transports: list[str] | None = Field(default=None)
    transports_reject: list[str] | None = Field(default=None)
    requiredSecuritySchemes: list[str] | None = Field(default=None)  # noqa: N815
    requiredSecuritySchemes_reject: list[str] | None = Field(default=None)  # noqa: N815
    skillTags: list[str] | None = Field(default=None)  # noqa: N815
    skillTags_reject: list[str] | None = Field(default=None)  # noqa: N815
    skillIds: list[str] | None = Field(default=None)  # noqa: N815
    skillIds_reject: list[str] | None = Field(default=None)  # noqa: N815
    providerCountryCodes: list[str] | None = Field(default=None)  # noqa: N815
    providerCountryCodes_reject: list[str] | None = Field(default=None)  # noqa: N815
    providerOrganizations: list[str] | None = Field(default=None)  # noqa: N815
    providerOrganizations_reject: list[str] | None = Field(default=None)  # noqa: N815
    providerLicenses: list[str] | None = Field(default=None)  # noqa: N815
    providerLicenses_reject: list[str] | None = Field(default=None)  # noqa: N815
    inputModes: list[str] | None = Field(default=None)  # noqa: N815
    inputModes_reject: list[str] | None = Field(default=None)  # noqa: N815
    outputModes: list[str] | None = Field(default=None)  # noqa: N815
    outputModes_reject: list[str] | None = Field(default=None)  # noqa: N815
    isActive: bool | None = Field(default=None)  # noqa: N815
    aic: str | None = Field(default=None)
    aicStartWith: str | None = Field(default=None)  # noqa: N815
    entityUserId: str | None = Field(default=None)  # noqa: N815
    hasEndpoints: bool | None = Field(default=None)  # noqa: N815
    hasWebAppUrl: bool | None = Field(default=None)  # noqa: N815
    onlyAvailable: bool | None = Field(default=None)  # noqa: N815
    capabilities: DiscoveryCapabilityFlags | None = Field(default=None)


def _collect_conditions(filter_obj: DiscoveryFilter, out: list[FilterCondition]) -> None:
    if filter_obj.conditions:
        out.extend(filter_obj.conditions)
    if filter_obj.groups:
        for group in filter_obj.groups:
            _collect_conditions(group, out)


def _as_list(value: Any) -> list[Any]:
    if value is None:
        return []
    items = list(value) if isinstance(value, list | tuple) else [value]
    return [str(item) for item in items if item is not None]


def convert_filter_to_legacy(filter_obj: DiscoveryFilter | None) -> DiscoveryFilters | None:
    """将 DiscoveryFilter 转换为内部 DiscoveryFilters。"""

    if filter_obj is None:
        return None

    conditions: list[FilterCondition] = []
    _collect_conditions(filter_obj, conditions)
    if not conditions:
        return None

    legacy = DiscoveryFilters()

    for cond in conditions:
        field = cond.field
        op = cond.op
        value = cond.value

        if field == "active":
            if op in (FilterOperator.EQ, FilterOperator.NE):
                legacy.isActive = bool(value) if op == FilterOperator.EQ else not bool(value)

        elif field == "protocolVersion":
            if op in (FilterOperator.EQ, FilterOperator.IN):
                legacy.protocolVersions = _as_list(value)
            elif op in (FilterOperator.NIN, FilterOperator.NE):
                legacy.protocolVersions_reject = _as_list(value)

        elif field == "endPoints.transport":
            if op in (FilterOperator.EQ, FilterOperator.IN):
                legacy.transports = _as_list(value)
            elif op in (FilterOperator.NIN, FilterOperator.NE):
                legacy.transports_reject = _as_list(value)

        elif field == "securitySchemes":
            if op in (FilterOperator.HAS_KEY, FilterOperator.HAS_ANY_KEY, FilterOperator.HAS_ALL_KEYS):
                legacy.requiredSecuritySchemes = _as_list(value)
            elif op == FilterOperator.HAS_NO_KEY:
                legacy.requiredSecuritySchemes_reject = _as_list(value)

        elif field == "skills.tags":
            if op in (FilterOperator.ANY_OF, FilterOperator.ALL_OF):
                legacy.skillTags = _as_list(value)
            elif op == FilterOperator.NONE_OF:
                legacy.skillTags_reject = _as_list(value)

        elif field == "skills.id":
            if op in (FilterOperator.EQ, FilterOperator.IN):
                legacy.skillIds = _as_list(value)
            elif op in (FilterOperator.NIN, FilterOperator.NE):
                legacy.skillIds_reject = _as_list(value)

        elif field == "provider.countryCode":
            if op in (FilterOperator.EQ, FilterOperator.IN):
                legacy.providerCountryCodes = _as_list(value)
            elif op in (FilterOperator.NIN, FilterOperator.NE):
                legacy.providerCountryCodes_reject = _as_list(value)

        elif field == "provider.organization":
            if op in (
                FilterOperator.EQ,
                FilterOperator.CONTAINS,
                FilterOperator.STARTS_WITH,
                FilterOperator.CONTAINS_CS,
                FilterOperator.IN,
            ):
                legacy.providerOrganizations = _as_list(value)
            elif op in (FilterOperator.NIN, FilterOperator.NE):
                legacy.providerOrganizations_reject = _as_list(value)

        elif field == "provider.license":
            if op in (FilterOperator.EQ, FilterOperator.CONTAINS, FilterOperator.IN):
                legacy.providerLicenses = _as_list(value)
            elif op == FilterOperator.NIN:
                legacy.providerLicenses_reject = _as_list(value)

        elif field in ("defaultInputModes", "skills.inputModes"):
            if op in (FilterOperator.ANY_OF, FilterOperator.ALL_OF):
                legacy.inputModes = _as_list(value)
            elif op == FilterOperator.NONE_OF:
                legacy.inputModes_reject = _as_list(value)

        elif field in ("defaultOutputModes", "skills.outputModes"):
            if op in (FilterOperator.ANY_OF, FilterOperator.ALL_OF):
                legacy.outputModes = _as_list(value)
            elif op == FilterOperator.NONE_OF:
                legacy.outputModes_reject = _as_list(value)

        elif field == "aic":
            if op == FilterOperator.EQ:
                legacy.aic = value
            elif op == FilterOperator.STARTS_WITH:
                legacy.aicStartWith = value
            elif op == FilterOperator.IN:
                lst = _as_list(value)
                if lst:
                    legacy.aic = lst[0]

        elif field == "entityUserId":
            if op == FilterOperator.EQ:
                legacy.entityUserId = value

        elif field == "endPoints":
            if op == FilterOperator.EXISTS:
                legacy.hasEndpoints = bool(value)

        elif field == "webAppUrl":
            if op == FilterOperator.EXISTS:
                legacy.hasWebAppUrl = bool(value)

        elif field == "onlyAvailable":
            if op == FilterOperator.EQ:
                legacy.onlyAvailable = bool(value)

        elif field == "capabilities.streaming":
            if op == FilterOperator.EQ:
                if legacy.capabilities is None:
                    legacy.capabilities = DiscoveryCapabilityFlags()
                legacy.capabilities.streaming = bool(value)

        elif field == "capabilities.notification":
            if op == FilterOperator.EQ:
                if legacy.capabilities is None:
                    legacy.capabilities = DiscoveryCapabilityFlags()
                legacy.capabilities.notification = bool(value)

        elif field == "capabilities.messageQueue":
            if op == FilterOperator.ANY_OF:
                if legacy.capabilities is None:
                    legacy.capabilities = DiscoveryCapabilityFlags()
                legacy.capabilities.messageQueue = _as_list(value)
            elif op == FilterOperator.NONE_OF:
                if legacy.capabilities is None:
                    legacy.capabilities = DiscoveryCapabilityFlags()
                legacy.capabilities.messageQueue_reject = _as_list(value)

    return legacy


class DiscoveryRequest(BaseModel):
    """对外发现请求模型（与 CPU 版本保持一致）。"""

    model_config = ConfigDict(populate_by_name=True)

    type: str = "explicit"
    query: str | None = Field(default=None, description="自然语言查询文本")
    context: DiscoveryContext | None = Field(default=None, description="上下文信息")
    limit: int = Field(default=5, ge=1, le=50)
    filter: DiscoveryFilter | None = Field(default=None, description="结构化过滤条件")
    forwardDepthLimit: int = Field(default=1, ge=1, le=5)  # noqa: N815
    forwardFanoutLimit: int = Field(default=1, ge=1, le=5)  # noqa: N815
    forwardFanoutRemaining: int = Field(default=0, ge=0, le=5)  # noqa: N815
    forwardChain: list[str] | None = Field(default_factory=list)  # noqa: N815
    forwardTrustedServers: list[str] | None = Field(default_factory=list)  # noqa: N815
    forwardSignatures: list[str] | None = Field(default_factory=list)  # noqa: N815
    forwardEachTimeoutMs: int | None = 10000  # noqa: N815
    forwardTotalTimeoutMs: int | None = 60000  # noqa: N815
