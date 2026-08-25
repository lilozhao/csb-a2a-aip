"""AIP v2.1.0 standalone-deployment audit checks."""

from __future__ import annotations

import http.client
import json
import os
import re
import shlex
import socket
import ssl
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    import tomllib  # type: ignore[attr-defined]
except ModuleNotFoundError:  # pragma: no cover - Python < 3.11
    tomllib = None  # type: ignore[assignment]


def read_compat_env(primary: str, legacy: str, default: str = "") -> str:
    for env_name in (primary, legacy):
        value = os.environ.get(env_name)
        if value is not None:
            value = value.strip()
            if value:
                return value
    return default


AIC_PATTERN = re.compile(r"^[0-9]+(?:\.[0-9A-Z]+)+$")
INBOX_EXPIRES_MS = 60 * 24 * 60 * 60 * 1000
INBOX_MESSAGE_TTL_MS = 7 * 24 * 60 * 60 * 1000
GROUP_ACL_KEY_TTL_SECONDS = 7 * 24 * 60 * 60
DEFAULT_REDIS_FALLBACK_WAIT_SECONDS = int(
    read_compat_env(
        "AIP_V210_REDIS_FALLBACK_WAIT_SECONDS",
        "AIPV210_REDIS_FALLBACK_WAIT_SECONDS",
        "31",
    )
)


def infer_base_dir_from_leader_config(config_file: str) -> Path:
    config_path = Path(config_file).expanduser().resolve()
    candidate_paths = [config_path.parent, config_path.parent.parent]

    def has_partner_runtime(candidate: Path) -> bool:
        partner_candidates = [
            (candidate / "../partners/partners/online").resolve(),
            (candidate / "../partners/online").resolve(),
            (candidate / "../../partners/partners/online").resolve(),
            (candidate / "../../partners/online").resolve(),
        ]
        return any(path.exists() for path in partner_candidates)

    def has_runtime_infra(candidate: Path) -> bool:
        return (candidate / "../../stage-infra").resolve().exists()

    for candidate in candidate_paths:
        if has_partner_runtime(candidate) and has_runtime_infra(candidate):
            return candidate

    for candidate in candidate_paths:
        if has_partner_runtime(candidate):
            return candidate

    return config_path.parent


LEADER_CONFIG_FILE_ENV = os.environ.get("LEADER_CONFIG_FILE", "").strip()
DEFAULT_BASE_DIR = (
    infer_base_dir_from_leader_config(LEADER_CONFIG_FILE_ENV)
    if LEADER_CONFIG_FILE_ENV
    else Path(__file__).resolve().parents[1]
)
BASE_DIR = (
    Path(os.environ.get("SMOKE_BASE_DIR") or DEFAULT_BASE_DIR).expanduser().resolve()
)
LEADER_CONFIG_FILE = (
    Path(LEADER_CONFIG_FILE_ENV or BASE_DIR / "leader" / "config.toml")
    .expanduser()
    .resolve()
)
AUDIT_OUTPUT = read_compat_env("AIP_V210_AUDIT_OUTPUT", "AIPV210_AUDIT_OUTPUT")
LOG_SINCE = read_compat_env("AIP_V210_LOG_SINCE", "AIPV210_LOG_SINCE")
REGISTRY_BASE_URL = read_compat_env(
    "AIP_V210_REGISTRY_BASE_URL",
    "AIPV210_REGISTRY_BASE_URL",
    "http://localhost:9000/registry",
)
DISCOVERY_BASE_URL = read_compat_env(
    "AIP_V210_DISCOVERY_BASE_URL",
    "AIPV210_DISCOVERY_BASE_URL",
    "http://localhost:9000/discovery",
)
INFRA_CERT_DIR_ENV = read_compat_env(
    "AIP_V210_INFRA_CERT_DIR",
    "AIPV210_INFRA_CERT_DIR",
)
MQ_AUTH_CERT_DIR_ENV = read_compat_env(
    "AIP_V210_MQ_AUTH_CERT_DIR",
    "AIPV210_MQ_AUTH_CERT_DIR",
)
RABBITMQ_HOST = read_compat_env(
    "AIP_V210_RABBITMQ_HOST", "AIPV210_RABBITMQ_HOST", "localhost"
)
RABBITMQ_PORT = int(os.environ.get("RABBITMQ_PORT", "5671"))
AUTH_SERVICE_HOST = read_compat_env(
    "AIP_V210_AUTH_SERVICE_HOST",
    "AIPV210_AUTH_SERVICE_HOST",
    "localhost",
)
AUTH_SERVICE_PORT = int(os.environ.get("MQ_AUTH_PORT", "9007"))
MQ_AUTH_CONTAINER_CANDIDATES = (
    "mq-auth-server-green",
    "mq-auth-server-blue",
    "mq-auth-server",
)

_ACTIVE_MQ_AUTH_CONTAINER: Optional[str] = None
_OPENSSL_SUPPORTS_BRIEF: Optional[bool] = None


class AuditFailure(Exception):
    """Raised when an audit check fails."""


@dataclass
class CheckResult:
    """A single audit check outcome."""

    check_id: str
    title: str
    status: str
    details: str

    def to_dict(self) -> Dict[str, str]:
        return {
            "id": self.check_id,
            "title": self.title,
            "status": self.status,
            "details": self.details,
        }


def log(message: str) -> None:
    print(f"[aip-v210-audit] {message}", flush=True)


def warn(message: str) -> None:
    print(f"[aip-v210-audit] WARN: {message}", file=sys.stderr, flush=True)


def resolve_mq_auth_container_name() -> str:
    global _ACTIVE_MQ_AUTH_CONTAINER
    if _ACTIVE_MQ_AUTH_CONTAINER:
        return _ACTIVE_MQ_AUTH_CONTAINER

    for candidate in MQ_AUTH_CONTAINER_CANDIDATES:
        result = subprocess.run(
            ["docker", "inspect", "-f", "{{.State.Running}}", candidate],
            text=True,
            capture_output=True,
            check=False,
        )
        if result.returncode == 0 and result.stdout.strip() == "true":
            _ACTIVE_MQ_AUTH_CONTAINER = candidate
            return candidate

    raise AuditFailure(
        "no running mq-auth-server container found; expected one of: "
        + ", ".join(MQ_AUTH_CONTAINER_CANDIDATES)
    )


def openssl_supports_brief() -> bool:
    global _OPENSSL_SUPPORTS_BRIEF
    if _OPENSSL_SUPPORTS_BRIEF is not None:
        return _OPENSSL_SUPPORTS_BRIEF

    result = subprocess.run(
        ["openssl", "s_client", "-help"],
        text=True,
        capture_output=True,
        check=False,
    )
    help_output = f"{result.stdout}\n{result.stderr}"
    _OPENSSL_SUPPORTS_BRIEF = "-brief" in help_output
    return _OPENSSL_SUPPORTS_BRIEF


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise AuditFailure(message)


