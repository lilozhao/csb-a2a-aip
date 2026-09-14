#!/usr/bin/env node
/**
 * bridge-uac.test.js —— UAC 接入 bridge 判定钩子（P0）单元测试
 * 覆盖：fail-safe 前置 / 有效放行 / 各类拒绝（未登记·吊销·过期·坏签名·scope 不足·能力越界·超频·防重放）
 * 依赖：csb-security 的 uac.js + aid.js（同工作区兄弟仓）；仅本地，无网络。
 * 用法: node tests/bridge-uac.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { checkUAC, requiredUacScope } = require('../a2a-bridge-uac');

const aid = require(path.join(__dirname, '..', '..', 'csb-security', 'lib', 'identity', 'aid'));
const uacLib = require(path.join(__dirname, '..', '..', 'csb-security', 'lib', 'authz', 'uac'));

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

console.log('\n[bridge-uac · P0 判定钩子]\n');

// ── 夹具 ──
const SENDER = '若兰';
const userKey = aid.generateKeyPair('user-key-01');       // 一澜的密钥
const otherKey = aid.generateKeyPair('user-key-02');      // 冒名者密钥
const PUB = userKey.publicJwk;

function mkUAC({ scopes = [requiredUacScope('shell')], key = userKey.privateKey, ttl = 3600, sub = SENDER } = {}) {
  return uacLib.createUAC({
    userPrivateKey: key,
    userId: 'user:yilan@csb',
    agentId: sub,
    scopes,
    ttl,
  });
}

const basePolicy = () => ({
  version: 1,
  enabled: true,
  peers: [{
    id: 'ruolan',
    agentId: SENDER,
    userPublicKey: PUB,
    capabilities: ['pull', 'test'],
    scopes: [requiredUacScope('shell')],
    rate: { max: 3, windowSeconds: 86400 },
    revokedAt: null,
  }],
});

const baseEnvelope = (uac, capabilities = ['pull', 'test']) => ({
  scope: 'shell',
  uac,
  capabilities,
});

// 常规 ctx：带「频次计数器」（策略含 rate，需注入 rateCheck 才不失守）
const okCtx = (policy) => ({
  policy, sender: { agentId: SENDER }, now: Date.now(),
  rateCheck: () => ({ ok: true }),
});
// 仅前置校验用（不带计数器）——供「缺计数器 fail-safe」用例
const bareCtx = (policy) => ({ policy, sender: { agentId: SENDER }, now: Date.now() });

// ── 1. fail-safe 前置 ──
t('policy 未启用 → 不免（policy_disabled）', () => {
  const p = basePolicy(); p.enabled = false;
  const r = checkUAC(baseEnvelope(mkUAC()), okCtx(p));
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'policy_disabled');
});

t('信封未带 UAC → 不免（no_uac）', () => {
  const r = checkUAC({ scope: 'shell', capabilities: ['pull'] }, okCtx(basePolicy()));
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'no_uac');
});

t('发起方未登记 → 不免（peer_not_registered）', () => {
  const p = basePolicy(); p.peers[0].agentId = '别家';
  const r = checkUAC(baseEnvelope(mkUAC()), okCtx(p));
  assert.strictEqual(r.reason, 'peer_not_registered');
});

t('同伴授权被吊销 → 不免（peer_revoked）', () => {
  const p = basePolicy(); p.peers[0].revokedAt = '2026-09-15T00:00:00Z';
  const r = checkUAC(baseEnvelope(mkUAC()), okCtx(p));
  assert.strictEqual(r.reason, 'peer_revoked');
});

t('同伴授权过期 → 不免（peer_grant_expired）', () => {
  const p = basePolicy(); p.peers[0].expiresAt = '2020-01-01T00:00:00Z';
  const r = checkUAC(baseEnvelope(mkUAC()), okCtx(p));
  assert.strictEqual(r.reason, 'peer_grant_expired');
});

// ── 2. 有效放行 ──
t('A 有效 + B 命中 → 免确认（auto_approved）', () => {
  const r = checkUAC(baseEnvelope(mkUAC()), okCtx(basePolicy()));
  assert.strictEqual(r.hit, true);
  assert.strictEqual(r.reason, 'auto_approved');
  assert.strictEqual(r.policyId, 'ruolan');
  assert.deepStrictEqual(r.capabilities, ['pull', 'test']);
  assert.ok(r.uac.jti, '应回带 jti 供留痕');
});

// ── 3. 各类拒绝 ──
t('签名不对（他人密钥签发）→ uac_invalid', () => {
  const p = basePolicy();
  const bad = mkUAC({ key: otherKey.privateKey });
  const r = checkUAC(baseEnvelope(bad), okCtx(p));
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'uac_invalid');
});

t('UAC 已过期 → uac_invalid(expired)', () => {
  const old = mkUAC({ ttl: 1 });
  const r = checkUAC(baseEnvelope(old), { ...okCtx(basePolicy()), now: Date.now() + 60_000 });
  assert.strictEqual(r.reason, 'uac_invalid');
  assert.match(String(r.detail), /expired/);
});

t('UAC scope 不足 → uac_scope_insufficient', () => {
  const weak = mkUAC({ scopes: [requiredUacScope('read')] });
  const r = checkUAC(baseEnvelope(weak), okCtx(basePolicy()));
  assert.strictEqual(r.reason, 'uac_scope_insufficient');
});

t('能力越界（策略只许 pull/test，委托带 restart）→ capability_not_allowed', () => {
  const r = checkUAC(baseEnvelope(mkUAC(), ['pull', 'restart']), okCtx(basePolicy()));
  assert.strictEqual(r.reason, 'capability_not_allowed');
  assert.match(String(r.detail), /restart/);
});

t('未声明能力 → no_capabilities_declared', () => {
  const r = checkUAC(baseEnvelope(mkUAC(), []), okCtx(basePolicy()));
  assert.strictEqual(r.reason, 'no_capabilities_declared');
});

t('策略无能力白名单 → no_capability_whitelist（fail-safe）', () => {
  const p = basePolicy(); delete p.peers[0].capabilities;
  const r = checkUAC(baseEnvelope(mkUAC()), okCtx(p));
  assert.strictEqual(r.reason, 'no_capability_whitelist');
});

t('有 rate 策略但缺计数器 → rate_tracker_unavailable（fail-safe）', () => {
  const r = checkUAC(baseEnvelope(mkUAC()), bareCtx(basePolicy()));
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'rate_tracker_unavailable');
});

t('超频 → rate_exceeded', () => {
  const ctx = { ...bareCtx(basePolicy()), rateCheck: () => ({ ok: false, detail: '4/3' }) };
  const r = checkUAC(baseEnvelope(mkUAC()), ctx);
  assert.strictEqual(r.reason, 'rate_exceeded');
});

t('未注入 rateCheck 但策略无 rate → 可放行；注入通过 → 可放行', () => {
  const p = basePolicy(); delete p.peers[0].rate;
  const r = checkUAC(baseEnvelope(mkUAC()), okCtx(p));
  assert.strictEqual(r.hit, true);
});

t('防重放：同一 jti 第二次 → uac_invalid(replay_detected)', () => {
  const jtiCache = new Set();
  const token = mkUAC();
  const p = basePolicy();
  const first = checkUAC(baseEnvelope(token), { ...okCtx(p), jtiCache, rateCheck: () => ({ ok: true }) });
  const second = checkUAC(baseEnvelope(token), { ...okCtx(p), jtiCache, rateCheck: () => ({ ok: true }) });
  assert.strictEqual(first.hit, true);
  assert.strictEqual(second.hit, false);
  assert.match(String(second.detail), /replay/);
});

t('取不到验证器 → verifier_unavailable（fail-safe）', () => {
  const r = checkUAC(baseEnvelope(mkUAC()), {
    policy: basePolicy(), sender: { agentId: SENDER },
    verifyUAC: 'not-a-function',
  });
  assert.strictEqual(r.hit, false);
  assert.strictEqual(r.reason, 'verifier_unavailable');
});

console.log(`\n结果: ${passed} 通过 · ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
