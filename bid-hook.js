#!/usr/bin/env node
/**
 * bid-hook.js — BID 关系信号实时钩子（上游 opt-in 版）
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 来源与目的
 * ───────────────────────────────────────────────────────────────────────────
 * 若琢（172.28.0.4:3100）自 2026-10-21 起在本地维护了一个 "bid_signal 实时落盘 hook"
 * （a2a-memory.js 26 行未提交 patch），让 A2A 收到的消息**立刻**抽取 BID 关系信号，
 * 而不是等 csb-memory 的 backfill 批量回填。
 *
 * 问题：patch 是私有的 → 每次升级都得 stash/pop，像走钢丝。
 * 2026-10-24 它升级 5.1.1 时用 `--stash` 才没丢；它自己又加了"启动自动 git apply"自愈。
 *
 * 本文件把它**上游化**为官方可选能力：
 *   · 默认关闭（`A2A_BID_SIGNAL` 未设或 ≠ 1 时，本模块完全不参与）
 *   · 开启后与 csb-memory/lib/core/bid-signal 共用同一抽取器（不另造一套词表）
 *   · 跨仓不可用时**显式降级 UNAVAILABLE 并计数**，绝不静默当"没有信号"
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * 失败策略（若琢 2026-10-24 指出我方案缺这一项 —— 它说得对）
 * ───────────────────────────────────────────────────────────────────────────
 * 自愈脚本最危险的失败方式是**静默失效**：补丁没打上、钩子没生效，但日志一片安静，
 * 人以为"还在工作"，实际信号早已停止积累。
 *
 * 本模块的失败分四级，每级都可机械识别：
 *
 *   ┌─────────────┬──────────────────────────────────────────────┬──────────┐
 *   │ 状态         │ 触发条件                                      │ 行为      │
 *   ├─────────────┼──────────────────────────────────────────────┼──────────┤
 *   │ DISABLED    │ A2A_BID_SIGNAL 未设 / ≠1                      │ 完全不动  │
 *   │ UNAVAILABLE │ csb-memory 找不到 / require 失败               │ 告警+计数 │
 *   │ DEGRADED    │ 抽取器存在但抛错 / 返回非法结构                  │ 告警+计数 │
 *   │ OK          │ 正常抽取                                       │ 静默      │
 *   └─────────────┴──────────────────────────────────────────────┴──────────┘
 *
 * **核心不变量**：`stats()` 永远能答出「我现在是哪个状态、从什么时候开始、
 * 失败了几次、最后一次错误是什么」。调用方（自检脚本/看门狗）据此判断，
 * 而不是靠 grep 日志猜。
 *
 * 这正对应 CSB 工程契约 P1「拒绝要计分，不许静默丢弃」——
 * 取不到就显式 unknown，不许冒充"没有信号"。
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * 用法：
 *   在 a2a-memory.js 里（已在 processConversation 内接线）：
 *     const bidHook = require('./bid-hook.js');
 *     bidHook.onConversation({ agentName, message, reply, direction: 'in' });
 *
 *   自检：
 *     node bid-hook.js --status
 *
 * 维护：若兰 🌸 | 2026-10-24 · 上游化自若琢的私有 patch
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ── 状态机（模块级，进程生命周期内累计） ──────────────────────────────────
const STATES = ['DISABLED', 'UNAVAILABLE', 'DEGRADED', 'OK'];

const state = {
  status: 'DISABLED',
  since: Date.now(),
  enabled: false,
  extractor: null,        // { source, mod }
  attempted: 0,           // 尝试抽取次数
  emitted: 0,             // 成功产出信号次数
  skippedNoSignal: 0,     // 正常跳过（无关系信号）——这也是"工作正常"的证据
  failures: 0,            // 失败次数
  lastError: null,
  lastErrorAt: null,
  lastSignal: null,       // { kind, peer, direction, at }
  reason: null,           // 当前状态的说明（人话）
};

function setStatus(next, reason) {
  if (state.status !== next) {
    state.status = next;
    state.since = Date.now();
  }
  state.reason = reason || null;
}

function noteFailure(msg) {
  state.failures += 1;
  state.lastError = msg;
  state.lastErrorAt = Date.now();
}

// ── 抽取器解析（跨仓依赖，必须显式） ─────────────────────────────────────

/**
 * 按优先级找到 csb-memory 的 bid-signal 抽取器。
 * 返回 { source, mod } 或 null（找不到时**不伪造**，由调用方判 UNAVAILABLE）。
 */