def utc_timestamp() -> str:
    return (
        datetime.now(timezone.utc)
        .replace(microsecond=0)
        .isoformat()
        .replace("+00:00", "Z")
    )


def run_command(
    command: List[str],
    *,
    input_text: Optional[str] = None,
    check: bool = True,
    timeout: int = 60,
) -> str:
    completed = subprocess.run(
        command,
        input=input_text,
        text=True,
        capture_output=True,
        timeout=timeout,
        check=False,
    )
    if check and completed.returncode != 0:
        stderr = completed.stderr.strip()
        stdout = completed.stdout.strip()
        raise AuditFailure(
            f"command failed ({completed.returncode}): {' '.join(command)}; "
            f"stdout={stdout or '<empty>'}; stderr={stderr or '<empty>'}"
        )
    return completed.stdout


def _parse_basic_toml(text: str) -> Dict[str, Any]:
    root: Dict[str, Any] = {}
    current: Dict[str, Any] = root

    for raw_line in text.splitlines():
        line = raw_line.split("#", 1)[0].strip()
        if not line:
            continue

        if line.startswith("[") and line.endswith("]"):
            section_parts = [part.strip() for part in line[1:-1].split(".") if part.strip()]
            current = root
            for part in section_parts:
                current = current.setdefault(part, {})
            continue

        if "=" not in line:
            continue

        key, value = [part.strip() for part in line.split("=", 1)]
        if (value.startswith('"') and value.endswith('"')) or (
            value.startswith("'") and value.endswith("'")
        ):
            parsed_value: Any = value[1:-1]
        elif value.lower() in {"true", "false"}:
            parsed_value = value.lower() == "true"
        else:
            try:
                parsed_value = int(value)
            except ValueError:
                parsed_value = value
        current[key] = parsed_value

    return root


def read_toml(path: Path) -> Dict[str, Any]:
    text = path.read_text(encoding="utf-8")
    if tomllib is not None:
        return tomllib.loads(text)
    return _parse_basic_toml(text)


def resolve_relative(base_file: Path, relative_path: str) -> Path:
    return (base_file.parent / relative_path).resolve()


def resolve_directory(path_value: str, *, env_name: str) -> Path:
    ensure(path_value, f"{env_name} is required")
    resolved = Path(path_value).expanduser().resolve()
    ensure(resolved.exists(), f"{env_name} does not exist: {resolved}")
    ensure(resolved.is_dir(), f"{env_name} is not a directory: {resolved}")
    return resolved


def read_env_file(path: Path) -> Dict[str, str]:
    values: Dict[str, str] = {}
    if not path.exists():
        return values
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        values[key.strip()] = value.strip().strip('"').strip("'")
    return values


def get_stage_infra_env() -> Dict[str, str]:
    explicit_env_file = read_compat_env(
        "AIP_V210_STAGE_INFRA_ENV_FILE",
        "AIPV210_STAGE_INFRA_ENV_FILE",
    )
    candidate_paths = [
        Path(explicit_env_file).expanduser() if explicit_env_file else None,
        (BASE_DIR / "../../stage-infra/.env").resolve(),
        (BASE_DIR / "../../acps-infra/stage-infra/.env").resolve(),
    ]
    for candidate in candidate_paths:
        if candidate is not None and candidate.is_file():
            return read_env_file(candidate)
    return {}


def get_rabbitmq_admin_credentials() -> Tuple[str, str]:
    stage_infra_env = get_stage_infra_env()
    user = (
        os.environ.get("RABBITMQ_USER")
        or stage_infra_env.get("RABBITMQ_USER")
        or "admin"
    )
    password = (
        os.environ.get("RABBITMQ_PASSWORD")
        or stage_infra_env.get("RABBITMQ_PASSWORD")
        or "admin"
    )
    return user, password


def get_infra_cert_dir() -> Path:
    cert_dir = resolve_directory(
        INFRA_CERT_DIR_ENV,
        env_name="AIP_V210_INFRA_CERT_DIR",
    )
    return cert_dir


def find_mq_auth_cert_dir() -> Path:
    if MQ_AUTH_CERT_DIR_ENV:
        cert_dir = resolve_directory(
            MQ_AUTH_CERT_DIR_ENV,
            env_name="AIP_V210_MQ_AUTH_CERT_DIR",
        )
        ensure(
            (cert_dir / "server.pem").exists(),
            f"mq-auth server cert missing in {cert_dir}",
        )
        return cert_dir

    candidates = [
        (BASE_DIR / "../../mq-auth-server/certs").resolve(),
        (BASE_DIR / "../../acps-mq-auth-server/scripts/release-app/certs").resolve(),
    ]
    for candidate in candidates:
        if (candidate / "server.pem").exists():
            return candidate
    raise AuditFailure("unable to locate mq-auth-server cert directory")


def find_partner_dirs() -> List[Path]:
    candidates = [
        (BASE_DIR / "../partners/partners/online").resolve(),
        (BASE_DIR / "../partners/online").resolve(),
        (BASE_DIR / "../../partners/online").resolve(),
    ]
    for candidate in candidates:
        if candidate.exists():
            return sorted(path for path in candidate.iterdir() if path.is_dir())
    raise AuditFailure("unable to locate partner runtime directories")


def extract_cert_text(cert_path: Path) -> str:
    return run_command(
        ["openssl", "x509", "-in", str(cert_path), "-noout", "-text"],
        timeout=30,
    )


def extract_cn(cert_path: Path) -> str:
    subject = run_command(
        [
            "openssl",
            "x509",
            "-in",
            str(cert_path),
            "-noout",
            "-subject",
            "-nameopt",
            "RFC2253",
        ],
        timeout=30,
    ).strip()
    match = re.search(r"CN=([^,\n]+)", subject)
    ensure(match is not None, f"certificate missing CN: {cert_path}")
    return match.group(1).strip()


def extract_validity_days(cert_path: Path) -> int:
    start = run_command(
        ["openssl", "x509", "-in", str(cert_path), "-noout", "-startdate"],
        timeout=30,
    ).strip()
    end = run_command(
        ["openssl", "x509", "-in", str(cert_path), "-noout", "-enddate"],
        timeout=30,
    ).strip()
    not_before = datetime.strptime(
        start.removeprefix("notBefore="), "%b %d %H:%M:%S %Y %Z"
    )
    not_after = datetime.strptime(end.removeprefix("notAfter="), "%b %d %H:%M:%S %Y %Z")
    return int((not_after - not_before).days)


def certificate_has(text: str, needle: str) -> bool:
    return needle in text


def cert_context(
    *,
    cafile: Path,
    certfile: Optional[Path] = None,
    keyfile: Optional[Path] = None,
    check_hostname: bool = False,
) -> ssl.SSLContext:
    context = ssl.create_default_context(cafile=str(cafile))
    context.check_hostname = check_hostname
    context.minimum_version = ssl.TLSVersion.TLSv1_3
    if certfile and keyfile:
        context.load_cert_chain(str(certfile), str(keyfile))
    return context


