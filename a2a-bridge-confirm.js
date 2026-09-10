#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge Confirm · L3 用户确认流（M2 实现 · Step 4）
 * ═══════════════════════════════════════════════════════
 *
 * 实现 RFC v0.2 §四（L3 确认流时序）
 * - write/shell 类委托 → 必须碳基用户确认（T2 全票 B：跨宿主写必 L3）
 * - 超时降级 = 拒绝（阿昭：L3 超时降级不静默执行）
 * - 同源同批聚合（M2 风险 3：确认请求聚合，防打扰轰炸）
 * - 全程审计留痕（谁确认/何时/结果/超时）
 * - 一事一确认：taskId 幂等（防重复确认/重放）
 *
 * 依赖注入（可 mock）：
 *   - sendConfirmRequest: async ({taskId, summary, scope, delegator, deadlineAt}) => void
 *     向用户投递确认请求（本机=飞书私聊；跨机=被委托方的用户通道）
 *   - awaitResponse: async (taskId) => {approved, by, at} | null
 *     （可选）外部响应回调式；缺省用 waitForDecision 轮询决策表
 *
 * 用法：
 *   const confirm = require('./a2a-bridge-confirm');
 *   const flow = confirm.createConfirmFlow({ sendConfirmRequest });
 *   // 用户答复入口（IM webhook / 工具调用）：
 *   flow.resolve(taskId, { approved: true, by: '一澜' });
 *   // bridge core 的 confirmL3 依赖：
 *   const r = await flow.confirmL3(envelope, { taskId, sender });
 *
 * 依赖: 无（纯 Node.js）
 * 协议: A2A Bridge RFC v0.2 · M2 Step 4
 * 作者: 若兰 🌸 · 2026-09-10
 * ═══════════════════════════════════════════════════════
 */

'use strict';

const DEFAULT_CONFIRM_TIMEOUT_MS = 10 * 60 * 1000; // 10 分钟（超时=拒绝）
const AGGREGATE_WINDOW_MS = 60 * 1000;              // 同源聚合窗口 60s

/** 决策状态 */
const DECISION = Object.freeze({
  PENDING: 'pending',
  APPROVED: 'approved',
  DECLINED: 'declined',
  TIMED_OUT: 'timed_out',
  AGGREGATED: 'aggregated', // 被聚合进同源批次
});

class ConfirmFlow {
  /**
   * @param {object} deps
   *   - sendConfirmRequest: async (req) => void   投递确认请求（必填）
   *   - timeoutMs: number                          确认超时（缺省 10min）
   *   - audit: (evt) => void                       审计留痕（可选）
   *   - now: () => number                          时钟（测试注入）
   */
  constructor(deps = {}) {
    if (typeof deps.sendConfirmRequest !== 'function') throw new Error('confirm: sendConfirmRequest 依赖必填');
    this.sendConfirmRequest = deps.sendConfirmRequest;
    this.timeoutMs = deps.timeoutMs || DEFAULT_CONFIRM_TIMEOUT_MS;
    this.audit = deps.audit || (() => {});
    this.now = deps.now || Date.now;

    /** taskId → { envelope, sender, decision, deadlineAt, resolvers[], createdAt, aggregatedInto? } */
    this._pending = new Map();
    /** 同源最近批次：`${scope}|${delegatorHost}` → { taskId, at } */
    this._recentBatch = new Map();
  }

  /** 待确认数（观测） */
  get pendingCount() { return [...this._pending.values()].filter(p => p.decision === DECISION.PENDING).length; }

  /**
   * L3 确认（bridge core 依赖签名）
   * @returns {Promise<{ok:boolean, by?:string, declined?:boolean, timedOut?:boolean, aggregated?:boolean, detail?:string}>}
   */
  async confirmL3(envelope, ctx = {}) {
    const taskId = ctx.taskId || ('confirm-' + this.now());
    const scope = envelope?.scope || 'unknown';
    const delegator = ctx.sender?.url || envelope?.delegator || 'unknown';
    const summary = envelope?.task || '(任务内容缺失)';
    const startedAt = this.now();
    const deadlineAt = startedAt + this.timeoutMs;

    // 1. 幂等：已存在同 taskId 的决策 → 直接返回
    const existing = this._pending.get(taskId);
    if (existing && existing.decision !== DECISION.PENDING) {
      return this._toResult(existing);
    }

    // 2. 同源聚合（M2 风险 3）：同 scope+delegator 在窗口内已有 pending → 归并提示，复用同一等待
    const batchKey = `${scope}|${this._hostOf(delegator)}`;
    const recent = this._recentBatch.get(batchKey);
    let aggregatedInto = null;
    if (recent && (startedAt - recent.at) < AGGREGATE_WINDOW_MS && this._pending.has(recent.taskId)) {
      aggregatedInto = recent.taskId;
      this.audit({ phase: 'confirm', taskId, event: 'aggregated', into: aggregatedInto, at: new Date().toISOString() });
    } else {
      this._recentBatch.set(batchKey, { taskId, at: startedAt });
    }

    // 3. 登记 pending + 投递确认请求
    const record = {
      envelope, sender: ctx.sender, taskId,
      decision: DECISION.PENDING,
      deadlineAt, createdAt: startedAt,
      aggregatedInto,
      resolvers: [],
    };
    this._pending.set(taskId, record);

    if (!aggregatedInto) {
      try {
        await this.sendConfirmRequest({
          taskId, summary: String(summary).slice(0, 500), scope, delegator,
          deadlineAt, at: new Date(startedAt).toISOString(),
        });
      } catch (e) {
        // 投递失败 → 直接拒绝（不静默执行）
        record.decision = DECISION.DECLINED;
        record.detail = `确认请求投递失败: ${e.message}`;
        this.audit({ phase: 'confirm', taskId, event: 'delivery_failed', error: e.message, at: new Date().toISOString() });
        return this._toResult(record);
      }
    }

    // 4. 等待决策或超时（超时=拒绝，阿昭规则）
    const decision = await this._waitDecision(taskId);
    return decision;
  }