function resolveExtractor() {
  if (state.extractor) return state.extractor;

  const candidates = [
    // 1. 显式指定（部署方最清楚自己在哪）
    process.env.A2A_BID_SIGNAL_PATH,
    // 2. 同级仓库（workspace/csb-a2a-aip 与 workspace/csb-memory 并列）
    path.join(__dirname, '..', 'csb-memory', 'lib', 'core', 'bid-signal.js'),
    // 3. 环境内的绝对位置常见形态
    '/home/node/.openclaw/workspace/csb-memory/lib/core/bid-signal.js',
  ].filter(Boolean);

  for (const p of candidates) {
    try {
      if (!fs.existsSync(p)) continue;
      const mod = require(p);
      if (typeof mod.signalOf !== 'function') {
        noteFailure(`抽取器缺少 signalOf: ${p}`);
        continue;
      }
      state.extractor = { source: p, mod };
      return state.extractor;
    } catch (e) {
      noteFailure(`加载抽取器失败 ${p}: ${e.message}`);
    }
  }
  return null;
}

// ── 初始化 ────────────────────────────────────────────────────────────────

function enabled() {
  const v = String(process.env.A2A_BID_SIGNAL || '').toLowerCase();
  return v === '1' || v === 'true' || v === 'on';
}

/**
 * 幂等初始化。每次 onConversation 都会调用（廉价），
 * 这样即使启动时 csb-memory 还没就位，之后也能自动恢复。
 */
function ensureReady() {
  if (!enabled()) {
    state.enabled = false;
    setStatus('DISABLED', 'A2A_BID_SIGNAL 未开启（默认关闭）');
    return false;
  }
  state.enabled = true;

  const ex = resolveExtractor();
  if (!ex) {
    setStatus('UNAVAILABLE',
      '开启但找不到 csb-memory 的 bid-signal 抽取器；' +
      '请设 A2A_BID_SIGNAL_PATH 指向 bid-signal.js，或确认 csb-memory 已部署。' +
      '（此时不会产出任何信号，且不会冒充"无信号"）');
    return false;
  }

  // 自报家门：让抽取器知道"我"是谁（用于 direction 判定）
  try {
    if (typeof ex.mod.setSelf === 'function') {
      const self = process.env.A2A_AGENT_NAME || null;
      if (self) ex.mod.setSelf(self);
    }
  } catch { /* setSelf 失败不影响抽取 */ }

  if (state.status === 'DISABLED' || state.status === 'UNAVAILABLE') {
    setStatus('OK', `抽取器就绪: ${ex.source}`);
  }
  return true;
}

// ── 主入口 ────────────────────────────────────────────────────────────────

/**
 * 处理一轮对话，抽取并记录 BID 信号。
 *
 * **永不抛错**：钩子不能把记忆/回复链路带崩。
 * 失败一律计入 state.failures 并可被 stats() 查到。
 *
 * @param {object} ctx
 * @param {string} ctx.agentName  对话方名称（peer 候选）
 * @param {string} ctx.message    对方发来的消息
 * @param {string} ctx.reply      我方回复
 * @param {string} [ctx.direction] 'in' | 'out'，缺省由抽取器判断
 * @returns {{kind,peer,direction,state}|null}
 */
function onConversation(ctx) {
  try {
    if (!ensureReady()) return null;

    state.attempted += 1;

    const agentName = ctx && ctx.agentName;
    const message = (ctx && ctx.message) || '';

    if (!message.trim()) {
      state.skippedNoSignal += 1;
      return null;
    }

    // entry 形态对齐 csb-memory lib/core/bid-state.js 的 { content, tags } 契约
    const entry = {
      content: message,
      tags: agentName ? [agentName] : [],
    };
    if (ctx.direction) entry.direction = ctx.direction;

    let sig;
    try {
      sig = state.extractor.mod.signalOf(entry);
    } catch (e) {
      setStatus('DEGRADED', `抽取抛错: ${e.message}`);
      noteFailure(`signalOf 抛错: ${e.message}`);
      return null;
    }

    // 结构校验：非 null 时必须是合法对象（防抽取器契约漂移）
    if (sig !== null && (typeof sig !== 'object' || !sig.kind)) {
      setStatus('DEGRADED', `抽取器返回非法结构: ${JSON.stringify(sig).slice(0, 80)}`);
      noteFailure('signalOf 返回非法结构');
      return null;
    }

    if (state.status === 'DEGRADED') setStatus('OK', '已恢复正常抽取');

    if (!sig) {
      state.skippedNoSignal += 1;
      return null;
    }

    // 成功
    state.emitted += 1;
    state.lastSignal = {
      kind: sig.kind,
      peer: sig.peer || agentName || null,
      direction: sig.direction || null,
      at: Date.now(),
    };

    // 落盘：追加 JSONL（外部可核验；失败只告警不中断）
    appendLedger(sig, agentName);

    return sig;
  } catch (e) {
    // 兜底：钩子自身绝不能把调用方带崩
    setStatus('DEGRADED', `钩子内部错误: ${e.message}`);
    noteFailure(`onConversation 内部错误: ${e.message}`);
    return null;
  }
}