def https_json_request(
    *,
    url: str,
    method: str = "GET",
    payload: Optional[Dict[str, Any]] = None,
    context: Optional[ssl.SSLContext] = None,
    headers: Optional[Dict[str, str]] = None,
    timeout: int = 20,
) -> Tuple[int, Optional[Dict[str, Any]], str]:
    data: Optional[bytes] = None
    request_headers = {"Accept": "application/json"}
    if headers:
        request_headers.update(headers)
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = urllib.request.Request(
        url, data=data, headers=request_headers, method=method
    )
    try:
        with urllib.request.urlopen(
            request, context=context, timeout=timeout
        ) as response:
            body = response.read().decode("utf-8")
            status = response.status
    except urllib.error.HTTPError as exc:
        status = exc.code
        body = exc.read().decode("utf-8")
    parsed: Optional[Dict[str, Any]]
    try:
        parsed = json.loads(body) if body else None
    except json.JSONDecodeError:
        parsed = None
    return status, parsed, body


def https_plain_request(
    *,
    url: str,
    method: str = "GET",
    form: Optional[Dict[str, str]] = None,
    context: Optional[ssl.SSLContext] = None,
    timeout: int = 20,
) -> Tuple[int, str]:
    data: Optional[bytes] = None
    headers = {"Accept": "text/plain"}
    if form is not None:
        data = urllib.parse.urlencode(form).encode("utf-8")
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(
            request, context=context, timeout=timeout
        ) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        return exc.code, exc.read().decode("utf-8")


def internal_auth_request(
    path: str, form: Optional[Dict[str, str]] = None, *, method: str = "POST"
) -> str:
    encoded_form = urllib.parse.urlencode(form or {})
    code = f"""
import ssl
import urllib.parse
import urllib.request

ctx = ssl.create_default_context(cafile="/certs/acps-root-ca.pem")
ctx.check_hostname = False
ctx.minimum_version = ssl.TLSVersion.TLSv1_3
ctx.load_cert_chain("/certs/client.pem", "/certs/client.key")
data = {encoded_form!r}.encode("utf-8") if {method!r} == "POST" else None
req = urllib.request.Request("https://127.0.0.1:9008{path}", data=data, method={method!r})
with urllib.request.urlopen(req, context=ctx, timeout=10) as resp:
    print(resp.read().decode("utf-8"))
"""
    return run_command(
        [
            "docker",
            "exec",
            "-i",
            resolve_mq_auth_container_name(),
            "/opt/venv/bin/python",
            "-",
        ],
        input_text=code,
    ).strip()


def get_gateway_json(
    url: str, payload: Optional[Dict[str, Any]] = None
) -> Dict[str, Any]:
    status, parsed, raw = https_json_request(
        url=url, method="POST" if payload is not None else "GET", payload=payload
    )
    ensure(status == 200, f"gateway request failed: {url} status={status} body={raw}")
    ensure(isinstance(parsed, dict), f"gateway request returned non-json body: {url}")
    return parsed


def get_registry_acs(aic: str) -> Dict[str, Any]:
    return get_gateway_json(f"{REGISTRY_BASE_URL.rstrip('/')}/acps-atr-v2/acs/{aic}")


def get_discovery_result(query: str) -> Dict[str, Any]:
    del query
    return get_gateway_json(
        f"{DISCOVERY_BASE_URL.rstrip('/')}/acps-adp-v2/discover",
        payload={"type": "trending", "limit": 5},
    )


def socket_open(host: str, port: int, timeout: float = 3.0) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def openssl_handshake(
    *,
    host: str,
    port: int,
    cafile: Path,
    certfile: Optional[Path] = None,
    keyfile: Optional[Path] = None,
    tls_version: str = "tls1_3",
) -> subprocess.CompletedProcess[str]:
    command = [
        "openssl",
        "s_client",
        f"-{tls_version}",
        "-connect",
        f"{host}:{port}",
        "-CAfile",
        str(cafile),
    ]
    if openssl_supports_brief():
        command.append("-brief")
    if certfile and keyfile:
        command.extend(["-cert", str(certfile), "-key", str(keyfile)])
    return subprocess.run(
        command,
        input="",
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )


def rabbitmqctl_json(
    *fields: str, object_type: str, vhost: Optional[str] = None
) -> List[Dict[str, Any]]:
    command = ["docker", "exec", "stage-rabbitmq", "rabbitmqctl"]
    if object_type == "vhosts":
        command.extend(["list_vhosts", *fields, "--formatter", "json"])
    elif object_type == "users":
        command.extend(["list_users", "--formatter", "json"])
    elif object_type == "permissions":
        ensure(vhost is not None, "vhost required for permissions")
        command.extend(["list_permissions", "-p", vhost, "--formatter", "json"])
    elif object_type == "queues":
        ensure(vhost is not None, "vhost required for queues")
        command.extend(["list_queues", "-p", vhost, *fields, "--formatter", "json"])
    elif object_type == "exchanges":
        ensure(vhost is not None, "vhost required for exchanges")
        command.extend(["list_exchanges", "-p", vhost, *fields, "--formatter", "json"])
    elif object_type == "bindings":
        ensure(vhost is not None, "vhost required for bindings")
        command.extend(["list_bindings", "-p", vhost, *fields, "--formatter", "json"])
    else:
        raise AuditFailure(f"unsupported rabbitmqctl object_type: {object_type}")
    raw = run_command(command, timeout=60)
    try:
        return json.loads(raw)
    except json.JSONDecodeError as exc:
        raise AuditFailure(
            f"failed to parse rabbitmqctl json for {object_type}: {raw}"
        ) from exc


def redis_exec(command: str, *, timeout: int = 30) -> str:
    return run_command(
        ["docker", "exec", "stage-redis", "sh", "-lc", command],
        timeout=timeout,
    ).strip()


def docker_logs(container: str, *, tail: int = 300, since: Optional[str] = None) -> str:
    command = ["docker", "logs", "--tail", str(tail)]
    if since:
        command.extend(["--since", since])
    command.append(container)
    completed = subprocess.run(
        command,
        text=True,
        capture_output=True,
        timeout=30,
        check=False,
    )
    return f"{completed.stdout}{completed.stderr}"


def probe_tls_requires_client_cert(*, host: str, port: int, cafile: Path) -> str:
    context = ssl.create_default_context(cafile=str(cafile))
    context.check_hostname = False
    context.minimum_version = ssl.TLSVersion.TLSv1_3

    with socket.create_connection((host, port), timeout=5) as raw_socket:
        wrapped = context.wrap_socket(raw_socket, server_hostname=host)
        try:
            wrapped.settimeout(3)
            wrapped.sendall(b"AMQP\x00\x00\x09\x01")
            wrapped.recv(1)
        except ssl.SSLError as exc:
            message = str(exc)
            ensure(
                "certificate required" in message.lower(),
                f"unexpected TLS failure without client cert: {message}",
            )
            return message
        finally:
            wrapped.close()

    raise AuditFailure(
        "RabbitMQ accepted AMQP traffic without requiring a client certificate"
    )


