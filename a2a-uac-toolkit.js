/**
 * a2a-uac-toolkit.js —— UAC 签发/策略工具箱（P1 · 2026-09-15）
 *
 * 阶段：P1 —— 为「签发 CLI」与「接收侧豁免登记命令」提供**纯逻辑**底座（可单测）。
 *   CLI 壳见 scripts/uac-keygen.js · scripts/uac-issue.js · scripts/uac-policy.js
 *
 * 角色划分（详见 docs/uac-bridge-integration-plan-2026-09-15.md）：
 *   - 签发侧（发起方主人）：生成用户密钥对 → 签发 UAC（A 凭证）
 *   - 登记侧（接收方主人）：登记豁免策略（B 规则），**默认空 = 现状**
 *
 * 安全：密钥材料**只落本地**（.uac/，600），不入仓；策略文件只含公钥，默认 gitignore（留 .example）。
 */

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SCOPE_PREFIX = 'a2a.delegate:';
const POLICY_VERSION = 1;

// ── 依赖：csb-security（同工作区兄弟仓 / 已安装）──
function loadSecurity() {
  const candidates = ['../csb-security/lib/authz/uac', 'csb-security/lib/authz/uac'];
  for (const c of candidates) {
    try { return require(c); } catch { /* next */ }
  }
  throw new Error('找不 csb-security/lib/authz/uac —— 签发/校验需要它');
}

// ── 小工具 ──
function readJsonSafe(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function writeJson(p, obj, { mode = 0o644 } = {}) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n', { mode });
  try { fs.chmodSync(p, mode); } catch { /* 平台不支持则忽略 */ }
  return p;
}

/** TTL 解析：'5m'|'1h'|'24h'|'7d'|'365d'|纯数字(秒) → 秒 */
function parseTtl(v) {
  if (v === undefined || v === null || v === '') return 3600;
  const s = String(v).trim();
  if (/^\d+$/.test(s)) return parseInt(s, 10);
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)?$/i.exec(s);
  if (!m) throw new Error(`无法解析 ttl: ${v}（示例 5m / 1h / 24h / 7d / 3600）`);
  const n = parseFloat(m[1]);
  const unit = (m[2] || 's').toLowerCase();
  const mul = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[unit];
  return Math.round(n * mul);
}

// ── 签发侧 ──

/** 生成用户（主人）密钥对；返回含 JWK 的密钥库对象（私钥材料！勿外传） */
function generateUserKey({ kid = null } = {}) {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    kid: kid || `user-key-${Date.now()}`,
    createdAt: new Date().toISOString(),
    publicJwk: publicKey.export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
}

function jwkToPrivateKey(privateJwk) {
  return crypto.createPrivateKey({ key: privateJwk, format: 'jwk' });
}

/**
 * [2026-09-15] 导入既有用户密钥（PEM）——用于**复用已锚定的主人钥**，而不是另造新钥。
 * 背景：P1 的 keygen 默认会生成一把全新钥（无锚），收货方无法与既有身份链对账
 *       （阿轩踩到：墨白点头 ≠ 这把公钥属于若兰）。故签发侧默认应复用既有用户钥。
 * @param {string} pemPath PKCS8 PEM（如 csb-security/data/yilan-user-key.pem）
 * @param {object} o  { kid }
 */
function importUserKeyFromPem(pemPath, { kid = null } = {}) {
  const pem = fs.readFileSync(pemPath, 'utf8');
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey);
  return {
    kid: kid || `user-key-${Date.now()}`,
    createdAt: new Date().toISOString(),
    importedFrom: pemPath,
    publicJwk: publicKey.export({ format: 'jwk' }),
    privateJwk: privateKey.export({ format: 'jwk' }),
  };
}

/**
 * RFC 7638 JWK thumbprint（SHA-256 → base64url）——**锚指纹**，供人—人带外核对。
 * 收货方据此判断「登记的这把公钥」是否就是发起方主人手里那把。
 */
function thumbprint(jwk) {
  if (!jwk || !jwk.x) throw new Error('thumbprint 需要 Ed25519 JWK（含 x）');
  const canon = JSON.stringify({ crv: jwk.crv || 'Ed25519', kty: jwk.kty || 'OKP', x: jwk.x });
  return crypto.createHash('sha256').update(canon).digest('base64url');
}

/** 指纹分组显示（每 4 字符一空格，便于口述/比对） */
function formatThumbprint(t) {
  return String(t).match(/.{1,4}/g).join(' ');
}

