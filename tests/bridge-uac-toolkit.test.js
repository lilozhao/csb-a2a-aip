#!/usr/bin/env node
/**
 * bridge-uac-toolkit.test.js —— P1 工具箱单测（2026-09-15）
 * 覆盖：TTL 解析 / 密钥生成 / 签发→验签回路 / 策略增删改查 / **P0 判定钩子端到端**（登记→放行，吊销→拒）
 * 用法: node tests/bridge-uac-toolkit.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const tk = require('../a2a-uac-toolkit');
const { checkUAC } = require('../a2a-bridge-uac');
const uacLib = require(path.join(__dirname, '..', '..', 'csb-security', 'lib', 'authz', 'uac'));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\n[bridge-uac-toolkit · P1]\n');

// ── TTL ──
t('parseTtl: 5m / 1h / 24h / 7d / 纯秒', () => {
  assert.strictEqual(tk.parseTtl('5m'), 300);
  assert.strictEqual(tk.parseTtl('1h'), 3600);
  assert.strictEqual(tk.parseTtl('24h'), 86400);
  assert.strictEqual(tk.parseTtl('7d'), 604800);
  assert.strictEqual(tk.parseTtl('3600'), 3600);
});
t('parseTtl: 非法输入抛错', () => {
  assert.throws(() => tk.parseTtl('nope'));
});

// ── 密钥 & 签发 ──
const ks = tk.generateUserKey({ kid: 'user-key-test' });
t('generateUserKey: 有 OKP 公私钥 + kid', () => {
  assert.strictEqual(ks.publicJwk.kty, 'OKP');
  assert.strictEqual(ks.publicJwk.crv, 'Ed25519');
  assert.ok(ks.privateJwk, 'privateJwk 存在');
  assert.strictEqual(ks.kid, 'user-key-test');
});

const USER = 'user:yilan@csb';
const AGENT = '小虾';
const issued = tk.issueUAC({
  keyStore: ks, user: USER, agent: AGENT,
  scopes: [tk.SCOPE_PREFIX + 'shell'], ttl: 3600,
});
t('issueUAC: payload iss/sub/scopes/exp 正确', () => {
  assert.strictEqual(issued.payload.iss, USER);
  assert.strictEqual(issued.payload.sub, AGENT);
  assert.deepStrictEqual(issued.payload.scopes, ['a2a.delegate:shell']);
  assert.ok(issued.payload.exp > issued.payload.iat);
});
t('issueUAC: 用主人公钥验签通过（回路）', () => {
  const r = uacLib.verifyUAC(issued.token, { userPublicKey: ks.publicJwk, expectedAgentId: AGENT });
  assert.strictEqual(r.valid, true, r.error);
});
t('issueUAC: scopes 空 → 抛错', () => {
  assert.throws(() => tk.issueUAC({ keyStore: ks, user: USER, agent: AGENT, scopes: [] }));
});
t('issueUAC: restrictions.allowed_agents 透传', () => {
  const x = tk.issueUAC({ keyStore: ks, user: USER, agent: AGENT, scopes: ['a2a.delegate:shell'], ttl: 60, restrictions: { allowed_agents: ['小虾'] } });
  assert.deepStrictEqual(x.payload.restrictions, { allowed_agents: ['小虾'] });
});

// ── 策略 CRUD ──
t('emptyPolicy: 默认关 + 空名单', () => {
  const p = tk.emptyPolicy();
  assert.strictEqual(p.enabled, false);
  assert.deepStrictEqual(p.peers, []);
});
t('addPeer: 缺 agentId / 公钥 / 能力白名单 → 抛错', () => {
  assert.throws(() => tk.addPeer(tk.emptyPolicy(), { userPublicKey: ks.publicJwk, capabilities: ['pull'] }));
  assert.throws(() => tk.addPeer(tk.emptyPolicy(), { agentId: AGENT, capabilities: ['pull'] }));
  assert.throws(() => tk.addPeer(tk.emptyPolicy(), { agentId: AGENT, userPublicKey: ks.publicJwk, capabilities: [] }));
});
let pol = tk.addPeer(tk.emptyPolicy(), {
  agentId: AGENT, name: '小虾', userPublicKey: ks.publicJwk,
  capabilities: ['pull', 'test'], scopes: ['a2a.delegate:shell'],
});
t('addPeer: 登记成功 + findPeer 命中', () => {
  assert.strictEqual(pol.peers.length, 1);
  assert.ok(tk.findPeer(pol, AGENT));
  assert.deepStrictEqual(tk.findPeer(pol, AGENT).capabilities, ['pull', 'test']);
});
t('addPeer: 同 agent 再登记 → 更新（不重复）', () => {
  const p2 = tk.addPeer(pol, { agentId: AGENT, userPublicKey: ks.publicJwk, capabilities: ['pull'] });
  assert.strictEqual(p2.peers.length, 1);
  assert.deepStrictEqual(p2.peers[0].capabilities, ['pull']);
});
t('setEnabled: 开关生效', () => {
  assert.strictEqual(tk.setEnabled(pol, true).enabled, true);
  assert.strictEqual(tk.setEnabled(pol, false).enabled, false);
});

// ── 端到端：P1 登记 → P0 判定 ──
const enabledPol = tk.setEnabled(
  tk.addPeer(tk.emptyPolicy(), {
    agentId: AGENT, userPublicKey: ks.publicJwk,
    capabilities: ['pull', 'test'], scopes: ['a2a.delegate:shell'],
  }),
  true
);
const env = { scope: 'shell', uac: issued.token, capabilities: ['pull', 'test'] };
const ctx = { policy: enabledPol, sender: { agentId: AGENT }, rateCheck: () => ({ ok: true }) };

t('端到端①: 签发 + 登记 → checkUAC 放行', () => {
  const r = checkUAC(env, ctx);
  assert.strictEqual(r.hit, true, r.reason);
  assert.strictEqual(r.reason, 'auto_approved');
  assert.strictEqual(r.policyId, AGENT);
});
t('端到端②: 策略未 enable → 不放行（policy_disabled）', () => {
  const r = checkUAC(env, { ...ctx, policy: tk.setEnabled(enabledPol, false) });
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'policy_disabled');
});
t('端到端③: 吊销后 → 不放行（peer_revoked）', () => {
  const r = checkUAC(env, { ...ctx, policy: tk.revokePeer(enabledPol, AGENT) });
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'peer_revoked');
});
t('端到端④: 委托能力越界（策略只 pull/test，带 restart）→ 不放行', () => {
  const r = checkUAC({ ...env, capabilities: ['pull', 'restart'] }, ctx);
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'capability_not_allowed');
});
t('端到端⑤: scope 不匹配（UAC 只授 shell，委托 read）→ 不放行', () => {
  const r = checkUAC({ ...env, scope: 'read' }, ctx);
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'uac_scope_insufficient');
});

// ── 锚钥复用 / 锚指纹（2026-09-15 加：阿轩「无锚钥」踩坑 → 默认复用既有用户钥）──
// 注意：本组用例**完全自包含**（不读本机私钥、不依赖 data/ 下的 gitignored 文件）——
//   否则其他实例跑必挂（佯 2026-09-15 复现：ENOENT yilan-user-key.pem / 无 data/users/*.pub.json）
const fsx = require('fs');
const ANCHOR_PUB = path.join(__dirname, '..', 'config', 'uac-peers', 'ruolan.pub.json');
const ANCHOR_X = 'rpNYnf224QbmIuK1Ivrj7u7BMa5KnUFFCAe54Tm-_4U';
const ANCHOR_TP = '8lci3XPY1CVVX8EOOemYtqVPTpuPbZyV6gUizA1fLGk';
const anchorJwk = { crv: 'Ed25519', kty: 'OKP', x: ANCHOR_X };

t('thumbprint: RFC 7638 指纹与既有锚钥一致（含仓内锚公钥文件对账）', () => {
  assert.strictEqual(tk.thumbprint(anchorJwk), ANCHOR_TP);
  const f = JSON.parse(fsx.readFileSync(ANCHOR_PUB, 'utf8'));
  assert.strictEqual(f.x, ANCHOR_X, '仓内 config/uac-peers/ruolan.pub.json 应与硬编码锚钥一致');
  assert.strictEqual(f.kid, 'user-yilan');
});
t('thumbprint: 缺 x 抛错；formatThumbprint 4 字符分组', () => {
  assert.throws(() => tk.thumbprint({ kty: 'OKP' }));
  assert.strictEqual(tk.formatThumbprint('abcdefgh'), 'abcd efgh');
});
t('importUserKeyFromPem: 从 PEM 导入并可签发（自包含，不依赖任何本机私有资源）', () => {
  const crypto = require('crypto');
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const dir = path.join(__dirname, '..', '.uac');
  fsx.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `.test-key-${process.pid}.pem`);
  fsx.writeFileSync(tmp, pem, { mode: 0o600 });
  try {
    const imported = tk.importUserKeyFromPem(tmp, { kid: 'user-test' });
    assert.strictEqual(imported.publicJwk.x, publicKey.export({ format: 'jwk' }).x, '导入公钥应与源 PEM 一致');
    const { token } = tk.issueUAC({ keyStore: imported, user: 'user:yilan@csb', agent: '若兰', scopes: ['a2a.delegate:shell'], ttl: 600 });
    const r = uacLib.verifyUAC(token, { userPublicKey: imported.publicJwk, expectedAgentId: '若兰' });
    assert.strictEqual(r.valid, true);
  } finally {
    try { fsx.unlinkSync(tmp); } catch { /* 已清理 */ }
  }
});
t('无锚钥互斥: 新造钥签的 UAC 用锚公钥验签 → bad_signature', () => {
  const fresh = tk.generateUserKey({ kid: 'unanchored' });
  const { token } = tk.issueUAC({ keyStore: fresh, user: 'user:yilan@csb', agent: '若兰', scopes: ['a2a.delegate:shell'], ttl: 600 });
  const r = uacLib.verifyUAC(token, { userPublicKey: anchorJwk, expectedAgentId: '若兰' });
  assert.strictEqual(r.valid, false);
  assert.strictEqual(r.error, 'bad_signature');
});

console.log(`\n结果: ${passed} 通过 · ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
