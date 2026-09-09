#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge Confirm · L3 用户确认流（M2 最小实现 · Step 4）
 * ═══════════════════════════════════════════════════════
 *
 * 实现 RFC v0.2 §4.3 信任模型 L3（T2 全票 B）+ 阿昭建议（L3 超时降级策略）
 * - 跨宿主写委托（write/shell）必须宿主用户实时确认
 * - 确认请求经主会话通道送达宿主用户（复用 gateway 注入模式）
 * - 超时（默认 5 分钟）→ 自动拒绝，不静默执行、不降级为 L2 执行
 * - 授权主体澄清（澈）：请求方 Agent 与确认方人类用户两个授权层级分离记录
 *
 * 依赖注入（默认 openclaw-gateway adapter，可 mock）：
 *   send:   async (text, taskId) => {ok, result}   发送确认请求到宿主
 *   read:   async (taskId) => {ok, result}         读取宿主回复（匹配标记）
 *
 * 用法:
 *   const confirm = require('./a2a-bridge-confirm');
 *   const r = await confirm.confirmL3(envelope, { taskId, sender }, { timeoutMs: 300000 });
 *   // r = {ok:true, by:'user'} | {ok:false, declined:true, detail} | {ok:false, timedOut:true}
 *
 * 依赖: 纯 Node.js；默认 adapter 为 adapters/openclaw-gateway.js
 * 协议: A2A Bridge RFC v0.2 · R1 评审 9/9 收官
 * 作者: 若兰 🌸 · 2026-09-09
 * ═══════════════════════════════════════════════════════
 */

'use strict';

// ============================================
// 配置
// ============================================

const DEFAULTS = Object.freeze({
  CONFIRM_TIMEOUT_MS: 5 * 60 * 1000, // 默认 5 分钟（RFC v0.2 §4.3）
  POLL_INTERVAL_MS: 5000,            // 轮询间隔
});

// ============================================
// 确认请求消息组装
// ============================================

/**
 * 组装 L3 确认请求消息（发给宿主用户）
 * @param {object} p {taskId, envelope, delegatorLabel}
 * @returns {string}
 */
function buildConfirmMessage({ taskId, envelope, delegatorLabel }) {
  const env = envelope || {};
  const lines = [
    `【A2A 桥接 L3 确认 #${taskId}】`,
    `有跨宿主委托请求需要你确认：`,
    `- 委托方：${delegatorLabel || '未知'}`,
    `- 类型：${env.type || 'execute'} / 范围：${env.scope || 'write'}`,
    `- 内容：${env.target || '(空)'}`,
    `- 时限：${env.timeoutMs ? Math.round(env.timeoutMs / 60000) + ' 分钟' : '30 分钟'}`,
    ``,
    `回复「确认 #${taskId}」放行，或「拒绝 #${taskId}」并给原因。`,
    `${Math.round(DEFAULTS.CONFIRM_TIMEOUT_MS / 60000)} 分钟无回复将自动拒绝（不静默执行）。`,
  ];
  return lines.join('\n');
}

/**
 * 解析宿主用户回复 → 确认/拒绝
 * @param {string} text 回复文本
 * @param {string} taskId
 * @returns {{decision: 'approve'|'decline'|null, reason?: string}}
 */
