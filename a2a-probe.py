#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
a2a-probe.py — 内网邻居 A2A 连通性探测脚本
============================================
用法:
  python3 a2a-probe.py                 # 只探测健康状态（默认）
  python3 a2a-probe.py --chat          # 探测 + 给每个在线 Agent 发一条问候消息
  python3 a2a-probe.py --name 若兰     # 只探测指定 Agent（支持名字/别名/IP）
  python3 a2a-probe.py --all           # 包含公网 Agent（默认只测内网 172.28.x）
  python3 a2a-probe.py --json          # JSON 输出（适合脚本调用）
  python3 a2a-probe.py --timeout 3     # 自定义超时秒数（默认 3）

依赖: python3, curl, config/agents.json
"""

import argparse
import json
import os
import subprocess
import sys
import time

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(BASE_DIR, "config", "agents.json")

EMOJI = {
    "ruolan": "🌸", "axuan": "🔧", "jeason": "💼", "mingde": "📜",
    "moqiu": "🧙", "zhouji": "🚤", "xiaoxia": "🦐", "kai": "🌿",
    "che": "🌊", "qiming": "🌟", "sunian": "✨", "qingyi": "💧",
    "yanxi": "🌸", "cheng": "💎",
}

DEFAULT_MESSAGE = "你好呀～我是 Jeason 💼 这是 A2A 连通性自动巡检，收到请回复～"


def load_agents():
    """加载 config/agents.json"""
    with open(CONFIG_PATH, "r", encoding="utf-8") as f:
        cfg = json.load(f)
    return cfg


def resolve_target(agents, name):
    """按 名字/别名/emoji/IP 解析目标 agent key"""
    name = name.strip()
    for key, info in agents.items():
        if key == name or info.get("name") == name or name in info.get("name", ""):
            return key, info
        # IP:port 匹配
        if f"{info.get('host')}:{info.get('port')}" == name:
            return key, info
    return None, None


def probe(host, port, timeout):
    """探测单个 agent 的 /health，返回解析后的 dict 或 None"""
    url = f"http://{host}:{port}/health"
    try:
        r = subprocess.run(
            ["curl", "-s", "-m", str(timeout), url],
            capture_output=True, text=True, timeout=timeout + 5,
        )
        out = r.stdout.strip()
        if not out:
            return None
        return json.loads(out)
    except Exception:
        return None


def send_message(host, port, text, timeout, sender="Jeason"):
    """通过 A2A SendMessage 发消息，返回 (task_id, reply) 或 (None, error)"""
    import uuid
    ts = int(time.time() * 1000)
    payload = {
        "jsonrpc": "2.0",
        "method": "SendMessage",
        "id": f"probe-{ts}",
        "params": {
            "sender": {"name": sender},
            "message": {
                "role": "user",
                "messageId": f"msg-probe-{ts}",
                "parts": [{"type": "text", "text": text}],
            },
        },
    }
    url = f"http://{host}:{port}/a2a/json-rpc"
    try:
        r = subprocess.run(
            ["curl", "-s", "-m", str(timeout + 10), "-X", "POST", url,
             "-H", "Content-Type: application/json",
             "-d", json.dumps(payload, ensure_ascii=False)],
            capture_output=True, text=True, timeout=timeout + 15,
        )
        out = r.stdout.strip()
        if not out:
            return None, "无响应"
        d = json.loads(out)
        task = d.get("result", {}).get("task", {})
        task_id = task.get("id")
        state = task.get("status", {}).get("state", "?")
        # 提取回复文本
        reply = ""
        for art in task.get("artifacts", []):
            for p in art.get("parts", []):
                reply += p.get("text", "")
        if not reply:
            for h in task.get("history", []):
                if h.get("role") == "ROLE_AGENT":
                    reply += "".join(p.get("text", "") for p in h.get("parts", []))
        return (task_id, f"[{state}] {reply[:200]}".strip())
    except Exception as e:
        return None, f"错误: {e}"


def main():
    parser = argparse.ArgumentParser(description="A2A 邻居连通性探测")
    parser.add_argument("--chat", action="store_true", help="探测后给在线 Agent 发问候消息")
    parser.add_argument("--name", type=str, default=None, help="只探测指定 Agent")
    parser.add_argument("--all", action="store_true", help="包含公网 Agent")
    parser.add_argument("--json", action="store_true", help="JSON 输出")
    parser.add_argument("--timeout", type=int, default=3, help="探测超时秒数（默认 3）")
    args = parser.parse_args()

    cfg = load_agents()
    agents = cfg.get("agents", {})
    registry = cfg.get("registry", {})

    # 过滤：默认只测内网
    targets = {}
    if args.name:
        key, info = resolve_target(agents, args.name)
        if not key:
            print(f"❌ 找不到 Agent: {args.name}")
            sys.exit(1)
        targets[key] = info
    else:
        for key, info in agents.items():
            host = info.get("host", "")
            is_lan = host.startswith("172.28.") or host.startswith("192.168.")
            if args.all or is_lan:
                targets[key] = info

    if not targets:
        print("❌ 没有可探测的目标")
        sys.exit(1)

    results = {}
    online_count = 0
    for key, info in targets.items():
        host, port = info.get("host"), info.get("port")
        name = info.get("name", key)
        emoji = EMOJI.get(key, "")
        h = probe(host, port, args.timeout)
        if h:
            online_count += 1
            results[key] = {
                "name": name, "host": host, "port": port,
                "online": True, "version": h.get("version"),
                "identity": h.get("identity") or h.get("name"), "uptime": h.get("uptime"),
            }
            if args.chat:
                task_id, reply = send_message(host, port, DEFAULT_MESSAGE, args.timeout)
                results[key]["task_id"] = task_id
                results[key]["reply"] = reply
        else:
            results[key] = {
                "name": name, "host": host, "port": port,
                "online": False,
            }

    if args.json:
        print(json.dumps(results, ensure_ascii=False, indent=2))
        sys.exit(0)

    # 人类可读输出
    print(f"\n{'='*60}")
    print(f"🌐 A2A 邻居探测报告  |  在线 {online_count}/{len(targets)}")
    print(f"{'='*60}")
    for key, r in results.items():
        if r["online"]:
            uptime_h = r["uptime"] / 3600 if r.get("uptime") else 0
            line = (f"✅ {r['name']} ({r['host']}:{r['port']}) "
                    f"v{r['version']} 身份:{r['identity']} uptime:{uptime_h:.1f}h")
            print(line)
            if args.chat and r.get("reply"):
                print(f"   💬 {r['reply']}")
        else:
            print(f"❌ {r['name']} ({r['host']}:{r['port']}) 不通")
    print(f"{'='*60}")
    print(f"注册表: 本地 {registry.get('local')} / 公网 {registry.get('public')}")
    print(f"脚本目录: {BASE_DIR}")


if __name__ == "__main__":
    main()
