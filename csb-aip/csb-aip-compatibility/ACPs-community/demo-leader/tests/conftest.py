"""
Leader tests 全局 fixture 和配置。

优先加载项目根目录 .env，使 integration/e2e 测试能够复用真实联调配置；
仅在变量仍缺失时才回退到占位值，避免 pytest 采集阶段触发 config.py 的 sys.exit()。
"""

import json
import os
import shutil
import socket
import ssl
import subprocess
import tempfile
import time
import tomllib
from collections.abc import Generator
from dataclasses import dataclass
from pathlib import Path

import httpx
import pytest
from dotenv import load_dotenv

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ENV_PATH = PROJECT_ROOT / ".env"
LEADER_ROOT = PROJECT_ROOT / "leader"
DEMO_PARTNER_ROOT = PROJECT_ROOT.parent / "demo-partner"
PARTNER_ONLINE_DIR = DEMO_PARTNER_ROOT / "partners" / "online"
PARTNER_PYTHON = DEMO_PARTNER_ROOT / ".venv" / "bin" / "python"
LEADER_CERT_FILE = LEADER_ROOT / "atr" / "client.pem"
LEADER_KEY_FILE = LEADER_ROOT / "atr" / "client.key"
LEADER_TRUST_BUNDLE = LEADER_ROOT / "atr" / "trust-bundle.pem"
TEST_CONNECT_HOST = "localhost"
TEST_BIND_HOST = "127.0.0.1"
PARTNER_STARTUP_TIMEOUT_SECONDS = 45.0

BEIJING_FOOD_ACS = "beijing_food.json"
BEIJING_RURAL_ACS = "beijing_rural.json"
BEIJING_URBAN_ACS = "beijing_urban.json"
CHINA_HOTEL_ACS = "china_hotel.json"
CHINA_TRANSPORT_ACS = "china_transport.json"

STATIC_TOUR_MAPPING = {
    "hotel": [CHINA_HOTEL_ACS],
    "food": [BEIJING_FOOD_ACS],
    "intercity_transport": [CHINA_TRANSPORT_ACS],
    "local_transport": [BEIJING_URBAN_ACS, BEIJING_RURAL_ACS],
    "attraction": [BEIJING_URBAN_ACS, BEIJING_RURAL_ACS],
}
ACS_FILE_BY_AGENT = {
    "beijing_food": BEIJING_FOOD_ACS,
    "beijing_rural": BEIJING_RURAL_ACS,
    "beijing_urban": BEIJING_URBAN_ACS,
    "china_hotel": CHINA_HOTEL_ACS,
    "china_transport": CHINA_TRANSPORT_ACS,
}

if ENV_PATH.exists():
    load_dotenv(ENV_PATH, override=False)

# 仅在本地 .env / 外部环境都未提供时使用占位值。
os.environ.setdefault("LEADER_LLM_FAST_API_KEY", "test-key")
os.environ.setdefault("LEADER_LLM_FAST_BASE_URL", "http://localhost:11434/v1")
os.environ.setdefault("LEADER_LLM_FAST_MODEL", "test-model")
os.environ.setdefault("LEADER_LLM_DEFAULT_API_KEY", "test-key")
os.environ.setdefault("LEADER_LLM_DEFAULT_BASE_URL", "http://localhost:11434/v1")
os.environ.setdefault("LEADER_LLM_DEFAULT_MODEL", "test-model")
os.environ.setdefault("LEADER_LLM_PRO_API_KEY", "test-key")
os.environ.setdefault("LEADER_LLM_PRO_BASE_URL", "http://localhost:11434/v1")
os.environ.setdefault("LEADER_LLM_PRO_MODEL", "test-model")


@dataclass(slots=True)
class DemoPartnerRuntime:
    """demo-partner 临时运行时信息。"""

    agent_urls: dict[str, str]
    scenario_root: Path
    client_ssl_context: ssl.SSLContext


@dataclass(slots=True)
class _PreparedPartnerRuntime:
    """Partner 临时目录与端口占位信息。"""

    runtime_root: Path
    online_dir: Path
    agent_urls: dict[str, str]
    reserved_sockets: list[socket.socket]