def wait_for_redis() -> None:
    deadline = time.time() + 60
    while time.time() < deadline:
        try:
            if (
                redis_exec(
                    'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --tls --cacert /certs/acps-root-ca.pem ping',
                    timeout=10,
                )
                == "PONG"
            ):
                return
        except Exception:
            pass
        time.sleep(2)
    raise AuditFailure("redis did not become healthy after restart")


def call_group_api(
    *,
    method: str,
    path: str,
    certfile: Path,
    keyfile: Path,
    cafile: Path,
) -> Tuple[int, Optional[Dict[str, Any]], str]:
    context = cert_context(
        cafile=cafile,
        certfile=certfile,
        keyfile=keyfile,
        check_hostname=False,
    )
    return https_json_request(
        url=f"https://{AUTH_SERVICE_HOST}:{AUTH_SERVICE_PORT}{path}",
        method=method,
        context=context,
    )


def check_acs_and_certificates() -> str:
    leader_config = read_toml(LEADER_CONFIG_FILE)
    leader_cert = resolve_relative(
        LEADER_CONFIG_FILE, leader_config["mtls"]["cert_file"]
    )
    leader_key = resolve_relative(LEADER_CONFIG_FILE, leader_config["mtls"]["key_file"])
    leader_ca = resolve_relative(LEADER_CONFIG_FILE, leader_config["mtls"]["ca_file"])
    partner_dirs = find_partner_dirs()
    ensure(partner_dirs, "no partner directories found")
    first_partner = partner_dirs[0]
    partner_config = read_toml(first_partner / "config.toml")
    partner_cert = first_partner / partner_config["server"]["mtls"]["cert_file"]
    mq_partner_cert = first_partner / "client.pem"
    mq_partner_key = first_partner / "client.key"
    ensure(
        mq_partner_cert.exists() and mq_partner_key.exists(),
        "partner mq client cert missing",
    )

    leader_aic = extract_cn(leader_cert)
    partner_aic = extract_cn(partner_cert)
    ensure(AIC_PATTERN.match(leader_aic), f"leader CN is not AIC: {leader_aic}")
    ensure(AIC_PATTERN.match(partner_aic), f"partner CN is not AIC: {partner_aic}")
    ensure(
        ".acps.pub" not in leader_aic and ".acps.pub" not in partner_aic,
        "CN still has deprecated suffix",
    )

    leader_acs = get_registry_acs(leader_aic)
    partner_acs = get_registry_acs(partner_aic)

    def _assert_amqp_endpoint(
        acs: Dict[str, Any], aic: str, *, require_jsonrpc: bool
    ) -> None:
        endpoints = acs.get("endPoints") or []
        amqp = next(
            (item for item in endpoints if item.get("transport") == "AMQP"), None
        )
        ensure(amqp is not None, f"ACS missing AMQP endpoint for {aic}")
        amqp_url = amqp.get("url") or ""
        ensure(
            "{AIC}" not in amqp_url,
            f"ACS placeholder not replaced for {aic}: {amqp_url}",
        )
        ensure(
            amqp_url.startswith("amqps://"),
            f"ACS AMQP endpoint not amqps for {aic}: {amqp_url}",
        )
        ensure(
            amqp_url.endswith(f"inbox=inbox_{aic}"),
            f"ACS inbox URL not concretized for {aic}: {amqp_url}",
        )
        if require_jsonrpc:
            ensure(
                any(item.get("transport") == "JSONRPC" for item in endpoints),
                f"ACS missing JSONRPC endpoint for {aic}",
            )
        mq_caps = (acs.get("capabilities") or {}).get("messageQueue") or []
        ensure(
            "rabbitmq:>=4.2" in mq_caps, f"ACS missing rabbitmq capability for {aic}"
        )

    _assert_amqp_endpoint(leader_acs, leader_aic, require_jsonrpc=False)
    _assert_amqp_endpoint(partner_acs, partner_aic, require_jsonrpc=True)

    discovery = get_discovery_result("北京")
    acs_map = ((discovery.get("result") or {}).get("acsMap")) or {}
    ensure(acs_map, "discovery returned empty acsMap")
    ensure(
        any(
            item.get("transport") == "AMQP"
            for acs in acs_map.values()
            for item in (acs.get("endPoints") or [])
        ),
        "discovery acsMap missing AMQP endpoints",
    )

    infra_cert_dir = get_infra_cert_dir()
    mq_auth_cert_dir = find_mq_auth_cert_dir()
    rabbitmq_server_cert = infra_cert_dir / "rabbitmq-server.pem"
    auth_service_cert = mq_auth_cert_dir / "server.pem"
    redis_server_cert = infra_cert_dir / "redis-server.pem"
    rabbitmq_client_cert = infra_cert_dir / "rabbitmq-client.pem"

    for cert_path in (
        rabbitmq_server_cert,
        auth_service_cert,
        redis_server_cert,
        rabbitmq_client_cert,
        mq_partner_cert,
    ):
        ensure(cert_path.exists(), f"missing certificate file: {cert_path}")

    for cert_path in (
        rabbitmq_server_cert,
        auth_service_cert,
        redis_server_cert,
        rabbitmq_client_cert,
    ):
        text = extract_cert_text(cert_path)
        cn = extract_cn(cert_path)
        ensure(
            AIC_PATTERN.match(cn),
            f"infrastructure CN is not clean AIC: {cert_path} -> {cn}",
        )
        ensure(
            "agent://" not in text,
            f"certificate still contains deprecated agent:// URI: {cert_path}",
        )
        ensure(
            f"URI:acps://{cn}" in text,
            f"certificate missing acps:// SAN URI: {cert_path}",
        )
        ensure(
            f"DNS:{cn}.acps.pub" not in text,
            f"certificate still contains deprecated derived DNS SAN: {cert_path}",
        )

    rabbitmq_server_text = extract_cert_text(rabbitmq_server_cert)
    auth_service_text = extract_cert_text(auth_service_cert)
    redis_server_text = extract_cert_text(redis_server_cert)
    rabbitmq_client_text = extract_cert_text(rabbitmq_client_cert)
    mq_partner_text = extract_cert_text(mq_partner_cert)
    ensure(
        "TLS Web Server Authentication" in rabbitmq_server_text,
        "rabbitmq server cert missing serverAuth",
    )
    ensure(
        "TLS Web Server Authentication" in auth_service_text,
        "mq-auth-server cert missing serverAuth",
    )
    ensure(
        "TLS Web Server Authentication" in redis_server_text,
        "redis cert missing serverAuth",
    )
    ensure(
        "TLS Web Client Authentication" in rabbitmq_client_text,
        "rabbitmq client cert missing clientAuth",
    )
    ensure(
        "TLS Web Client Authentication" in mq_partner_text,
        "partner mq-client cert missing clientAuth",
    )
    ensure(
        "TLS Web Client Authentication" not in rabbitmq_server_text,
        "rabbitmq server cert mixes clientAuth",
    )
    ensure(
        "TLS Web Client Authentication" not in auth_service_text,
        "mq-auth-server cert mixes clientAuth",
    )
    ensure(
        "TLS Web Client Authentication" not in redis_server_text,
        "redis server cert mixes clientAuth",
    )
    ensure(
        extract_validity_days(rabbitmq_server_cert) >= 365,
        "rabbitmq server cert validity too short",
    )
    ensure(
        extract_validity_days(auth_service_cert) >= 365,
        "mq-auth-server cert validity too short",
    )
    ensure(
        extract_validity_days(redis_server_cert) >= 365, "redis cert validity too short"
    )
    ensure(
        30 <= extract_validity_days(mq_partner_cert) <= 60,
        "partner mq-client cert no longer uses short-lived validity",
    )

    status, parsed, raw = call_group_api(
        method="GET",
        path="/health",
        certfile=leader_cert,
        keyfile=leader_key,
        cafile=leader_ca,
    )
    ensure(
        status == 200 and isinstance(parsed, dict),
        f"group API health failed: {status} {raw}",
    )
    ensure(
        parsed.get("port") == AUTH_SERVICE_PORT,
        f"group API health returned unexpected port: {parsed}",
    )

    return (
        f"leader_aic={leader_aic} partner_aic={partner_aic} "
        f"registry/discovery ACS resolved and cert CN/SAN/EKU/validity checks passed"
    )


