/**
 * a2a-uac-observability.js —— UAC P3 可观测性底座（2026-09-25）
 *
 * 阶段：P3 —— 为「审计查询」「指标」与「策略变更留痕」提供**纯逻辑 + 只读读账**底座。
 *   CLI 壳：scripts/uac-audit.js · scripts/uac-metrics.js · scripts/uac-policy.js（写账）
 *   文档：docs/UAC-P3-PLAN.md · docs/UAC-BRIDGE.md §12
 *
 * 设计纪律：
 *   1. **只读优先**：本模块读账本不写账本（写账只走 recordUacEvent → 信任账本旁路）
 *   2. **不含敏感物**：事件 detail 用 `k=v` 紧凑串，**不写 token / 私钥 / 公钥全文 / 策略文件全文**
 *   3. **诚实**：取不到 → null；不写 0 冒充（BR-12）
 *   4. **旁路**：记账失败绝不影响判定与主流程（fail-safe，与 P2 同一条纪律）
 */

'use strict';

const fs = require('fs');
const path = require('path');

/** P3 新增的三个事件名（与 docs/UAC-P3-PLAN.md §3 一致） */
const UAC_EVENTS = Object.freeze({
  AUTO_APPROVED: 'delegate_auto_approved',   // P2 既有
  NOT_HIT: 'delegate_uac_not_hit',           // P3 新增：带 UAC 但未放行
  POLICY_CHANGED: 'uac_policy_changed',      // P3 新增：策略登记/撤销/开关
  ISSUED: 'uac_issued',                      // P3 新增：签发台账
});

/** 「UAC 相关」事件集合（audit 查询默认只看这些） */
const UAC_ACTIONS = Object.freeze([
  UAC_EVENTS.AUTO_APPROVED, UAC_EVENTS.NOT_HIT, UAC_EVENTS.POLICY_CHANGED, UAC_EVENTS.ISSUED,
]);

/** 默认账本路径（与 a2a-trust-evidence.js 保持一致；写死是为让本模块可独立单测） */
function defaultLedgerPath() {
  return process.env.CSB_TRUST_DATA_DIR
    ? path.join(process.env.CSB_TRUST_DATA_DIR, 'trust-evidence.jsonl')
    : path.join(__dirname, 'data', 'trust', 'trust-evidence.jsonl');
}

// ────────────────────────────── 写账（旁路） ──────────────────────────────

/**
 * 记一条 UAC 相关事件到信任账本（**永不抛**）。
 * @returns {object|null} 账本条目；降级/失败 → null（并 warn 一次）
 */
function recordUacEvent(action, { subject = null, ref = null, detail = '', actor = 'a2a-uac', note = null } = {}) {
  try {
    // eslint-disable-next-line global-require
    const te = require(path.join(__dirname, 'a2a-trust-evidence.js'));
    const subj = subject || { name: 'unknown' };
    return te.recordEvent(action, { subject: subj, evidence: { ref, detail }, actor, note });
  } catch (e) {
    console.warn(`⚠️ [UAC-P3] 留痕失败（不影响主流程）: ${e.message}`);
    return null;
  }
}

// ────────────────────────────── 策略摘要 / 变更描述 ──────────────────────────────

/**
 * 策略摘要：**只留可审计的要素**，绝不带公钥全文。
 * @returns {{enabled:boolean, peers:Array<{agentId,caps:string[],revoked:boolean,expiresAt:string|null}>}}
 */
function policyDigest(policy) {
  const p = policy || {};
  return {
    enabled: p.enabled === true,
    peers: (Array.isArray(p.peers) ? p.peers : []).map((x) => ({
      agentId: x && (x.agentId || x.id || x.name) || 'unknown',
      caps: Array.isArray(x && x.capabilities) ? [...x.capabilities] : [],
      revoked: !!(x && x.revokedAt),
      expiresAt: (x && x.expiresAt) || null,
    })),
  };
}

const _caps = (arr) => (arr && arr.length ? arr.join(',') : '-');

/**
 * 对比策略前后，产出**可核对的变更明细**（用于 uac_policy_changed 的 detail）。
 * @returns {{op:string, peers:{added:string[],removed:string[],changed:Array<object>}, enabled:{before:boolean,after:boolean}}}
 */
function diffPolicy(before, after) {
  const b = policyDigest(before);
  const a = policyDigest(after);
  const bMap = new Map(b.peers.map((p) => [p.agentId, p]));
  const aMap = new Map(a.peers.map((p) => [p.agentId, p]));
  const added = [...aMap.keys()].filter((k) => !bMap.has(k));
  const removed = [...bMap.keys()].filter((k) => !aMap.has(k));
  const changed = [];
  for (const [k, av] of aMap) {
    const bv = bMap.get(k);
    if (!bv) continue;
    const capsDiff = { before: bv.caps, after: av.caps };
    const revDiff = { before: bv.revoked, after: av.revoked };
    const expDiff = { before: bv.expiresAt, after: av.expiresAt };
    const same = _caps(capsDiff.before) === _caps(capsDiff.after)
      && revDiff.before === revDiff.after && expDiff.before === expDiff.after;
    if (!same) changed.push({ agentId: k, caps: capsDiff, revoked: revDiff, expiresAt: expDiff });
  }
  return { op: added.length && !removed.length && !changed.length ? 'add' : 'update', peers: { added, removed, changed }, enabled: { before: b.enabled, after: a.enabled } };
}