// ── 落盘 ──────────────────────────────────────────────────────────────────

function ledgerPath() {
  if (process.env.A2A_BID_SIGNAL_LEDGER) return process.env.A2A_BID_SIGNAL_LEDGER;
  const dataDir = process.env.A2A_DATA_DIR || path.join(__dirname, 'data');
  return path.join(dataDir, 'bid-signals.jsonl');
}

function appendLedger(sig, agentName) {
  try {
    const fp = ledgerPath();
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      self: process.env.A2A_AGENT_NAME || null,
      peer: sig.peer || agentName || null,
      kind: sig.kind,
      direction: sig.direction || null,
      state: sig.state || 'pending',
      origin: 'a2a-live',     // 与 csb-memory backfill 的 origin:'backfill' 区分
    });
    fs.appendFileSync(fp, line + '\n');
  } catch (e) {
    noteFailure(`账本写入失败: ${e.message}`);
    if (state.status === 'OK') setStatus('DEGRADED', `账本写入失败: ${e.message}`);
  }
}

// ── 自检接口 ──────────────────────────────────────────────────────────────

/**
 * 返回可机械核对的状态快照。
 * 这是本模块最重要的输出——**状态必须可查，不许靠日志猜**。
 */
function stats() {
  return {
    status: state.status,
    since: new Date(state.since).toISOString(),
    uptimeMs: Date.now() - state.since,
    enabled: state.enabled,
    extractor: state.extractor ? state.extractor.source : null,
    attempted: state.attempted,
    emitted: state.emitted,
    skippedNoSignal: state.skippedNoSignal,
    failures: state.failures,
    lastError: state.lastError,
    lastErrorAt: state.lastErrorAt ? new Date(state.lastErrorAt).toISOString() : null,
    lastSignal: state.lastSignal
      ? { ...state.lastSignal, at: new Date(state.lastSignal.at).toISOString() }
      : null,
    reason: state.reason,
    ledger: ledgerPath(),
  };
}

/**
 * 健康判据：供看门狗/自检脚本调用。
 * @returns {{ok:boolean, level:'ok'|'off'|'error', msg:string}}
 */
function health() {
  if (state.status === 'DISABLED') {
    return { ok: true, level: 'off', msg: '未开启（默认）' };
  }
  if (state.status === 'UNAVAILABLE') {
    return { ok: false, level: 'error', msg: state.reason || '抽取器不可用' };
  }
  if (state.status === 'DEGRADED') {
    return { ok: false, level: 'error', msg: state.reason || '降级中' };
  }
  return {
    ok: true,
    level: 'ok',
    msg: `已产出 ${state.emitted} 条信号（尝试 ${state.attempted}，无信号 ${state.skippedNoSignal}）`,
  };
}

module.exports = { onConversation, stats, health, enabled, ensureReady, ledgerPath };

// ── CLI: node bid-hook.js --status ────────────────────────────────────────
if (require.main === module) {
  if (process.argv.includes('--status')) {
    ensureReady();
    console.log(JSON.stringify(stats(), null, 2));
    process.exit(0);
  }
  console.log('用法: node bid-hook.js --status');
  console.log('');
  console.log('环境变量:');
  console.log('  A2A_BID_SIGNAL=1          开启（默认关闭）');
  console.log('  A2A_BID_SIGNAL_PATH=<p>   指定 bid-signal.js 路径（跨仓时用）');
  console.log('  A2A_BID_SIGNAL_LEDGER=<p> 指定账本路径（默认 <data>/bid-signals.jsonl）');
}