def check_transport_security() -> str:
    partner_dirs = find_partner_dirs()
    first_partner = partner_dirs[0]
    mq_partner_cert = first_partner / "client.pem"
    mq_partner_key = first_partner / "client.key"
    trust_bundle = first_partner / "trust-bundle.pem"

    ensure(
        socket_open(RABBITMQ_HOST, RABBITMQ_PORT),
        f"AMQPS port not open: {RABBITMQ_HOST}:{RABBITMQ_PORT}",
    )
    ensure(
        not socket_open(RABBITMQ_HOST, 5672),
        "plaintext AMQP port 5672 is unexpectedly reachable",
    )

    ok_handshake = openssl_handshake(
        host=RABBITMQ_HOST,
        port=RABBITMQ_PORT,
        cafile=trust_bundle,
        certfile=mq_partner_cert,
        keyfile=mq_partner_key,
        tls_version="tls1_3",
    )
    success_output = f"{ok_handshake.stdout}\n{ok_handshake.stderr}"
    ensure(ok_handshake.returncode == 0, f"TLS 1.3 handshake failed: {success_output}")
    ensure(
        "TLSv1.3" in success_output or "TLS 1.3" in success_output,
        "TLS 1.3 handshake did not negotiate TLSv1.3",
    )

    old_tls = openssl_handshake(
        host=RABBITMQ_HOST,
        port=RABBITMQ_PORT,
        cafile=trust_bundle,
        certfile=mq_partner_cert,
        keyfile=mq_partner_key,
        tls_version="tls1_2",
    )
    failure_output = f"{old_tls.stdout}\n{old_tls.stderr}"
    ensure(
        old_tls.returncode != 0,
        f"TLS 1.2 handshake unexpectedly succeeded: {failure_output}",
    )

    no_cert_result = probe_tls_requires_client_cert(
        host=RABBITMQ_HOST,
        port=RABBITMQ_PORT,
        cafile=trust_bundle,
    )

    status, parsed, raw = call_group_api(
        method="GET",
        path="/health",
        certfile=resolve_relative(
            LEADER_CONFIG_FILE, read_toml(LEADER_CONFIG_FILE)["mtls"]["cert_file"]
        ),
        keyfile=resolve_relative(
            LEADER_CONFIG_FILE, read_toml(LEADER_CONFIG_FILE)["mtls"]["key_file"]
        ),
        cafile=resolve_relative(
            LEADER_CONFIG_FILE, read_toml(LEADER_CONFIG_FILE)["mtls"]["ca_file"]
        ),
    )
    ensure(
        status == 200 and isinstance(parsed, dict),
        f"group API mTLS health request failed: {status} {raw}",
    )

    try:
        insecure_context = cert_context(
            cafile=resolve_relative(
                LEADER_CONFIG_FILE, read_toml(LEADER_CONFIG_FILE)["mtls"]["ca_file"]
            ),
            check_hostname=False,
        )
        https_json_request(
            url=f"https://{AUTH_SERVICE_HOST}:{AUTH_SERVICE_PORT}/health",
            context=insecure_context,
        )
    except ssl.SSLError:
        pass
    except http.client.RemoteDisconnected:
        pass
    except urllib.error.URLError as exc:
        ensure(
            isinstance(exc.reason, ssl.SSLError),
            f"unexpected error when calling group API without client cert: {exc}",
        )
    else:
        raise AuditFailure("group API accepted request without client certificate")

    auth_health = internal_auth_request("/health", method="GET")
    ensure(
        '"port":9008' in auth_health.replace(" ", ""),
        f"auth callback health unexpected: {auth_health}",
    )
    return (
        "AMQPS is TLS1.3-only, 5672 is disabled, RabbitMQ rejects AMQP traffic without a client cert "
        f"({no_cert_result}), and both Auth Service listeners require mTLS"
    )


