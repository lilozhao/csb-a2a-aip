#!/usr/bin/env node
/**
 * a2a-expansion.js —— A2A 原文按需展开与逐次授权（SPEC-A2A-0003 · v1.0 · L 级）
 *
 * 二期（Q2 授权模型）：承一期 min_info（默认只传「结论+证据指针」），
 * 补「指针 → 原文」的**按需展开**闭环。默认拒绝 fail-safe + 逐次显式授权起步；
 * 契约预授权本期**不实现、默认关**（见 spec §RFC-DRAFT-ANCHOR）。
 *
 * 需求映射（R1–R12 / A1–A12）见 tests/expansion.test.js。
 * 边界：pull-only（非 push）；不引入新依赖；不绕过身份校验。
 */
'use strict';
const crypto = require('crypto');

/** 拒绝码（R2/R6/R8/R9） */
const CODE = {
  IDENTITY_REQUIRED: 'EXPANSION_IDENTITY_REQUIRED',
  NOT_AUTHORIZED: 'EXPANSION_NOT_AUTHORIZED',
  TIMEOUT: 'EXPANSION_TIMEOUT',
  SCOPE_EXCEEDED: 'EXPANSION_SCOPE_EXCEEDED',
  RATE_LIMITED: 'EXPANSION_RATE_LIMITED',
  BREACH: 'EXPANSION_BREACH',
};

/** 授权粒度首期仅 single-ref（Q1 定案） */
const GRANULARITY_DEFAULT = 'single-ref';

