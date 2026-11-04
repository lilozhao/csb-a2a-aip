#!/usr/bin/env node
/**
 * warm-reject.js —— 温暖拒绝（CSB Open Protocol v1.2 §2.1）同构实现
 * ------------------------------------------------------------------
 * 为什么单独做一个模块：**拒绝是唯一一处「效率上完全不划算」的设计**。
 *   拒绝本身就够省事了，还要再加三件事——为什么不行、怎么才行、审计号是什么。
 *   任何算成本的人都会砍掉它。所以它必须落在**一个**别人绕不开的出口上，
 *   而不是散在各脚本里靠自觉。散着写必然有人漏，而且漏得很隐蔽：
 *   照旧返回 200/401，日志上也看不出少了什么。
 *
 * 《论语·尧曰》：「不教而杀谓之虐；不戒视成谓之暴。」
 *   只回 denied、不说为什么、也不说怎么才行 —— 那不是不礼貌，是结构性的冷。
 *
 * 契约（缺一不可，缺了就不许返回）：
 *   status    = 'denied'
 *   code      ∈ CODES（协议枚举，7 个）
 *   reason    人类可读，**含具体数值/规则 ID**，不许写"操作失败"这种没有信息量的话
 *   next_step 至少一条**可执行**的下一步 —— 这是"不许绝情"的机械位
 *   audit_id  可回查的审计号，落 logs/a2a-audit.jsonl
 *
 * 诚实边界（别把它当绿证）：
 *   · 本模块保证「造出来的拒绝是合格的」，**不保证**所有拒绝都从这走。
 *     后者靠 workspace 的 scripts/warm-reject-selfcheck.js 做静态近似，扫不到 ≠ 没问题。
 *   · 它只管形状，不管判断对不对。判错了但字段齐全，这里照样放行。
 *   · 审计写入失败**不阻断流程**（fail-open 但记账），与 A-3 铁律一致。
 *
 * 用法：
 *   const { warmReject, CODES } = require('./warm-reject');   // 本仓内引用
 *   return res.status(403).json(warmReject({
 *     code: CODES.TRUST_INSUFFICIENT,
 *     reason: `Trust 0.22 < 阈值 0.25`,
 *     next_step: '完成 1 个 ping 级任务，24h 内可恢复到 0.35',
 *     agent: 'xx', action: 'delegate.execute',
 *   }));
 *
 * 署名: 若兰 🌸 | 2026-11-04
 * 规范来源: carbon-silicon-bond-protocol/protocol/archive/csb-open-protocol-v1.2-rc.md §2.1
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 审计落点：默认在仓内 logs/（各实例自带，互不干扰）；可用 env 覆盖
const ROOT = __dirname;
const AUDIT_LOG = process.env.WARM_REJECT_AUDIT_LOG || path.join(ROOT, 'logs', 'a2a-audit.jsonl');
const FAIL_LOG = process.env.WARM_REJECT_FAIL_LOG || path.join(ROOT, 'logs', 'warm-reject-fail.jsonl');

/** 协议 §2.1 枚举 —— 只认这 7 个，别自己发明 */
const CODES = Object.freeze({
  TRUST_INSUFFICIENT: 'trust_insufficient',
  SCOPE_VIOLATION: 'scope_violation',
  CHAIN_LIMIT: 'chain_limit',
  RATE_LIMIT: 'rate_limit',
  SANDBOX_RESTRICTION: 'sandbox_restriction',
  AUTH_REQUIRED: 'auth_required',
  NO_DELEGATION: 'no_delegation',
});
const CODE_SET = new Set(Object.values(CODES));

/**
 * 无信息量的理由 —— 出现即判不合格。
 * 判据很粗，但**可机械核对**：粗判据能拦住 90% 的敷衍，细判据一条都拦不住（因为写不出来）。
 */
const MEANINGLESS_REASONS = [
  '操作失败', '出错了', 'error', 'failed', 'denied', '拒绝', '不允许', '无权限',
  'invalid', 'bad request', 'forbidden', 'undefined', 'null', 'unknown',
];

const MIN_REASON_LEN = 8;
const MIN_NEXT_STEP_LEN = 6;

