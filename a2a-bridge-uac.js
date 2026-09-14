/**
 * a2a-bridge-uac.js —— UAC 接入 bridge 的判定钩子（P0）
 *
 * 阶段：P0（2026-09-15）· **纯逻辑模块，默认不接线**
 *   —— handleInbound() 暂不调用它；本阶段只定义：信封字段 + 策略格式 + 判定逻辑 + 单测。
 *
 * 目标：让「已授权的常规动作」（如 pull + test）免去接收方主人的**重复 L3 点头**，
 *   同时不弱化底线：**免确认的权力属于接收方主人**（设计红线，详见
 *   docs/uac-bridge-integration-plan-2026-09-15.md）。
 *
 * 双层证据（两条同时成立才免 L3）：
 *   A. 代表授权：发起方主人签发的 UAC（信封 delegation.uac）→ 证明「我确实替主人办事」
 *   B. 豁免规则：接收方主人登记的本地策略（policy.peers[]）→ 声明「我愿意对谁、在什么范围内放行」
 *
 * fail-safe 原则：任何一环证据缺失/不确定 → **不免确认**（hit:false），回到原 L3 路径。
 *
 * ── 信封字段（新增，均可选，缺省不影响现状）─────────────────────────────
 *   delegation.uac           : string   A 凭证（JWT, EdDSA）
 *   delegation.capabilities  : string[] 本次动作的能力标签（如 ["pull","test"]），
 *                                        必须 ⊆ 接收方策略 pepeers[].capabilities
 *
 * ── 接收方策略格式（policy）───────────────────────────────────────────
 *   {
 *     "version": 1,
 *     "enabled": false,                       // 默认关；不开启 = 现状
 *     "peers": [{
 *       "id": "ruolan",
 *       "agentId": "若兰",                     // 与入站 sender.agentId/name 匹配
 *       "userPublicKey": { ...JWK... },        // 发起方主人公钥（信任登记取得）
 *       "capabilities": ["pull", "test"],      // 允许免确认的能力白名单
 *       "scopes": ["a2a.delegate:shell"],      // 允许免确认的 UAC scope（可选，留档/校验）
 *       "rate": { "max": 3, "windowSeconds": 86400 },
 *       "expiresAt": "2026-09-22T00:00:00Z",   // 策略有效期（可选）
 *       "revokedAt": null
 *     }]
 *   }
 */

'use strict';

const SCOPE_PREFIX = 'a2a.delegate:';
const POLICY_VERSION = 1;

/** UAC scope 命名：a2a.delegate:<scope>（scope ∈ read|write|shell|notify） */
function requiredUacScope(scope) {
  return SCOPE_PREFIX + String(scope);
}

/** 默认验证器：优先同工作区兄弟仓 csb-security；取不到则 fail-safe（verifier_unavailable） */
let _defaultVerifier;
function defaultVerifier() {
  if (_defaultVerifier !== undefined) return _defaultVerifier;
  const candidates = ['../csb-security/lib/authz/uac', 'csb-security/lib/authz/uac'];
  _defaultVerifier = null;
  for (const c of candidates) {
    try { _defaultVerifier = require(c); break; } catch { /* try next */ }
  }
  return _defaultVerifier;
}

/**
 * 判定是否可免除 L3（自动放行）
 *
 * @param {object} envelope  规范化信封（a2a-bridge-core.validateEnvelope 产物）
 *   - scope, uac, capabilities, delegator...
 * @param {object} ctx
 *   - policy       接收方豁免策略（见文件头）
 *   - sender       { agentId?, name? } 入站发起方
 *   - now          毫秒（默认 Date.now()）
 *   - jtiCache     Set（防重放，可选）
 *   - rateCheck    (peerId, now, rate) => {ok, detail?}（有 rate 策略而缺此函数 → fail-safe）
 *   - verifyUAC / coversScopes  可注入（测试用）；缺省取 csb-security
 * @returns {{hit: boolean, reason: string, detail?: string, policyId?: string, uac?: object, capabilities?: string[]}}
 */
