/**
 * a2a-aat-envelope.js — 入站 AAT 验签结论「落信封」（W-63 · 2026-11-23）
 *
 * 解决什么：公网隧道把源 IP 抹成 127.0.0.1，`sender.name` 又是自述字段——
 *   「这条消息到底是不是它自己发的」在信封里完全没有痕迹。于是知微/明德
 *   入站行长期显示 `trust: None`，事后无法机械复核。
 *
 * 做法：验签结论写进收件箱信封 `aat: {valid, fingerprint, ...}`。
 *
 * 设计铁律
 *   1. **不可伪造**：结论走 Symbol 键透传（与 a2a-verified-flag.js 同源理由），
 *      客户端自带 `metadata.aat` 造不出 Symbol，伪造不了「已验签」。
 *   2. **没有票也要有结论**：无 token → `valid:false, error:'no_token'`。
 *      「字段缺席」和「验签失败」必须长得不一样，否则负向判据永远红不了。
 *   3. **指纹认钥匙不认票**：fingerprint = sha256(crv:x) 前 16 位，
 *      同一把固定公钥签出的每条消息指纹相同 —— 这样才能与 `agents.local.json`
 *      里 pin 的那把逐字对账。票本身的哈希另记 `token`，只用于查重。
 *   4. **只读不改行为**：本模块不参与放行/拦截判断，纯留痕。
 */
'use strict';

const crypto = require('crypto');

/** 验签结论的透传键（Symbol：JSON 造不出来） */
const AAT_VERDICT = Symbol.for('csb.aat.verdict');

/** 公钥指纹：认钥匙，不认票。JWK 至少要有 crv + x */
function keyFingerprint(jwk) {
  try {
    if (!jwk || !jwk.x) return null;
    const canon = `${jwk.crv || 'unknown'}:${jwk.x}`;
    return crypto.createHash('sha256').update(canon).digest('hex').slice(0, 16);
  } catch { return null; }
}

/** 票指纹：只用于同一条消息查重，不作为身份凭据 */
function tokenFingerprint(token) {
  try {
    if (!token) return null;
    return crypto.createHash('sha256').update(String(token)).digest('hex').slice(0, 16);
  } catch { return null; }
}

/**
 * 构造结论对象。
 * @param {object} p
 * @param {boolean} p.valid          验签是否通过
 * @param {object|null} p.key        命中并用于验签的固定公钥（JWK）
 * @param {string|null} p.fingerprint 已算好的指纹（优先于 key；避免二次哈希）
 * @param {string|null} p.token      原始 AAT
 * @param {string|null} p.issuer     票里 iss（未验签也能读，仅供排查）
 * @param {string|null} p.agentId    本地 pin 的 agent id
 * @param {string|null} p.error      失败码（no_token/expired/bad_signature…）
 * @returns {{valid:boolean,fingerprint:string|null,error:string|null,token:string|null,issuer:string|null,agentId:string|null}}
 */
function makeVerdict({ valid = false, key = null, fingerprint = null, token = null, issuer = null, agentId = null, error = null } = {}) {
  return {
    valid: valid === true,
    // 优先用调用方已算好的指纹（a2a-aat.js 返回值里就是指纹，不是 key）
    // —— 否则会二次哈希，得到一把对不上 config 的假指纹。
    fingerprint: fingerprint || keyFingerprint(key),
    error: valid === true ? null : (error || 'verify_failed'),
    token: tokenFingerprint(token),
    issuer: issuer || null,
    agentId: agentId || null,
  };
}

/** 把结论盖上 metadata（Symbol 键；展开运算会带上它） */
function stamp(metadata, verdict) {
  if (metadata && typeof metadata === 'object' && verdict) metadata[AAT_VERDICT] = verdict;
  return metadata;
}

/** 从 metadata 取结论（没有就是 null） */
function read(metadata) {
  if (!metadata || typeof metadata !== 'object') return null;
  return metadata[AAT_VERDICT] || null;
}

/**
 * 信封里那一行的形状 —— **永远返回一个对象**。
 * 缺席不等于正常：没有票就明写 no_token。
 */
function summarize(metadata) {
  // 结论可能盖在 metadata 上，也可能盖在 metadata.sender 上（REST 入口现拼 restMeta 的情况）
  const v = read(metadata) || read(metadata && metadata.sender);
  if (!v) return { valid: false, fingerprint: null, error: 'no_verdict', token: null, issuer: null, agentId: null };
  return {
    valid: v.valid === true,
    fingerprint: v.fingerprint || null,
    error: v.valid === true ? null : (v.error || 'verify_failed'),
    token: v.token || null,
    issuer: v.issuer || null,
    agentId: v.agentId || null,
  };
}

module.exports = { AAT_VERDICT, keyFingerprint, tokenFingerprint, makeVerdict, stamp, read, summarize };
