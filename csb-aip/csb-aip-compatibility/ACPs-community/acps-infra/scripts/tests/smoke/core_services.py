"""核心服务 happy path 冒烟测试。

覆盖以下主链路：

1. registry + ca: 用户登录、Agent 保存、提交审核、管理员审批、EAB 获取、证书签发
2. discovery: demo ACS 注册审批、DSP 同步、discover query 命中目标 Agent

测试逻辑基于 acps-cli/tests/e2e 中的 happy path 用例裁剪，保持为“已部署系统上的业务烟测”，
因此默认直接调用 sibling 项目的 acps-cli，而不复用 pytest fixture 的本地服务托管逻辑。
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

GATEWAY_PUBLIC_HOST = (
    os.environ.get("GATEWAY_PUBLIC_HOST", "localhost").strip() or "localhost"
)
STAGE_NGINX_PORT = os.environ.get("STAGE_NGINX_PORT", "9000").strip() or "9000"
DEFAULT_GATEWAY_BASE_URL = f"http://{GATEWAY_PUBLIC_HOST}:{STAGE_NGINX_PORT}"
GATEWAY_BASE_URL = os.environ.get("GATEWAY_BASE_URL", DEFAULT_GATEWAY_BASE_URL).rstrip(
    "/"
)
REGISTRY_URL = os.environ.get("REGISTRY_URL", f"{GATEWAY_BASE_URL}/registry").rstrip(
    "/"
)
CA_URL = os.environ.get("CA_URL", f"{GATEWAY_BASE_URL}/ca-server").rstrip("/")
DISCO_URL = os.environ.get("DISCO_URL", f"{GATEWAY_BASE_URL}/discovery").rstrip("/")
REGISTRY_MTLS_URL = os.environ.get("REGISTRY_MTLS_URL", "").rstrip("/")
REGISTRY_MTLS_CA_FILE = os.environ.get("REGISTRY_MTLS_CA_FILE", "").strip()
REGISTRY_ADMIN_USERNAME = os.environ.get("REGISTRY_ADMIN_USERNAME", "admin")
REGISTRY_ADMIN_PASSWORD = os.environ.get("REGISTRY_ADMIN_PASSWORD", "admin123")
CA_SERVER_ADMIN_API_TOKEN = os.environ.get(
    "CA_SERVER_ADMIN_API_TOKEN", "test-ca-admin-token"
)
DISCOVERY_QUERY_POLL_INTERVAL = float(
    os.environ.get("DISCOVERY_QUERY_POLL_INTERVAL", "3")
)
DISCOVERY_QUERY_POLL_TIMEOUT = int(os.environ.get("DISCOVERY_QUERY_POLL_TIMEOUT", "90"))
DISCOVERY_SYNC_REQUEST_TIMEOUT = int(
    os.environ.get("DISCOVERY_SYNC_REQUEST_TIMEOUT", "120")
)
DISCOVERY_SYNC_WAIT_TIMEOUT = int(os.environ.get("DISCOVERY_SYNC_WAIT_TIMEOUT", "180"))
DISCOVERY_SYNC_WAIT_INTERVAL = float(
    os.environ.get("DISCOVERY_SYNC_WAIT_INTERVAL", "5")
)

WORKSPACE_ROOT = Path(__file__).resolve().parents[4]
ACPS_CLI_PROJECT_DIR = Path(
    os.environ.get("ACPS_CLI_PROJECT_DIR") or WORKSPACE_ROOT / "acps-cli"
)
DISCOVERY_TEMPLATE_CANDIDATES = (
    WORKSPACE_ROOT / "demo-partner/partners/online/beijing_food/acs.json",
    WORKSPACE_ROOT / "runtime/demo/partners/partners/online/beijing_food/acs.json",
)
TEXT_PLAIN_MODE = "text/plain"
BEIJING_TIMEZONE = timezone(timedelta(hours=8))


class SmokeFailure(Exception):
    """核心服务冒烟失败。"""


def log(message: str) -> None:
    print(f"[smoke-test-core-services] {message}", flush=True)


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise SmokeFailure(message)


def resolve_discovery_template_path() -> Path:
    for candidate in DISCOVERY_TEMPLATE_CANDIDATES:
        if candidate.exists():
            return candidate

    raise SmokeFailure(
        "缺少 discovery demo ACS 模板，已检查: "
        + ", ".join(str(candidate) for candidate in DISCOVERY_TEMPLATE_CANDIDATES)
    )


def resolve_cli_command() -> list[str]:
    explicit_bin = os.environ.get("ACPS_CLI_BIN", "").strip()
    if explicit_bin:
        cli_path = shutil.which(explicit_bin) or explicit_bin
        ensure(Path(cli_path).exists(), f"ACPS_CLI_BIN 不存在: {explicit_bin}")
        return [str(cli_path)]

    local_cli = ACPS_CLI_PROJECT_DIR / ".venv/bin/acps-cli"
    if local_cli.exists():
        return [str(local_cli)]

    uv_bin = shutil.which("uv")
    if uv_bin is not None and ACPS_CLI_PROJECT_DIR.exists():
        return [uv_bin, "run", "--project", str(ACPS_CLI_PROJECT_DIR), "acps-cli"]

    raise SmokeFailure(
        "未找到可用的 acps-cli。请先准备 acps-cli/.venv，或设置 ACPS_CLI_BIN，或安装 uv。"
    )


CLI_COMMAND = resolve_cli_command()


def run_command(
    command: list[str], *, timeout: int = 180
) -> subprocess.CompletedProcess[str]:
    result = subprocess.run(  # noqa: S603
        command,
        cwd=str(ACPS_CLI_PROJECT_DIR if "uv" in Path(command[0]).name else Path.cwd()),
        capture_output=True,
        text=True,
        timeout=timeout,
        check=False,
    )
    return result


def run_cli(*args: str, timeout: int = 180) -> subprocess.CompletedProcess[str]:
    command = [*CLI_COMMAND, *args]
    result = run_command(command, timeout=timeout)
    if result.returncode != 0:
        raise SmokeFailure(
            "acps-cli 执行失败:\n"
            f"command: {shlex.join(command)}\n"
            f"exit_code: {result.returncode}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    return result


def run_cli_json(*args: str, timeout: int = 180) -> dict[str, object]:
    result = run_cli(*args, timeout=timeout)
    try:
        payload = json.loads(result.stdout)
    except json.JSONDecodeError as exc:
        raise SmokeFailure(
            "acps-cli 输出不是合法 JSON:\n"
            f"command: {shlex.join([*CLI_COMMAND, *args])}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        ) from exc
    ensure(isinstance(payload, dict), f"命令返回结果不是 JSON object: {payload}")
    return payload


def request_json(
    method: str, url: str, *, timeout: int = 30
) -> tuple[int, dict[str, object] | None, str]:
    request = urllib.request.Request(
        url,
        headers={"Accept": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read().decode("utf-8")
            parsed = json.loads(raw) if raw else None
            if parsed is not None:
                ensure(isinstance(parsed, dict), f"响应不是 JSON object: {raw}")
            return response.status, parsed, raw
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8")
        parsed: dict[str, object] | None = None
        if raw:
            try:
                decoded = json.loads(raw)
            except json.JSONDecodeError:
                decoded = None
            if decoded is not None:
                ensure(isinstance(decoded, dict), f"响应不是 JSON object: {raw}")
                parsed = decoded
        return exc.code, parsed, raw
    except urllib.error.URLError as exc:
        raise SmokeFailure(f"请求失败: {method} {url}: {exc}") from exc


def write_cli_config(work_dir: Path) -> Path:
    config_path = work_dir / "acps-cli.toml"
    user_token_path = work_dir / ".acps-cli/tokens/registry-user.json"
    admin_token_path = work_dir / ".acps-cli/tokens/registry-admin.json"
    user_token_path.parent.mkdir(parents=True, exist_ok=True)
    keyfiles_dir = work_dir / "keyfiles"
    (keyfiles_dir / "accounts").mkdir(parents=True, exist_ok=True)
    (keyfiles_dir / "private").mkdir(parents=True, exist_ok=True)
    (keyfiles_dir / "certs").mkdir(parents=True, exist_ok=True)
    (keyfiles_dir / "csr").mkdir(parents=True, exist_ok=True)

    lines = [
        "[registry]",
        f'base_url = "{REGISTRY_URL}"',
    ]
    if REGISTRY_MTLS_URL:
        lines.append(f'mtls_base_url = "{REGISTRY_MTLS_URL}"')
    if REGISTRY_MTLS_CA_FILE:
        lines.append(f'mtls_server_ca_file = "{REGISTRY_MTLS_CA_FILE}"')

    lines.extend(
        [
            "",
            "[auth]",
            f'user_token_file = "{user_token_path}"',
            f'admin_token_file = "{admin_token_path}"',
            "",
            "[ca]",
            f'base_url = "{CA_URL}"',
            f'admin_api_token = "{CA_SERVER_ADMIN_API_TOKEN}"',
            f'account_keys_dir = "{keyfiles_dir / "accounts"}"',
            f'private_keys_dir = "{keyfiles_dir / "private"}"',
            f'certs_dir = "{keyfiles_dir / "certs"}"',
            f'csr_dir = "{keyfiles_dir / "csr"}"',
            f'trust_bundle_path = "{keyfiles_dir / "trust-bundle.pem"}"',
            "",
            "[discovery]",
            f'base_url = "{DISCO_URL}"',
        ]
    )
    config_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return config_path


def make_ontology_acs_file(work_dir: Path) -> tuple[Path, str, str]:
    suffix = uuid.uuid4().hex[:6]
    agent_name = f"system-smoke-agent-{suffix}"
    unique_marker = f"system-smoke-{suffix}"
    now = datetime.now(BEIJING_TIMEZONE).isoformat()
    acs = {
        "aic": "",
        "active": False,
        "lastModifiedTime": now,
        "protocolVersion": "02.01",
        "name": agent_name,
        "version": "1.0.0",
        "description": f"system smoke ontology agent {unique_marker}",
        "provider": {
            "organization": "System Smoke",
            "url": "https://example.org/system-smoke",
            "license": "TEST-LICENSE",
        },
        "securitySchemes": {
            "mtls": {
                "type": "mutualTLS",
                "description": "Agent 间 mTLS 双向认证",
            }
        },
        "endPoints": [
            {
                "url": "https://localhost:9000/rpc",
                "transport": "JSONRPC",
                "security": [{"mtls": []}],
            }
        ],
        "capabilities": {"streaming": False, "notification": False, "messageQueue": []},
        "defaultInputModes": [TEXT_PLAIN_MODE],
        "defaultOutputModes": [TEXT_PLAIN_MODE],
        "skills": [
            {
                "id": f"{agent_name}.skill",
                "name": "System Smoke Skill",
                "description": f"system smoke skill {unique_marker}",
                "version": "1.0.0",
                "tags": ["system-smoke", unique_marker],
                "examples": [unique_marker],
                "inputModes": [TEXT_PLAIN_MODE],
                "outputModes": [TEXT_PLAIN_MODE],
            }
        ],
    }
    acs_path = work_dir / f"ontology-{agent_name}.json"
    acs_path.write_text(json.dumps(acs, ensure_ascii=False, indent=2), encoding="utf-8")
    return acs_path, agent_name, unique_marker


def make_discovery_demo_acs_file(work_dir: Path) -> tuple[Path, str]:
    template_path = resolve_discovery_template_path()
    ensure(
        template_path.exists(),
        f"缺少 discovery demo ACS 模板: {template_path}",
    )
    payload = json.loads(template_path.read_text(encoding="utf-8"))
    suffix = uuid.uuid4().hex[:6]
    unique_marker = f"system-smoke-discovery-{suffix}"
    payload["aic"] = ""
    payload["active"] = False
    payload["lastModifiedTime"] = datetime.now(BEIJING_TIMEZONE).isoformat()
    payload["name"] = f"{payload['name']}-{suffix}"
    payload["description"] = f"{payload['description']} 唯一测试标识：{unique_marker}。"

    skills = payload.get("skills") or []
    if skills:
        first_skill = skills[0]
        tags = list(first_skill.get("tags") or [])
        if unique_marker not in tags:
            tags.append(unique_marker)
        first_skill["tags"] = tags
        examples = list(first_skill.get("examples") or [])
        examples.append(unique_marker)
        first_skill["examples"] = examples

    acs_path = work_dir / f"discovery-demo-{suffix}.json"
    acs_path.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return acs_path, str(payload["name"])


def login_user(config_path: Path, username: str, password: str) -> None:
    payload = run_cli_json(
        "--config",
        str(config_path),
        "auth",
        "login",
        "--username",
        username,
        "--password",
        password,
        "--json",
    )
    status = payload.get("status")
    ensure(status in {"registered", "logged-in"}, f"用户登录结果异常: {payload}")


def login_admin(config_path: Path) -> None:
    run_cli_json(
        "--config",
        str(config_path),
        "admin",
        "auth",
        "login",
        "--username",
        REGISTRY_ADMIN_USERNAME,
        "--password",
        REGISTRY_ADMIN_PASSWORD,
        "--json",
    )


def save_submit_approve_agent(
    config_path: Path, acs_path: Path, *, ontology: bool
) -> tuple[str, str]:
    save_args = [
        "--config",
        str(config_path),
        "agent",
        "save",
        "--acs-file",
        str(acs_path),
        "--json",
    ]
    if ontology:
        save_args.insert(-1, "--ontology")

    save_payload = run_cli_json(*save_args)
    agent_id = str(save_payload.get("agent_id") or "")
    ensure(agent_id, f"agent save 未返回 agent_id: {save_payload}")

    submit_payload = run_cli_json(
        "--config",
        str(config_path),
        "agent",
        "submit",
        "--agent-id",
        agent_id,
        "--json",
    )
    ensure(
        str(submit_payload.get("approval_status", "")).upper() == "PENDING",
        f"agent submit 结果异常: {submit_payload}",
    )

    approve_payload = run_cli_json(
        "--config",
        str(config_path),
        "admin",
        "registry",
        "review",
        "approve",
        "--agent-id",
        agent_id,
        "--json",
    )
    ensure(
        str(approve_payload.get("approval_status", "")).upper() == "APPROVED",
        f"agent approve 结果异常: {approve_payload}",
    )
    aic = str(approve_payload.get("aic") or "")
    ensure(aic, f"审批结果未返回 AIC: {approve_payload}")
    return agent_id, aic


def sync_agent_acs(config_path: Path, acs_path: Path) -> None:
    run_cli_json(
        "--config",
        str(config_path),
        "agent",
        "sync",
        "--acs-file",
        str(acs_path),
        "--json",
    )


def delete_agent_by_acs(config_path: Path, acs_path: Path) -> None:
    run_cli_json(
        "--config",
        str(config_path),
        "agent",
        "delete",
        "--acs-file",
        str(acs_path),
        "--json",
    )


def issue_certificate(config_path: Path, work_dir: Path, aic: str) -> Path:
    eab_path = work_dir / "eab.json"
    run_cli_json(
        "--config",
        str(config_path),
        "cert",
        "eab",
        "fetch",
        "--aic",
        aic,
        "--output",
        str(eab_path),
        "--json",
    )
    ensure(eab_path.exists(), f"EAB 文件未生成: {eab_path}")

    run_cli(
        "--config",
        str(config_path),
        "cert",
        "issue",
        "--aic",
        aic,
        "--eab-file",
        str(eab_path),
        "--usage",
        "clientAuth",
        timeout=300,
    )

    cert_path = work_dir / "keyfiles/certs" / f"{aic}.pem"
    ensure(cert_path.exists(), f"证书文件未生成: {cert_path}")
    return cert_path


def verify_certificate(aic: str, cert_path: Path) -> None:
    openssl_bin = shutil.which("openssl")
    if openssl_bin is None:
        log("未找到 openssl，跳过证书内容校验，仅检查文件生成")
        return

    result = run_command(
        [openssl_bin, "x509", "-in", str(cert_path), "-noout", "-subject", "-issuer"],
        timeout=30,
    )
    ensure(result.returncode == 0, f"openssl 校验证书失败: {result.stderr}")
    ensure(
        aic in result.stdout,
        f"证书 subject/issuer 未包含 AIC: {aic} -> {result.stdout}",
    )


def run_discovery_sync(config_path: Path) -> None:
    del config_path

    status, _parsed, raw = request_json(
        "POST",
        f"{DISCO_URL}/admin/dsp/hard-reset",
        timeout=30,
    )
    ensure(status == 200, f"discovery hard-reset 失败: {status} {raw}")

    status, _parsed, raw = request_json(
        "POST",
        f"{DISCO_URL}/admin/dsp/sync",
        timeout=DISCOVERY_SYNC_REQUEST_TIMEOUT,
    )
    ensure(
        status in {200, 504},
        f"discovery run-sync 失败: {status} {raw}",
    )

    deadline = time.time() + DISCOVERY_SYNC_WAIT_TIMEOUT
    last_raw = raw
    while time.time() < deadline:
        status, parsed, raw = request_json(
            "GET",
            f"{DISCO_URL}/admin/dsp/status",
            timeout=30,
        )
        ensure(
            status == 200 and isinstance(parsed, dict),
            f"discovery status 失败: {status} {raw}",
        )
        counts = parsed.get("object_count_by_type") or {}
        ensure(
            isinstance(counts, dict),
            f"discovery status object_count_by_type 非法: {parsed}",
        )
        last_raw = raw
        if (
            parsed.get("needs_snapshot") is False
            and parsed.get("last_sync_time")
            and int(counts.get("acs") or 0) >= 1
        ):
            return
        time.sleep(DISCOVERY_SYNC_WAIT_INTERVAL)

    raise SmokeFailure(
        "discovery run-sync 轮询超时: "
        f"timeout={DISCOVERY_SYNC_WAIT_TIMEOUT}s, last_status={last_raw}"
    )


def query_discovery_until_hit(
    config_path: Path, query_text: str, expected_aic: str
) -> None:
    deadline = time.time() + DISCOVERY_QUERY_POLL_TIMEOUT
    last_payload: dict[str, object] | None = None

    while time.time() < deadline:
        payload = run_cli_json(
            "--config",
            str(config_path),
            "discover",
            "query",
            query_text,
            "--limit",
            "5",
            timeout=180,
        )
        last_payload = payload
        result = payload.get("result")
        if isinstance(result, dict):
            acs_map = result.get("acsMap") or {}
            if isinstance(acs_map, dict) and expected_aic in acs_map:
                return
        time.sleep(DISCOVERY_QUERY_POLL_INTERVAL)

    raise SmokeFailure(
        f"discovery query 在超时前未命中目标 AIC: query={query_text}, aic={expected_aic}, payload={last_payload}"
    )


def run_registry_ca_happy_path(config_path: Path, work_dir: Path) -> None:
    username = f"system_smoke_{uuid.uuid4().hex[:8]}"
    password = "Test@12345"
    login_user(config_path, username, password)
    login_admin(config_path)

    ontology_acs_path, agent_name, _ = make_ontology_acs_file(work_dir)
    primary_error: SmokeFailure | None = None
    cleanup_error: SmokeFailure | None = None
    aic = ""

    try:
        _agent_id, aic = save_submit_approve_agent(
            config_path, ontology_acs_path, ontology=True
        )
        cert_path = issue_certificate(config_path, work_dir, aic)
        verify_certificate(aic, cert_path)
    except SmokeFailure as exc:
        primary_error = exc

    try:
        delete_agent_by_acs(config_path, ontology_acs_path)
    except SmokeFailure as exc:
        cleanup_error = exc

    if primary_error is not None:
        if cleanup_error is not None:
            raise SmokeFailure(
                f"{primary_error}; registry+ca smoke cleanup 失败: {cleanup_error}"
            ) from primary_error
        raise primary_error

    if cleanup_error is not None:
        raise SmokeFailure(
            f"registry+ca smoke cleanup 失败: {cleanup_error}"
        ) from cleanup_error

    log(f"registry+ca happy path 通过: agent={agent_name}, aic={aic}")


def run_discovery_happy_path(config_path: Path, work_dir: Path) -> None:
    discovery_acs_path, query_text = make_discovery_demo_acs_file(work_dir)
    primary_error: SmokeFailure | None = None
    cleanup_error: SmokeFailure | None = None
    aic = ""

    try:
        _agent_id, aic = save_submit_approve_agent(
            config_path, discovery_acs_path, ontology=False
        )
        sync_agent_acs(config_path, discovery_acs_path)
        run_discovery_sync(config_path)
        query_discovery_until_hit(config_path, query_text, aic)
    except SmokeFailure as exc:
        primary_error = exc

    try:
        delete_agent_by_acs(config_path, discovery_acs_path)
        run_discovery_sync(config_path)
    except SmokeFailure as exc:
        cleanup_error = exc

    if primary_error is not None:
        if cleanup_error is not None:
            raise SmokeFailure(
                f"{primary_error}; discovery smoke cleanup 失败: {cleanup_error}"
            ) from primary_error
        raise primary_error

    if cleanup_error is not None:
        raise SmokeFailure(
            f"discovery smoke cleanup 失败: {cleanup_error}"
        ) from cleanup_error

    log(f"discovery happy path 通过: query={query_text}, aic={aic}")


def main() -> int:
    log(f"registry url: {REGISTRY_URL}")
    log(f"ca url: {CA_URL}")
    log(f"discovery url: {DISCO_URL}")
    with tempfile.TemporaryDirectory(prefix="acps-infra-system-smoke-") as temp_dir:
        work_dir = Path(temp_dir)
        config_path = write_cli_config(work_dir)
        try:
            run_registry_ca_happy_path(config_path, work_dir)
            run_discovery_happy_path(config_path, work_dir)
        except SmokeFailure as exc:
            log(f"FAIL: {exc}")
            return 1

    log("OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
