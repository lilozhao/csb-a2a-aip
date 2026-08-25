from __future__ import annotations

import pytest
from fastapi import FastAPI

from app.core import health_probe as health_probe_module
from app.core.config import settings as config_settings

pytestmark = pytest.mark.unit


def test_build_root_status_omits_runtime_when_snapshot_missing(monkeypatch: pytest.MonkeyPatch) -> None:
    app = FastAPI()
    monkeypatch.setattr(health_probe_module, "get_runtime_services_snapshot", lambda _: None)

    payload = health_probe_module.build_root_status(app)

    assert payload["status"] == "healthy"
    assert payload["service"] == config_settings.APP_NAME
    assert payload["version"] == config_settings.APP_VERSION
    assert payload["description"] == config_settings.APP_DESC
    assert "runtime" not in payload


def test_build_root_status_includes_runtime_snapshot(monkeypatch: pytest.MonkeyPatch) -> None:
    app = FastAPI()
    runtime_snapshot = {
        "semantic_matcher": {"running": True, "last_error": None},
        "dsp_sync": {"running": False, "last_error": None},
    }
    monkeypatch.setattr(health_probe_module, "get_runtime_services_snapshot", lambda _: runtime_snapshot)

    payload = health_probe_module.build_root_status(app)

    assert payload["runtime"] == runtime_snapshot
