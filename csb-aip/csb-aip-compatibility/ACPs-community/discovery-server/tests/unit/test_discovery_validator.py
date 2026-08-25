from __future__ import annotations

import pytest
from acps_sdk.adp import FilterCondition, FilterOperator

from app.discovery.exception import ADPError
from app.discovery.schema import DiscoveryFilter, DiscoveryRequest
from app.discovery.validator import validate_discovery_request

pytestmark = pytest.mark.unit


def test_validate_discovery_request_requires_query_for_explicit() -> None:
    request = DiscoveryRequest(type="explicit", query="   ")

    with pytest.raises(ADPError) as exc_info:
        validate_discovery_request(request)

    assert exc_info.value.error_data.code == 40001
    assert exc_info.value.error_data.message == "MissingQuery"


def test_validate_discovery_request_rejects_invalid_forward_depth_limit() -> None:
    request = DiscoveryRequest.model_construct(type="filtered", forwardDepthLimit=6)

    with pytest.raises(ADPError) as exc_info:
        validate_discovery_request(request)

    assert exc_info.value.error_data.code == 40002
    assert exc_info.value.error_data.message == "ForwardDepthLimitInvalid"


def test_validate_discovery_request_rejects_blank_forward_chain_entry() -> None:
    request = DiscoveryRequest(
        type="filtered",
        filter=DiscoveryFilter(conditions=[FilterCondition(field="active", op=FilterOperator.EQ, value=True)]),
        forwardChain=["AIC-DS-A", "   "],
    )

    with pytest.raises(ADPError) as exc_info:
        validate_discovery_request(request)

    assert exc_info.value.error_data.code == 40003
    assert exc_info.value.error_data.message == "ForwardChainInvalid"