/** 把一次策略变更压成一行 `k=v` detail（可正则解析，且不含敏感物） */
function describePolicyChange({ op, peer = null, capability = null, before = null, after = null, reason = null, extra = null }) {
  const parts = [`op=${op}`];
  if (peer) parts.push(`peer=${peer}`);
  if (capability) parts.push(`capability=${capability}`);
  if (before !== null && before !== undefined) parts.push(`before=${before}`);
  if (after !== null && after !== undefined) parts.push(`after=${after}`);
  if (reason) parts.push(`reason=${reason}`);
  if (extra) parts.push(extra);
  return parts.join('; ');
}

/**
 * 策略变更 → 写账（CLI 用）。op ∈ add|revoke|revoke-capability|remove|enable|disable
 * 不抛；返回账本条目或 null。
 */
function recordPolicyChange({ op, peer = null, capability = null, before = null, after = null, reason = null, policyPath = null }) {
  const detail = describePolicyChange({ op, peer, capability, before, after, reason });
  return recordUacEvent(UAC_EVENTS.POLICY_CHANGED, {
    subject: { name: peer || 'policy' },
    ref: policyPath || null,
    detail,
    actor: 'uac-policy',
    note: 'UAC 策略变更',
  });
}

// ────────────────────────────── 只读读账 ──────────────────────────────

/** 定位 csb-security（复用 trust-evidence 的探测，避免重复实现） */
function locateSecurity() {
  try {
    // eslint-disable-next-line global-require
    const te = require(path.join(__dirname, 'a2a-trust-evidence.js'));
    return te.TrustEvidence.locateSecurity();
  } catch { return null; }
}

/**
 * 只读读账本：条目 + 哈希链校验。**不写**。
 * @param {{ledgerPath?:string}} opts
 * @returns {{ledgerPath,exists,entries,chainValid,signed,error}}
 */