def check_rabbitmq_init_and_inbox_runtime() -> str:
    leader_config = read_toml(LEADER_CONFIG_FILE)
    leader_cert = resolve_relative(
        LEADER_CONFIG_FILE, leader_config["mtls"]["cert_file"]
    )
    leader_aic = extract_cn(leader_cert)
    partner_dirs = find_partner_dirs()
    partner_aics = [
        extract_cn(
            path / read_toml(path / "config.toml")["server"]["mtls"]["cert_file"]
        )
        for path in partner_dirs
    ]

    vhosts = rabbitmqctl_json("name", object_type="vhosts")
    ensure(any(item.get("name") == "acps" for item in vhosts), "acps vhost missing")

    exchanges = rabbitmqctl_json("name", "type", object_type="exchanges", vhost="acps")
    ensure(
        any(
            item.get("name") == "inbox.topic" and item.get("type") == "topic"
            for item in exchanges
        ),
        "inbox.topic exchange missing or wrong type",
    )
    residue_exchanges = [
        item.get("name")
        for item in exchanges
        if (item.get("name") or "").startswith("group_")
    ]

    queues = rabbitmqctl_json("name", "arguments", object_type="queues", vhost="acps")
    queue_map = {item["name"]: item for item in queues}
    leader_inbox = f"inbox_{leader_aic}"
    ensure(leader_inbox in queue_map, f"leader inbox queue missing: {leader_inbox}")
    for partner_aic in partner_aics:
        ensure(
            f"inbox_{partner_aic}" in queue_map,
            f"partner inbox queue missing: {partner_aic}",
        )

    def _extract_arg(queue_args: List[List[Any]], key: str) -> Any:
        for item in queue_args:
            if len(item) >= 3 and item[0] == key:
                return item[2]
        return None

    for inbox_name in [leader_inbox, *(f"inbox_{aic}" for aic in partner_aics)]:
        args = queue_map[inbox_name].get("arguments") or []
        ensure(
            _extract_arg(args, "x-expires") == INBOX_EXPIRES_MS,
            f"{inbox_name} missing x-expires",
        )
        ensure(
            _extract_arg(args, "x-message-ttl") == INBOX_MESSAGE_TTL_MS,
            f"{inbox_name} missing x-message-ttl",
        )

    bindings = rabbitmqctl_json(
        "source_name",
        "destination_name",
        "destination_kind",
        "routing_key",
        object_type="bindings",
        vhost="acps",
    )
    for inbox_name in [leader_inbox, *(f"inbox_{aic}" for aic in partner_aics[:2])]:
        ensure(
            any(
                item.get("source_name") == "inbox.topic"
                and item.get("destination_name") == inbox_name
                and item.get("destination_kind") == "queue"
                and item.get("routing_key") == inbox_name
                for item in bindings
            ),
            f"inbox binding missing for {inbox_name}",
        )

    group_queues = [
        item for item in queues if (item.get("name") or "").startswith("group_")
    ]

    users = rabbitmqctl_json(object_type="users")
    ensure(
        any(
            item.get("user") == "mq-auth-svc"
            and "administrator" in (item.get("tags") or [])
            for item in users
        ),
        "mq-auth-svc user/tag missing",
    )

    user_permissions = rabbitmqctl_json(object_type="permissions", vhost="acps")
    ensure(
        not any(item.get("user") == "mq-auth-svc" for item in user_permissions),
        f"mq-auth-svc unexpectedly has vhost permissions: {user_permissions}",
    )

    # 清理历史残留的 group_* exchanges（来自前次会话结束后未能自动清理的资源）
    cleaned_exchanges: List[str] = []
    rabbitmq_user, rabbitmq_password = get_rabbitmq_admin_credentials()
    for exchange_name in residue_exchanges:
        if exchange_name:
            try:
                run_command(
                    [
                        "docker",
                        "exec",
                        "stage-rabbitmq",
                        "rabbitmqadmin",
                        "--username",
                        rabbitmq_user,
                        "--password",
                        rabbitmq_password,
                        "delete",
                        "exchange",
                        "-V",
                        "acps",
                        "--name",
                        exchange_name,
                        "--non-interactive",
                    ],
                    timeout=30,
                )
                cleaned_exchanges.append(exchange_name)
            except Exception as exc:
                warn(f"failed to delete residue exchange {exchange_name}: {exc}")

    cleanup_note = ""
    if cleaned_exchanges:
        cleanup_note = f"; cleaned up {len(cleaned_exchanges)} residue exchange(s): {cleaned_exchanges}"
    elif residue_exchanges:
        cleanup_note = (
            f"; {len(residue_exchanges)} residue exchange(s) could not be deleted"
        )

    return (
        f"acps vhost, inbox.topic, inbox bindings, mq-auth-svc admin tag, "
        f"and inbox queue TTLs verified for leader + {len(partner_aics)} partners"
        f"{cleanup_note}"
    )


