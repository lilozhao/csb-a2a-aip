from __future__ import annotations

import pytest


def pytest_collection_modifyitems(items: list[pytest.Item]) -> None:
    """为 unit 目录下未显式标注的测试补齐 unit marker。"""

    for item in items:
        if item.get_closest_marker("unit") is None:
            item.add_marker(pytest.mark.unit)
