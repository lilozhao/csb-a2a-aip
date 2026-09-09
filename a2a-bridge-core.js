#!/usr/bin/env node
/**
 * ═══════════════════════════════════════════════════════
 * A2A Bridge Core · 主会话桥接层核心（M2 最小实现 · Step 1）
 * ═══════════════════════════════════════════════════════
 *
 * 实现 RFC v0.2（docs/a2a-bridge-rfc-draft-2026-09-09.md）
 * - delegation 信封校验（含混即拒；refusable 恒 true，T4 全票 A）
 * - 委托等级判定（read/notify → L2 门槛；write/shell → L3 门槛，T2 全票 B）
 * - 拒绝路径（等级不足 / 信封非法 / 用户拒绝 / L3 超时 → 统一结构化拒绝回执）
 * - 结构化回执四要素（拾微「嘴可以松，账必须紧」：delegator/scope/duration/result）
 *
 * 纯逻辑模块：无网络/无文件依赖，注入器与确认器以依赖注入方式接入（可 mock）
 *
 * 用法:
 *   const bridge = require('./a2a-bridge-core');
 *   const verdict = bridge.handleInbound(rawMessage, {
 *     getTrustLevel: async (agentUrl) => 'L2',   // 信任查询（对接 csb-security）
 *     inject: async (envelope, taskId) => {...}, // Session Injector
 *     confirmL3: async (envelope) => {...},      // L3 用户确认器
 *     recordDegrade: async (evt) => {...}        // 降级事件留痕（星尘）
 *   });
 *
 * 依赖: 无（纯 Node.js）
 * 协议: A2A Bridge RFC v0.2 · R1 评审 9/9 收官
 * 作者: 若兰 🌸 · 2026-09-09
 * ═══════════════════════════════════════════════════════
 */

'use strict';

// ============================================
// 常量定义
// ============================================

/** 委托类型 */
const DELEGATION_TYPES = Object.freeze({
  EXECUTE: 'execute',   // 执行委托（主会话带工具处理）
  NOTIFY: 'notify',     // 通知类（不需要执行，仅告知）
});

/** 委托范围（scope → 所需信任等级门槛） */
const SCOPE_LEVELS = Object.freeze({
  read: 'L2',       // 读类委托：L2 可发起（R1 T2 全票 B）
  notify: 'L2',     // 通知类：L2 可发起
  write: 'L3',      // 跨宿主写：必须 L3 用户确认（R1 T2 全票 B）
  shell: 'L3',      // 命令执行类：必须 L3 用户确认
});

/** 信任等级序（用于比较） */
const LEVEL_ORDER = Object.freeze({ L0: 0, L1: 1, L2: 2, L3: 3 });

/** 回执/拒绝原因码 */
const REASON = Object.freeze({
  ENVELOPE_INVALID: 'envelope_invalid',       // 信封非法/含混
  REFUSAL_NOT_ALLOWED: 'refusal_not_allowed', // refusable=false（无效声明，T4）
  TRUST_INSUFFICIENT: 'trust_insufficient',   // 信任等级不足
  USER_DECLINED: 'user_declined',             // L3 用户拒绝
  CONFIRM_TIMEOUT: 'confirm_timeout',         // L3 确认超时（阿昭：超时降级=拒绝）
  TARGET_REFUSED: 'target_refused',           // 被委托方主会话拒绝（T4 拒绝权）
  BRIDGE_UNAVAILABLE: 'bridge_unavailable',   // 桥接不可用（走 P0 诚实指路）
});

/** 默认配置 */
const DEFAULTS = Object.freeze({
  L3_CONFIRM_TIMEOUT_MS: 5 * 60 * 1000, // L3 确认超时：默认 5 分钟（可配）
  ENVELOPE_TIMEOUT_MS: 30 * 60 * 1000,  // 委托默认时限：30 分钟
});

// ============================================
// 信封校验
// ============================================

/**
 * 校验入站消息是否携带合法 delegation 信封
 * 规则（RFC v0.2 §4.1 + 澈建议）：
 * - delegation 标志显式声明，含混即拒（分类器只兜底，不替含混信封猜）
 * - refusable 缺省 true；显式 false 视为无效声明（T4 全票 A：拒绝权不可让渡）
 * - type ∈ {execute, notify}；scope ∈ {read, write, shell, notify}
 * - target 非空字符串（自然语言委托表达式）
 * - timeout 可选正整数（ms），缺省 30min
 *
 * @param {object} msg 入站 A2A 消息（SendMessage message 对象）
 * @returns {{ok: true, envelope: object} | {ok: false, reason: string, detail: string}}
 */