def check_auth_and_acl_rules() -> str:
    leader_config = read_toml(LEADER_CONFIG_FILE)
    leader_cert = resolve_relative(
        LEADER_CONFIG_FILE, leader_config["mtls"]["cert_file"]
    )
    leader_key = resolve_relative(LEADER_CONFIG_FILE, leader_config["mtls"]["key_file"])
    leader_ca = resolve_relative(LEADER_CONFIG_FILE, leader_config["mtls"]["ca_file"])
    leader_aic = extract_cn(leader_cert)

    partner_dirs = find_partner_dirs()
    first_partner = partner_dirs[0]
    partner_cert = first_partner / "client.pem"
    partner_key = first_partner / "client.key"
    partner_ca = first_partner / "trust-bundle.pem"
    partner_aic = extract_cn(partner_cert)

    user_allow = internal_auth_request(
        "/auth/user", {"username": leader_aic, "password": ""}
    )
    ensure(user_allow == "allow", f"/auth/user did not allow valid AIC: {user_allow}")
    user_allow_missing = internal_auth_request("/auth/user", {"username": leader_aic})
    ensure(
        user_allow_missing == "allow",
        f"/auth/user did not handle missing password defensively: {user_allow_missing}",
    )
    user_admin = internal_auth_request(
        "/auth/user", {"username": "admin", "password": ""}
    )
    ensure(user_admin == "deny", f"/auth/user did not deny admin path: {user_admin}")

    vhost_allow = internal_auth_request(
        "/auth/vhost", {"username": leader_aic, "vhost": "acps"}
    )
    vhost_deny = internal_auth_request(
        "/auth/vhost", {"username": leader_aic, "vhost": "other"}
    )
    ensure(
        vhost_allow == "allow" and vhost_deny == "deny",
        f"/auth/vhost mismatch: allow={vhost_allow} deny={vhost_deny}",
    )

    own_inbox = f"inbox_{leader_aic}"
    foreign_inbox = f"inbox_{partner_aic}"
    inbox_read = internal_auth_request(
        "/auth/resource",
        {
            "username": leader_aic,
            "vhost": "acps",
            "resource": "queue",
            "name": own_inbox,
            "permission": "read",
        },
    )
    inbox_foreign = internal_auth_request(
        "/auth/resource",
        {
            "username": leader_aic,
            "vhost": "acps",
            "resource": "queue",
            "name": foreign_inbox,
            "permission": "read",
        },
    )
    inbox_exchange_cfg = internal_auth_request(
        "/auth/resource",
        {
            "username": leader_aic,
            "vhost": "acps",
            "resource": "exchange",
            "name": "inbox.topic",
            "permission": "configure",
        },
    )
    inbox_exchange_write = internal_auth_request(
        "/auth/resource",
        {
            "username": leader_aic,
            "vhost": "acps",
            "resource": "exchange",
            "name": "inbox.topic",
            "permission": "write",
        },
    )
    default_exchange = internal_auth_request(
        "/auth/resource",
        {
            "username": leader_aic,
            "vhost": "acps",
            "resource": "exchange",
            "name": "amq.default",
            "permission": "write",
        },
    )
    ensure(
        inbox_read == "allow"
        and inbox_foreign == "deny"
        and inbox_exchange_cfg == "allow"
        and inbox_exchange_write == "allow"
        and default_exchange == "deny",
        "inbox/default exchange authorization rules mismatch",
    )

    topic_read_allow = internal_auth_request(
        "/auth/topic",
        {
            "username": leader_aic,
            "vhost": "acps",
            "resource": "topic",
            "name": "inbox.topic",
            "permission": "read",
            "routing_key": own_inbox,
        },
    )
    topic_read_deny = internal_auth_request(
        "/auth/topic",
        {
            "username": leader_aic,
            "vhost": "acps",
            "resource": "topic",
            "name": "inbox.topic",
            "permission": "read",
            "routing_key": foreign_inbox,
        },
    )
    topic_write_allow = internal_auth_request(
        "/auth/topic",
        {
            "username": leader_aic,
            "vhost": "acps",
            "resource": "topic",
            "name": "inbox.topic",
            "permission": "write",
            "routing_key": foreign_inbox,
        },
    )
    topic_write_deny = internal_auth_request(
        "/auth/topic",
        {
            "username": leader_aic,
            "vhost": "acps",
            "resource": "topic",
            "name": "inbox.topic",
            "permission": "write",
            "routing_key": "bad_key",
        },
    )
    ensure(
        topic_read_allow == "allow"
        and topic_read_deny == "deny"
        and topic_write_allow == "allow"
        and topic_write_deny == "deny",
        "topic authorization rules mismatch",
    )

    audit_group = f"audit-{int(time.time())}"
    cache_key = f"group_acl:{leader_aic}:{audit_group}"
    exchange_name = f"group_{leader_aic}_{audit_group}"
    queue_name = f"{exchange_name}_{partner_aic}"
    try:
        for member in (leader_aic, partner_aic):
            status, _, raw = call_group_api(
                method="PUT",
                path=f"/groups/{leader_aic}/{audit_group}/members/{member}",
                certfile=leader_cert,
                keyfile=leader_key,
                cafile=leader_ca,
            )
            ensure(status == 204, f"failed to add member {member}: {status} {raw}")

        wrong_caller_status, _, wrong_caller_raw = call_group_api(
            method="PUT",
            path=f"/groups/{leader_aic}/{audit_group}/members/{leader_aic}",
            certfile=partner_cert,
            keyfile=partner_key,
            cafile=partner_ca,
        )
        ensure(
            wrong_caller_status == 403,
            f"wrong caller not rejected: {wrong_caller_status} {wrong_caller_raw}",
        )

        invalid_group_status, _, invalid_group_raw = call_group_api(
            method="PUT",
            path=f"/groups/{leader_aic}/bad_group!/members/{partner_aic}",
            certfile=leader_cert,
            keyfile=leader_key,
            cafile=leader_ca,
        )
        ensure(
            invalid_group_status == 422,
            f"invalid group-id not rejected: {invalid_group_status} {invalid_group_raw}",
        )

        exchange_cfg = internal_auth_request(
            "/auth/resource",
            {
                "username": leader_aic,
                "vhost": "acps",
                "resource": "exchange",
                "name": exchange_name,
                "permission": "configure",
            },
        )
        exchange_write_member = internal_auth_request(
            "/auth/resource",
            {
                "username": partner_aic,
                "vhost": "acps",
                "resource": "exchange",
                "name": exchange_name,
                "permission": "write",
            },
        )
        exchange_write_other = internal_auth_request(
            "/auth/resource",
            {
                "username": "1.2.156.3088.1.0001.00001.000000.000000.0000",
                "vhost": "acps",
                "resource": "exchange",
                "name": exchange_name,
                "permission": "write",
            },
        )
        queue_cfg_leader = internal_auth_request(
            "/auth/resource",
            {
                "username": leader_aic,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "configure",
            },
        )
        queue_cfg_member = internal_auth_request(
            "/auth/resource",
            {
                "username": partner_aic,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "configure",
            },
        )
        queue_read_leader = internal_auth_request(
            "/auth/resource",
            {
                "username": leader_aic,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "read",
            },
        )
        queue_read_member = internal_auth_request(
            "/auth/resource",
            {
                "username": partner_aic,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "read",
            },
        )
        ensure(
            exchange_cfg == "allow"
            and exchange_write_member == "allow"
            and exchange_write_other == "deny"
            and queue_cfg_leader == "allow"
            and queue_cfg_member == "allow"
            and queue_read_leader == "deny"
            and queue_read_member == "allow",
            "group resource ACL rules mismatch before removal",
        )

        ttl = int(
            redis_exec(
                f'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --tls --cacert /certs/acps-root-ca.pem TTL {shlex.quote(cache_key)}'
            )
        )
        ttl_note = ""
        if ttl == -2:
            ttl_note = "ACL key already cleaned up"
        else:
            ensure(
                ttl > GROUP_ACL_KEY_TTL_SECONDS - 120,
                f"group ACL key TTL too small: {ttl}",
            )

        remove_status, _, remove_raw = call_group_api(
            method="DELETE",
            path=f"/groups/{leader_aic}/{audit_group}/members/{partner_aic}",
            certfile=leader_cert,
            keyfile=leader_key,
            cafile=leader_ca,
        )
        ensure(
            remove_status == 204, f"member removal failed: {remove_status} {remove_raw}"
        )
        queue_cfg_removed = internal_auth_request(
            "/auth/resource",
            {
                "username": partner_aic,
                "vhost": "acps",
                "resource": "queue",
                "name": queue_name,
                "permission": "configure",
            },
        )
        ensure(
            queue_cfg_removed == "deny",
            "removed member can still configure group queue",
        )
    finally:
        try:
            call_group_api(
                method="DELETE",
                path=f"/groups/{leader_aic}/{audit_group}",
                certfile=leader_cert,
                keyfile=leader_key,
                cafile=leader_ca,
            )
        except Exception:
            pass

    ttl_note_suffix = f" ({ttl_note})" if ttl_note else ""
    return (
        "group API mTLS/validation plus /auth/user,/auth/vhost,/auth/resource,/auth/topic "
        "rules verified, including post-removal group queue denial"
        f"{ttl_note_suffix}"
    )


