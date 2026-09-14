#!/usr/bin/env bash
# init-instance-config.sh — 从 identity.json.example 生成本实例的本地身份文件
#
# 缘起：2026-09-14「拆 self」——实例身份不再来自共享仓 config/agents.json 的 self 段，
#      改为本机 identity.json（已 gitignore）。缺它、或缺 publicHost 时，
#      AgentCard / 注册会上报 localhost 或错地址（9/12 那个坑的同一族）。
# 策略真源：docs/shared-repo-hygiene.md（`.example` 进仓享共享，真值本地生成）
#
# 用法:
#   scripts/init-instance-config.sh                    # 交互式
#   scripts/init-instance-config.sh --name 阿轩 --emoji 🔧 --host <本机IP> --port 3100 --slug axuan
#   scripts/init-instance-config.sh --dry              # 只打印将写入的内容，不落盘
#   scripts/init-instance-config.sh --force            # 覆盖已存在的 identity.json（先备份 .bak-<ts>）
# 退出码: 0 成功 · 1 已存在未加 --force · 2 用法错误
set -eu

ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
EXAMPLE="$ROOT/identity.json.example"
OUT="$ROOT/identity.json"

name=""; emoji=""; host=""; port=""; slug=""; desc=""; llmhost=""; model=""
dry=0; force=0
while [ $# -gt 0 ]; do
  case "$1" in
    --name) name="$2"; shift 2 ;;
    --emoji) emoji="$2"; shift 2 ;;
    --host) host="$2"; shift 2 ;;
    --port) port="$2"; shift 2 ;;
    --slug) slug="$2"; shift 2 ;;
    --desc) desc="$2"; shift 2 ;;
    --llm-host) llmhost="$2"; shift 2 ;;
    --model) model="$2"; shift 2 ;;
    --dry) dry=1; shift ;;
    --force) force=1; shift ;;
    -h|--help) sed -n '2,18p' "$0"; exit 0 ;;
    *) echo "未知参数: $1" >&2; exit 2 ;;
  esac
done

# 本机对外地址自动探测（A2A_HOST > hostname -i > ip route）
detect_host() {
  if [ -n "${A2A_HOST:-}" ]; then printf '%s' "$A2A_HOST"; return; fi
  local ip
  ip=$(hostname -i 2>/dev/null | tr ' ' '\n' | grep -E '^([0-9]{1,3}\.){3}[0-9]{1,3}$' | grep -v '^127\.' | head -1 || true)
  [ -z "$ip" ] && ip=$(ip -4 -o addr show scope global 2>/dev/null | awk '{print $4}' | cut -d/ -f1 | head -1 || true)
  printf '%s' "$ip"
}

ask() { # ask <提示> <变量名> <默认>
  eval "_cur=\${$2:-}"
  if [ -z "$_cur" ]; then
    if [ -t 0 ]; then printf '%s [%s]: ' "$1" "$3"; read -r _ans; eval "$2=\${_ans:-$3}"
    else eval "$2=\"$3\""; echo "⚠️ 非交互环境，$2 用默认值: $3" >&2; fi
  fi
}

ask "实例名 (name)"            name   "${name:-}"
[ -z "$name" ] && { echo "❌ 必须提供 --name（不是交互终端时不猜）" >&2; exit 2; }
ask "emoji"                    emoji  "${emoji:-🌸}"
ask "对外地址 publicHost"       host   "${host:-$(detect_host)}"
ask "端口"                      port   "${port:-3100}"
ask "握手 slug"                 slug   "${slug:-$name}"
ask "描述 description"          desc   "${desc:-CSB A2A 实例 $name}"
ask "LLM host"                 llmhost "${llmhost:-}"
ask "LLM model"                model  "${model:-}"

[ -z "$host" ] && { echo "❌ publicHost 为空——请 --host 指定本机对外地址（必填）" >&2; exit 2; }

if [ -f "$OUT" ] && [ "$force" != 1 ] && [ "$dry" != 1 ]; then
  echo "❌ identity.json 已存在：$OUT（要覆盖请加 --force，会先备份）" >&2
  exit 1
fi

# 模板：优先用仓里的 identity.json.example；没有则内建最小模板
if [ -f "$EXAMPLE" ]; then TPL=$(cat "$EXAMPLE"); else
  echo "⚠️ 未找到 $EXAMPLE，使用内建最小模板" >&2
  TPL='{
  "name": "<YOUR_AGENT_NAME>",
  "emoji": "<YOUR_AGENT_EMOJI>",
  "description": "<YOUR_AGENT_DESCRIPTION>",
  "publicHost": "<YOUR_HOST>",
  "port": 3100,
  "capabilities": { "chat": true },
  "llm": { "host": "<YOUR_LLM_HOST>", "port": "443", "path": "/compatible-mode/v1/chat/completions", "apiKeyEnv": "A2A_LLM_API_KEY", "model": "<YOUR_MODEL>" },
  "version": "1.0.0",
  "security": { "handshake": { "slug": "<YOUR_SLUG>" } }
}'
fi

OUTPUT=$(printf '%s\n' "$TPL" \
  | sed -e "s|<YOUR_AGENT_NAME>|$name|g" \
        -e "s|<YOUR_AGENT_EMOJI>|$emoji|g" \
        -e "s|<YOUR_AGENT_DESCRIPTION>|$desc|g" \
        -e "s|<YOUR_HOST>|$host|g" \
        -e "s|<YOUR_LLM_HOST>|$llmhost|g" \
        -e "s|<YOUR_MODEL>|$model|g" \
        -e "s|<YOUR_SLUG>|$slug|g" \
        -e "s|\"port\": 3100|\"port\": $port|" )

if printf '%s' "$OUTPUT" | grep -q '<YOUR_'; then
  echo "⚠️ 生成结果仍含未替换占位 <YOUR_...>，请检查字段：" >&2
  printf '%s' "$OUTPUT" | grep -o '<YOUR_[A-Z_]*>' | sort -u >&2
fi

if [ "$dry" = 1 ]; then echo "── dry-run（不落盘）──"; printf '%s\n' "$OUTPUT"; exit 0; fi

if [ -f "$OUT" ]; then cp -p "$OUT" "$OUT.bak-$(date +%Y%m%d%H%M%S)"; echo "↩︎ 已备份旧 identity.json"; fi
printf '%s\n' "$OUTPUT" > "$OUT"
chmod 600 "$OUT"
echo "✅ 已生成 $OUT（mode 600）"
echo "   本机身份：$name $emoji @ $host:$port · slug=$slug"
echo ""
echo "下一步："
echo "  1) 重启 v5（按你侧启动脚本），或临时： A2A_IDENTITY_PATH=$OUT node server_v5.js"
echo "  2) 验： curl -s localhost:$port/.well-known/agent.json | grep -o '\"jsonrpc\":\"[^\"]*\"'  # 应为本机地址"
echo "  3) 验： curl -s localhost:$port/health"
echo "  4) 卫生自检： bash <protocol-repo>/scripts/check-repo-hygiene.sh --audit"
