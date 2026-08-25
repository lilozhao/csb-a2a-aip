from __future__ import annotations

from enum import StrEnum

import pytest

from app.discovery.exception import DiscoveryError, DiscoveryOperationError
from app.sync.exception import SyncError, SyncOperationError

pytestmark = pytest.mark.unit


def test_discovery_error_is_str_enum_and_keeps_existing_value() -> None:
    assert issubclass(DiscoveryError, StrEnum)
    assert DiscoveryError.DISCOVERY_FAIL.value == "discovery_fail"

    exc = DiscoveryOperationError(error_name=DiscoveryError.DISCOVERY_FAIL)

    assert exc.error_name == DiscoveryError.DISCOVERY_FAIL


def test_sync_error_is_str_enum_and_keeps_existing_value() -> None:
    assert issubclass(SyncError, StrEnum)
    assert SyncError.SYNC_FAIL.value == "sync_fail"

    exc = SyncOperationError(error_name=SyncError.SYNC_FAIL)

    assert exc.error_name == SyncError.SYNC_FAIL