  /**
   * 用户答复入口（IM webhook / 工具调用 / 测试直接调）
   * @param {string} taskId
   * @param {{approved:boolean, by?:string}} answer
   */
  resolve(taskId, answer = {}) {
    const rec = this._pending.get(taskId);
    if (!rec) return { ok: false, detail: 'unknown taskId' };
    if (rec.decision !== DECISION.PENDING) return this._toResult(rec);

    rec.decision = answer.approved === true ? DECISION.APPROVED : DECISION.DECLINED;
    rec.by = answer.by || 'user';
    rec.resolvedAt = this.now();
    this.audit({
      phase: 'confirm', taskId, event: rec.decision,
      by: rec.by, at: new Date(rec.resolvedAt).toISOString(),
      latencyMs: rec.resolvedAt - rec.createdAt,
    });
    // 唤醒等待者
    for (const r of rec.resolvers) r(this._toResult(rec));
    rec.resolvers = [];
    return this._toResult(rec);
  }

  /** 等待决策（内部）：超时 → 置 TIMED_OUT（=拒绝）并唤醒 */
  _waitDecision(taskId) {
    const rec = this._pending.get(taskId);
    return new Promise((resolve) => {
      if (rec.decision !== DECISION.PENDING) { resolve(this._toResult(rec)); return; }
      rec.resolvers.push(resolve);
      const timer = setTimeout(() => {
        if (rec.decision === DECISION.PENDING) {
          rec.decision = DECISION.TIMED_OUT;
          rec.detail = `确认超时（${this.timeoutMs}ms）——按约定视为拒绝，未执行`;
          this.audit({ phase: 'confirm', taskId, event: 'timed_out', at: new Date(this.now()).toISOString() });
          for (const r of rec.resolvers) r(this._toResult(rec));
          rec.resolvers = [];
        }
      }, this.timeoutMs);
      // 注意：不能 unref——超时是核心机制，需保持事件循环活跃以完成 Promise
    });
  }

  _toResult(rec) {
    if (rec.decision === DECISION.APPROVED) {
      return { ok: true, by: rec.by || 'user', detail: `已确认（${rec.by || 'user'}）` };
    }
    if (rec.decision === DECISION.TIMED_OUT) {
      return { ok: false, declined: false, timedOut: true, detail: rec.detail || '确认超时，视为拒绝' };
    }
    // DECLINED
    return { ok: false, declined: true, detail: rec.detail || `用户拒绝（${rec.by || 'user'}）` };
  }

  /** 审计查询：某 taskId 的决策记录 */
  getRecord(taskId) {
    const r = this._pending.get(taskId);
    if (!r) return null;
    return { taskId, decision: r.decision, by: r.by || null, createdAt: r.createdAt, deadlineAt: r.deadlineAt, aggregatedInto: r.aggregatedInto };
  }

  /** 清理已完成记录（内存管理；默认保留 1h） */
  prune(olderThanMs = 60 * 60 * 1000) {
    const cut = this.now() - olderThanMs;
    let n = 0;
    for (const [id, rec] of this._pending) {
      if (rec.decision !== DECISION.PENDING && rec.createdAt < cut) { this._pending.delete(id); n++; }
    }
    return n;
  }

  _hostOf(url) {
    try { return new URL(url).host; } catch { return String(url).slice(0, 40); }
  }
}

function createConfirmFlow(deps) { return new ConfirmFlow(deps); }

module.exports = { ConfirmFlow, createConfirmFlow, DECISION, DEFAULT_CONFIRM_TIMEOUT_MS, AGGREGATE_WINDOW_MS };