function checkUAC(envelope, ctx = {}) {
  const now = ctx.now || Date.now();
  const policy = ctx.policy;
  const sender = ctx.sender || {};
  const senderId = sender.agentId || sender.name || null;

  // ── 0. fail-safe 前置 ──
  if (!policy || policy.enabled !== true) return { hit: false, reason: 'policy_disabled' };
  if (!envelope || !envelope.uac) return { hit: false, reason: 'no_uac' };
  if (!senderId) return { hit: false, reason: 'no_sender_id' };

  // ── 1. 找登记同伴（B 层）──
  const peer = (policy.peers || []).find(
    (p) => p && (p.agentId === senderId || p.name === senderId)
  );
  if (!peer) return { hit: false, reason: 'peer_not_registered' };
  if (peer.revokedAt) return { hit: false, reason: 'peer_revoked' };
  if (peer.expiresAt && now > Date.parse(peer.expiresAt)) {
    return { hit: false, reason: 'peer_grant_expired' };
  }

  // ── 2. 验 A 凭证（代表授权）──
  const injected = ctx.verifyUAC !== undefined; // 显式注入（含注入无效件）→ 不再回退默认
  const verifier = injected
    ? { verifyUAC: ctx.verifyUAC, coversScopes: ctx.coversScopes }
    : defaultVerifier();
  if (!verifier || typeof verifier.verifyUAC !== 'function') {
    return { hit: false, reason: 'verifier_unavailable' };
  }

  const res = verifier.verifyUAC(envelope.uac, {
    userPublicKey: peer.userPublicKey,
    expectedAgentId: senderId,
    jtiCache: ctx.jtiCache || null,
    now,
  });
  if (!res || !res.valid) return { hit: false, reason: 'uac_invalid', detail: res && res.error };

  // ── 3. scope 覆盖：UAC 必须涵盖 a2a.delegate:<envelope.scope> ──
  const need = [requiredUacScope(envelope.scope)];
  const cov = (typeof verifier.coversScopes === 'function')
    ? verifier.coversScopes(res.payload, need)
    : false;
  if (!cov) return { hit: false, reason: 'uac_scope_insufficient', detail: need.join(',') };

  // ── 4. 能力白名单：委托声明的 capabilities ⊆ 策略允许 ──
  const caps = Array.isArray(envelope.capabilities) ? envelope.capabilities : [];
  const allowedCaps = Array.isArray(peer.capabilities) ? peer.capabilities : null;
  if (allowedCaps === null) return { hit: false, reason: 'no_capability_whitelist' };
  if (caps.length === 0) return { hit: false, reason: 'no_capabilities_declared' };
  const notAllowed = caps.filter((c) => !allowedCaps.includes(c));
  if (notAllowed.length) {
    return { hit: false, reason: 'capability_not_allowed', detail: notAllowed.join(',') };
  }

  // ── 5. 频次（有 rate 策略而缺计数器 → fail-safe 拒绝）──
  if (peer.rate && peer.rate.max > 0) {
    if (typeof ctx.rateCheck !== 'function') return { hit: false, reason: 'rate_tracker_unavailable' };
    const r = ctx.rateCheck(peer.agentId, now, peer.rate);
    if (!r || r.ok !== true) return { hit: false, reason: 'rate_exceeded', detail: r && r.detail };
  }

  // ── 6. 放行 ──
  return {
    hit: true,
    reason: 'auto_approved',
    policyId: peer.id || peer.agentId,
    capabilities: caps,
    uac: {
      iss: res.payload.iss,
      sub: res.payload.sub,
      jti: res.payload.jti,
      scopes: res.payload.scopes,
    },
  };
}

module.exports = { checkUAC, requiredUacScope, SCOPE_PREFIX, POLICY_VERSION };
