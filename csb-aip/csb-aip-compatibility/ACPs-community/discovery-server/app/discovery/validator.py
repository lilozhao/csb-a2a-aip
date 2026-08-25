from __future__ import annotations

from typing import TYPE_CHECKING

from acps_sdk.adp import ErrorDetail

from app.discovery.exception import ADPError

if TYPE_CHECKING:
    from app.discovery.schema import DiscoveryRequest

E_MISSING_QUERY = ErrorDetail(
    code=40001,
    message="MissingQuery",
    data="type=explicit 或 exploratory 时缺少 query，或文本为空字符串。",
)
E_FORWARD_DEPTH_LIMIT_INVALID = ErrorDetail(
    code=40002,
    message="ForwardDepthLimitInvalid",
    data="forwardDepthLimit 不在 1-5 区间。",
)
E_FORWARD_CHAIN_INVALID = ErrorDetail(
    code=40003,
    message="ForwardChainInvalid",
    data="客户端携带的 forwardChain 包含非法 AIC。",
)


def validata_aic_safe(aic: str) -> bool:
    return isinstance(aic, str) and len(aic.strip()) > 0


def validata_aics_safe(aics: list[str] | str) -> None:
    if not isinstance(aics, list | str):
        raise ADPError(E_FORWARD_CHAIN_INVALID)
    if isinstance(aics, str):
        if not validata_aic_safe(aics):
            raise ADPError(E_FORWARD_CHAIN_INVALID)
        return
    if not all(validata_aic_safe(aic) for aic in aics):
        raise ADPError(E_FORWARD_CHAIN_INVALID)


def validate_discovery_request(request: DiscoveryRequest) -> None:
    """对传入 DiscoveryRequest 执行业务规则校验。"""

    if request.type in ("explicit", "exploratory") and not (
        request.query and isinstance(request.query, str) and request.query.strip()
    ):
        raise ADPError(E_MISSING_QUERY)

    if not (1 <= request.forwardDepthLimit <= 5):
        raise ADPError(E_FORWARD_DEPTH_LIMIT_INVALID)

    if request.forwardChain:
        validata_aics_safe(request.forwardChain)
