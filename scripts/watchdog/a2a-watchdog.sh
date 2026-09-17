#!/usr/bin/env bash
# ==============================================================================
# a2a-watchdog.sh —— A2A 服务看门狗（通用版 · 参数化）
# ==============================================================================
# 2026-09-18 · 若兰 🌸 · 缘起：舟楫宿主那份 a2a-watchdog.sh 不在任何 git 仓里，
#   出问题只能靠手工 .bak 比对。抽成通用版入仓后：**改仓 → pull → 自动到位**。
#
# 设计：**模板 + 本机差异分离**
#   · 本脚本（进仓）：只保留"看门狗该干的事"，所有实例私有值走 env
#   · instance.env（**不进仓**）：每台实例自己的路径/URL/启动命令/私有 export
#
# 相对舟楫原版修掉的三处（逐行可核）：
#   ① 探活**单发无重试** → 一次抖动就判死（误报）。本版：轮询 + 递增退避，失败日志带 `last=<code>`
#   ② 启动日志用单 `>` → **每次重启截断 server.log**（历史现场丢失）。本版：`>>` + 可选按大小轮转
#   ③ `pgrep -f` 模式过宽 → PID 纠正可能写错 → 下轮抖动误重启。本版：模式可配，且只在能唯一命中时纠正
#
# 用法：
#   A2A_INSTANCE_ENV=/path/to/instance.env bash scripts/watchdog/a2a-watchdog.sh
#   （不设 A2A_INSTANCE_ENV 时，默认读同目录 instance.env）
# 部署（三步，见 scripts/watchdog/README.md）由**实例本机**一次性完成；
# 之后任何改动都走本仓 pull，重启动作仍由本机调度触发。
# ==============================================================================

set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# ── 0. 载入实例配置（不进仓；含路径、启动命令、私有 export） ──
INSTANCE_ENV="${A2A_INSTANCE_ENV:-$SCRIPT_DIR/instance.env}"
if [ -f "$INSTANCE_ENV" ]; then
  # shellcheck source=/dev/null
  . "$INSTANCE_ENV"
else
  echo "⚠️ a2a-watchdog：未找到实例配置 $INSTANCE_ENV（用 --help 见 README；也可用 A2A_INSTANCE_ENV 指定）" >&2
fi

# ── 1. 参数（默认值可被 instance.env / 环境变量覆盖） ──
A2A_START_CMD="${A2A_START_CMD:-}"
A2A_DIR="${A2A_DIR:-}"
A2A_PID_FILE="${A2A_PID_FILE:-${A2A_DIR:+$A2A_DIR/server.pid}}"
A2A_LOG_DIR="${A2A_LOG_DIR:-${A2A_DIR:+$A2A_DIR/logs}}"
A2A_SERVER_LOG="${A2A_SERVER_LOG:-${A2A_LOG_DIR:+$A2A_LOG_DIR/server.log}}"
A2A_WATCHDOG_LOG="${A2A_WATCHDOG_LOG:-${A2A_LOG_DIR:+$A2A_LOG_DIR/watchdog.log}}"
A2A_HEALTH_URL="${A2A_HEALTH_URL:-http://localhost:3100/health}"
A2A_PROC_PATTERN="${A2A_PROC_PATTERN:-node server_v5.js}"
A2A_HEALTH_RETRIES="${A2A_HEALTH_RETRIES:-6}"        # 探活次数（>1 才叫"重试"）
A2A_HEALTH_INTERVAL="${A2A_HEALTH_INTERVAL:-2}"      # 首次间隔（秒）
A2A_HEALTH_INTERVAL_MAX="${A2A_HEALTH_INTERVAL_MAX:-5}"
A2A_HEALTH_TIMEOUT="${A2A_HEALTH_TIMEOUT:-5}"        # 单次 curl 超时（秒）
A2A_SERVER_LOG_MAX_BYTES="${A2A_SERVER_LOG_MAX_BYTES:-0}"   # >0 时按大小轮转（0=不轮转）
A2A_ALWAYS_HOOK="${A2A_ALWAYS_HOOK:-}"   # 每次调用都跑（如懒安装自愈）
A2A_PRE_START_HOOK="${A2A_PRE_START_HOOK:-}"  # 仅重启前跑

# ── 2. 必需项校验（fail-loud，别拿默认值把"没配"伪装成"配了"） ──
_missing=""
[ -n "$A2A_DIR" ] || _missing="$_missing A2A_DIR"
[ -n "$A2A_START_CMD" ] || _missing="$_missing A2A_START_CMD"
if [ -n "$_missing" ]; then
  echo "❌ a2a-watchdog：缺少必需配置：$_missing" >&2
  echo "   请在 instance.env 中设置（模板见 scripts/watchdog/instance.env.example）" >&2
  exit 2
fi

mkdir -p "$A2A_LOG_DIR" 2>/dev/null || true

log() { echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*" >> "$A2A_WATCHDOG_LOG"; }

# ── 3. 探活（轮询 + 递增退避）——fix① ──
# 返回：stdout "<code> <attempts>"；exit 0=通，1=不通
probe_health() {
  local tries=0 code="000" delay="$A2A_HEALTH_INTERVAL"
  while [ "$tries" -lt "$A2A_HEALTH_RETRIES" ]; do
    tries=$((tries + 1))
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time "$A2A_HEALTH_TIMEOUT" "$A2A_HEALTH_URL" 2>/dev/null || true)
    [ -n "$code" ] || code="000"      # curl 连不上时可能空输出——归一成 000（不拼接！）
    if [ "$code" = "200" ]; then echo "200 $tries"; return 0; fi
    if [ "$tries" -lt "$A2A_HEALTH_RETRIES" ]; then sleep "$delay"; fi
    if [ "$delay" -lt "$A2A_HEALTH_INTERVAL_MAX" ]; then delay=$((delay + 1)); fi
  done
  echo "$code $tries"; return 1
}

# ── 4. 日志轮转（按大小；>max 时改名 .1）——fix② 的配套 ──
rotate_log_if_needed() {
  local f="$1" max="$A2A_SERVER_LOG_MAX_BYTES"
  [ "${max:-0}" -gt 0 ] 2>/dev/null || return 0
  [ -f "$f" ] || return 0
  local sz; sz=$(wc -c < "$f" 2>/dev/null || echo 0)
  if [ "${sz:-0}" -gt "$max" ]; then
    mv -f "$f" "$f.1" 2>/dev/null || true
    log "🔄 轮转日志：$(basename "$f")（${sz}B > ${max}B）→ .1"
  fi
}

# ── 5. 每次调用都跑的钩子（懒安装自愈等，须在探活前——否则"健康即 exit"会让它永不执行） ──
if [ -n "$A2A_ALWAYS_HOOK" ] && [ -f "$A2A_ALWAYS_HOOK" ]; then
  bash "$A2A_ALWAYS_HOOK" >> "$A2A_WATCHDOG_LOG" 2>&1 || log "⚠️ ALWAYS_HOOK 退出非零：$A2A_ALWAYS_HOOK"
fi

# ── 6. 探活 ──
_res="$(probe_health)"; _ok=$?
CODE="${_res% *}"; ATT="${_res#* }"

if [ "$_ok" -eq 0 ]; then
  # 服务正常：仅在 PID 文件确实过期时纠正（模式可配，避免误纠 → fix③）
  LIVE_PID="$(pgrep -f "$A2A_PROC_PATTERN" 2>/dev/null | sort -n | head -1)"
  if [ -n "$LIVE_PID" ] && [ -f "$A2A_PID_FILE" ]; then
    CUR="$(cat "$A2A_PID_FILE" 2>/dev/null)"
    if [ "$CUR" != "$LIVE_PID" ]; then
      log "✅ 服务正常（health ok after ${ATT} 次探测），PID 文件纠正 ${CUR:-?} → ${LIVE_PID}"
      echo "$LIVE_PID" > "$A2A_PID_FILE"
    else
      log "✅ 服务正常（health ok after ${ATT} 次探测）"
    fi
  else
    log "✅ 服务正常（health ok after ${ATT} 次探测）"
  fi
  echo "OK health=200 attempts=$ATT"
  exit 0
fi

# ── 7. 不通 → 重启 ──
log "⚠️ A2A 无响应（探测 ${ATT} 次全失败，last=${CODE}）→ 重启"
echo "UNHEALTHY last=${CODE} attempts=${ATT} → restart"

OLD_PID=""
[ -f "$A2A_PID_FILE" ] && OLD_PID="$(cat "$A2A_PID_FILE" 2>/dev/null)"
if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
  log "⏹ 停止旧进程 PID ${OLD_PID}"
  kill "$OLD_PID" 2>/dev/null || true
  sleep 2
fi

cd "$A2A_DIR" || { log "❌ A2A_DIR 不可进入：$A2A_DIR"; echo "ERR cd $A2A_DIR"; exit 2; }

if [ -n "$A2A_PRE_START_HOOK" ] && [ -f "$A2A_PRE_START_HOOK" ]; then
  bash "$A2A_PRE_START_HOOK" >> "$A2A_WATCHDOG_LOG" 2>&1 || log "⚠️ PRE_START_HOOK 退出非零：$A2A_PRE_START_HOOK"
fi

rotate_log_if_needed "$A2A_SERVER_LOG"

# 启动：**追加**（fix②）——不再截断历史现场
log "▶️ 启动：$A2A_START_CMD（日志追加 → $A2A_SERVER_LOG）"
nohup bash -c "$A2A_START_CMD" >> "$A2A_SERVER_LOG" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$A2A_PID_FILE" 2>/dev/null || true

# ── 8. 复验（同样走重试，不报假成功） ──
_res2="$(probe_health)"; _ok2=$?
H2="${_res2% *}"; N2="${_res2#* }"
if [ "$_ok2" -eq 0 ]; then
  log "✅ 重启成功 (PID ${NEW_PID}，health ok after ${N2} 次探测)"
  echo "RESTARTED pid=$NEW_PID health=200 attempts=$N2"
  exit 0
fi

log "❌ 重启失败 (health last=${H2}，探测 ${N2} 次)，请人工检查 $A2A_SERVER_LOG"
echo "RESTART_FAILED last=${H2} attempts=${N2}"
exit 1
