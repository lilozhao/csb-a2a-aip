from __future__ import annotations

import asyncio
import json
from pathlib import Path
from typing import TYPE_CHECKING, Any

from scripts import seed

if TYPE_CHECKING:
    import pytest


def _write_acs(path: Path, aic: str, *, skill_count: int = 1) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    skills = [
        {
            "id": f"skill-{index}",
            "description": f"描述 {index}",
        }
        for index in range(skill_count)
    ]
    path.write_text(json.dumps({"aic": aic, "skills": skills}), encoding="utf-8")


def test_resolve_seed_sources_defaults_to_partners(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    partner_dir = tmp_path / "partners"
    _write_acs(partner_dir / "beijing_food" / "acs.json", "aic-food")
    _write_acs(partner_dir / "china_hotel" / "acs.json", "aic-hotel")

    monkeypatch.setattr(seed, "PARTNER_SEED_DIR", partner_dir)
    monkeypatch.setattr(seed, "LEADER_SEED_PATH", tmp_path / "leader" / "acs.json")

    sources = seed.resolve_seed_sources()

    assert [source.kind for source in sources] == ["partner", "partner"]
    assert [source.name for source in sources] == ["beijing_food", "china_hotel"]


def test_resolve_seed_sources_can_include_leader(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> None:
    partner_dir = tmp_path / "partners"
    leader_path = tmp_path / "leader" / "acs.json"
    _write_acs(partner_dir / "beijing_food" / "acs.json", "aic-food")
    _write_acs(leader_path, "aic-leader", skill_count=0)

    monkeypatch.setattr(seed, "PARTNER_SEED_DIR", partner_dir)
    monkeypatch.setattr(seed, "LEADER_SEED_PATH", leader_path)

    sources = seed.resolve_seed_sources(include_leader=True)

    assert [source.kind for source in sources] == ["partner", "leader"]
    assert [source.name for source in sources] == ["beijing_food", "leader"]


def test_build_seed_summary_counts_skills() -> None:
    records: list[tuple[seed.SeedSource, dict[str, Any]]] = [
        (seed.SeedSource(kind="partner", name="a", path=Path("a.json")), {"aic": "aic-a", "skills": [{}, {}]}),
        (seed.SeedSource(kind="leader", name="leader", path=Path("l.json")), {"aic": "aic-l", "skills": []}),
    ]

    summary = seed.build_seed_summary(
        records,
        target="app",
        include_leader=True,
        dry_run=True,
        reset_applied=False,
    )

    assert summary.target == "app"
    assert summary.source_count == 2
    assert summary.imported_agents == 2
    assert summary.imported_skills == 2
    assert summary.include_leader is True
    assert summary.dry_run is True


def test_configure_target_environment_for_app_uses_database_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "APP_ENV=development\nDATABASE_URL=postgresql+asyncpg://dev:dev@localhost:5432/agent_discovery\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(seed, "ENV_FILE", env_file)
    monkeypatch.delenv("APP_ENV", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)

    context = seed.configure_target_environment("app")

    assert context.target == "app"
    assert context.app_env == "development"
    assert context.database_url.endswith("/agent_discovery")


def test_configure_target_environment_for_test_uses_test_database_url(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    env_file = tmp_path / ".env"
    env_file.write_text(
        "TEST_DATABASE_URL=postgresql+asyncpg://test:test@localhost:5432/agent_discovery_test\n",
        encoding="utf-8",
    )
    monkeypatch.setattr(seed, "ENV_FILE", env_file)
    monkeypatch.delenv("TEST_DATABASE_URL", raising=False)
    monkeypatch.delenv("DATABASE_URL", raising=False)
    monkeypatch.delenv("APP_ENV", raising=False)

    context = seed.configure_target_environment("test")

    assert context.target == "test"
    assert context.app_env == "testing"
    assert context.database_url.endswith("/agent_discovery_test")


def test_build_seed_envelopes_uses_seq_zero_and_upsert() -> None:
    records = [
        (
            seed.SeedSource(kind="partner", name="beijing_food", path=Path("food.json")),
            {"aic": "demo.partner", "skills": [{"id": "skill-1", "description": "desc"}]},
        )
    ]

    envelopes = seed.build_seed_envelopes(records)

    assert len(envelopes) == 1
    assert envelopes[0].id == "demo.partner"
    assert envelopes[0].seq == 0
    assert envelopes[0].version == 1
    assert envelopes[0].type == "acs"
    assert envelopes[0].payload["aic"] == "demo.partner"


def test_main_dry_run_skips_import(monkeypatch: pytest.MonkeyPatch) -> None:
    records = [
        (
            seed.SeedSource(kind="partner", name="beijing_food", path=Path("food.json")),
            {"aic": "demo.partner", "skills": [{"id": "skill-1", "description": "desc"}]},
        )
    ]
    import_called = False

    monkeypatch.setattr(seed, "build_seed_records", lambda include_leader=False: records)

    async def fake_import_seed_records(*args: Any, **kwargs: Any) -> seed.SeedSummary:
        nonlocal import_called
        del args, kwargs
        await asyncio.sleep(0)
        import_called = True
        return seed.build_seed_summary(records, target="app", include_leader=False, dry_run=False, reset_applied=False)

    monkeypatch.setattr(seed, "import_seed_records", fake_import_seed_records)

    exit_code = seed.main(["--dry-run"])

    assert exit_code == 0
    assert import_called is False