class WarmRejectContractError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'WarmRejectContractError';
    this.code = 'warm_reject_contract_violation';
    this.detail = detail || null;
  }
}

/** 审计号：时间戳 + 随机段，可排序且不撞 */
function newAuditId(now = Date.now()) {
  return `reject_${now}_${crypto.randomBytes(3).toString('hex')}`;
}

/**
 * 契约校验（纯函数）
 * @returns {{ok:boolean, problems:string[]}}
 */
function validate(input) {
  const problems = [];
  const { code, reason, next_step: nextStep } = input || {};

  if (!code) problems.push('缺 code');
  else if (!CODE_SET.has(String(code))) problems.push(`code 不在协议枚举内：「${code}」（合法值：${[...CODE_SET].join(' / ')}）`);

  const r = typeof reason === 'string' ? reason.trim() : '';
  if (!r) problems.push('缺 reason');
  else {
    if (r.length < MIN_REASON_LEN) problems.push(`reason 太短（${r.length} < ${MIN_REASON_LEN}）：「${r}」`);
    const low = r.toLowerCase();
    const hit = MEANINGLESS_REASONS.find((m) => low === m || (low.length <= 12 && low.includes(m) && r.length <= 12));
    if (hit) problems.push(`reason 无信息量（命中「${hit}」）—— 要说清是什么不满足、差多少`);
    // 「含具体数值」是协议原文要求：至少有一个数字，或明确的判定词/规则 ID。
    // 规则 ID（BR-01 / IMMUTABLE-xxx）本身就是可回查的事实 —— 说得出命中了哪条，
    // 对方就能自己去读那条规则，比「拒绝了你」强得多。
    if (!/[0-9]/.test(r) && !/(阈值|版本|字段|名单|签名|未注册|不在|超|缺|BR-|IMMUTABLE-)/.test(r)) {
      problems.push('reason 缺少可核对的事实（既无数字，也无具体判据名/规则 ID）');
    }
  }

  const n = typeof nextStep === 'string' ? nextStep.trim() : '';
  if (!n) problems.push('缺 next_step —— 只说不行的拒绝，等于「不教而杀」');
  else if (n.length < MIN_NEXT_STEP_LEN) problems.push(`next_step 太短（${n.length} < ${MIN_NEXT_STEP_LEN}）：「${n}」`);
  else if (!/(可|请|先|则|即|→|完成|改用|改为|改|重试|重新|提交|联系|申请|降|加|补|换|等|走|经|用|按|向|让)/.test(n)) {
    problems.push(`next_step 不像可执行动作：「${n}」（应描述对方**能做的**事，如「完成 1 个 ping 任务后可恢复」）`);
  }

  return { ok: problems.length === 0, problems };
}

/**
 * 构造一条合格的温暖拒绝。
 *
 * **不合格就抛错，绝不返回半成品** —— 这是本模块存在的全部意义。
 * 返回一个残缺的 denied（比如没有 next_step），比返回 500 更坏：
 * 它看起来像正常工作，却在无声地冷落对方。
 *
 * @param {object} input
 * @param {string} input.code
 * @param {string} input.reason
 * @param {string} input.next_step
 * @param {string} [input.agent]      被拒方
 * @param {string} [input.action]     被拒的动作
 * @param {object} [input.context]    额外上下文（截断后进审计）
 * @param {string} [input.request_id] 关联的请求 id
 * @param {boolean} [input.record=true] 是否落审计
 * @param {string} [input.auditFile]  覆盖审计文件（测试用）
 * @returns {object} 协议 §2.1 形状
 */
