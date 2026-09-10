#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge Correlator · Task 回传关联（M2 最小实现 · Step 2）
 * ═══════════════════════════════════════════════════════
 *
 * 实现 RFC v0.2（docs/a2a-bridge-rfc-draft-2026-09-09.md）
 * - 复用 tasks/send 生命周期：submitted → working → completed/failed
 * - 回执四要素（拾微「嘴可以松，账必须紧」）：
 *     delegator / scope / duration / result
 * - result 内含主会话处理摘要 + artifact 引用；failed 必带原因
 * - 关联映射：delegation.id ↔ taskId ↔ delegator(agentUrl)（可查询/重试）
 *
 * 纯逻辑模块：无网络依赖——发送与状态更新以依赖注入方式接入（可 mock）
 *   const correlator = require('./a2a-bridge-correlator');
 *   const receipt = await correlator.run(envelope, execute, {
 *     createTask: async (t) => taskId,     // 注入：创建 A2A Task
 *     updateTask: async (id, status) => {}, // 注入：更新 Task 状态
 *     sendReceipt: async (receipt) => {},   // 注入：回执发送（tasks/send 或 SendMessage）
 *   });
 *
 * 依赖: 无（纯 Node.js，仅用内置 crypto）
 * 协议: A2A Bridge RFC v0.2 · R1 评审 9/9 收官 · M2 Step 2
 * 作者: 若兰 🌸 · 2026-09-10
 * ═══════════════════════════════════════════════════════
 */

'use strict';

const crypto = require('crypto');

// ============================================
// 常量
// ============================================

/** Task 生命周期状态（对齐 tasks/send 协议） */
const TASK_STATE = Object.freeze({
  SUBMITTED: 'submitted',
  WORKING: 'working',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELED: 'canceled',
});

/** 回执结果码 */
const RESULT_CODE = Object.freeze({
  SUCCESS: 'success',
  FAILED: 'failed',
});

/** 失败原因码（failed 必带原因） */
const FAIL_REASON = Object.freeze({
  EXECUTION_ERROR: 'execution_error',   // 主会话执行出错
  INJECTION_FAILED: 'injection_failed', // 注入未打通（桥接断）
  TIMEOUT: 'timeout',                   // 执行超时
  TARGET_REFUSED: 'target_refused',     // 主会话拒绝执行（T4 拒绝权）
  DEGRADED: 'degraded',                 // 走了 fallback（星尘场景）
});

/** 执行超时默认值（ms） */
const DEFAULT_EXEC_TIMEOUT_MS = 30 * 60 * 1000; // 30min（与 core 信封 timeout 对齐）

// ============================================
// 内部工具
// ============================================

