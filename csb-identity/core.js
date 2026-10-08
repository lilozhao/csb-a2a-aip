#!/usr/bin/env node
/**
 * stage2.js — CSB 身份层 · 阶段二（建在 csb-security 之上）
 * ------------------------------------------------------------------
 * 作者：明德 🎋 · 2026-10-08
 * 依据：硅隐 2026-10-08 12:45 拍板
 *   D1 agent_id 默认英文名（中文 → 提示用英文名）
 *   D2 covenant：独立文件 + 只把 hash 进 AID
 *   D3 breach：proposed/effective/cleared + 记录不可删
 *   D4 暂不部署（本模块只本地跑，不碰服务端）
 *
 * 复用 csb-security（不重造）：
 *   - AID 生成/验签      → aid.generateAID / signAID / verifyAID / buildAID
 *   - AAT 签发/验证      → aat.createAAT / verifyAAT
 *   - 防重放             → defense/replay-guard.js
 *   - 不可篡改留痕       → audit/audit-log.js（哈希链 + 每条签名）
 * 本模块新增（csb-security 没有的）：
 *   - agent_id 英文名策略 + 中文提示
 *   - 保留字校验（reserved-names.json）
 *   - passport_uri  csb://<owner>/<name>
 *   - covenant（独立文件 + hash 进 AID）
 *   - breach 状态机（proposed/effective/cleared），不可删
 */
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const csb = require('../../csb-security/lib/index.js');

const STAGE2_ROOT = __dirname; // csb-a2a-aip/identity/ 自身即数据根
const RESERVED_FILE = path.join(STAGE2_ROOT, 'reserved-names.json');
const COVENANT_DIR = path.join(STAGE2_ROOT, 'covenants');
const DATA_DIR = path.join(STAGE2_ROOT, 'data');
const BREACH_LOG = path.join(DATA_DIR, 'breach-log.jsonl');

// ---------- JCS 规范化（与 verify-demo.js 同源；生产建议用 npm canonicalize）----------
function jcs(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'boolean') return value ? 'true' : 'false';
  if (t === 'number') { if (!Number.isFinite(value)) throw new Error('JCS: non-finite'); return JSON.stringify(value); }
  if (t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(jcs).join(',') + ']';
  if (t === 'object') {
    return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + jcs(value[k])).join(',') + '}';
  }
  throw new Error('JCS: unsupported ' + t);
}

// ---------- 归一化（与 gen-reserved-names.js 一致）----------
const STRIP = /[\p{Extended_Pictographic}\uFE0F\u200D\u200B\u200C\u2060\u00AD]/gu;
function nameKey(s) {
  if (typeof s !== 'string') return '';
  return s.normalize('NFKC').replace(STRIP, '').replace(/\s+/g, '').toLowerCase();
}

// ---------- 保留字 ----------
let _reserved = null;
function reserved() {
  if (!_reserved) _reserved = new Set(JSON.parse(fs.readFileSync(RESERVED_FILE, 'utf8')).reserved_keys);
  return _reserved;
}
function checkReserved(raw, kind) {
  const k = nameKey(raw);
  if (!k) return { ok: false, error: 'empty_name', kind };
  if (reserved().has(k)) return { ok: false, error: 'name_reserved', kind, key: k };
  // 前缀保留
  if (/^(csb[-_]|official[-_]|admin[-_])/.test(k)) return { ok: false, error: 'name_reserved_prefix', kind, key: k };
  return { ok: true, key: k };
}

/**
 * 保留名认领：保留名默认拒收，但**本人**可凭公钥认领（R2：本人可重签，他人不可复用）
 * 认领键 = name_key → 公钥指纹（JWK.x）。M1 阶段用内存表；接服务时改持久化。
 */
