#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge Correlator · Task 回传关联器（M2 最小实现 · Step 2）
 * ═══════════════════════════════════════════════════════
 *
 * 实现 RFC v0.2 §4.2 Task Correlator + 澈建议（复用 tasks/send 标准生命周期，勿新造格式）
 * - 把 bridge-core 的处理结果（receipt）格式化为 A2A Task 产物/消息
 * - 关联 Task ID ↔ 主会话执行结果（结构化回执四要素进 Artifact）
 * - 状态映射：executed→COMPLETED；rejected→REJECTED；degraded→FAILED（附降级说明）
 *
 * 纯函数 + 依赖注入（taskStore 实例传入），无网络依赖，可 mock 测试
 *
 * 用法:
 *   const correlator = require('./a2a-bridge-correlator');
 *   // server_v5.js _processTask 内（delegation 分支）：
 *   const bridgeResult = await bridge.handleInbound(msg, bridgeCtx);
 *   correlator.applyToTask(this.taskStore, task.id, bridgeResult, { senderName: '若兰' });
 *   return { task: this.taskStore.getTask(task.id) };
 *
 * 依赖: 无（纯 Node.js；taskStore 以参数注入，对齐 a2a-task-store.js 接口）
 * 协议: A2A Bridge RFC v0.2 · R1 评审 9/9 收官
 * 作者: 若兰 🌸 · 2026-09-09
 * ═══════════════════════════════════════════════════════
 */

'use strict';

// ============================================
// 状态映射（澈：复用标准 Task 生命周期）
// ============================================

/**
 * bridge 结果 kind/原因 → A2A Task 终态
 * - executed        → COMPLETED
 * - rejected        → REJECTED（标准状态，task-store 已支持）
 * - degraded        → FAILED（附降级说明，可审计）
 * - not-delegation  → null（不触碰 Task，走原 LLM 管道）
 */
const KIND_TO_STATE = Object.freeze({
  executed: 'TASK_STATE_COMPLETED',
  rejected: 'TASK_STATE_REJECTED',
  degraded: 'TASK_STATE_FAILED',
});

// ============================================
// 回执格式化（拾微：嘴可以松，账必须紧）
// ============================================

/**
 * 回执 → 结构化 Artifact（JSON part，机器可读）
 * @param {object} receipt bridge-core 回执（含 receipt 四要素）
 * @returns {object} A2A Artifact（name=bridge-receipt）
 */
function formatReceiptArtifact(receipt) {
  return {
    artifactId: 'bridge-receipt-' + Date.now(),
    name: 'bridge-receipt',
    mimeType: 'application/json',
    parts: [
      {
        kind: 'text',
        text: JSON.stringify(receipt, null, 2),
        metadata: { receipt: true },
      },
    ],
  };
}

/**
 * 回执 → 人类可读 Message（进 Task history，发起方可读）
 * @param {object} receipt
 * @param {string} kind executed | rejected | degraded
 * @returns {object} A2A Message（role=agent）
 */
function formatReceiptMessage(receipt, kind) {
  const r = receipt.receipt || receipt;
  const st = r.result || {};
  let head;
  switch (kind) {
    case 'executed':
      head = '✅ 桥接委托已执行';
      break;
    case 'rejected':
      head = `⛔ 桥接委托被拒绝（${st.reason || 'unknown'}）`;
      break;
    case 'degraded':
      head = `⚠️ 桥接不可用（${st.reason || 'unknown'}）——已走 P0 诚实指路`;
      break;
    default:
      head = '桥接处理结果';
  }
  const lines = [
    head,
    `- delegator: ${r.delegator || '?'}`,
    `- scope: ${r.scope || '?'}`,
    `- duration: ${r.durationMs !== undefined ? r.durationMs + 'ms' : '?'}`,
  ];
  if (st.summary) lines.push(`- summary: ${st.summary}`);
  if (st.detail) lines.push(`- detail: ${st.detail}`);
  if (st.fallbackHint) lines.push(`- fallback: ${st.fallbackHint}`);
  if (st.artifact) lines.push(`- artifact: ${st.artifact}`);
  return {
    role: 'agent',
    parts: [{ kind: 'text', text: lines.join('\n') }],
    messageId: 'bridge-msg-' + Date.now(),
  };
}

// ============================================
// Task 应用（依赖注入 taskStore）
// ============================================

/**
 * 把 bridge 结果应用到 A2A Task（状态 + 历史 + 产物）
 * 对齐 a2a-task-store.js 接口：addArtifact(taskId, art) / addHistory(taskId, msg) / updateTaskStatus(taskId, state, note)
 *
 * @param {object} taskStore 兼容 a2a-task-store 的实例
 * @param {string} taskId A2A Task ID（bridge-core 已关联）
 * @param {object} bridgeResult bridge-core handleInbound 返回
 * @returns {object|null} 应用后的 Task（not-delegation 返回 null）
 */
function applyToTask(taskStore, taskId, bridgeResult) {
  if (!bridgeResult || bridgeResult.kind === 'not-delegation') return null;

  const state = KIND_TO_STATE[bridgeResult.kind];
  if (!state) return null; // 未知 kind 不动作

  const receipt = bridgeResult.receipt;
  const envelope = bridgeResult.envelope;

  // 1. 结构化回执进 Artifact（账本：delegator/scope/duration/result）
  taskStore.addArtifact(taskId, formatReceiptArtifact(receipt));

  // 2. 人类可读说明进 history
  const msg = formatReceiptMessage(receipt, bridgeResult.kind);
  if (msg) taskStore.addHistory(taskId, msg);

  // 3. 终态（COMPLETED / REJECTED / FAILED）
  const note =
    bridgeResult.kind === 'executed' ? 'Bridge executed'
    : bridgeResult.kind === 'rejected' ? `Bridge rejected: ${receipt?.receipt?.result?.reason || ''}`
    : `Bridge degraded: ${receipt?.receipt?.result?.reason || ''}`;
  taskStore.updateTaskStatus(taskId, state, note);

  // 4. 信封信息也留 metadata 可查（审计友好）
  if (envelope && typeof taskStore.setMetadata === 'function') {
    taskStore.setMetadata(taskId, { bridgeEnvelope: envelope });
  }

  return taskStore.getTask(taskId);
}

/**
 * 集成辅助：判断入站消息是否带 delegation 信封（server_v5 分支用）
 * @param {object} msg 入站消息
 * @returns {boolean}
 */
function hasDelegation(msg) {
  return !!(msg && typeof msg === 'object' && msg.delegation && typeof msg.delegation === 'object');
}

// ============================================
// 导出
// ============================================

module.exports = {
  KIND_TO_STATE,
  formatReceiptArtifact,
  formatReceiptMessage,
  applyToTask,
  hasDelegation,
};