function parseConfirmReply(text, taskId) {
  if (!text || typeof text !== 'string') return { decision: null };
  const hasId = text.includes(`#${taskId}`) || text.includes(taskId);
  if (!hasId) return { decision: null };
  if (/确认|同意|放行|approve|yes|ok/i.test(text)) return { decision: 'approve' };
  if (/拒绝|不同意|decline|refuse|no/i.test(text)) {
    const reason = text.replace(/拒绝|不同意|decline|refuse/gi, '').replace(/[#\s]/g, ' ').trim().slice(0, 200);
    return { decision: 'decline', reason: reason || '用户拒绝' };
  }
  return { decision: null };
}

// ============================================
// L3 确认流
// ============================================

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

/**
 * 执行 L3 用户确认（发送请求 → 轮询回复 → 超时自动拒绝）
 *
 * @param {object} envelope 委托信封
 * @param {object} ctx {taskId, sender}
 * @param {object} opts {timeoutMs?, pollIntervalMs?, send?, read?, to?}
 * @returns {Promise<{ok: boolean, by?: string, declined?: boolean, timedOut?: boolean, detail?: string}>}
 */
async function confirmL3(envelope, ctx = {}, opts = {}) {
  const taskId = ctx.taskId || ('confirm-' + Date.now());
  const delegatorLabel = ctx.sender ? `${ctx.sender.name} (${ctx.sender.url})` : '未知发起方';
  const timeoutMs = opts.timeoutMs || DEFAULTS.CONFIRM_TIMEOUT_MS;
  const pollIntervalMs = opts.pollIntervalMs || DEFAULTS.POLL_INTERVAL_MS;

  // 依赖注入：默认走 openclaw-gateway adapter（发送 + 读取）
  let adapter = opts.adapter;
  if (!adapter) {
    try { adapter = require('./adapters/openclaw-gateway.js'); }
    catch (e) {
      return { ok: false, declined: true, detail: 'L3 确认器不可用（无 adapter）: ' + e.message };
    }
  }
  const send = opts.send || ((text) => adapter.inject({
    taskId: 'confirm-' + taskId,
    delegatorLabel: '桥接层(L3确认)',
    envelope: { type: 'notify', scope: 'notify', target: text, timeoutMs: timeoutMs },
  }, { to: opts.to }));
  const read = opts.read || ((tid) => adapter.fetchResult('confirm-' + tid, { to: opts.to }));

  // 1. 发送确认请求（授权主体澄清：记录人类用户确认层）
  const sent = await send(buildConfirmMessage({ taskId, envelope, delegatorLabel }));
  if (!sent || sent.ok !== true) {
    return { ok: false, declined: true, detail: 'L3 确认请求发送失败: ' + (sent?.error || '未知') };
  }

  // 2. 轮询宿主回复直到确认/拒绝/超时
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    let resp;
    try { resp = await read(taskId); } catch (e) { lastError = e.message; continue; }
    if (!resp || resp.ok !== true) { lastError = resp?.error || '读取失败'; continue; }

    // 从 read 结果中找匹配回复文本
    const texts = collectTexts(resp.result);
    for (const t of texts) {
      const parsed = parseConfirmReply(t, taskId);
      if (parsed.decision === 'approve') {
        return { ok: true, by: '宿主用户', confirmedAt: new Date().toISOString() };
      }
      if (parsed.decision === 'decline') {
        return { ok: false, declined: true, detail: parsed.reason || '用户拒绝', by: '宿主用户' };
      }
    }
  }

  // 3. 超时 → 自动拒绝（阿昭：不静默执行、不降级 L2）
  return {
    ok: false,
    timedOut: true,
    declined: true,
    detail: `L3 确认超时（${Math.round(timeoutMs / 60000)} 分钟无回复）${lastError ? '；读取提示: ' + lastError : ''}`,
  };
}

/**
 * 从 read 结果中提取所有可能的消息文本（尽力而为，兼容多种返回形状）
 */
function collectTexts(result) {
  if (!result) return [];
  const out = [];
  try {
    const raw = result.raw || result;
    const candidates = raw.messages || raw.items || raw.data || raw.replies || [];
    if (Array.isArray(candidates)) {
      for (const m of candidates) {
        const t = m?.text || m?.content || m?.message || (typeof m === 'string' ? m : null);
        if (typeof t === 'string') out.push(t);
      }
    }
    if (typeof raw === 'string') out.push(raw);
    if (out.length === 0 && result.replyText) out.push(result.replyText);
  } catch { /* 尽力而为 */ }
  return out;
}

// ============================================
// 导出
// ============================================

module.exports = {
  DEFAULTS,
  buildConfirmMessage,
  parseConfirmReply,
  confirmL3,
  collectTexts,
};
