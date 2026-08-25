"""Discovery 服务交互：DSP 同步触发与查询验证。

错误分级策略：
  - DB 过滤查询失败 → ToolError（ERROR，计入 FAIL_COUNT）
  - 语义查询失败   → 仅 log_warn（WARNING，不影响退出码）
"""

from __future__ import annotations

import os
import subprocess
import time
from typing import Any

from .utils import ToolError, ensure, log_info, log_warn, request_json

# ─── DSP 同步触发 ─────────────────────────────────────────────────────────────

# 容器内 discovery-server 的内部端口
_INTERNAL_PORT = 9005
_DSP_ADMIN_TIMEOUT_SECONDS = 30
_DSP_SYNC_REQUEST_TIMEOUT_SECONDS = 120
_DSP_SYNC_WAIT_TIMEOUT_SECONDS = int(
    os.environ.get("DISCOVERY_DSP_SYNC_WAIT_TIMEOUT_SECONDS", "600")
)
_DSP_SYNC_WAIT_INTERVAL_SECONDS = int(
    os.environ.get("DISCOVERY_DSP_SYNC_WAIT_INTERVAL_SECONDS", "5")
)


def trigger_sync(gateway_url: str) -> None:
    """触发 Discovery Server 的 DSP 数据同步。

    先尝试通过 gateway admin API 触发；若不可达且 docker 可用，
    则 fallback 到 docker exec 直接调用容器内部接口。

    Args:
        gateway_url: Discovery 网关基础 URL（已去除末尾斜杠）。

    Raises:
        ToolError: 同步失败且无法通过任何途径完成时抛出。
    """
    gateway_error: ToolError | None = None
    try:
        _trigger_sync_via_gateway(gateway_url)
        return
    except ToolError as exc:
        gateway_error = exc
        if not _is_gateway_connectivity_error(exc):
            raise

    # fallback: docker exec
    container_name = _find_discovery_container()
    if not container_name:
        raise ToolError(
            "discovery admin/dsp 网关不可达，且未找到运行中的 discovery-server 容器"
            f"（原始错误: {gateway_error}）"
        )

    log_warn("discovery admin/dsp 网关不可达，回退到 docker exec 内部接口")
    _trigger_sync_via_docker_exec(container_name)


def _is_gateway_connectivity_error(exc: ToolError) -> bool:
    """判断错误是否属于网关连通性问题，可尝试 fallback 到 docker exec。"""
    message = str(exc)
    return (
        "HTTP 请求失败:" in message
        or "HTTP 请求超时:" in message
        or "检查失败:" in message and ("不可达" in message or "连接超时" in message)
    )


def _trigger_sync_via_gateway(gateway_url: str) -> None:
    """通过网关 admin API 触发 DSP 同步。"""
    status, parsed, raw = request_json(
        "POST",
        f"{gateway_url}/admin/dsp/hard-reset",
        timeout=_DSP_ADMIN_TIMEOUT_SECONDS,
    )
    ensure(status == 200, f"DSP hard-reset 失败: {status} {raw}")

    try:
        status, parsed, raw = request_json(
            "POST",
            f"{gateway_url}/admin/dsp/sync",
            timeout=_DSP_SYNC_REQUEST_TIMEOUT_SECONDS,
        )
        if status != 200:
            if status == 504:
                log_warn("DSP sync 请求被网关以 504 超时返回，改为轮询 status 等待完成")
            else:
                raise ToolError(f"DSP sync 失败: {status} {raw}")
    except ToolError as exc:
        if "超时" not in str(exc):
            raise
        log_warn(
            "DSP sync 请求超过 "
            f"{_DSP_SYNC_REQUEST_TIMEOUT_SECONDS}s，改为轮询 status 等待完成"
        )

    parsed = _wait_for_gateway_sync_completion(gateway_url)

    counts: dict[str, int] = parsed.get("object_count_by_type") or {}  # type: ignore[union-attr]
    log_info(f"DSP 同步完成，当前 ACS 对象数: {counts.get('acs', 0)}")


def _wait_for_gateway_sync_completion(gateway_url: str) -> dict[str, Any]:
    """轮询 DSP status，等待同步完成。"""
    deadline = time.time() + _DSP_SYNC_WAIT_TIMEOUT_SECONDS
    last_error = ""

    while time.time() < deadline:
        try:
            status, parsed, raw = request_json(
                "GET",
                f"{gateway_url}/admin/dsp/status",
                timeout=_DSP_ADMIN_TIMEOUT_SECONDS,
            )
            ensure(
                status == 200 and isinstance(parsed, dict),
                f"DSP status 失败: {status} {raw}",
            )

            counts: dict[str, int] = parsed.get("object_count_by_type") or {}  # type: ignore[union-attr]
            last_error = str(parsed)
            if (
                parsed.get("needs_snapshot") is False
                and parsed.get("last_sync_time")
                and (counts.get("acs") or 0) >= 1
            ):
                return parsed
        except ToolError as exc:
            last_error = str(exc)

        time.sleep(_DSP_SYNC_WAIT_INTERVAL_SECONDS)

    raise ToolError(
        "DSP status 轮询超时 "
        f"（{_DSP_SYNC_WAIT_TIMEOUT_SECONDS}s），最后状态: {last_error}"
    )


