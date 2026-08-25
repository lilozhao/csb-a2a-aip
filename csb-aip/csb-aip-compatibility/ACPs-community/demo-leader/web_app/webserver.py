"""最简静态文件服务器 (仅提供 web_app 目录静态资源, 不做 API 代理)

使用标准库 http.server, 避免对 FastAPI / Uvicorn 等依赖；可直接使用全局 python 运行。

用法:
    python web_app/webserver.py            # 默认 127.0.0.1:9010
    python web_app/webserver.py --port 4000 # 指定端口

说明:
    - 根路径 http://127.0.0.1:9010/ 自动返回 index.html (SimpleHTTPRequestHandler 默认行为)
    - 仅用于前端静态调试；/user_api 等调用仍需指向后端服务 (例如 9011)；前端 fetch('/user_api') 在纯静态环境将失败，需手动改为完整后端 URL。
  - 若需要同源代理，请使用之前的 FastAPI 版本或自行扩展。
"""

from __future__ import annotations

import argparse
import contextlib
import http.server
import os
import socket
import socketserver
import sys
from pathlib import Path

from leader.runtime_paths import resolve_web_app_root

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 9010


class QuietHandler(http.server.SimpleHTTPRequestHandler):
    # 关闭默认的控制台日志 (可根据需要改成 pass 调试)
    def log_message(self, format: str, *args):
        sys.stderr.write("[static] " + (format % args) + "\n")

    def end_headers(self):
        """Tell the browser not to cache responses so edits show immediately."""
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()


def find_free_port(host: str, port: int) -> int:
    if port != 0:
        return port
    with contextlib.closing(socket.socket(socket.AF_INET, socket.SOCK_STREAM)) as s:
        s.bind((host, 0))
        return s.getsockname()[1]


def main():
    parser = argparse.ArgumentParser(description="Simple static file server (web_app)")
    parser.add_argument("--host", default=DEFAULT_HOST, help="Bind host (default 127.0.0.1)")
    parser.add_argument(
        "--port",
        type=int,
        default=DEFAULT_PORT,
        help="Bind port (default 9010; 0 = auto)",
    )
    parser.add_argument(
        "--root",
        default="",
        help="Static file root directory (default runtime web_app/)",
    )
    args = parser.parse_args()

    base_dir = Path(args.root).expanduser().resolve() if args.root else resolve_web_app_root()
    if not base_dir.is_dir():
        parser.error(f"静态资源目录不存在: {base_dir}")

    os.chdir(base_dir)  # 切换到 web_app 目录
    port = find_free_port(args.host, args.port)
    handler_cls = QuietHandler
    with socketserver.TCPServer((args.host, port), handler_cls) as httpd:
        print(f"[static-server] Serving {base_dir} at http://{args.host}:{port}/ (Ctrl+C to quit)")
        if (base_dir / "index.html").exists():
            print("[static-server] Found index.html -> will serve as root page")
        else:
            print("[static-server] WARNING: index.html not found in web_app directory")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\n[static-server] Stopped.")


if __name__ == "__main__":
    main()