const reservedClaims = new Map();
/** 认领表落盘（可选）：设了文件则每次认领后写盘；启动时自动加载 */
let claimsFilePath = null;
function useClaimsFile(file) {
  claimsFilePath = file;
  reservedClaims.clear();
  if (file && fs.existsSync(file)) {
    try {
      const j = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const [k, v] of Object.entries(j.claims || {})) reservedClaims.set(k, v.x);
    } catch (e) { console.warn('[stage2] claims load failed:', e.message); }
  }
}
function persistClaims() {
  if (!claimsFilePath) return;
  const claims = {};
  for (const [k, x] of reservedClaims) claims[k] = { x, claimed_at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(claimsFilePath), { recursive: true });
  fs.writeFileSync(claimsFilePath, JSON.stringify({ updated_at: new Date().toISOString(), claims }, null, 2));
}
function claimReservedName(rawName, publicJwk) {
  const k = nameKey(rawName);
  if (!reserved().has(k)) return { ok: false, error: 'not_reserved', key: k };
  if (!publicJwk || !publicJwk.x) return { ok: false, error: 'bad_pubkey' };
  const prev = reservedClaims.get(k);
  if (prev && prev !== publicJwk.x) return { ok: false, error: 'already_claimed', key: k, hint: '该保留名已被他人认领' };
  reservedClaims.set(k, publicJwk.x);
  persistClaims();
  return { ok: true, key: k, thumbprint: String(publicJwk.x).slice(0, 8) + '…' };
}
function isClaimedBy(key, publicJwk) { return !!publicJwk && reservedClaims.get(key) === publicJwk.x; }
/** 生成"持有证明"：签名内容 = JCS({name, public_key, nonce, timestamp}) */
function signClaim(name, publicJwk, privateKey) {
  const nonce = crypto.randomBytes(12).toString('hex');
  const timestamp = new Date().toISOString();
  const msg = jcs({ name, public_key: publicJwk, nonce, timestamp });
  const sig = crypto.sign(null, Buffer.from(msg), privateKey).toString('base64');
  return { name, public_key: publicJwk, proof: { nonce, timestamp, sig } };
}

