"""app.acme.mock_data 的单元测试。"""

from __future__ import annotations

import random
import secrets
import time
from datetime import UTC, datetime

from app.acme.mock_data import MockCacheSimulator, MockDataGenerator, MockDelaySimulator, generate_realistic_error


def test_random_string_and_number_string_length() -> None:
    text = MockDataGenerator.random_string(8)
    digits = MockDataGenerator.random_number_string(10)

    assert len(text) == 8
    assert len(digits) == 10
    assert digits.isdigit()


def test_generate_email_and_domain_format() -> None:
    email = MockDataGenerator.generate_email("A & B Company")
    domain = MockDataGenerator.generate_domain()

    assert "@" in email
    assert email.endswith(".com")
    assert domain.count(".") == 1


def test_generate_aic_has_expected_segments_and_prefix() -> None:
    aic = MockDataGenerator.generate_aic()
    segments = aic.split(".")

    assert len(segments) == 10
    assert ".".join(segments[:4]) == "1.2.156.3088"
    assert len(segments[-1]) == 4


def test_generate_organization_info_has_required_fields() -> None:
    org = MockDataGenerator.generate_organization_info()

    assert set(org.keys()) == {
        "organizationName",
        "organizationalUnit",
        "country",
        "state",
        "locality",
        "contactEmail",
    }


def test_generate_agent_info_contains_acs_shape() -> None:
    info = MockDataGenerator.generate_agent_info("1.2.156.3088.A.B.C.D.E.F")

    assert info["aic"] == "1.2.156.3088.A.B.C.D.E.F"
    assert info["active"] is True
    assert info["provider"]["organization"]
    assert isinstance(info["endPoints"], list)
    assert isinstance(info["skills"], list)
    assert "certificate" in info


def test_agent_registry_helper_methods_always_return_true() -> None:
    generator = MockDataGenerator()

    assert generator.generate_endpoint_validation_result() is True
    assert generator.generate_registration_result() is True
    assert generator.generate_notification_result() is True
    assert generator.generate_ownership_verification_result() is True


def test_generate_pre_validation_result_success_payload() -> None:
    generator = MockDataGenerator()

    result = generator.generate_pre_validation_result("AIC-001")

    assert result["success"] is True
    assert result["details"]["agent_id"] == "AIC-001"


def test_mock_delay_simulator_hits_selected_scenario(monkeypatch) -> None:
    monkeypatch.setattr(random, "random", lambda: 0.01)
    monkeypatch.setattr(random, "uniform", lambda _a, _b: 0.2)

    slept: list[float] = []
    monkeypatch.setattr(time, "sleep", lambda value: slept.append(value))

    delay = MockDelaySimulator.simulate_network_delay()

    assert delay == 0.2
    assert slept == [0.2]


def test_mock_delay_simulator_fallback_path(monkeypatch) -> None:
    values = iter([0.9, 0.9, 0.9, 0.9])
    monkeypatch.setattr(random, "random", lambda: next(values))
    monkeypatch.setattr(random, "uniform", lambda _a, _b: 0.15)

    slept: list[float] = []
    monkeypatch.setattr(time, "sleep", lambda value: slept.append(value))

    delay = MockDelaySimulator.simulate_network_delay()

    assert delay == 0.15
    assert slept == [0.15]


def test_mock_cache_get_set_and_invalidate(monkeypatch) -> None:
    cache = MockCacheSimulator(ttl_seconds=10)
    current_time = {"value": 100.0}

    monkeypatch.setattr(time, "time", lambda: current_time["value"])
    monkeypatch.setattr(time, "sleep", lambda _v: None)
    monkeypatch.setattr(random, "uniform", lambda _a, _b: 0.001)

    cache.set("k", {"x": 1})
    assert cache.get("k") == {"x": 1}

    cache.invalidate("k")
    assert cache.get("k") is None


def test_mock_cache_expires_value(monkeypatch) -> None:
    cache = MockCacheSimulator(ttl_seconds=5)
    clock = {"now": 100.0}

    monkeypatch.setattr(time, "time", lambda: clock["now"])
    monkeypatch.setattr(time, "sleep", lambda _v: None)
    monkeypatch.setattr(random, "uniform", lambda _a, _b: 0.001)

    cache.set("k", "v")
    clock["now"] = 106.0

    assert cache.get("k") is None


def test_generate_realistic_error_for_known_service(monkeypatch) -> None:
    monkeypatch.setattr(random, "choice", lambda seq: seq[0])
    monkeypatch.setattr(secrets, "token_hex", lambda _n: "deadbeef")

    result = generate_realistic_error("agent_registry", "validate")

    assert result["service"] == "agent_registry"
    assert result["operation"] == "validate"
    assert result["correlation_id"] == "deadbeef"
    # 确认时间字段可解析
    datetime.fromisoformat(result["timestamp"]).astimezone(UTC)


def test_generate_realistic_error_for_unknown_service() -> None:
    result = generate_realistic_error("unknown", "op")

    assert result["code"] == "UNKNOWN_ERROR"
    assert result["service"] == "unknown"
    assert result["operation"] == "op"
