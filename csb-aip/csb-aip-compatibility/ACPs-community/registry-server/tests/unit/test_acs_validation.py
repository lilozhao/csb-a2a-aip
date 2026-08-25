"""ACS challenge URL 兼容层保留测试。"""

import json
from pathlib import Path
from typing import cast

import pytest

from app.utils.acs import validate

pytestmark = pytest.mark.unit


def _load_example_acs() -> dict[str, object]:
    example_path = Path(__file__).resolve().parent.parent / "fixtures" / "acs" / "beijing_urban.json"
    return cast("dict[str, object]", json.loads(example_path.read_text(encoding="utf-8")))


def test_validate_accepts_legacy_challenge_url_field() -> None:
    """兼容层保留测试：历史 ACS 仍可携带 x-caChallengeBaseUrl。"""
    acs = _load_example_acs()
    security_schemes = cast("dict[str, dict[str, object]]", acs["securitySchemes"])
    mtls_scheme = security_schemes["mtls"]
    mtls_scheme["x-caChallengeBaseUrl"] = "http://legacy.example.com/acps-atr-v2"

    validate(acs)


def test_validate_accepts_current_acs_without_challenge_url() -> None:
    """主链路测试：当前 ACS 在 EAB 模式下不再要求 challenge URL。"""
    acs = _load_example_acs()

    validate(acs)


def test_validate_accepts_certificate_alt_names() -> None:
    acs = _load_example_acs()
    acs["certificate"] = {"altNames": {"dns": ["host.docker.internal", "localhost"]}}

    validate(acs)


def test_validate_accepts_certificate_requested_validity() -> None:
    acs = _load_example_acs()
    acs["certificate"] = {
        "altNames": {"dns": ["host.docker.internal"]},
        "requestedValidity": 365,
    }

    validate(acs)


def test_validate_accepts_amqps_endpoint() -> None:
    acs = _load_example_acs()
    end_points = cast("list[dict[str, object]]", acs["endPoints"])
    end_points.append(
        {
            "url": "amqps://host.docker.internal:5671/acps?inbox=inbox_{AIC}",
            "transport": "AMQP",
            "security": [{"mtls": []}],
        }
    )

    validate(acs)
