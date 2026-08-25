"""共享工具函数：HTTP 请求、JSON 提取、彩色日志、汇总报告。"""

from __future__ import annotations

import json
import socket
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from typing import Any


# ─── 异常 ────────────────────────────────────────────────────────────────────


class ToolError(Exception):
    """工具执行失败（非预期错误或前置条件不满足）。"""


# ─── 彩色日志 ─────────────────────────────────────────────────────────────────

_RED = "\033[0;31m"
_GREEN = "\033[0;32m"
_YELLOW = "\033[1;33m"
_NC = "\033[0m"


def log_info(message: str) -> None:
    """输出绿色 [INFO] 日志。"""
    print(f"{_GREEN}[INFO]{_NC}  {message}", flush=True)


def log_warn(message: str) -> None:
    """输出黄色 [WARN] 日志（输出到 stderr）。"""
    print(f"{_YELLOW}[WARN]{_NC}  {message}", file=sys.stderr, flush=True)


def log_error(message: str) -> None:
    """输出红色 [ERROR] 日志（输出到 stderr）。"""
    print(f"{_RED}[ERROR]{_NC} {message}", file=sys.stderr, flush=True)


# ─── 汇总报告 ─────────────────────────────────────────────────────────────────


@dataclass
class SummaryTracker:
    """跟踪操作的成功/失败/跳过计数，并生成汇总报告。

    Attributes:
        success_count: 成功操作数。
        fail_count: 失败操作数。
        skip_count: 跳过操作数。
        fail_items: 失败项记录列表。
    """

    success_count: int = 0
    fail_count: int = 0
    skip_count: int = 0
    fail_items: list[str] = field(default_factory=list)

    def add_success(self) -> None:
        """记录一次成功。"""
        self.success_count += 1

    def add_failure(self, item: str) -> None:
        """记录一次失败。

        Args:
            item: 失败项描述，格式如 `leader(证书失败)`。
        """
        self.fail_count += 1
        self.fail_items.append(item)

    def add_skip(self) -> None:
        """记录一次跳过。"""
        self.skip_count += 1

    @property
    def exit_code(self) -> int:
        """根据失败数决定进程退出码（0 = 全部成功，>0 = 有失败）。"""
        return self.fail_count

    def print_summary(self) -> None:
        """打印操作汇总报告。"""
        print()
        log_info("================================================")
        log_info("  汇总报告")
        log_info("================================================")
        log_info(f"  成功: {self.success_count}")
        if self.fail_count > 0:
            log_error(f"  失败: {self.fail_count} — {' '.join(self.fail_items)}")
        if self.skip_count > 0:
            log_warn(f"  跳过: {self.skip_count}")
        log_info("================================================")


# ─── HTTP 工具 ────────────────────────────────────────────────────────────────


def request_json(
    method: str,
    url: str,
    payload: dict[str, Any] | None = None,
    timeout: int = 30,
) -> tuple[int, dict[str, Any] | None, str]:
    """发送 HTTP 请求，返回 (状态码, 解析后的 JSON 或 None, 原始响应体)。

    Args:
        method: HTTP 方法（GET / POST 等）。
        url: 请求 URL。
        payload: 可选请求体，自动序列化为 JSON。
        timeout: 请求超时秒数。

    Returns:
        (status_code, parsed_body, raw_body) 三元组。

    Raises:
        ToolError: 网络不可达或连接超时时抛出。
    """
    body: bytes | None = None
    headers: dict[str, str] = {"Accept": "application/json"}
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
        headers["Content-Type"] = "application/json"

    request = urllib.request.Request(url, data=body, headers=headers, method=method)
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status: int = response.status
            raw_body: str = response.read().decode("utf-8")
    except urllib.error.HTTPError as exc:
        status = exc.code
        raw_body = exc.read().decode("utf-8")
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, socket.timeout):
            reason = "连接超时"
        raise ToolError(f"HTTP 请求失败: {method} {url} ({reason})") from exc
    except TimeoutError as exc:
        raise ToolError(f"HTTP 请求超时: {method} {url}") from exc

    parsed: dict[str, Any] | None = None
    if raw_body:
        try:
            parsed = json.loads(raw_body)
        except json.JSONDecodeError:
            parsed = None

    return status, parsed, raw_body


def probe_http_endpoint(
    url: str,
    label: str,
    allowed_statuses: set[int] | None = None,
    timeout: int = 10,
) -> None:
    """探测 HTTP 端点可达性。

    Args:
        url: 待探测的 URL。
        label: 日志标识（如 "Registry Health"）。
        allowed_statuses: 允许的 HTTP 状态码集合，默认 {200}。
        timeout: 请求超时秒数。

    Raises:
        ToolError: 端点不可达、超时或返回非预期状态码时抛出。
    """
    if allowed_statuses is None:
        allowed_statuses = {200}

    request = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            status = response.status
        if status not in allowed_statuses:
            expected = ", ".join(str(s) for s in sorted(allowed_statuses))
            raise ToolError(
                f"{label} 检查失败: {url} 返回非预期状态码 {status}，期望 {expected}"
            )
    except urllib.error.HTTPError as exc:
        if exc.code in allowed_statuses:
            return
        body = exc.read().decode("utf-8", "ignore").strip()
        detail = body or f"HTTP {exc.code}"
        raise ToolError(f"{label} 检查失败: {url} 返回 {exc.code} ({detail})") from exc
    except urllib.error.URLError as exc:
        reason = exc.reason
        if isinstance(reason, socket.timeout):
            reason = "连接超时"
        raise ToolError(f"{label} 检查失败: {url} 不可达 ({reason})") from exc
    except TimeoutError as exc:
        raise ToolError(f"{label} 检查失败: {url} 连接超时") from exc


def ensure(condition: bool, message: str) -> None:
    """断言条件为真，否则抛出 ToolError。

    Args:
        condition: 待验证的条件。
        message: 条件不满足时的错误消息。

    Raises:
        ToolError: 条件为假时抛出。
    """
    if not condition:
        raise ToolError(message)


# ─── JSON / 字符串工具 ────────────────────────────────────────────────────────


def extract_json_field(data: str | dict[str, Any], field_name: str) -> str:
    """从 JSON 字符串或字典中安全提取字段值，返回字符串。

    Args:
        data: JSON 字符串或已解析的字典。
        field_name: 要提取的字段名。

    Returns:
        字段的字符串值；布尔值转为 "true"/"false"；缺失或 None 返回空字符串。
    """
    if isinstance(data, str):
        try:
            parsed: dict[str, Any] = json.loads(data)
        except json.JSONDecodeError:
            return ""
    else:
        parsed = data

    value = parsed.get(field_name)
    if isinstance(value, bool):
        return "true" if value else "false"
    if value is None:
        return ""
    return str(value)


def strip_trailing_slash(url: str) -> str:
    """去除 URL 末尾的斜杠。

    Args:
        url: 待处理的 URL 字符串。

    Returns:
        去除末尾斜杠后的 URL。
    """
    return url.rstrip("/")