def _reserve_free_port() -> tuple[int, socket.socket]:
    reserved_socket = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    reserved_socket.bind((TEST_BIND_HOST, 0))
    reserved_socket.listen(1)
    port = reserved_socket.getsockname()[1]
    return port, reserved_socket


def _build_partner_client_ssl_context() -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=str(LEADER_TRUST_BUNDLE))
    context.load_cert_chain(certfile=str(LEADER_CERT_FILE), keyfile=str(LEADER_KEY_FILE))
    return context


def _rewrite_partner_server_port(config_path: Path, port: int) -> None:
    content = config_path.read_text(encoding="utf-8")
    updated_content = []
    replaced = False
    for line in content.splitlines():
        if not replaced and line.strip().startswith("port ="):
            updated_content.append(f"port = {port}")
            replaced = True
            continue
        updated_content.append(line)
    if not replaced:
        raise RuntimeError(f"无法在 {config_path} 中定位 server.port 配置")
    config_path.write_text("\n".join(updated_content) + "\n", encoding="utf-8")


def _discover_partner_urls(online_dir: Path) -> dict[str, str]:
    agent_urls: dict[str, str] = {}
    for entry in sorted(online_dir.iterdir(), key=lambda item: item.name):
        config_path = entry / "config.toml"
        if not entry.is_dir() or not config_path.is_file():
            continue

        with config_path.open("rb") as file_obj:
            config = tomllib.load(file_obj)

        port = config.get("server", {}).get("port")
        if not port:
            continue

        tls_enabled = config.get("server", {}).get("mtls", {}).get("tls_enabled", False)
        protocol = "https" if tls_enabled else "http"
        agent_urls[entry.name] = f"{protocol}://{TEST_CONNECT_HOST}:{port}"

    return agent_urls


def _prepare_temp_partner_runtime() -> _PreparedPartnerRuntime:
    runtime_root = Path(tempfile.mkdtemp(prefix="demo-leader-shared-partners-"))
    online_dir = runtime_root / "online"
    shutil.copytree(PARTNER_ONLINE_DIR, online_dir)

    reserved_sockets: list[socket.socket] = []
    for entry in sorted(online_dir.iterdir(), key=lambda item: item.name):
        if not entry.is_dir():
            continue

        config_path = entry / "config.toml"
        if not config_path.is_file():
            continue

        port, reserved_socket = _reserve_free_port()
        reserved_sockets.append(reserved_socket)
        _rewrite_partner_server_port(config_path, port)

    return _PreparedPartnerRuntime(
        runtime_root=runtime_root,
        online_dir=online_dir,
        agent_urls=_discover_partner_urls(online_dir),
        reserved_sockets=reserved_sockets,
    )


def _rewrite_static_mapping(domain_path: Path) -> None:
    content = domain_path.read_text(encoding="utf-8")
    replacement_lines = ["[partners.static_mapping]"]
    for dimension_id, acs_files in STATIC_TOUR_MAPPING.items():
        replacement_lines.append(f"{dimension_id} = {json.dumps(acs_files, ensure_ascii=False)}")

    lines = content.splitlines()
    start_index = next(
        (index for index, line in enumerate(lines) if line.strip() == "[partners.static_mapping]"),
        -1,
    )
    end_index = next(
        (
            index
            for index, line in enumerate(lines[start_index + 1 :], start=start_index + 1)
            if line.strip() == "[consistency]"
        ),
        -1,
    )
    if start_index == -1 or end_index == -1 or end_index <= start_index:
        raise RuntimeError(f"无法在 {domain_path} 中定位 [partners.static_mapping] 配置段")

    updated_lines = lines[:start_index] + replacement_lines + [""] + lines[end_index:]
    domain_path.write_text("\n".join(updated_lines) + "\n", encoding="utf-8")


