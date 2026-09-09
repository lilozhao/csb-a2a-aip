#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge Audit · 降级事件留痕（M2 最小实现 · Step 5）
 * ═══════════════════════════════════════════════════════
 *
 * 实现 RFC v0.2 §4.4（星尘 R1 要求）：
 *   任何降级/fallback（quota 耗尽/超时/解析错/桥接不可用）都要留痕一条「降级事件」，
 *   不只 log 一行——主会话可见、可审计、不静默。
 *
 * 双层留痕：
 *   1. 本地审计文件（JSON Lines，对齐 remote-command/audit.js 风格）
 *      logs/a2a-bridge-degrade-YYYYMMDD.log
 *   2. 主会话可见汇总（同机时写入主 workspace logs/ + 可选消息通知宿主）
 *      ——「降级事件」进主会话可读位置，主 agent 巡检时能看到（星尘：可审计性）
 *
 * 用法:
 *   const audit = require('./a2a-bridge-audit');
 *   await audit.recordDegradeEvent({
 *     phase: 'inject', reason: 'gateway 断连', fallback: 'P0 诚实指路',
 *     taskId: 'task-1', extra: {...}
 *   });
 *
 * 依赖: 纯 Node.js（fs）；可选 adapter 通知宿主（openclaw-gateway）
 * 协议: A2A Bridge RFC v0.2 · 星尘 R1 补充
 * 作者: 若兰 🌸 · 2026-09-09
 * ═══════════════════════════════════════════════════════
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

// ============================================
// 配置
// ============================================

const DEFAULTS = Object.freeze({
  // 本地审计文件（JSON Lines 追加）
  logDir: path.join(__dirname, 'logs'),
  // 主会话可见副本（同机主 workspace logs；A2A server 与主会话同机时有效）
  mainVisibleDir: process.env.A2A_BRIDGE_MAIN_LOGS || '/home/node/.openclaw/workspace/logs',
  maxFileBytes: 5 * 1024 * 1024, // 5MB 轮转
});

// ============================================
// 内部工具
// ============================================

function todayStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}`;
}

function appendJsonLine(file, obj) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 简单轮转：超限重命名 .1
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > DEFAULTS.maxFileBytes) {
        fs.renameSync(file, file + '.1');
      }
    } catch { /* 轮转失败不阻塞 */ }
    fs.appendFileSync(file, JSON.stringify(obj) + os.EOL, 'utf8');
    return true;
  } catch (e) {
    console.error('[A2A-Bridge-Audit] 本地留痕失败:', e.message);
    return false;
  }
}

// ============================================
// 降级事件记录
// ============================================

/**
 * 记录一条降级事件（双层留痕）
 *
 * @param {object} evt
 * @param {string} evt.phase    降级环节（inject/confirm/classify/...）
 * @param {string} evt.reason   降级原因（gateway 断连/quota 耗尽/超时/解析错...）
 * @param {string} evt.fallback 兜底动作（P0 诚实指路 / local 模板...）
 * @param {string} [evt.taskId] 关联 Task ID（如有）
 * @param {object} [evt.extra]  附加上下文
 * @param {object} [opts] {notifyHost?: boolean, adapter?: object, to?: string}
 * @returns {Promise<{logged: boolean, mainVisible: boolean, entry: object}>}
 */
async function recordDegradeEvent(evt, opts = {}) {
  const entry = {
    type: 'degrade_event',
    ts: new Date().toISOString(),
    host: os.hostname(),
    phase: evt.phase || 'unknown',
    reason: evt.reason || 'unknown',
    fallback: evt.fallback || 'none',
    taskId: evt.taskId || null,
    extra: evt.extra || undefined,
  };

  // 1. 本地审计文件
  const localFile = path.join(DEFAULTS.logDir, `a2a-bridge-degrade-${todayStamp()}.log`);
  const logged = appendJsonLine(localFile, entry);

  // 2. 主会话可见副本（同机主 workspace logs——主 agent 巡检可读）
  let mainVisible = false;
  try {
    if (DEFAULTS.mainVisibleDir && fs.existsSync(path.dirname(DEFAULTS.mainVisibleDir))) {
      const mainFile = path.join(DEFAULTS.mainVisibleDir, 'a2a-bridge-degrade-events.log');
      mainVisible = appendJsonLine(mainFile, entry);
    } else {
      // 目录不存在（不同机）→ 尝试创建
      const mainFile = path.join(DEFAULTS.mainVisibleDir, 'a2a-bridge-degrade-events.log');
      mainVisible = appendJsonLine(mainFile, entry);
    }
  } catch { mainVisible = false; }

  // 3. 可选：通知宿主（默认关闭——降级事件不打扰，靠巡检；星尘要求的是「可审计不静默」）
  if (opts.notifyHost) {
    try {
      let adapter = opts.adapter;
      if (!adapter) { adapter = require('./adapters/openclaw-gateway.js'); }
      await adapter.inject({
        taskId: evt.taskId || 'degrade-' + Date.now(),
        delegatorLabel: '桥接层审计',
        envelope: {
          type: 'notify', scope: 'notify',
          target: `⚠️ 桥接降级事件：${entry.phase} / ${entry.reason} → 兜底：${entry.fallback}（${entry.ts}）`,
          timeoutMs: 60000,
        },
      }, { to: opts.to });
    } catch { /* 通知失败不影响留痕 */ }
  }

  return { logged, mainVisible, entry };
}

// ============================================
// 查询（主会话/巡检用）
// ============================================

/**
 * 读取最近的降级事件（供主 agent 巡检/审计）
 * @param {number} limit
 * @param {object} opts {mainVisible?: boolean}
 * @returns {Array<object>}
 */
function recentDegradeEvents(limit = 20, opts = {}) {
  const file = opts.mainVisible
    ? path.join(DEFAULTS.mainVisibleDir, 'a2a-bridge-degrade-events.log')
    : path.join(DEFAULTS.logDir, `a2a-bridge-degrade-${todayStamp()}.log`);
  try {
    if (!fs.existsSync(file)) return [];
    const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-limit).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch {
    return [];
  }
}

// ============================================
// 导出
// ============================================

module.exports = {
  DEFAULTS,
  recordDegradeEvent,
  recentDegradeEvents,
  _appendJsonLine: appendJsonLine, // 测试用
};