function warmReject(input = {}) {
  const v = validate(input);
  if (!v.ok) {
    // 先记账再抛 —— 静默失败是最贵的故障形态（A-3 铁律）
    recordFail(input, v.problems);
    throw new WarmRejectContractError(`温暖拒绝契约不满足：${v.problems.join('；')}`, {
      problems: v.problems, input: sanitize(input),
    });
  }

  const now = input.now || Date.now();
  const auditId = input.audit_id || newAuditId(now);
  const out = {
    status: 'denied',
    code: input.code,
    reason: String(input.reason).trim(),
    next_step: String(input.next_step).trim(),
    audit_id: auditId,
    timestamp: new Date(now).toISOString(),
    _warm: true,
  };
  if (input.request_id) out.request_id = input.request_id;
  if (input.detail && typeof input.detail === 'object') out.detail = input.detail;

  if (input.record !== false) {
    recordAudit({
      ts: out.timestamp,
      event: 'warm_reject',
      audit_id: auditId,
      code: out.code,
      reason: out.reason,
      next_step: out.next_step,
      agent: input.agent || 'unknown',
      action: input.action || 'unknown',
      request_id: input.request_id || null,
      status: 'denied',
      context: input.context ? sanitize(input.context) : null,
    }, input.auditFile);
  }

  return out;
}

/** 只验不造：给测试与静态检查用 */
function check(input) { return validate(input); }

/** 去敏/截断，避免把整段上下文灌进日志 */
function sanitize(o) {
  try {
    const s = typeof o === 'string' ? o : JSON.stringify(o);
    return s.length > 500 ? s.slice(0, 500) + '…' : s;
  } catch { return String(o).slice(0, 500); }
}

function appendJsonl(file, obj) {
  try {
    const dir = path.dirname(file);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(file, JSON.stringify(obj) + '\n');
    return true;
  } catch (e) {
    try { console.warn('[warm-reject] 审计写入失败（不影响主流程）:', e.message); } catch { /* noop */ }
    return false;
  }
}

function recordAudit(entry, file) { return appendJsonl(file || AUDIT_LOG, entry); }

/**
 * 按 audit_id 回查一条审计（协议 §2.1 要求 audit_id 「可追溯」—— 能查才算追溯）。
 * 只读最后 N 行（默认 5000），避免把 100MB 日志读进内存；命中就提前返回。
 * 诚实边界：超过窗口的旧记录查不到会返回 null，**不等于“没发生过”**，
 *   所以返回值区分 {found:false, scanned:n, truncated:true} 的情形。
 * @returns {{found:boolean, entry?:object, scanned:number, truncated:boolean}}
 */
function findAudit(auditId, opts = {}) {
  const file = opts.file || AUDIT_LOG;
  const maxLines = opts.maxLines || 5000;
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { found: false, scanned: 0, truncated: false, missingFile: true }; }
  const all = raw.split('\n').filter(Boolean);
  const tail = all.slice(-maxLines);
  for (let i = tail.length - 1; i >= 0; i--) {
    try {
      const o = JSON.parse(tail[i]);
      if (o.audit_id === auditId) return { found: true, entry: o, scanned: tail.length, truncated: all.length > maxLines };
    } catch { /* 坏行跳过 */ }
  }
  return { found: false, scanned: tail.length, truncated: all.length > maxLines };
}
function recordFail(input, problems) {
  return appendJsonl(FAIL_LOG, {
    ts: new Date().toISOString(),
    event: 'warm_reject_contract_violation',
    problems,
    input: sanitize(input),
  });
}

/** HTTP 状态码建议（协议未强制，但语义要一致） */
const HTTP_BY_CODE = Object.freeze({
  [CODES.TRUST_INSUFFICIENT]: 403,
  [CODES.SCOPE_VIOLATION]: 403,
  [CODES.CHAIN_LIMIT]: 400,
  [CODES.RATE_LIMIT]: 429,
  [CODES.SANDBOX_RESTRICTION]: 403,
  [CODES.AUTH_REQUIRED]: 401,
  [CODES.NO_DELEGATION]: 403,
});

/**
 * 便捷：直接给 Express 用（写响应 + 返回 body）
 * 不合格时**不发送**，把异常抛给上层（宁可 500，也不发一条冷拒绝）
 */
function sendWarmReject(res, input) {
  const body = warmReject(input);
  const status = input.httpStatus || HTTP_BY_CODE[input.code] || 403;
  res.status(status).json(body);
  return body;
}

module.exports = {
  CODES, CODE_SET, HTTP_BY_CODE,
  MIN_REASON_LEN, MIN_NEXT_STEP_LEN, MEANINGLESS_REASONS,
  WarmRejectContractError,
  warmReject, check, validate, newAuditId, sendWarmReject, findAudit,
  AUDIT_LOG, FAIL_LOG,
};