/** 解析 JWT payload（不验签，仅供人看/CLI 摘要） */
function decodePayload(token) {
  try {
    const parts = String(token).split('.');
    if (parts.length !== 3) return null;
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch { return null; }
}

/**
 * 签发 UAC（A 凭证）
 * @param {object} o
 *   - keyStore   {privateJwk, kid} 签发者（主人）密钥库
 *   - user       主人标识（iss），如 'user:yilan@csb'
 *   - agent      被授权 Agent（sub），如 '若兰'
 *   - scopes     数组，如 ['a2a.delegate:shell']
 *   - ttl        秒（见 parseTtl）
 *   - restrictions 可选 { allowed_agents: [...] }
 */
function issueUAC({ keyStore, user, agent, scopes, ttl = 3600, restrictions = null }) {
  if (!keyStore || !keyStore.privateJwk) throw new Error('keyStore.privateJwk 缺失');
  if (!user) throw new Error('user(iss) 必填');
  if (!agent) throw new Error('agent(sub) 必填');
  if (!Array.isArray(scopes) || scopes.length === 0) throw new Error('scopes 不能为空');
  const uac = loadSecurity();
  const token = uac.createUAC({
    userPrivateKey: jwkToPrivateKey(keyStore.privateJwk),
    userId: user,
    agentId: agent,
    scopes,
    ttl,
    restrictions,
    kid: keyStore.kid || null,
  });
  return { token, payload: decodePayload(token), publicJwk: keyStore.publicJwk || null };
}

// ── 登记侧（接收方策略）──

/** 空策略（默认关闭）——与 config/bridge-uac-policy.example.json 同构 */
function emptyPolicy() {
  return { version: POLICY_VERSION, enabled: false, peers: [] };
}

function normalizePolicy(p) {
  const pol = (p && typeof p === 'object') ? { ...p } : emptyPolicy();
  // 浅拷贝要连 peers 元素一起复制——否则 revokePeer/removePeer 会「顺手改到」调用方对象
  // （2026-09-15 单测踩到：共享引用导致后续用例被污染）
  pol.peers = Array.isArray(pol.peers) ? pol.peers.map((x) => (x && typeof x === 'object') ? { ...x } : x) : [];
  if (!Array.isArray(pol.peers)) pol.peers = [];
  if (typeof pol.enabled !== 'boolean') pol.enabled = false;
  if (!pol.version) pol.version = POLICY_VERSION;
  return pol;
}

function findPeer(policy, id) {
  return (policy.peers || []).find((x) => x && (x.id === id || x.agentId === id || x.name === id)) || null;
}

/**
 * 登记/更新一条豁免（B 规则）
 * @param {object} peer
 *   - id/name/agentId（至少 agentId）
 *   - userPublicKey  JWK（必填，验 A 用）
 *   - capabilities   能力白名单，如 ['pull','test']（必填，空则不免确认）
 *   - scopes         允许免确认的 UAC scope（留档/校验，可选）
 *   - rate           { max, windowSeconds }（可选）
 *   - expiresAt      ISO 或 null（可选）
 */
function addPeer(policy, peer) {
  const pol = normalizePolicy(policy);
  if (!peer || !peer.agentId) throw new Error('peer.agentId 必填');
  if (!peer.userPublicKey) throw new Error('peer.userPublicKey 必填（验 A 用）');
  if (!Array.isArray(peer.capabilities) || peer.capabilities.length === 0) {
    throw new Error('peer.capabilities 必填且非空（空白名单 = 不免确认，无意义）');
  }
  const entry = {
    id: peer.id || peer.agentId,
    name: peer.name || peer.agentId,
    agentId: peer.agentId,
    userPublicKey: peer.userPublicKey,
    capabilities: peer.capabilities,
    scopes: peer.scopes || [],
    rate: peer.rate || null,
    expiresAt: peer.expiresAt || null,
    revokedAt: null,
    addedAt: new Date().toISOString(),
  };
  const i = pol.peers.findIndex((x) => x.agentId === entry.agentId || x.id === entry.id);
  if (i >= 0) { entry.addedAt = pol.peers[i].addedAt || entry.addedAt; pol.peers[i] = entry; }
  else pol.peers.push(entry);
  return pol;
}

function revokePeer(policy, id, at = new Date().toISOString()) {
  const pol = normalizePolicy(policy);
  const p = findPeer(pol, id);
  if (!p) throw new Error(`未登记该同伴: ${id}`);
  p.revokedAt = at;
  return pol;
}

function removePeer(policy, id) {
  const pol = normalizePolicy(policy);
  pol.peers = pol.peers.filter((x) => !(x && (x.id === id || x.agentId === id || x.name === id)));
  return pol;
}

function setEnabled(policy, on) {
  const pol = normalizePolicy(policy);
  pol.enabled = !!on;
  return pol;
}

/**
 * [P3 · 2026-09-25] **按 capability 粒级撤销**：保留同伴登记，只收窄能力白名单。
 * 用途：不必整人撤掉（那会连正常授权一起断），只收回越界/不再需要的那几项。
 *
 * @param {object} policy
 * @param {string} id 同伴 id
 * @param {string|string[]} capabilities 要撤销的能力（单个或数组）
 * @returns {{policy:object, removed:string[], remaining:string[]}}
 * @throws 未登记同伴 / 能力不在白名单
 */
function revokeCapability(policy, id, capabilities) {
  const pol = normalizePolicy(policy);
  const p = findPeer(pol, id);
  if (!p) throw new Error(`未登记该同伴: ${id}`);
  const want = (Array.isArray(capabilities) ? capabilities : [capabilities]).filter(Boolean);
  if (!want.length) throw new Error('revokeCapability 需要至少一个 capability');
  const have = Array.isArray(p.capabilities) ? p.capabilities : [];
  const missing = want.filter((c) => !have.includes(c));
  if (missing.length) throw new Error(`能力不在白名单，无法撤销: ${missing.join(',')}（当前: ${have.join(',') || '-'}）`);
  p.capabilities = have.filter((c) => !want.includes(c));
  return { policy: pol, removed: [...want], remaining: [...p.capabilities] };
}

module.exports = {
  SCOPE_PREFIX, POLICY_VERSION,
  loadSecurity, readJsonSafe, writeJson,
  parseTtl, decodePayload,
  generateUserKey, importUserKeyFromPem, thumbprint, formatThumbprint, issueUAC,
  emptyPolicy, normalizePolicy, findPeer, addPeer, revokePeer, removePeer, setEnabled,
  revokeCapability,
};