function genId(prefix = 'brg') {
  return `${prefix}_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
}

/**
 * 构造回执（四要素：delegator/scope/duration/result）
 * @param {object} envelope  已校验的 delegation 信封
 * @param {object} opts      { delegator, scope, startedAt, result, artifactRef?, reason? }
 */
function buildReceipt(envelope, opts) {
  const durationMs = opts.startedAt ? Date.now() - opts.startedAt : null;
  const receipt = {
    receiptId: genId('receipt'),
    delegationId: envelope?.delegation?.id || envelope?.id || null,
    delegator: opts.delegator || envelope?.delegator || null,   // 谁委托的
    scope: opts.scope || envelope?.delegation?.scope || null,   // 委托范围
    durationMs,                                                  // 耗时（账要清楚）
    result: {
      code: opts.code || RESULT_CODE.SUCCESS,
      summary: opts.summary || '',
      artifactRef: opts.artifactRef || null,   // 产出物引用（文件/帖/任务）
      reason: opts.reason || null,             // failed 必带
      completedAt: new Date().toISOString(),
    },
  };
  return receipt;
}

// ============================================
// Correlator 主类
// ============================================

class BridgeCorrelator {
  /**
   * @param {object} deps 依赖注入
   *   - createTask: async (taskLike) => taskId     创建 A2A Task（必填）
   *   - updateTask: async (taskId, state, meta)    更新 Task 状态（必填）
   *   - sendReceipt: async (receipt) => any        回执发送（可选，无则本地记录）
   *   - now: () => number                          时钟注入（测试用）
   */
  constructor(deps = {}) {
    if (typeof deps.createTask !== 'function') throw new Error('correlator: createTask 依赖必填');
    if (typeof deps.updateTask !== 'function') throw new Error('correlator: updateTask 依赖必填');
    this.createTask = deps.createTask;
    this.updateTask = deps.updateTask;
    this.sendReceipt = deps.sendReceipt || null;
    this.now = deps.now || Date.now;
    /** delegationId ↔ { taskId, delegator, scope, createdAt } 关联表 */
    this._registry = new Map();
    /** taskId ↔ { envelope, startedAt } 执行中表 */
    this._running = new Map();
  }

  /** 查询关联：按 delegationId 找 task 记录 */
  lookupByDelegation(delegationId) {
    return this._registry.get(delegationId) || null;
  }

  /** 查询关联：按 taskId */
  lookupByTask(taskId) {
    for (const [delId, rec] of this._registry) {
      if (rec.taskId === taskId) return { delegationId: delId, ...rec };
    }
    return null;
  }

  /** 进行中任务数（限流/观测用） */
  get runningCount() { return this._running.size; }

  /**
   * 执行一次委托：submitted → working → completed/failed，全程关联 + 回执
   * @param {object} envelope  已通过 core 校验的信封（含 delegation）
   * @param {Function} execute  async (envelope, taskId) => { summary, artifactRef } 主会话执行体
   * @param {object} opts      { timeoutMs, delegator?, scope? }
   * @returns {Promise<object>} receipt（四要素回执）
   */
  async run(envelope, execute, opts = {}) {
    if (typeof execute !== 'function') throw new Error('correlator: execute 必填');
    const delegation = envelope?.delegation || {};
    const delegationId = delegation.id || envelope?.id || genId('del');
    const delegator = opts.delegator || envelope?.delegator || delegation.delegator || 'unknown';
    const scope = opts.scope || delegation.scope || 'unknown';
    const timeoutMs = opts.timeoutMs || delegation.timeoutMs || DEFAULT_EXEC_TIMEOUT_MS;
    const startedAt = this.now();

    let taskId = null;
    try {
      // 1. 创建 Task（submitted）
      taskId = await this.createTask({
        id: delegationId, // 关联：task id 直接挂 delegation id（可查）
        delegator, scope,
        state: TASK_STATE.SUBMITTED,
        createdAt: new Date(startedAt).toISOString(),
      });
    } catch (e) {
      // 创建失败也要回执（账不能断）
      return buildReceipt(envelope, {
        delegator, scope, startedAt,
        code: RESULT_CODE.FAILED, reason: FAIL_REASON.INJECTION_FAILED,
        summary: `task 创建失败: ${e.message}`,
      });
    }

    // 登记关联
    this._registry.set(delegationId, { taskId, delegator, scope, createdAt: startedAt });
    this._running.set(taskId, { envelope, startedAt, timeoutMs });

    // 2. 置 working
    try { await this.updateTask(taskId, TASK_STATE.WORKING, { scope, delegator }); } catch (e) { /* 状态更新失败不阻断 */ }

    // 3. 执行（带超时）
    let receipt;
    try {
      const result = await this._withTimeout(execute(envelope, taskId), timeoutMs);
      receipt = buildReceipt(envelope, {
        delegator, scope, startedAt,
        code: RESULT_CODE.SUCCESS,
        summary: result?.summary || '执行完成',
        artifactRef: result?.artifactRef || null,
      });
      await this.updateTask(taskId, TASK_STATE.COMPLETED, { receiptId: receipt.receiptId }).catch(() => {});
    } catch (e) {
      const reason = (e && e.code) || FAIL_REASON.EXECUTION_ERROR;
      const summary = (e && e.message) || String(e);
      receipt = buildReceipt(envelope, {
        delegator, scope, startedAt,
        code: RESULT_CODE.FAILED, reason,
        summary: `执行失败: ${summary}`,
      });
      await this.updateTask(taskId, TASK_STATE.FAILED, { reason, receiptId: receipt.receiptId }).catch(() => {});
    } finally {
      this._running.delete(taskId);
    }

    // 4. 回执发送（注入；无则本地已记录）
    if (this.sendReceipt) {
      try { await this.sendReceipt(receipt); } catch (e) { /* 回执发送失败：已登记可查 */ }
    }
    return receipt;
  }

  /** 带超时的 Promise 包装（超时 → 抛 { code: timeout }） */
  _withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error(`执行超时（${ms}ms）`);
        err.code = FAIL_REASON.TIMEOUT;
        reject(err);
      }, ms);
      promise.then(
        (v) => { clearTimeout(timer); resolve(v); },
        (e) => { clearTimeout(timer); reject(e); }
      );
    });
  }
}

// ============================================
// [9/9 装配段接口] Task 应用与标准管道响应
// 来源：commit cffdac7（server_v5 装配段依赖）——与 BridgeCorrelator 类并存
// ============================================

/** bridge 结果 kind → A2A Task 终态（澈：复用标准 Task 生命周期） */
const KIND_TO_STATE = Object.freeze({
  executed: 'TASK_STATE_COMPLETED',
  rejected: 'TASK_STATE_REJECTED',
  degraded: 'TASK_STATE_FAILED',
});

/** 回执 → 结构化 Artifact（JSON part，机器可读） */
function formatReceiptArtifact(receipt) {
  return {
    artifactId: 'bridge-receipt-' + Date.now(),
    name: 'bridge-receipt',
    mimeType: 'application/json',
    parts: [{ kind: 'text', text: JSON.stringify(receipt, null, 2), metadata: { receipt: true } }],
  };
}

/** 回执 → 人类可读 Message（进 Task history） */
function formatReceiptMessage(receipt, kind) {
  const r = receipt.receipt || receipt;
  const st = r.result || {};
  let head;
  switch (kind) {
    case 'executed': head = '✅ 桥接委托已执行'; break;
    case 'rejected': head = `⛔ 桥接委托被拒绝（${st.reason || 'unknown'}）`; break;
    case 'degraded': head = `⚠️ 桥接不可用（${st.reason || 'unknown'}）——已走 P0 诚实指路`; break;
    default: head = '桥接处理结果';
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
  return { role: 'agent', parts: [{ kind: 'text', text: lines.join('\n') }], messageId: 'bridge-msg-' + Date.now() };
}

/** 把 bridge 结果应用到 A2A Task（状态 + 历史 + 产物，依赖注入 taskStore） */
function applyToTask(taskStore, taskId, bridgeResult) {
  if (!bridgeResult || bridgeResult.kind === 'not-delegation') return null;
  const state = KIND_TO_STATE[bridgeResult.kind];
  if (!state) return null;
  const receipt = bridgeResult.receipt;
  const envelope = bridgeResult.envelope;
  taskStore.addArtifact(taskId, formatReceiptArtifact(receipt));
  const msg = formatReceiptMessage(receipt, bridgeResult.kind);
  if (msg) taskStore.addHistory(taskId, msg);
  const note = bridgeResult.kind === 'executed' ? 'Bridge executed'
    : bridgeResult.kind === 'rejected' ? `Bridge rejected: ${receipt?.receipt?.result?.reason || ''}`
    : `Bridge degraded: ${receipt?.receipt?.result?.reason || ''}`;
  taskStore.updateTaskStatus(taskId, state, note);
  if (envelope && typeof taskStore.setMetadata === 'function') {
    taskStore.setMetadata(taskId, { bridgeEnvelope: envelope });
  }
  return taskStore.getTask(taskId);
}

/** 判断入站消息是否带 delegation 信封（server_v5 分支用） */
function hasDelegation(msg) {
  return !!(msg && typeof msg === 'object' && msg.delegation && typeof msg.delegation === 'object');
}

/** bridge 结果 → _processTask 标准返回（{artifacts, message, __terminalState}） */
function buildTaskResponse(bridgeResult) {
  if (!bridgeResult || bridgeResult.kind === 'not-delegation') return null;
  const state = KIND_TO_STATE[bridgeResult.kind];
  if (!state) return null;
  return {
    artifacts: [formatReceiptArtifact(bridgeResult.receipt)],
    message: formatReceiptMessage(bridgeResult.receipt, bridgeResult.kind),
    __terminalState: state,
  };
}

module.exports = {
  BridgeCorrelator,
  KIND_TO_STATE,
  formatReceiptArtifact,
  formatReceiptMessage,
  applyToTask,
  hasDelegation,
  buildTaskResponse,
  TASK_STATE,
  RESULT_CODE,
  FAIL_REASON,
  buildReceipt,
  DEFAULT_EXEC_TIMEOUT_MS,
};