/** env 开关 */
function enabled() {
  return /^(1|true|on|yes)$/i.test(String(process.env.A2A_EXPANSION_ENABLED || '').trim());
}
function confirmTimeoutMs() {
  const v = parseInt(process.env.A2A_EXPANSION_CONFIRM_TIMEOUT_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 300000;
}
function rateLimit() {
  // 默认 3 次 / 60s / 身份
  const v = parseInt(process.env.A2A_EXPANSION_RATE_LIMIT || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 3;
}
function rateWindowMs() {
  const v = parseInt(process.env.A2A_EXPANSION_RATE_WINDOW_MS || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 60000;
}
function fatigueThreshold() {
  const v = parseInt(process.env.A2A_EXPANSION_FATIGUE_THRESHOLD || '', 10);
  return Number.isFinite(v) && v > 0 ? v : 5;
}

/** 请求指纹（R11 防重放）：hash(raw_ref.pointer + requester.name + purpose) */
function requestFingerprint(rawRef, requesterName, purpose) {
  const pointer = (rawRef && rawRef.pointer) || '';
  return crypto.createHash('sha256').update(`${pointer}|${requesterName || ''}|${purpose || ''}`).digest('hex');
}

/** 视图指纹（R12）：schema_hash + 不可逆脱敏 */
function schemaHash(view) {
  const norm = JSON.stringify(view, Object.keys(view || {}).sort());
  return 'sha256:' + crypto.createHash('sha256').update(norm).digest('hex').slice(0, 16);
}

/** 不可逆脱敏（R12）：不返回可还原的原文；仅保留哈希指纹 */
function desensitize(rawValue) {
  const h = crypto.createHash('sha256').update(String(rawValue == null ? '' : rawValue)).digest('hex').slice(0, 12);
  return { redacted: true, fingerprint: 'sha256:' + h };
}

/** 身份校验（R2）：申请人须具 A2A 标准身份名 */
function validateRequester(requester) {
  if (!requester || typeof requester !== 'object') return { ok: false, code: CODE.IDENTITY_REQUIRED, detail: '缺 requester' };
  if (typeof requester.name !== 'string' || requester.name.trim() === '') {
    return { ok: false, code: CODE.IDENTITY_REQUIRED, detail: 'requester.name 缺失（身份无默认值 P2）' };
  }
  return { ok: true };
}

/**
 * 限频状态（内存，进程内；R9）。key = 身份 → 时间戳数组。
 * 注：单实例内存计数；多实例部署需外置（spec 未强制）。
 */
const _rateBuckets = new Map();
function _rateCheck(identity, now = Date.now()) {
  const arr = (_rateBuckets.get(identity) || []).filter((ts) => now - ts < rateWindowMs());
  if (arr.length >= rateLimit()) return { ok: false, retry_after_ms: rateWindowMs() - (now - arr[0]) };
  arr.push(now);
  _rateBuckets.set(identity, arr);
  return { ok: true };
}
function _resetRate() { _rateBuckets.clear(); }

/**
 * 授权判定（R3 默认拒绝）。授权来源：显式逐次授权（本函数入参 grants）。
 * 契约预授权本期不实现（默认关）→ 一律不认。
 * @param {{raw_ref:object, requester:object, scope:object}} req
 * @param {{grants:Array<{pointer:string,requester:string,ttl_s?:number}>, now?:number}} ctx
 */
function decideAuthorization(req, ctx = {}) {
  const now = ctx.now || Date.now();
  const grants = Array.isArray(ctx.grants) ? ctx.grants : [];
  const pointer = (req.raw_ref && req.raw_ref.pointer) || '';
  const who = (req.requester && req.requester.name) || '';
  const hit = grants.find((g) => g && g.pointer === pointer && g.requester === who);
  if (!hit) return { granted: false, needsHuman: requiresHuman(req) };
  if (hit.ttl_s && hit.expires_at && now > hit.expires_at) {
    return { granted: false, needsHuman: requiresHuman(req), reason: CODE.TIMEOUT };
  }
  return { granted: true, grant: hit };
}

/** 是否需人类确认（逐次显式授权路径 → 需 L3 确认窗口） */
function requiresHuman(req) {
  // 默认：逐次显式授权 → 需人类确认
  return !(req && req.preauth === true); // 预授权本期不实现，恒走人工
}

/** 数据侧权威裁剪 + schema_hash + 不可逆脱敏（R5/R12/R13） */
function projectView(rawValue, scope = {}) {
  const g = scope.granularity || GRANULARITY_DEFAULT;
  if (g !== GRANULARITY_DEFAULT) {
    return { ok: false, code: CODE.SCOPE_EXCEEDED, detail: `首期仅支持 ${GRANULARITY_DEFAULT}；请求 ${g}` };
  }
  // 不可逆脱敏：不回原文，只回指纹
  const view = desensitize(rawValue);
  view.schema_hash = schemaHash(view);
  return { ok: true, view };
}

/** 结构化拒绝（R6）：写账本，不静默 */
function denyWithReason(code, reason, ledger) {
  const rec = { action: 'expansion.denied', code, reason, ts: new Date().toISOString() };
  if (typeof ledger === 'function') { try { ledger(rec); } catch (_) {} }
  return { state: 'denied', code, reason };
}

/** 安全例外通道（R8）：breach 达判据 → 触发审计（不受授权链限制） */
const BREACH_KINDS = ['breach', 'boundary-cross', 'unauthorized-action', 'privacy-boundary'];
function securityException(event, auditor) {
  if (!event || !BREACH_KINDS.includes(event.kind)) return { triggered: false };
  const rec = { action: 'expansion.security_audit', kind: event.kind, ts: new Date().toISOString() };
  if (typeof auditor === 'function') { try { auditor(rec); } catch (_) {} }
  return { triggered: true, record: rec };
}

/** pending 指纹去重（R11）：窗口内同一指纹仅受理一次 */
const _pendingSeen = new Map();
function _pendingFingerprintOnce(fp, now = Date.now()) {
  const prev = _pendingSeen.get(fp);
  if (prev && now - prev < confirmTimeoutMs()) return { accepted: false };
  _pendingSeen.set(fp, now);
  return { accepted: true };
}
function _resetPending() { _pendingSeen.clear(); }

/** 防疲劳（R10）：同一主人连续未决达阈值 → 汇总为一条 */
function fatigueAggregate(pendingCount) {
  return { aggregated: pendingCount >= fatigueThreshold(), count: pendingCount };
}

/**
 * 主入口：处理一次展开请求（R1–R12）。
 * @param {object} params {raw_ref, requester, scope, purpose}
 * @param {object} ctx {grants, dataProvider(pointer)→rawValue, ledger, auditor, now}
 * @returns {object} 三态：granted / expansion_pending / denied
 */
function handleRequestExpansion(params, ctx = {}) {
  if (!enabled()) {
    // 默认关：与一期一致（不展开）
    return { state: 'denied', code: CODE.NOT_AUTHORIZED, reason: 'expansion disabled (A2A_EXPANSION_ENABLED=off)' };
  }

  // R2 身份
  const idr = validateRequester(params && params.requester);
  if (!idr.ok) return denyWithReason(idr.code, idr.detail, ctx.ledger);

  // R9 限频
  const rl = _rateCheck(params.requester.name, ctx.now || Date.now());
  if (!rl.ok) return denyWithReason(CODE.RATE_LIMITED, `超过限频（${rateLimit()}/${rateWindowMs()}ms）`, ctx.ledger);

  // R3 授权判定（默认拒绝）
  const authz = decideAuthorization(params, ctx);
  if (authz.granted) {
    const prov = typeof ctx.dataProvider === 'function' ? ctx.dataProvider(params.raw_ref.pointer) : undefined;
    const pv = projectView(prov, params.scope || {});
    if (!pv.ok) return denyWithReason(pv.code, pv.detail, ctx.ledger);
    return { state: 'granted', view: pv.view, retention: 'delete-after-use' }; // R7
  }

  // R4 pending（需人类确认）
  if (authz.needsHuman) {
    const fp = requestFingerprint(params.raw_ref, params.requester.name, params.purpose);
    const once = _pendingFingerprintOnce(fp, ctx.now || Date.now());
    if (!once.accepted) return denyWithReason(CODE.NOT_AUTHORIZED, '重复 pending（防重放 R11）', ctx.ledger);
    if (typeof ctx.notifyOwner === 'function') { try { ctx.notifyOwner({ fingerprint: fp }); } catch (_) {} }
    return { state: 'expansion_pending', confirm_by: new Date((ctx.now || Date.now()) + confirmTimeoutMs()).toISOString(), fingerprint: fp };
  }

  return denyWithReason(CODE.NOT_AUTHORIZED, '无有效授权（默认拒绝 R3）', ctx.ledger);
}

module.exports = {
  CODE, GRANULARITY_DEFAULT, BREACH_KINDS,
  enabled, confirmTimeoutMs, rateLimit, rateWindowMs, fatigueThreshold,
  requestFingerprint, schemaHash, desensitize,
  validateRequester, decideAuthorization, requiresHuman, projectView,
  denyWithReason, securityException, fatigueAggregate,
  handleRequestExpansion,
  _rateCheck, _resetRate, _pendingFingerprintOnce, _resetPending,
};