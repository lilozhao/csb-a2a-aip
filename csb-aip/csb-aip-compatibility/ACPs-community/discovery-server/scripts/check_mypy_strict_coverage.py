from __future__ import annotations

import tomllib
from pathlib import Path
from typing import Any

import click

REPO_ROOT = Path(__file__).resolve().parents[1]
PYPROJECT_PATH = REPO_ROOT / "pyproject.toml"
STRICT_COVERAGE_ROOTS = ("app", "tests", "scripts")
STRICT_COVERAGE_TOP_LEVEL_FILES = ("main.py",)


def _normalize_module_names(module_value: Any) -> set[str]:
    if isinstance(module_value, str):
        return {module_value}
    if isinstance(module_value, list):
        return {item for item in module_value if isinstance(item, str)}
    return set()


def load_mypy_strict_config(pyproject_path: Path) -> tuple[bool, set[str]]:
    with pyproject_path.open("rb") as file_obj:
        pyproject = tomllib.load(file_obj)

    mypy_config = pyproject.get("tool", {}).get("mypy", {})
    overrides = mypy_config.get("overrides", [])
    strict_modules: set[str] = set()
    global_strict = mypy_config.get("strict") is True

    for override in overrides:
        if not isinstance(override, dict) or override.get("strict") is not True:
            continue

        strict_modules.update(_normalize_module_names(override.get("module")))

    filtered_modules = {
        module_name
        for module_name in strict_modules
        if module_name == "app"
        or module_name == "main"
        or module_name == "scripts"
        or module_name.startswith("app.")
        or module_name.startswith("tests.")
        or module_name.startswith("scripts.")
    }
    return global_strict, filtered_modules


def _path_to_module(file_path: Path) -> str:
    relative_path = file_path.relative_to(REPO_ROOT).with_suffix("")
    parts = list(relative_path.parts)
    if parts[-1] == "__init__":
        parts = parts[:-1]
    return ".".join(parts)


def collect_expected_modules() -> set[str]:
    expected_modules: set[str] = set()

    for root_name in STRICT_COVERAGE_ROOTS:
        root_path = REPO_ROOT / root_name
        for file_path in root_path.rglob("*.py"):
            if "__pycache__" in file_path.parts:
                continue
            expected_modules.add(_path_to_module(file_path))

    for file_name in STRICT_COVERAGE_TOP_LEVEL_FILES:
        file_path = REPO_ROOT / file_name
        if file_path.is_file():
            expected_modules.add(_path_to_module(file_path))

    return expected_modules


def build_report() -> tuple[list[str], list[str]]:
    expected_modules = collect_expected_modules()
    global_strict, strict_modules = load_mypy_strict_config(PYPROJECT_PATH)

    if global_strict:
        missing_modules: list[str] = []
        stale_modules = sorted(strict_modules)
        return missing_modules, stale_modules

    missing_modules = sorted(expected_modules - strict_modules)
    stale_modules = sorted(strict_modules - expected_modules)
    return missing_modules, stale_modules


def main() -> int:
    missing_modules, stale_modules = build_report()

    if not missing_modules and not stale_modules:
        click.echo("mypy strict coverage is in sync with app/, tests/, scripts/, and guarded top-level files")
        return 0

    if missing_modules:
        click.echo("Missing mypy strict override entries:")
        for module_name in missing_modules:
            click.echo(f"  - {module_name}")

    if stale_modules:
        click.echo("Stale mypy strict override entries:")
        for module_name in stale_modules:
            click.echo(f"  - {module_name}")

    return 1


if __name__ == "__main__":
    raise SystemExit(main())