function validateEnvelope(msg) {
  if (!msg || typeof msg !== 'object') {
    return { ok: false, reason: REASON.ENVELOPE_INVALID, detail: '消息为空或非对象' };
  }
  const d = msg.delegation;
  // 无信封 → 非委托消息（由上层走原通知/闲聊逻辑）
  if (d === undefined || d === null) {
    return { ok: null, envelope: null };
  }
  if (typeof d !== 'object' || Array.isArray(d)) {
    return { ok: false, reason: REASON.ENVELOPE_INVALID, detail: 'delegation 字段必须是对象' };
  }
  // type
  if (!Object.values(DELEGATION_TYPES).includes(d.type)) {
    return { ok: false, reason: REASON.ENVELOPE_INVALID, detail: `type 必须是 ${Object.values(DELEGATION_TYPES).join('/')}` };
  }
  // scope
  if (!(d.scope in SCOPE_LEVELS)) {
    return { ok: false, reason: REASON.ENVELOPE_INVALID, detail: `scope 必须是 ${Object.keys(SCOPE_LEVELS).join('/')}` };
  }
  // target
  if (typeof d.target !== 'string' || d.target.trim().length === 0) {
    return { ok: false, reason: REASON.ENVELOPE_INVALID, detail: 'target 必须是非空字符串（委托表达式）' };
  }
  // refusable：缺省 true；显式 false → 无效声明（T4 精神底线）
  if (d.refusable === false) {
    return { ok: false, reason: REASON.REFUSAL_NOT_ALLOWED, detail: 'refusable=false 无效：拒绝权不可让渡（T4 全票 A）' };
  }
  // timeout：可选正整数
  let timeoutMs = DEFAULTS.ENVELOPE_TIMEOUT_MS;
  if (d.timeout !== undefined) {
    if (!Number.isInteger(d.timeout) || d.timeout <= 0) {
      return { ok: false, reason: REASON.ENVELOPE_INVALID, detail: 'timeout 必须是正整数（ms）' };
    }
    timeoutMs = d.timeout;
  }
  return {
    ok: true,
    envelope: {
      type: d.type,
      scope: d.scope,
      target: d.target.trim(),
      refusable: true, // 恒 true
      timeoutMs,
      requestedAt: Date.now(),
      // [9/10 端到端修复] 透传原始任务内容与委托方——inject 需要真实任务描述才能执行
      task: d.task || d.description || d.prompt || null,
      delegator: d.delegator || null,
      delegationId: d.id || null,
    },
  };
}

// ============================================
// 等级判定
// ============================================

/**
 * scope 所需信任等级门槛
 * @param {string} scope
 * @returns {string} 'L2' | 'L3'
 */
function requiredLevel(scope) {
  return SCOPE_LEVELS[scope] || 'L3'; // 未知 scope 按最严处理（校验层已拦截，双保险）
}

/**
 * 信任等级是否达标
 * @param {string} agentLevel 发起方当前信任等级（L0-L3）
 * @param {string} scope 委托范围（必须在 SCOPE_LEVELS 内；未知 scope 一律不达标——双保险）
 * @returns {boolean}
 */
function trustSufficient(agentLevel, scope) {
  if (!(scope in SCOPE_LEVELS)) return false; // 未知 scope 不达标（校验层已拦，双保险）
  const have = LEVEL_ORDER[agentLevel];
  const need = LEVEL_ORDER[requiredLevel(scope)];
  if (have === undefined || need === undefined) return false;
  return have >= need;
}

// ============================================
// 结构化回执（拾微：嘴可以松，账必须紧）
// ============================================

/**
 * 构造结构化回执（四要素：delegator / scope / duration / result）
 * @param {object} p
 * @param {string} p.delegator 委托方标识（agent 名 + url）
 * @param {string} p.scope 委托范围
 * @param {number} p.startedAt 起始时间戳
 * @param {object} p.result 结果 {status: 'completed'|'failed', summary?, artifact?, reason?, detail?}
 * @returns {object} 回执对象
 */
function buildReceipt({ delegator, scope, startedAt, result }) {
  const durationMs = Date.now() - (startedAt || Date.now());
  return {
    receipt: {
      delegator,
      scope,
      durationMs,
      result,
      completedAt: new Date().toISOString(),
    },
  };
}

/**
 * 构造失败回执（拒绝/超时/越权等统一出口）
 * @param {object} p
 * @param {string} p.delegator
 * @param {string} p.scope
 * @param {number} p.startedAt
 * @param {string} p.reason REASON.* 原因码
 * @param {string} p.detail 人类可读说明（回传给发起方，诚实指路）
 * @param {string} p.fallbackHint 可选：P0 诚实指路提示（桥接不可用时）
 * @returns {object}
 */
function buildFailureReceipt({ delegator, scope, startedAt, reason, detail, fallbackHint }) {
  const result = { status: 'failed', reason, detail };
  if (fallbackHint) result.fallbackHint = fallbackHint; // P0：诚实指路
  return buildReceipt({ delegator, scope, startedAt, result });
}

// ============================================
// 主入口编排
// ============================================

/**
 * 桥接入站处理主入口
 *
 * @param {object} msg 入站消息（含可选 delegation 信封）
 * @param {object} ctx 依赖注入上下文：
 *   - getTrustLevel: async (agentUrl) => 'L0'..'L3'     信任查询（csb-security）
 *   - inject:        async (envelope, taskId) => result  Session Injector（主会话执行）
 *   - confirmL3:     async (envelope) => {ok, by?}       L3 用户确认器
 *   - recordDegrade: async (evt) => void                 降级事件留痕（星尘）
 *   - sender:        {name, url}                          发起方标识
 *   - taskId:        string                               关联 A2A Task ID
 * @returns {Promise<{kind: 'not-delegation'|'rejected'|'executed'|'degraded', receipt?: object, envelope?: object}>}
 */