def _find_discovery_container() -> str:
    """查找正在运行的 discovery-server 容器名称。

    Returns:
        容器名；未找到或 docker 不可用时返回空字符串。
    """
    try:
        result = subprocess.run(
            ["docker", "ps", "--format", "{{.Names}}"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            timeout=10,
        )
        if result.returncode != 0:
            return ""
        for line in result.stdout.splitlines():
            if line.startswith("discovery-server-"):
                return line.strip()
        return ""
    except (FileNotFoundError, subprocess.TimeoutExpired):
        return ""


_DOCKER_SYNC_SCRIPT = f"""
import json, time, urllib.request, urllib.error

SYNC_REQUEST_TIMEOUT = {_DSP_SYNC_REQUEST_TIMEOUT_SECONDS}
STATUS_TIMEOUT = {_DSP_ADMIN_TIMEOUT_SECONDS}
WAIT_TIMEOUT = {_DSP_SYNC_WAIT_TIMEOUT_SECONDS}
WAIT_INTERVAL = {_DSP_SYNC_WAIT_INTERVAL_SECONDS}

def call(method, url, timeout):
    req = urllib.request.Request(url, headers={{"Accept":"application/json"}}, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, json.loads(r.read().decode("utf-8"))
    except urllib.error.HTTPError as e:
        raise SystemExit(f"{{method}} {{url}} failed: {{e.code}}")

base = "http://127.0.0.1:{_INTERNAL_PORT}"
call("POST", base + "/admin/dsp/hard-reset", STATUS_TIMEOUT)

try:
    call("POST", base + "/admin/dsp/sync", SYNC_REQUEST_TIMEOUT)
except TimeoutError:
    pass

deadline = time.time() + WAIT_TIMEOUT
last_status = None
while time.time() < deadline:
    status, parsed = call("GET", base + "/admin/dsp/status", STATUS_TIMEOUT)
    counts = parsed.get("object_count_by_type") or {{}}
    last_status = parsed
    if (
        parsed.get("needs_snapshot") is False
        and parsed.get("last_sync_time")
        and (counts.get("acs") or 0) >= 1
    ):
        break
    time.sleep(WAIT_INTERVAL)
else:
    raise SystemExit(f"DSP status polling timed out: {{last_status}}")
"""


def _trigger_sync_via_docker_exec(container_name: str) -> None:
    """通过 docker exec 在容器内执行 DSP 同步脚本。"""
    result = subprocess.run(
        ["docker", "exec", container_name, "python", "-c", _DOCKER_SYNC_SCRIPT],
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=60,
    )
    if result.returncode != 0:
        raise ToolError(
            f"docker exec DSP 同步失败: {(result.stdout + result.stderr).strip()}"
        )
    log_info("DSP 同步完成（via docker exec）")


# ─── 通用查询 ─────────────────────────────────────────────────────────────────


def query(
    gateway_url: str, payload: dict[str, Any], timeout: int = 90
) -> dict[str, Any]:
    """向 discovery API 发送查询请求，返回原始结果。

    此函数不对结果做任何验证，查询结果的判断由调用者负责。

    Args:
        gateway_url: Discovery 网关基础 URL。
        payload: 符合 ADP Discovery API 格式的查询 payload。
        timeout: 请求超时秒数。

    Returns:
        Discovery API 的原始 JSON 响应字典。

    Raises:
        ToolError: HTTP 请求失败或响应非 JSON 时抛出。
    """
    discover_url = f"{gateway_url}/acps-adp-v2/discover"
    status, parsed, raw = request_json("POST", discover_url, payload, timeout=timeout)
    ensure(status == 200, f"Discovery 查询失败: {status} {raw}")
    ensure(isinstance(parsed, dict), f"Discovery 查询返回非 JSON: {raw}")
    return parsed  # type: ignore[return-value]


# ─── 验证：DB 过滤查询（失败 = ERROR） ───────────────────────────────────────


def verify_filtered_query(
    gateway_url: str,
    aic: str,
    expected_active: bool,
) -> None:
    """通过数据库过滤查询验证 agent 可被 discovery 查询到。

    此接口使用 registry DB 数据，不依赖 LLM，失败直接报错。

    Args:
        gateway_url: Discovery 网关基础 URL。
        aic: 期望查询到的 agent AIC。
        expected_active: 期望该 agent 处于活跃状态。

    Raises:
        ToolError: 查询失败或结果不符合预期时抛出。
    """
    discover_url = f"{gateway_url}/acps-adp-v2/discover"

    default_payload: dict[str, Any] = {
        "type": "filtered",
        "query": "",
        "limit": 5,
        "filter": {
            "conditions": [
                {"field": "aic", "op": "eq", "value": aic},
                {"field": "onlyAvailable", "op": "eq", "value": False},
            ]
        },
    }
    status, parsed, raw = request_json(
        "POST", discover_url, default_payload, timeout=90
    )
    ensure(status == 200, f"Discovery 过滤查询失败: {status} {raw}")
    ensure(isinstance(parsed, dict), f"Discovery 过滤查询返回非 JSON: {raw}")

    default_groups = (parsed.get("result") or {}).get("agents") or []
    default_agents = (
        (default_groups[0].get("agentSkills") or []) if default_groups else []
    )

    if expected_active:
        ensure(
            len(default_agents) >= 1, f"期望 active agent 未在过滤查询中找到: {parsed}"
        )

        # 追加 active 字段的二次确认
        explicit_payload: dict[str, Any] = {
            "type": "filtered",
            "query": "",
            "limit": 5,
            "filter": {
                "conditions": [
                    {"field": "aic", "op": "eq", "value": aic},
                    {"field": "onlyAvailable", "op": "eq", "value": False},
                    {"field": "active", "op": "eq", "value": True},
                ]
            },
        }
        status, parsed, raw = request_json(
            "POST", discover_url, explicit_payload, timeout=90
        )
        ensure(status == 200, f"Discovery active 过滤查询失败: {status} {raw}")
        ensure(isinstance(parsed, dict), f"Discovery active 过滤查询返回非 JSON: {raw}")

        explicit_groups = (parsed.get("result") or {}).get("agents") or []
        explicit_agents = (
            (explicit_groups[0].get("agentSkills") or []) if explicit_groups else []
        )
        ensure(len(explicit_agents) >= 1, f"期望 active=true agent 未出现: {parsed}")

        acs_map: dict[str, Any] = (parsed.get("result") or {}).get("acsMap") or {}
        acs_payload = acs_map.get(aic) or {}
        ensure(
            acs_payload.get("active") is True,
            f"ACS active 字段不符预期: {acs_payload}",
        )
    else:
        ensure(
            len(default_agents) == 0,
            f"inactive agent 意外出现在过滤查询结果中: {parsed}",
        )


def wait_for_query_state(
    gateway_url: str,
    aic: str,
    expected_active: bool,
    timeout_seconds: int = 120,
    interval_seconds: int = 5,
) -> None:
    """轮询等待 discovery DB 过滤查询进入预期状态。

    Args:
        gateway_url: Discovery 网关基础 URL。
        aic: 期望查询到的 agent AIC。
        expected_active: 期望状态。
        timeout_seconds: 最大等待秒数（默认 120）。
        interval_seconds: 轮询间隔秒数（默认 5）。

    Raises:
        ToolError: 超时后仍未满足预期时抛出。
    """
    deadline = time.time() + timeout_seconds
    last_error: Exception | None = None

    while time.time() < deadline:
        try:
            verify_filtered_query(gateway_url, aic, expected_active)
            return
        except ToolError as exc:
            last_error = exc
            time.sleep(interval_seconds)

    raise ToolError(
        f"discovery 过滤查询轮询超时（{timeout_seconds}s），最后错误: {last_error}"
    )


# ─── 验证：语义查询（失败 = WARNING） ────────────────────────────────────────


def verify_semantic_query(gateway_url: str) -> list[str]:
    """执行语义查询验证（依赖 LLM），收集失败告警。

    语义查询测试使用固定的中文旅游场景关键词，属于软验证——
    失败只产生告警，不影响整体流程成功状态。

    Args:
        gateway_url: Discovery 网关基础 URL。

    Returns:
        告警消息列表（空列表表示全部通过）。
    """
    warnings: list[str] = []
    discover_url = f"{gateway_url}/acps-adp-v2/discover"
    test_queries = ["北京美食推荐", "酒店预订"]

    for q in test_queries:
        payload: dict[str, Any] = {"type": "explicit", "query": q, "limit": 5}
        try:
            status, parsed, raw = request_json(
                "POST", discover_url, payload, timeout=90
            )
            if status != 200:
                warnings.append(f"语义查询 [{q}] 返回 {status}: {raw[:200]}")
                continue
            if not isinstance(parsed, dict):
                warnings.append(f"语义查询 [{q}] 返回非 JSON")
                continue
            groups = (parsed.get("result") or {}).get("agents") or []
            agents = (groups[0].get("agentSkills") or []) if groups else []
            if len(agents) < 1:
                warnings.append(f"语义查询 [{q}] 结果为空")
            else:
                log_info(f"语义查询 [{q}] 通过，找到 {len(agents)} 个 agent")
        except ToolError as exc:
            warnings.append(f"语义查询 [{q}] 失败: {exc}")

    return warnings