// ---------- D1：agent_id 英文名策略 ----------
const CJK = /[\u3400-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const AGENT_ID_RE = /^[a-z0-9][a-z0-9._-]*@[a-z0-9][a-z0-9.:_-]*$/i;
function assertAgentId(agentId) {
  if (typeof agentId !== 'string' || !agentId) return { ok: false, error: 'agent_id_required' };
  if (CJK.test(agentId)) {
    return {
      ok: false, error: 'agent_id_must_be_ascii',
      hint: '请用英文名，例如 mingde@47.121.28.125:3100（中文名只作显示名 name）',
      suggestion: agentId.replace(CJK, '').replace(/[^\x20-\x7E]/g, '') || null
    };
  }
  if (!AGENT_ID_RE.test(agentId)) return { ok: false, error: 'agent_id_bad_format', hint: '格式：<english-name>@<host>:<port>' };
  return { ok: true };
}

// ---------- passport_uri：csb://<owner>/<name> ----------
const PASSPORT_RE = /^csb:\/\/([^/]+)\/([^/]+)$/;
function buildPassport(owner, name) {
  // 归一：owner 若写成 human://yebai → 取裸 handle（passport 段用裸 handle，避免 csb://human://x）
  const bare = String(owner || '').replace(/^human:\/\//, '');
  const o = checkReserved(bare, 'passport_owner');
  if (!o.ok) return o;
  const n = checkReserved(name, 'passport_name');
  if (!n.ok) return n;
  if (CJK.test(bare) || CJK.test(name)) return { ok: false, error: 'passport_must_be_ascii', hint: 'passport 的 owner 段与 name 段都必须是 ASCII（如 owner=yebai）；中文只作显示名 name 字段' };
  return { ok: true, uri: `csb://${o.key}/${n.key}` };
}
function parsePassport(uri) {
  const m = PASSPORT_RE.exec(uri || '');
  if (!m) return { ok: false, error: 'passport_bad_format' };
  return buildPassport(m[1], m[2]);
}

// ---------- F1：身份校验（复用 csb-security 验签 + 防重放）----------
const replayGuard = new csb.ReplayGuard();

/**
 * 校验一份"注册用"的 AID 文档 + 提交凭证
 * @param {Object} aidDoc     已签名 AID（csb-security 格式）
 * @param {Object} proof      { nonce, timestamp } —— 提交方公钥即 aidDoc.public_key
 * @param {Object} opts       { passport_uri? }
 */
function verifyIdentitySubmission(aidDoc, proof = {}, opts = {}) {
  // 1. agent_id 策略（D1）
  const idCheck = assertAgentId(aidDoc && aidDoc.agent_id);
  if (!idCheck.ok) return { valid: false, ...idCheck };

  // 2. AID 验签（csb-security）
  const v = csb.verifyAID(aidDoc);
  if (!v.valid) return { valid: false, error: 'aid_' + v.error };

  // 3. 有效期
  if (aidDoc.expires_at && new Date(aidDoc.expires_at).getTime() < Date.now()) {
    return { valid: false, error: 'aid_expired' };
  }

  // 4. 防重放（csb-security replay-guard）
  if (proof.timestamp) { const r = replayGuard.checkTimestamp(proof.timestamp); if (!r.allowed) return { valid: false, error: 'ts_' + r.error }; }
  if (proof.nonce) { const r = replayGuard.checkNonce(proof.nonce); if (!r.allowed) return { valid: false, error: 'nonce_' + r.error }; }

  // 4.5 跨命名空间同名互斥：agent 显示名不得与已登记的人 handle 同名（由调用方注入 humans.exists）
  if (typeof opts.humanExists === 'function') {
    const hk = nameKey(aidDoc.name);
    if (hk && opts.humanExists(hk)) return { valid: false, error: 'conflicts_with_human_handle', key: hk, hint: '跨命名空间同名互斥（防冒名）' };
  }

  // 5. 保留字：显示名 + passport（保留名 = 本人可认领，他人不可复用）
  let reservedClaimed = false;
  const nameChk = checkReserved(aidDoc.name, 'name');
  if (!nameChk.ok) {
    if (nameChk.error === 'name_reserved' && isClaimedBy(nameChk.key, aidDoc.public_key)) {
      reservedClaimed = true;
    } else {
      return { valid: false, ...nameChk, hint: nameChk.error === 'name_reserved' ? '保留名需本人凭公钥认领（claimReservedName）' : undefined };
    }
  }

  let passport = null;
  if (opts.passport_uri) {
    const p = parsePassport(opts.passport_uri);
    if (!p.ok) return { valid: false, ...p };
    passport = p.uri;
  } else if (opts.owner) {
    // passport 段必须是 ASCII。显示名常为 CJK（明德/若兰…），
    // 故 slug 默认取 agent_id 的本地段（已被 §D1 强制 ASCII），可显式覆盖。
    const slug = opts.passport_slug || String(aidDoc.agent_id).split('@')[0];
    const p = buildPassport(opts.owner, slug);
    if (p.ok) {
      passport = p.uri;
    } else if (p.error === 'name_reserved' && isClaimedBy(p.key, aidDoc.public_key)) {
      // name 段是保留名，但本人已认领 → 允许
      const o = checkReserved(opts.owner, 'passport_owner');
      if (!o.ok) return { valid: false, ...o };
      passport = `csb://${o.key}/${p.key}`;
    } else {
      return { valid: false, ...p };
    }
  }

  return { valid: true, agent_id: aidDoc.agent_id, name: aidDoc.name, passport_uri: passport, owner_handle: opts.owner ? String(opts.owner).replace(/^human:\/\//, '').toLowerCase() : null, reserved_claimed: reservedClaimed, aid: aidDoc };
}

// ---------- F3-a：covenant（独立文件 + hash 进 AID）----------
function loadCovenant(version = 'csb-covenant-v1') {
  const f = path.join(COVENANT_DIR, version + '.txt');
  if (!fs.existsSync(f)) { const e = new Error('covenant_not_found: ' + version); e.code = 'COVENANT_NOT_FOUND'; throw e; }
  return fs.readFileSync(f, 'utf8');
}
function covenantHash(version = 'csb-covenant-v1') {
  return crypto.createHash('sha256').update(loadCovenant(version), 'utf8').digest('base64');
}
/** 签契约：签的是 hash（不签全文） */
function signCovenant(agentId, privateKey, version = 'csb-covenant-v1') {
  const hash = covenantHash(version);
  const body = { agent_id: agentId, covenant_version: version, covenant_hash: hash };
  const sig = crypto.sign(null, Buffer.from(jcs(body)), privateKey).toString('base64');
  return { ...body, covenant_signed_at: new Date().toISOString(), covenant_sig: sig };
}
/** 验证契约签名 */
function verifyCovenant(rec, publicKey) {
  if (!rec || !rec.covenant_sig) return { valid: false, error: 'missing_covenant' };
  const body = { agent_id: rec.agent_id, covenant_version: rec.covenant_version, covenant_hash: rec.covenant_hash };
  try {
    const ok = crypto.verify(null, Buffer.from(jcs(body)), publicKey, Buffer.from(rec.covenant_sig, 'base64'));
    if (!ok) return { valid: false, error: 'bad_covenant_sig' };
    if (rec.covenant_hash !== covenantHash(rec.covenant_version)) return { valid: false, error: 'covenant_version_mismatch' };
    return { valid: true };
  } catch { return { valid: false, error: 'bad_public_key' }; }
}
/** 把 covenant 记录挂进 AID 并重签 AID（D2：只挂 hash 元组，不挂全文） */
function attachCovenantToAID(baseAID, covRec, privateKey) {
  const aid = { ...baseAID };
  delete aid.signature;
  aid.covenant = {
    version: covRec.covenant_version,
    hash: covRec.covenant_hash,
    signed_at: covRec.covenant_signed_at,
    sig: covRec.covenant_sig
  };
  return csb.aid.signAID(aid, privateKey); // signAID = 对除 signature 外全部字段签名
}

// ---------- F3-b：breach 状态机（proposed/effective/cleared）+ 不可删 ----------
/**
 * BreachRegistry —— 违约标记，**落在 csb-security 的 AuditLog 上**（一本账）
 * 说明（2026-10-08 修正）：
 *   早先我以为 csb.AuditLog.append() 只收白名单字段、无法携带结构化载荷，
 *   故自写了一个 JsonChainLog。**实际若兰 2026-09-05（commit 62edeb3）已支持**：
 *   append(entry, extra) 的第二参 `extra` 会过滤保留字段后并入 record，
 *   且自动纳入哈希链与签名 —— 正是所需能力。
 *   ⇒ 遂删除 JsonChainLog，改为复用 csb.AuditLog；breach 载荷走 `extra.details`。
 */
const BREACH_STATES = ['proposed', 'effective', 'cleared'];
class BreachRegistry {
  /**
   * @param {Object} o
   *   - log: 复用的 csb.AuditLog 实例（推荐：与安全审计同一本账）
   *   - logPath/privateKey/publicKey: 未注入 log 时自建
   */
  constructor({ log = null, logPath = BREACH_LOG, privateKey = null, publicKey = null } = {}) {
    if (log) {
      this.log = log;
    } else {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      this.log = new csb.AuditLog({ logPath, privateKey, publicKey });
    }
    this.records = new Map(); // breach_id -> record（从审计日志重建）
    this._rebuild();
  }
  _rebuild() {
    this.records.clear();
    for (const e of this.log.entries) {
      const d = e.details || {};
      if (!d.breach_id) continue;
      const rec = this.records.get(d.breach_id) || { breach_id: d.breach_id, agent_id: d.agent_id, state: null, history: [] };
      // 记录发起人（proposed 那条的 actor 即 reporter）——供连接分级自动降级用
      if (!rec.reporter && (d.state === 'proposed' || d.to_state === 'proposed')) rec.reporter = d.actor || d.reporter || null;
      rec.state = d.to_state || d.state || rec.state;
      rec.history.push({ seq: e.seq, at: e.timestamp, to: d.to_state || d.state, actor: d.actor || d.reporter, reason: d.reason });
      this.records.set(d.breach_id, rec);
    }
  }
  /** 发起 breach（state = proposed） */
  propose({ agentId, reason, evidence, reporter = null, reporterSig = null }) {
    if (!agentId || !reason) return { ok: false, error: 'agent_id_and_reason_required' };
    const breach_id = 'br-' + crypto.randomBytes(6).toString('hex');
    const entry = this.log.append(
      { event_type: 'breach_proposed', caller_id: reporter, callee_id: agentId, result: 'success' },
      { details: { breach_id, agent_id: agentId, state: 'proposed', to_state: 'proposed', actor: reporter, reason, evidence, reporter_sig: reporterSig } }
    );
    this._rebuild();
    return { ok: true, breach_id, state: 'proposed', seq: entry.seq };
  }
  /** 状态迁移：只允许 proposed→effective / proposed→cleared / effective→cleared */
  transition(breachId, toState, { actor = null, reason = null } = {}) {
    if (!BREACH_STATES.includes(toState)) return { ok: false, error: 'bad_state' };
    const rec = this.records.get(breachId);
    if (!rec) return { ok: false, error: 'breach_not_found' };
    const allowed = { proposed: ['effective', 'cleared'], effective: ['cleared'], cleared: [] }[rec.state] || [];
    if (!allowed.includes(toState)) return { ok: false, error: `illegal_transition:${rec.state}->${toState}` };
    const entry = this.log.append(
      { event_type: 'breach_' + toState, caller_id: actor, callee_id: rec.agent_id, result: 'success' },
      { details: { breach_id: breachId, agent_id: rec.agent_id, to_state: toState, actor, reason } }
    );
    this._rebuild();
    return { ok: true, breach_id: breachId, state: toState, seq: entry.seq };
  }
  /** 刻意不提供 delete —— 记录不可删，只可迁移状态 */
  get(breachId) { return this.records.get(breachId) || null; }
  byAgent(agentId) { return [...this.records.values()].filter(r => r.agent_id === agentId); }
  /** 某 agent 是否处于 effective breach（认领前的判据） */
  isBlocked(agentId) { return this.byAgent(agentId).some(r => r.state === 'effective'); }
  verify() { return this.log.verifyChain(); }
}

module.exports = {
  jcs, nameKey, checkReserved, reserved,
  claimReservedName, isClaimedBy, useClaimsFile, persistClaims, signClaim,
  assertAgentId, buildPassport, parsePassport,
  verifyIdentitySubmission,
  loadCovenant, covenantHash, signCovenant, verifyCovenant, attachCovenantToAID,
  BREACH_STATES, BreachRegistry,
  replayGuard
};