def _rewrite_partner_acs_endpoint(acs_path: Path, rpc_url: str) -> None:
    with acs_path.open(encoding="utf-8") as file_obj:
        acs_data = json.load(file_obj)

    for endpoint in acs_data.get("endPoints", []):
        transport = str(endpoint.get("transport", "")).upper()
        url = str(endpoint.get("url", ""))
        if transport in {"HTTP", "JSONRPC"} and url.startswith(("http://", "https://")):
            endpoint["url"] = rpc_url

    acs_path.write_text(json.dumps(acs_data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _prepare_temp_scenario_root(partner_urls: dict[str, str]) -> Path:
    runtime_root = Path(tempfile.mkdtemp(prefix="demo-leader-shared-scenario-"))
    scenario_root = runtime_root / "scenario"
    shutil.copytree(LEADER_ROOT / "scenario", scenario_root)

    tour_root = scenario_root / "expert" / "tour"
    _rewrite_static_mapping(tour_root / "domain.toml")

    for agent_name, acs_filename in ACS_FILE_BY_AGENT.items():
        _rewrite_partner_acs_endpoint(tour_root / acs_filename, f"{partner_urls[agent_name]}/rpc")

    return scenario_root


def _wait_for_partner_ready(
    agent_urls: dict[str, str],
    process: subprocess.Popen[str],
    log_path: Path,
    ssl_context: ssl.SSLContext,
) -> None:
    deadline = time.monotonic() + PARTNER_STARTUP_TIMEOUT_SECONDS

    with httpx.Client(timeout=1.0, verify=ssl_context) as client:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise RuntimeError(log_path.read_text(encoding="utf-8", errors="replace"))

            all_ready = True
            for url in agent_urls.values():
                try:
                    response = client.get(f"{url}/health")
                    if response.status_code != 200:
                        all_ready = False
                        break
                except httpx.HTTPError, OSError:
                    all_ready = False
                    break

            if all_ready:
                return

            time.sleep(1.0)

    raise RuntimeError(
        f"Partner 临时实例启动超时（{PARTNER_STARTUP_TIMEOUT_SECONDS}s）\n\n"
        + log_path.read_text(encoding="utf-8", errors="replace")
    )


@pytest.fixture(scope="session")
def managed_partner_runtime() -> Generator[DemoPartnerRuntime]:
    """为 demo-leader API/integration 测试提供临时 HTTPS Partner runtime。"""
    ssl_context = _build_partner_client_ssl_context()
    prepared_runtime = _prepare_temp_partner_runtime()
    scenario_root: Path | None = None
    process: subprocess.Popen[str] | None = None
    log_path: Path | None = None

    try:
        file_descriptor, log_path_str = tempfile.mkstemp(prefix="demo-leader-shared-partners-", suffix=".log")
        os.close(file_descriptor)
        log_path = Path(log_path_str)

        env = os.environ.copy()
        env["PARTNERS_ONLINE_DIR"] = str(prepared_runtime.online_dir)

        with log_path.open("w+", encoding="utf-8") as log_file:
            process = subprocess.Popen(  # noqa: S603
                [str(PARTNER_PYTHON), "-m", "partners.main"],
                cwd=DEMO_PARTNER_ROOT,
                env=env,
                stdout=log_file,
                stderr=subprocess.STDOUT,
                text=True,
            )

        for reserved_socket in prepared_runtime.reserved_sockets:
            reserved_socket.close()
        prepared_runtime.reserved_sockets.clear()

        _wait_for_partner_ready(prepared_runtime.agent_urls, process, log_path, ssl_context)
        scenario_root = _prepare_temp_scenario_root(prepared_runtime.agent_urls)

        yield DemoPartnerRuntime(
            agent_urls=prepared_runtime.agent_urls,
            scenario_root=scenario_root,
            client_ssl_context=ssl_context,
        )
    finally:
        if process and process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=10)

        for reserved_socket in prepared_runtime.reserved_sockets:
            reserved_socket.close()

        if log_path:
            log_path.unlink(missing_ok=True)
        shutil.rmtree(prepared_runtime.runtime_root, ignore_errors=True)
        if scenario_root is not None:
            shutil.rmtree(scenario_root.parent, ignore_errors=True)