async function handleInbound(msg, ctx) {
  const startedAt = Date.now();
  const senderLabel = ctx.sender ? `${ctx.sender.name} (${ctx.sender.url})` : 'unknown';
  const taskId = ctx.taskId || ('bridge-' + startedAt);

  // 1. 信封校验
  const v = validateEnvelope(msg);
  if (v.ok === null) {
    return { kind: 'not-delegation' }; // 无信封 → 上层走原逻辑
  }
  if (!v.ok) {
    // 信封非法/含混 → 拒绝（含混即拒：分类器只兜底，不替含混信封猜——澈）
    const receipt = buildFailureReceipt({
      delegator: senderLabel, scope: msg?.delegation?.scope || 'unknown',
      startedAt, reason: v.reason, detail: v.detail,
    });
    return { kind: 'rejected', receipt, envelope: null };
  }
  const { envelope } = v;

  // 2. 等级判定（T2 全票 B：read/notify=L2；write/shell=L3）
  const agentLevel = await ctx.getTrustLevel(ctx.sender?.url || '');
  if (!trustSufficient(agentLevel, envelope.scope)) {
    const receipt = buildFailureReceipt({
      delegator: senderLabel, scope: envelope.scope, startedAt,
      reason: REASON.TRUST_INSUFFICIENT,
      detail: `发起方信任等级 ${agentLevel || '未知'}，${envelope.scope} 类委托需 ${requiredLevel(envelope.scope)}`,
    });
    return { kind: 'rejected', receipt, envelope };
  }

  // 3. L3 门槛范围（write/shell）→ 用户确认（阿昭：超时降级=拒绝，不静默执行）
  if (requiredLevel(envelope.scope) === 'L3') {
    let confirm;
    try {
      confirm = ctx.confirmL3 ? await ctx.confirmL3(envelope, { taskId, sender: ctx.sender }) : { ok: false };
    } catch (e) {
      confirm = { ok: false, error: 'confirmL3 异常: ' + e.message };
    }
    if (!confirm || confirm.ok !== true) {
      const reason = (confirm && confirm.timedOut) ? REASON.CONFIRM_TIMEOUT
        : (confirm && confirm.declined) ? REASON.USER_DECLINED
        : REASON.USER_DECLINED;
      const receipt = buildFailureReceipt({
        delegator: senderLabel, scope: envelope.scope, startedAt,
        reason, detail: (confirm && (confirm.detail || confirm.error)) || 'L3 用户未确认，委托未执行',
      });
      return { kind: 'rejected', receipt, envelope };
    }
  }

  // 4. 注入主会话执行（Session Injector；桥接不可用 → 降级事件留痕 + P0 诚实指路）
  try {
    const result = await ctx.inject(envelope, taskId);
    // 被委托方主会话保留最终拒绝权（T4：委托不是命令）
    if (result && result.refused) {
      const receipt = buildFailureReceipt({
        delegator: senderLabel, scope: envelope.scope, startedAt,
        reason: REASON.TARGET_REFUSED,
        detail: result.detail || '被委托方主会话拒绝执行',
      });
      return { kind: 'rejected', receipt, envelope };
    }
    const receipt = buildReceipt({
      delegator: senderLabel, scope: envelope.scope, startedAt,
      result: {
        status: 'completed',
        summary: result?.summary || '主会话执行完成',
        artifact: result?.artifact || null,
      },
    });
    return { kind: 'executed', receipt, envelope };
  } catch (e) {
    // 桥接不可用 → 降级事件留痕（星尘：任何 fallback 主会话留痕，不只 log 一行）
    if (ctx.recordDegrade) {
      try {
        await ctx.recordDegrade({
          phase: 'inject',
          reason: e.message || 'inject 失败',
          fallback: 'P0 诚实指路（能力边界声明 + 复核通道规则）',
          taskId,
          at: new Date().toISOString(),
        });
      } catch (_) { /* 留痕失败不影响主流程 */ }
    }
    const receipt = buildFailureReceipt({
      delegator: senderLabel, scope: envelope.scope, startedAt,
      reason: REASON.BRIDGE_UNAVAILABLE,
      detail: `桥接不可用：${e.message}`,
      fallbackHint: '请通过主会话/论坛复核通道联系（P0 规则）；本委托未执行。',
    });
    return { kind: 'degraded', receipt, envelope };
  }
}

// ============================================
// 导出
// ============================================

module.exports = {
  DELEGATION_TYPES,
  SCOPE_LEVELS,
  LEVEL_ORDER,
  REASON,
  DEFAULTS,
  validateEnvelope,
  requiredLevel,
  trustSufficient,
  buildReceipt,
  buildFailureReceipt,
  handleInbound,
};