function readLedger({ ledgerPath = null } = {}) {
  const file = ledgerPath || defaultLedgerPath();
  const out = { ledgerPath: file, exists: false, entries: [], chainValid: null, signed: null, error: null };
  try {
    out.exists = fs.existsSync(file);
    if (!out.exists) return out;
    const secDir = locateSecurity();
    if (!secDir) { out.error = 'csb-security 未找到（无法校验哈希链）'; return out; }
    // eslint-disable-next-line global-require
    const { EvidenceLedger } = require(path.join(secDir, 'lib', 'trust', 'evidence-ledger.js'));
    const led = new EvidenceLedger({ ledgerPath: file });   // 只读：构造即解析，不 append
    out.entries = led.entries || [];
    try { const v = typeof led.verifyChain === 'function' ? led.verifyChain() : null; out.chainValid = v ? !!v.ok : null; } catch (e) { out.error = `chain: ${e.message}`; }
    out.signed = out.entries.some((e) => !!e.signature);
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// ────────────────────────────── 查询 ──────────────────────────────

const dayOf = (ts) => new Date(ts).toISOString().slice(0, 10);
const inMs = (ts, [lo, hi]) => (lo === null || ts >= lo) && (hi === null || ts <= hi);
const parseDayRange = (from, to) => [
  from ? Date.parse(`${from}T00:00:00Z`) : null,
  to ? Date.parse(`${to}T23:59:59.999Z`) : null,
];
const reasonOf = (e) => { const m = /(?:^|;\s*)reason=([^;\s]+)/.exec((e && e.evidence && e.evidence.detail) || ''); return m ? m[1] : null; };
const jtiOf = (e) => { const m = /jti=([^;\s]+)/.exec((e && e.evidence && e.evidence.detail) || ''); return m ? m[1] : null; };

/**
 * 过滤账本条目（纯函数）。
 * @param {Array} entries
 * @param {{from?:string,to?:string,peer?:string,result?:'hit'|'not_hit',reason?:string,jti?:string,action?:string,all?:boolean,limit?:number}} q
 */
function queryEntries(entries, q = {}) {
  const [lo, hi] = parseDayRange(q.from, q.to);
  const wantActions = q.all ? null : (q.action ? [q.action] : UAC_ACTIONS);
  let rows = (entries || []).filter((e) => {
    if (!e) return false;
    if (wantActions && !wantActions.includes(e.action)) return false;
    if (q.result === 'hit' && e.action !== UAC_EVENTS.AUTO_APPROVED) return false;
    if (q.result === 'not_hit' && e.action !== UAC_EVENTS.NOT_HIT) return false;
    if (q.peer && !String(e.subjectId || (e.subject && e.subject.name) || '').includes(q.peer)) return false;
    if (q.reason && reasonOf(e) !== q.reason) return false;
    if (q.jti && jtiOf(e) !== q.jti) return false;
    if (!inMs(e.ts, [lo, hi])) return false;
    return true;
  });
  rows = rows.sort((a, b) => a.ts - b.ts);
  const total = rows.length;
  if (q.limit && q.limit > 0) rows = rows.slice(-q.limit);
  return { rows, total, shown: rows.length };
}

// ────────────────────────────── 指标 ──────────────────────────────

/**
 * 计算 P3 指标（纯函数）。取不到 → null（不写 0 冒充）。
 * @param {Array} entries 账本条目
 * @param {{from?:string,to?:string,policy?:object|null}} opts
 */
function computeMetrics(entries, { from = null, to = null, policy = null } = {}) {
  const [lo, hi] = parseDayRange(from, to);
  const rows = (entries || []).filter((e) => e && inMs(e.ts, [lo, hi]));
  const hits = rows.filter((e) => e.action === UAC_EVENTS.AUTO_APPROVED);
  const miss = rows.filter((e) => e.action === UAC_EVENTS.NOT_HIT);
  const denom = hits.length + miss.length;

  // M1 自动放行率（分母 = 带 UAC 的判定：auto_approved + not_hit）
  const m1 = denom > 0
    ? { rate: Number((hits.length / denom).toFixed(4)), hits: hits.length, notHits: miss.length, denominator: denom }
    : { rate: null, hits: 0, notHits: 0, denominator: 0, note: 'insufficient：窗口内无带 UAC 的判定（不记 0 冒充）' };

  // M2 未命中原因分布
  const m2 = {};
  for (const e of miss) { const r = reasonOf(e) || 'unknown'; m2[r] = (m2[r] || 0) + 1; }

  // M3 每 peer 用量（有策略时才算了用量比）
  const perPeer = {};
  for (const e of [...hits, ...miss]) {
    const id = e.subjectId || (e.subject && e.subject.name) || 'unknown';
    perPeer[id] = perPeer[id] || { hits: 0, notHits: 0 };
    if (e.action === UAC_EVENTS.AUTO_APPROVED) perPeer[id].hits++; else perPeer[id].notHits++;
  }
  const peers = (policy && Array.isArray(policy.peers) ? policy.peers : []);
  const windowSec = peers.find((p) => p && p.rate && p.rate.windowSeconds)?.rate?.windowSeconds || null;
  const usageLo = windowSec ? Date.now() - windowSec * 1000 : null;
  const m3 = Object.entries(perPeer).map(([agentId, v]) => {
    const p = peers.find((x) => x && (x.agentId === agentId || x.id === agentId || x.name === agentId));
    const max = p && p.rate && p.rate.max ? p.rate.max : null;
    let usedInWindow = null;
    if (windowSec && max) {
      usedInWindow = rows.filter((e) => (e.subjectId || (e.subject && e.subject.name)) === agentId
        && e.action === UAC_EVENTS.AUTO_APPROVED && e.ts >= usageLo).length;
    }
    return {
      agentId, ...v,
      rateMax: max,
      usedInWindow,
      usagePct: (max && usedInWindow !== null) ? Number(((usedInWindow / max) * 100).toFixed(1)) : null,
      policyPresent: !!p,
    };
  });

  // M4 按日趋势（≥3 天才给趋势）
  const byDay = {};
  for (const e of [...hits, ...miss]) {
    const d = dayOf(e.ts);
    byDay[d] = byDay[d] || { day: d, hits: 0, notHits: 0 };
    if (e.action === UAC_EVENTS.AUTO_APPROVED) byDay[d].hits++; else byDay[d].notHits++;
  }
  const days = Object.values(byDay).sort((a, b) => (a.day < b.day ? -1 : 1))
    .map((d) => ({ ...d, rate: (d.hits + d.notHits) > 0 ? Number((d.hits / (d.hits + d.notHits)).toFixed(4)) : null }));
  const m4 = { days, sufficient: days.length >= 3, note: days.length >= 3 ? null : `insufficient：仅 ${days.length} 天数据（<3 天不给趋势）` };

  // M5 变更/签发计数
  const changes = rows.filter((e) => e.action === UAC_EVENTS.POLICY_CHANGED);
  const opOf = (e) => { const m = /(?:^|;\s*)op=([^;\s]+)/.exec((e.evidence && e.evidence.detail) || ''); return m ? m[1] : 'unknown'; };
  const m5 = {
    policyChanges: changes.length,
    byOp: changes.reduce((acc, e) => { const o = opOf(e); acc[o] = (acc[o] || 0) + 1; return acc; }, {}),
    issued: rows.filter((e) => e.action === UAC_EVENTS.ISSUED).length,
  };

  return {
    window: { from: from || null, to: to || null, rows: rows.length },
    M1_autoApproveRate: m1,
    M2_notHitReasons: m2,
    M3_perPeer: m3,
    M4_dailyTrend: m4,
    M5_changes: m5,
  };
}

module.exports = {
  UAC_EVENTS,
  UAC_ACTIONS,
  defaultLedgerPath,
  recordUacEvent,
  recordPolicyChange,
  policyDigest,
  diffPolicy,
  describePolicyChange,
  readLedger,
  queryEntries,
  computeMetrics,
  _internal: { reasonOf, jtiOf, parseDayRange, dayOf },
};