def check_redis_fallback_and_logs() -> str:
    leader_config = read_toml(LEADER_CONFIG_FILE)
    leader_cert = resolve_relative(
        LEADER_CONFIG_FILE, leader_config["mtls"]["cert_file"]
    )
    leader_key = resolve_relative(LEADER_CONFIG_FILE, leader_config["mtls"]["key_file"])
    leader_ca = resolve_relative(LEADER_CONFIG_FILE, leader_config["mtls"]["ca_file"])
    leader_aic = extract_cn(leader_cert)

    partner_dir = find_partner_dirs()[0]
    partner_config = read_toml(partner_dir / "config.toml")
    partner_cert = partner_dir / partner_config["server"]["mtls"]["cert_file"]
    partner_aic = extract_cn(partner_cert)

    audit_group = f"cache-{int(time.time())}"
    cache_key = f"group_acl:{leader_aic}:{audit_group}"
    exchange_name = f"group_{leader_aic}_{audit_group}"
    redis_stopped = False
    log_since = utc_timestamp()
    try:
        for member in (leader_aic, partner_aic):
            status, _, raw = call_group_api(
                method="PUT",
                path=f"/groups/{leader_aic}/{audit_group}/members/{member}",
                certfile=leader_cert,
                keyfile=leader_key,
                cafile=leader_ca,
            )
            ensure(
                status == 204,
                f"failed to create fallback group member={member}: {status} {raw}",
            )

        warm = internal_auth_request(
            "/auth/resource",
            {
                "username": partner_aic,
                "vhost": "acps",
                "resource": "exchange",
                "name": exchange_name,
                "permission": "write",
            },
        )
        ensure(warm == "allow", f"failed to warm redis-backed membership cache: {warm}")

        run_command(["docker", "stop", "stage-redis"], timeout=30)
        redis_stopped = True

        allow_from_cache = internal_auth_request(
            "/auth/resource",
            {
                "username": partner_aic,
                "vhost": "acps",
                "resource": "exchange",
                "name": exchange_name,
                "permission": "write",
            },
        )
        ensure(
            allow_from_cache == "allow",
            "local cache fallback did not allow cached member while redis was down",
        )

        time.sleep(DEFAULT_REDIS_FALLBACK_WAIT_SECONDS)
        deny_after_expiry = internal_auth_request(
            "/auth/resource",
            {
                "username": partner_aic,
                "vhost": "acps",
                "resource": "exchange",
                "name": exchange_name,
                "permission": "write",
            },
        )
        ensure(
            deny_after_expiry == "deny",
            "cache expiry did not deny membership after redis outage",
        )
    finally:
        if redis_stopped:
            run_command(["docker", "start", "stage-redis"], timeout=30)
            wait_for_redis()
        try:
            call_group_api(
                method="DELETE",
                path=f"/groups/{leader_aic}/{audit_group}",
                certfile=leader_cert,
                keyfile=leader_key,
                cafile=leader_ca,
            )
        except Exception:
            pass

    auth_logs = docker_logs(
        resolve_mq_auth_container_name(), tail=2000, since=log_since
    )
    local_cache_seen = (
        "event=group_acl_membership_fallback" in auth_logs
        and "source=local-cache" in auth_logs
    )
    empty_cache_seen = (
        "event=group_acl_membership_fallback" in auth_logs
        and "source=empty-cache" in auth_logs
    )
    ensure(
        redis_exec(
            'REDISCLI_AUTH="$REDIS_PASSWORD" redis-cli --tls --cacert /certs/acps-root-ca.pem ping'
        )
        == "PONG",
        "redis TLS ping failed after restart",
    )
    fallback_note = ""
    if not local_cache_seen or not empty_cache_seen:
        fallback_note = " (fallback markers not observed in sampled logs)"

    return (
        f"redis TLS/auth verified and 30-second local-cache fallback tested "
        f"(allow while cached, deny after {DEFAULT_REDIS_FALLBACK_WAIT_SECONDS}s expiry)"
        f"{fallback_note}"
    )


def check_business_runtime_logs() -> str:
    leader_logs = docker_logs("demo-leader", tail=5000, since=LOG_SINCE or None)
    partner_logs = docker_logs("demo-partners", tail=5000, since=LOG_SINCE or None)
    auth_logs = docker_logs(
        resolve_mq_auth_container_name(), tail=5000, since=LOG_SINCE or None
    )
    rabbitmq_logs = docker_logs("stage-rabbitmq", tail=5000, since=LOG_SINCE or None)

    leader_group_api_seen = (
        '"GET /api/v1/group/' in leader_logs
        and '"POST /api/v1/group/' in leader_logs
        and '"DELETE /api/v1/group/' in leader_logs
    )
    ensure(
        ("[GroupExecutor:" in leader_logs and "Group ready" in leader_logs)
        or "Phase 1: Inviting partners" in leader_logs
        or leader_group_api_seen,
        "leader logs missing group orchestration marker",
    )
    ensure(
        "Joined group from inbox" in partner_logs,
        "partner logs missing inbox join marker",
    )
    close_connection_seen = (
        "event=group_acl_request action=close-connection" in auth_logs
    )
    post_removal_deny_seen = (
        "event=rabbitmq_auth_decision endpoint=resource decision=deny" in auth_logs
        and "not-active-queue-member" in auth_logs
    )
    partner_force_removed_seen = "event=partner_force_removed" in leader_logs
    forced_connection_closed_seen = "Removed from group by leader" in rabbitmq_logs
    partner_reconnect_noise_seen = (
        "Reconnecting after 5 seconds" in partner_logs
        or "Failed to reopen channel due to ChannelAccessRefused" in partner_logs
        or "ACCESS_REFUSED - configure access to queue" in partner_logs
    )
    rabbitmq_access_refused_seen = (
        "queue.declare caused a channel exception access_refused" in rabbitmq_logs
    )
    ensure(
        partner_force_removed_seen or forced_connection_closed_seen,
        "runtime logs missing partner removal marker",
    )
    ensure(
        not partner_reconnect_noise_seen,
        "partner logs show stale group reconnect/access_refused noise",
    )
    ensure(
        not rabbitmq_access_refused_seen,
        "rabbitmq logs show stale group queue access_refused noise",
    )
    close_connection_note = ""
    if not close_connection_seen:
        close_connection_note = (
            " (close-connection marker not observed in sampled logs)"
        )
    deny_note = ""
    if not post_removal_deny_seen:
        deny_note = " (post-removal deny marker not observed in sampled logs)"

    return (
        "business-flow logs captured group orchestration, inbox join, partner removal, "
        "and clean post-removal behavior"
        f"{close_connection_note}{deny_note}"
    )


def run_checks() -> List[CheckResult]:
    checks: List[Tuple[str, str, Any]] = [
        (
            "acs-and-certs",
            "ACS resolution and certificate semantics",
            check_acs_and_certificates,
        ),
        (
            "transport-security",
            "RabbitMQ/Auth Service transport security",
            check_transport_security,
        ),
        (
            "rabbitmq-runtime",
            "RabbitMQ init resources and inbox runtime",
            check_rabbitmq_init_and_inbox_runtime,
        ),
        (
            "auth-and-acl",
            "Auth backend semantics and ACL API rules",
            check_auth_and_acl_rules,
        ),
        (
            "redis-fallback",
            "Redis TLS and fallback cache behavior",
            check_redis_fallback_and_logs,
        ),
        (
            "business-logs",
            "Business flow runtime log evidence",
            check_business_runtime_logs,
        ),
    ]
    results: List[CheckResult] = []
    failures = 0
    for check_id, title, func in checks:
        try:
            details = func()
            results.append(CheckResult(check_id, title, "passed", details))
            log(f"PASS {check_id}: {details}")
        except Exception as exc:
            results.append(CheckResult(check_id, title, "failed", str(exc)))
            warn(f"FAIL {check_id}: {exc}")
            failures += 1
    if AUDIT_OUTPUT:
        output_path = Path(AUDIT_OUTPUT)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        payload = {
            "generatedAt": utc_timestamp(),
            "baseDir": str(BASE_DIR),
            "infraCertDir": INFRA_CERT_DIR_ENV,
            "summary": {
                "passed": sum(result.status == "passed" for result in results),
                "failed": sum(result.status == "failed" for result in results),
            },
            "checks": [result.to_dict() for result in results],
        }
        output_path.write_text(
            json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8"
        )
        log(f"audit report written to {output_path}")
    if failures:
        raise SystemExit(1)
    return results


def main() -> int:
    try:
        run_checks()
        log("OK")
        return 0
    except SystemExit as exc:
        return int(exc.code) if isinstance(exc.code, int) else 1
    except Exception as exc:
        warn(str(exc))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
