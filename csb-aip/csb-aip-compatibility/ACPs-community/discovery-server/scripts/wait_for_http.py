#!/usr/bin/env python3
"""等待 HTTP 端点达到预期状态。"""

from __future__ import annotations

import argparse
import time

import click
import httpx


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="等待 HTTP 端点返回期望状态")
    parser.add_argument("url", help="待检查的 HTTP URL")
    parser.add_argument("--timeout", type=float, default=30.0, help="最大等待秒数")
    parser.add_argument("--interval", type=float, default=0.5, help="轮询间隔秒数")
    parser.add_argument("--expect-status", type=int, default=200, help="期望的 HTTP 状态码")
    parser.add_argument("--expect-json-key", default="", help="期望的 JSON 字段名")
    parser.add_argument("--expect-json-value", default="", help="期望的 JSON 字段值")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    deadline = time.monotonic() + args.timeout
    last_error = ""

    while time.monotonic() < deadline:
        try:
            response = httpx.get(args.url, timeout=2.0)
            if response.status_code != args.expect_status:
                last_error = f"unexpected status: {response.status_code}"
            elif args.expect_json_key:
                payload = response.json()
                actual_value = payload.get(args.expect_json_key)
                if str(actual_value) == args.expect_json_value:
                    return 0
                last_error = (
                    f"unexpected json value for {args.expect_json_key}: "
                    f"expected {args.expect_json_value!r}, got {actual_value!r}"
                )
            else:
                return 0
        except (httpx.HTTPError, ValueError) as exc:
            last_error = str(exc)

        time.sleep(args.interval)

    click.echo(f"[ERROR] 等待 HTTP 端点超时: {args.url}", err=True)
    if last_error:
        click.echo(f"[ERROR] 最后一次检查结果: {last_error}", err=True)
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
