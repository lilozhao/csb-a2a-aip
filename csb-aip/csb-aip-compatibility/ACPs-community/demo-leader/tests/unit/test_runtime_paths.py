from __future__ import annotations

from pathlib import Path

from leader import runtime_paths


def test_runtime_paths_default_to_package_layout(monkeypatch) -> None:
    monkeypatch.delenv(runtime_paths.RUNTIME_ROOT_ENV, raising=False)
    monkeypatch.delenv(runtime_paths.SCENARIO_ROOT_ENV, raising=False)
    monkeypatch.delenv(runtime_paths.WEB_APP_ROOT_ENV, raising=False)

    package_leader_dir = Path(runtime_paths.__file__).resolve().parent
    package_runtime_root = package_leader_dir.parent

    assert runtime_paths.resolve_runtime_root() == package_runtime_root
    assert runtime_paths.resolve_leader_dir() == package_leader_dir
    assert runtime_paths.resolve_config_path() == package_leader_dir / "config.toml"
    assert runtime_paths.resolve_project_env_file() == package_runtime_root / ".env"
    assert runtime_paths.resolve_web_app_root() == package_runtime_root / "web_app"


def test_runtime_paths_prefer_install_root_env(monkeypatch, tmp_path: Path) -> None:
    leader_dir = tmp_path / "leader"
    scenario_dir = leader_dir / "scenario"
    web_app_dir = tmp_path / "web_app"
    scenario_dir.mkdir(parents=True)
    web_app_dir.mkdir(parents=True)

    monkeypatch.setenv(runtime_paths.RUNTIME_ROOT_ENV, str(tmp_path))
    monkeypatch.delenv(runtime_paths.SCENARIO_ROOT_ENV, raising=False)
    monkeypatch.delenv(runtime_paths.WEB_APP_ROOT_ENV, raising=False)

    assert runtime_paths.resolve_runtime_root() == tmp_path
    assert runtime_paths.resolve_leader_dir() == leader_dir
    assert runtime_paths.resolve_config_path() == leader_dir / "config.toml"
    assert runtime_paths.resolve_acs_path("atr/acs.json") == leader_dir / "atr/acs.json"
    assert runtime_paths.resolve_scenario_root() == scenario_dir
    assert runtime_paths.resolve_web_app_root() == web_app_dir


def test_runtime_paths_allow_explicit_scenario_and_web_roots(
    monkeypatch,
    tmp_path: Path,
) -> None:
    scenario_root = tmp_path / "scenario-runtime"
    web_root = tmp_path / "frontend-runtime"
    scenario_root.mkdir()
    web_root.mkdir()

    monkeypatch.delenv(runtime_paths.RUNTIME_ROOT_ENV, raising=False)
    monkeypatch.setenv(runtime_paths.SCENARIO_ROOT_ENV, str(scenario_root))
    monkeypatch.setenv(runtime_paths.WEB_APP_ROOT_ENV, str(web_root))

    assert runtime_paths.resolve_scenario_root() == scenario_root
    assert runtime_paths.resolve_web_app_root() == web_root
