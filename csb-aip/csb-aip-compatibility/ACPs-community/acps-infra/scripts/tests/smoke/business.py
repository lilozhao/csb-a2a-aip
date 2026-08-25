"""业务 happy path 冒烟测试：direct_rpc / group 两种模式的完整 API 验证。

通过环境变量配置：
    API_BASE_URL          Web API 基础路径（必填）
    RPC_POLL_INTERVAL     direct_rpc 轮询间隔（秒，默认 1）
    RPC_POLL_TIMEOUT      direct_rpc 轮询超时（秒，默认 120）
    TASK_POLL_TIMEOUT     任务轮询超时（秒，默认 180）
    GROUP_POLL_INTERVAL   group 轮询间隔（秒，默认 2）
    GROUP_POLL_TIMEOUT    group 轮询超时（秒，默认 180）
    HTTP_REQUEST_TIMEOUT  单次 HTTP 请求超时（秒，默认 180）
"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor, as_completed
import json
import os
import sys
import time
import urllib.error
import urllib.request
import uuid

API_BASE_URL = os.environ.get("API_BASE_URL", "").rstrip("/")
RPC_POLL_INTERVAL = float(os.environ.get("RPC_POLL_INTERVAL", "1"))
RPC_POLL_TIMEOUT = int(os.environ.get("RPC_POLL_TIMEOUT", "120"))
TASK_POLL_TIMEOUT = int(os.environ.get("TASK_POLL_TIMEOUT", "180"))
GROUP_POLL_INTERVAL = float(os.environ.get("GROUP_POLL_INTERVAL", "2"))
GROUP_POLL_TIMEOUT = int(os.environ.get("GROUP_POLL_TIMEOUT", "300"))
HTTP_REQUEST_TIMEOUT = int(os.environ.get("HTTP_REQUEST_TIMEOUT", "180"))
GROUP_MIN_MEMBERS = int(os.environ.get("GROUP_MIN_MEMBERS", "2"))
LLM_ERROR_CODES = {"LLM_CALL_ERROR", "LLM_SERVICE_UNAVAILABLE", "LLM_PARSE_ERROR"}
GREETING_QUERY = "你好。"
TRAVEL_PLAN_QUERY = "请帮我规划一个北京三日游，两人同行，我从上海出发，出行日期是 2026-05-01 到 2026-05-03，预算 5000 元，想要景点、美食、酒店和交通建议。"
TRAVEL_SUPPLEMENT_QUERY = "补充一下，我更想住朝阳区，晚餐偏向北京特色菜，预算可以提高到 6000 元；城际交通按上海往返北京、5 月 1 日出发 5 月 3 日返程来规划。"


# ─── 异常 ─────────────────────────────────────────────────────────────────────


class SmokeFailure(Exception):
    pass


class SkipBusiness(Exception):
    pass


# ─── 日志 ─────────────────────────────────────────────────────────────────────


def log(message: str) -> None:
    print(f"[smoke-test-business] {message}", flush=True)


def warn(message: str) -> None:
    print(f"[smoke-test-business] WARN: {message}", file=sys.stderr, flush=True)


# ─── HTTP 工具 ────────────────────────────────────────────────────────────────


def request_json(
    method: str,
    path: str,
    payload: dict | None = None,
    timeout: int = HTTP_REQUEST_TIMEOUT,
) -> tuple[int, dict | None, str]:
    """发送 HTTP 请求，返回 (status_code, parsed_json_or_none, raw_body)。

    Args:
        method: HTTP 方法，如 GET / POST。
        path: 路径或完整 URL；相对路径自动拼接 API_BASE_URL。
        payload: 请求体（自动序列化为 JSON）。
        timeout: 超时秒数。

    Returns:
        (status_code, parsed, raw_body) 三元组。

    Raises:
        SmokeFailure: 网络错误或超时。
    """
    url = path if path.startswith("http") else f"{API_BASE_URL}/{path.lstrip('/')}"
    body: bytes | None = None
    headers: dict[str, str] = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"
    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
            raw_body = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw_body = exc.read().decode("utf-8")
    except TimeoutError as exc:
        raise SmokeFailure(f"HTTP 请求超时: {method} {url}") from exc
    except urllib.error.URLError as exc:
        raise SmokeFailure(f"HTTP 请求失败: {method} {url}: {exc.reason}") from exc

    try:
        parsed = json.loads(raw_body) if raw_body else None
    except json.JSONDecodeError:
        parsed = None
    return status, parsed, raw_body


# ─── 工具函数 ─────────────────────────────────────────────────────────────────


def maybe_skip_for_llm(status: int, parsed: dict | None, context: str) -> None:
    """LLM 错误时抛出 SkipBusiness（跳过，不视为失败）。"""
    if status != 500 or not isinstance(parsed, dict):
        return
    detail = parsed.get("detail")
    if isinstance(detail, dict) and detail.get("code") in LLM_ERROR_CODES:
        raise SkipBusiness(f"{context}: {detail['code']}")
    error = parsed.get("error")
    if isinstance(error, dict) and error.get("code") in LLM_ERROR_CODES:
        raise SkipBusiness(f"{context}: {error['code']}")


def ensure(condition: bool, message: str) -> None:
    """断言，条件不满足时抛出 SmokeFailure。"""
    if not condition:
        raise SmokeFailure(message)


def new_request_id(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:12]}"


def summarize_group_runtime(runtime: dict) -> str:
    members = runtime.get("members") or []
    member_parts = []
    for member in members:
        member_parts.append(
            (
                f"{member.get('partnerAic')}:route={member.get('invitationRoute')},"
                f"connected={member.get('connected')},queue={member.get('queueName')}"
            )
        )
    return (
        f"groupId={runtime.get('groupId')} state={runtime.get('state')} "
        f"connected={runtime.get('connectedMembers')}/{runtime.get('totalMembers')} "
        f"pending={runtime.get('pendingInvitations')} members=[{'; '.join(member_parts)}]"
    )


def find_group_member(runtime: dict, partner_aic: str) -> dict | None:
    for member in runtime.get("members") or []:
        if member.get("partnerAic") == partner_aic:
            return member
    return None


def extract_group_id(result: dict, active_task: dict) -> str | None:
    """从多个可能字段中提取 group_id，兼容不同返回结构。"""
    for candidate in (
        result.get("groupId"),
        result.get("group_id"),
        active_task.get("groupId"),
        active_task.get("group_id"),
    ):
        if isinstance(candidate, str) and candidate:
            return candidate
    return None


# ─── API 操作 ─────────────────────────────────────────────────────────────────


def submit(
    query: str,
    mode: str,
    session_id: str | None = None,
    active_task_id: str | None = None,
) -> tuple[str, str]:
    """提交请求，返回 (session_id, active_task_id)。"""
    payload: dict = {
        "query": query,
        "mode": mode,
        "clientRequestId": new_request_id(mode),
    }
    if session_id:
        payload["sessionId"] = session_id
    if active_task_id:
        payload["activeTaskId"] = active_task_id

    status, parsed, raw_body = request_json("POST", "submit", payload)
    maybe_skip_for_llm(status, parsed, f"submit[{mode}]")
    ensure(status == 200, f"submit[{mode}] 返回 {status}: {raw_body}")
    ensure(isinstance(parsed, dict), f"submit[{mode}] 返回非 JSON: {raw_body}")

    result = parsed.get("result")
    ensure(isinstance(result, dict), f"submit[{mode}] 缺少 result: {parsed}")
    ensure(
        result.get("mode") == mode, f"submit[{mode}] mode 不匹配: {result.get('mode')}"
    )
    for field in ("sessionId", "activeTaskId", "acceptedAt", "externalStatus"):
        ensure(
            field in result and result[field],
            f"submit[{mode}] 缺少字段 {field}: {result}",
        )
    return result["sessionId"], result["activeTaskId"]


def poll_result(
    session_id: str,
    expected_mode: str,
    timeout_seconds: int,
    interval_seconds: float,
) -> dict:
    """轮询 result API 直至收敛（final / clarification / error）或超时。"""
    deadline = time.time() + timeout_seconds
    last_snapshot: dict | None = None
    while time.time() < deadline:
        status, parsed, raw_body = request_json("GET", f"result/{session_id}")
        maybe_skip_for_llm(status, parsed, f"result[{expected_mode}]")
        ensure(status == 200, f"result[{expected_mode}] 返回 {status}: {raw_body}")
        ensure(
            isinstance(parsed, dict), f"result[{expected_mode}] 返回非 JSON: {raw_body}"
        )

        result = parsed.get("result")
        ensure(
            isinstance(result, dict), f"result[{expected_mode}] 缺少 result: {parsed}"
        )
        ensure(
            result.get("sessionId") == session_id,
            f"result[{expected_mode}] sessionId 不匹配",
        )
        ensure(
            result.get("mode") == expected_mode,
            f"result[{expected_mode}] mode 不匹配: {result.get('mode')}",
        )

        user_result = result.get("userResult") or {}
        active_task = result.get("activeTask") or {}
        partner_tasks = active_task.get("partnerTasks") or {}
        dialog_context = result.get("dialogContext") or {}
        recent_turns = dialog_context.get("recentTurns") or []
        group_id = extract_group_id(result, active_task)

        last_snapshot = {
            "result_type": user_result.get("type"),
            "session_id": result.get("sessionId"),
            "active_task_id": active_task.get("activeTaskId"),
            "active_task_status": active_task.get("externalStatus"),
            "partner_task_count": len(partner_tasks),
            "dialog_turns": len(recent_turns),
            "group_id": group_id,
            "closed": bool(result.get("closed")),
        }

        if last_snapshot["result_type"] in {"final", "clarification", "error"}:
            return last_snapshot

        time.sleep(interval_seconds)

    raise SmokeFailure(
        f"轮询超时: mode={expected_mode}, session={session_id}, last={last_snapshot}"
    )


def cancel_session(session_id: str) -> None:
    """取消会话并验证 closed 状态。"""
    status, parsed, raw_body = request_json("POST", f"cancel/{session_id}")
    ensure(status == 200, f"cancel 返回 {status}: {raw_body}")
    ensure(isinstance(parsed, dict), f"cancel 返回非 JSON: {raw_body}")

    status, parsed, raw_body = request_json("GET", f"result/{session_id}")
    ensure(status == 200, f"cancel 后查询 result 返回 {status}: {raw_body}")
    ensure(isinstance(parsed, dict), f"cancel 后 result 返回非 JSON: {raw_body}")
    result = parsed.get("result")
    ensure(isinstance(result, dict), f"cancel 后 result 为空: {parsed}")
    ensure(bool(result.get("closed")), f"cancel 后 closed 未置为 true: {result}")


def cancel_and_delete_session(session_id: str) -> None:
    """取消并删除会话，验证 session/group 均不可再查询。"""
    status, parsed, raw_body = request_json(
        "POST",
        f"cancel/{session_id}",
        {"deleteSession": True},
    )
    ensure(status == 200, f"cancel(delete) 返回 {status}: {raw_body}")
    ensure(isinstance(parsed, dict), f"cancel(delete) 返回非 JSON: {raw_body}")
    result = parsed.get("result")
    ensure(isinstance(result, dict), f"cancel(delete) 缺少 result: {parsed}")
    ensure(result.get("sessionDeleted") is True, f"session 未删除: {result}")

    status, _, raw_body = request_json("GET", f"result/{session_id}")
    ensure(status == 404, f"删除后 result 仍可查询: {status} {raw_body}")

    status, _, raw_body = request_json("GET", f"group/{session_id}")
    ensure(status == 404, f"删除后 group runtime 仍可查询: {status} {raw_body}")


def get_group_runtime(session_id: str) -> dict:
    """获取群组运行态。"""
    status, parsed, raw_body = request_json("GET", f"group/{session_id}")
    ensure(status == 200, f"group runtime 返回 {status}: {raw_body}")
    ensure(isinstance(parsed, dict), f"group runtime 返回非 JSON: {raw_body}")
    result = parsed.get("result")
    ensure(isinstance(result, dict), f"group runtime 缺少 result: {parsed}")
    return result


def wait_for_group_runtime(
    session_id: str,
    description: str,
    predicate,
    timeout_seconds: int = GROUP_POLL_TIMEOUT,
    interval_seconds: float = GROUP_POLL_INTERVAL,
) -> dict:
    """轮询群组运行态直到满足条件。"""
    deadline = time.time() + timeout_seconds
    last_runtime: dict | None = None
    while time.time() < deadline:
        runtime = get_group_runtime(session_id)
        last_runtime = runtime
        if predicate(runtime):
            log(f"{description}: {summarize_group_runtime(runtime)}")
            return runtime
        time.sleep(interval_seconds)

    raise SmokeFailure(
        f"{description} 超时: session={session_id}, last={summarize_group_runtime(last_runtime or {})}"
    )


def request_group_member_leave(session_id: str, partner_aic: str) -> None:
    """请求指定 Partner 优雅退出。"""
    status, parsed, raw_body = request_json(
        "POST",
        f"group/{session_id}/members/{partner_aic}/leave",
    )
    ensure(status == 200, f"request leave 返回 {status}: {raw_body}")
    ensure(isinstance(parsed, dict), f"request leave 返回非 JSON: {raw_body}")
    result = parsed.get("result")
    ensure(isinstance(result, dict), f"request leave 缺少 result: {parsed}")
    ensure(result.get("action") == "request-leave", f"request leave 动作异常: {result}")


def force_remove_group_member(session_id: str, partner_aic: str) -> None:
    """强制移除指定 Partner。"""
    status, parsed, raw_body = request_json(
        "DELETE",
        f"group/{session_id}/members/{partner_aic}",
    )
    ensure(status == 200, f"force remove 返回 {status}: {raw_body}")
    ensure(isinstance(parsed, dict), f"force remove 返回非 JSON: {raw_body}")
    result = parsed.get("result")
    ensure(isinstance(result, dict), f"force remove 缺少 result: {parsed}")
    ensure(result.get("action") == "force-remove", f"force remove 动作异常: {result}")


# ─── 测试场景 ─────────────────────────────────────────────────────────────────


def run_direct_rpc() -> None:
    """direct_rpc 模式：四轮多轮对话 + 取消场景。"""
    log("direct_rpc turn 1: greeting")
    session_id, _ = submit(
        query=GREETING_QUERY,
        mode="direct_rpc",
    )
    snapshot = poll_result(
        session_id, "direct_rpc", RPC_POLL_TIMEOUT, RPC_POLL_INTERVAL
    )
    ensure(
        snapshot["result_type"] in {"final", "clarification"},
        f"direct_rpc turn 1 未收敛: {snapshot}",
    )
    ensure(snapshot["dialog_turns"] >= 1, f"direct_rpc turn 1 对话轮次异常: {snapshot}")
    if snapshot["partner_task_count"] >= 1:
        warn(
            "direct_rpc turn 1 已进入任务澄清流程，按实际运行结果继续后续多轮 happy path"
        )

    log("direct_rpc turn 2: create task")
    session_id_again, _ = submit(
        query=TRAVEL_PLAN_QUERY,
        mode="direct_rpc",
        session_id=session_id,
        active_task_id=snapshot["active_task_id"],
    )
    ensure(session_id_again == session_id, "direct_rpc turn 2 sessionId 发生变化")
    snapshot = poll_result(
        session_id, "direct_rpc", TASK_POLL_TIMEOUT, RPC_POLL_INTERVAL
    )
    ensure(
        snapshot["result_type"] in {"final", "clarification"},
        f"direct_rpc turn 2 未收敛: {snapshot}",
    )
    ensure(snapshot["dialog_turns"] >= 2, f"direct_rpc turn 2 对话轮次异常: {snapshot}")
    ensure(
        snapshot["partner_task_count"] >= 1,
        f"direct_rpc turn 2 未观察到 partnerTasks: {snapshot}",
    )

    log("direct_rpc turn 3: supplement task")
    session_id_again, _ = submit(
        query=TRAVEL_SUPPLEMENT_QUERY,
        mode="direct_rpc",
        session_id=session_id,
        active_task_id=snapshot["active_task_id"],
    )
    ensure(session_id_again == session_id, "direct_rpc turn 3 sessionId 发生变化")
    snapshot = poll_result(
        session_id, "direct_rpc", TASK_POLL_TIMEOUT, RPC_POLL_INTERVAL
    )
    ensure(
        snapshot["result_type"] in {"final", "clarification"},
        f"direct_rpc turn 3 未收敛: {snapshot}",
    )
    ensure(snapshot["dialog_turns"] >= 3, f"direct_rpc turn 3 对话轮次异常: {snapshot}")

    log("direct_rpc turn 4: cancel session")
    cancel_session(session_id)


def run_group() -> None:
    """group 模式：真实验证 MQ inbox 邀请、加入、优雅退出、强制移除与清理。"""
    log("group turn 1: greeting")
    session_id, _ = submit(
        query=GREETING_QUERY,
        mode="group",
    )
    snapshot = poll_result(session_id, "group", GROUP_POLL_TIMEOUT, GROUP_POLL_INTERVAL)
    ensure(
        snapshot["result_type"] in {"final", "clarification"},
        f"group turn 1 未收敛: {snapshot}",
    )
    ensure(snapshot["dialog_turns"] >= 1, f"group turn 1 对话轮次异常: {snapshot}")
    if snapshot["partner_task_count"] >= 1:
        warn("group turn 1 已进入任务澄清流程，按实际运行结果继续后续多轮 happy path")

    log("group turn 2: create task")
    session_id_again, _ = submit(
        query=TRAVEL_PLAN_QUERY,
        mode="group",
        session_id=session_id,
        active_task_id=snapshot["active_task_id"],
    )
    ensure(session_id_again == session_id, "group turn 2 sessionId 发生变化")
    snapshot = poll_result(session_id, "group", GROUP_POLL_TIMEOUT, GROUP_POLL_INTERVAL)
    ensure(
        snapshot["result_type"] in {"final", "clarification"},
        f"group turn 2 未收敛: {snapshot}",
    )
    ensure(snapshot["dialog_turns"] >= 2, f"group turn 2 对话轮次异常: {snapshot}")
    ensure(
        snapshot["partner_task_count"] >= 2,
        f"group turn 2 未观察到多个 partnerTasks: {snapshot}",
    )
    if not snapshot["group_id"]:
        warn(
            f"group turn 2 未在 result 中暴露 groupId，改用 /group 运行态补齐: {snapshot}"
        )

    expected_group_id = snapshot["group_id"]
    runtime = wait_for_group_runtime(
        session_id,
        "group turn 2 runtime ready",
        lambda current: (
            (
                (current.get("groupId") == expected_group_id)
                if expected_group_id
                else bool(current.get("groupId"))
            )
            and len(current.get("members") or []) >= GROUP_MIN_MEMBERS
            and current.get("connectedMembers") == len(current.get("members") or [])
            and not (current.get("pendingInvitations") or [])
            and all(
                member.get("invitationRoute") == "inbox"
                for member in (current.get("members") or [])
            )
        ),
    )
    snapshot["group_id"] = snapshot["group_id"] or runtime.get("groupId")
    member_aics = [member["partnerAic"] for member in runtime["members"]]
    ensure(
        len(member_aics) >= GROUP_MIN_MEMBERS,
        f"group runtime 成员数不足，无法覆盖优雅退出/强制移除场景: {runtime}",
    )

    log("group turn 3: supplement task")
    session_id_again, _ = submit(
        query=TRAVEL_SUPPLEMENT_QUERY,
        mode="group",
        session_id=session_id,
        active_task_id=snapshot["active_task_id"],
    )
    ensure(session_id_again == session_id, "group turn 3 sessionId 发生变化")
    snapshot = poll_result(session_id, "group", GROUP_POLL_TIMEOUT, GROUP_POLL_INTERVAL)
    ensure(
        snapshot["result_type"] in {"final", "clarification"},
        f"group turn 3 未收敛: {snapshot}",
    )
    ensure(snapshot["dialog_turns"] >= 3, f"group turn 3 对话轮次异常: {snapshot}")
    ensure(
        snapshot["partner_task_count"] >= 2,
        f"group turn 3 未维持多个 partnerTasks: {snapshot}",
    )
    wait_for_group_runtime(
        session_id,
        "group turn 3 runtime stable",
        lambda current: (
            all(
                find_group_member(current, partner_aic) is not None
                for partner_aic in member_aics
            )
            and all(
                (find_group_member(current, partner_aic) or {}).get("invitationRoute")
                == "inbox"
                for partner_aic in member_aics
            )
        ),
    )

    graceful_members = member_aics[:-1]
    force_member = member_aics[-1]
    log(
        "group lifecycle: graceful leave for "
        + ", ".join(graceful_members)
        + f"; force remove {force_member}"
    )

    for partner_aic in graceful_members:
        request_group_member_leave(session_id, partner_aic)

    wait_for_group_runtime(
        session_id,
        "group graceful leaves observed",
        lambda current: all(
            (
                (member := find_group_member(current, partner_aic)) is not None
                and member.get("connected") is False
            )
            for partner_aic in graceful_members
        )
        and (find_group_member(current, force_member) or {}).get("connected") is True,
    )

    force_remove_group_member(session_id, force_member)
    wait_for_group_runtime(
        session_id,
        "group force remove observed",
        lambda current: find_group_member(current, force_member) is None
        and all(
            (
                (member := find_group_member(current, partner_aic)) is not None
                and member.get("connected") is False
            )
            for partner_aic in graceful_members
        ),
    )

    log("group turn 4: cancel and delete session")
    cancel_and_delete_session(session_id)


def run_business_scenarios() -> None:
    scenarios = [
        ("direct_rpc", run_direct_rpc),
        ("group", run_group),
    ]
    failures: list[str] = []
    skip_exception: SkipBusiness | None = None

    log("parallel scenarios: direct_rpc + group")
    with ThreadPoolExecutor(max_workers=len(scenarios)) as executor:
        future_to_name = {executor.submit(func): name for name, func in scenarios}
        for future in as_completed(future_to_name):
            scenario_name = future_to_name[future]
            try:
                future.result()
                log(f"{scenario_name} scenario completed")
            except SkipBusiness as exc:
                if skip_exception is None:
                    skip_exception = exc
            except SmokeFailure as exc:
                failures.append(f"{scenario_name}: {exc}")
            except Exception as exc:
                failures.append(f"{scenario_name}: unexpected error: {exc}")

    if failures:
        raise SmokeFailure("; ".join(failures))
    if skip_exception is not None:
        raise skip_exception


# ─── 主函数 ───────────────────────────────────────────────────────────────────


def main() -> int:
    """运行全部冒烟场景，返回进程退出码。"""
    if not API_BASE_URL:
        warn("API_BASE_URL 未设置")
        return 1
    try:
        run_business_scenarios()
        log("OK")
        return 0
    except SkipBusiness as exc:
        warn(f"跳过业务测试: {exc}")
        return 0
    except SmokeFailure as exc:
        warn(str(exc))
        return 1
