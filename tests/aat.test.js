#!/usr/bin/env node
/**
 * tests/aat.test.js — AAT 消息级签名：只认固定公钥
 *
 * 这个文件的灵魂是**反例**。凡是「能自证」的方案都等于没验证，
 * 所以重点断言不是「正确的通过」，而是：自签名、跨主机、跨受众、重放、篡改**必须全被拒**。
 *
 * 用法: node tests/aat.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

// ── 用临时目录造一对身份，避免碰生产密钥 ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aat-test-'));
const mkKey = (name) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });
  const p = path.join(tmp, `${name}.pem`);
  fs.writeFileSync(p, pem, { mode: 0o600 });
  return { privateKey, publicJwk: publicKey.export({ format: 'jwk' }), path: p };
};

const MINE = mkKey('mine');
const PEER = mkKey('peer');
const EVIL = mkKey('evil');

const MY_ID = 'ruolan@10.0.0.1:3100';
const PEER_ID = 'mingde@peer.example:3100';
const PEER_URL = 'http://peer.example:3100/a2a/json-rpc';

const mineAid = path.join(tmp, 'mine-aid.json');
fs.writeFileSync(mineAid, JSON.stringify({ agent_id: MY_ID, public_key: MINE.publicJwk, endpoint: 'http://10.0.0.1:3100/a2a/json-rpc' }));

process.env.A2A_SECURITY_HANDSHAKE_AID = mineAid;
process.env.A2A_SECURITY_HANDSHAKE_KEY = MINE.path;

const AAT = require('../a2a-aat.js');

console.log('=== AAT 消息签名测试 ===\n');

// ─────────────────────────────────────────────
// 自身身份
// ─────────────────────────────────────────────
test('自身身份解析：agent_id 来自 AID，公钥与私钥一致', () => {
  const self = AAT.getSelf();
  assert.strictEqual(self.ok, true, self.reason);
  assert.strictEqual(self.agentId, MY_ID);
  assert.strictEqual(self.publicJwk.x, crypto.createPublicKey(MINE.privateKey).export({ format: 'jwk' }).x);
});

test('AID 公钥与私钥不一致 → 拒绝签发（身份不一致不能签名）', () => {
  const badAid = path.join(tmp, 'bad-aid.json');
  fs.writeFileSync(badAid, JSON.stringify({ agent_id: MY_ID, public_key: EVIL.publicJwk }));
  const old = process.env.A2A_SECURITY_HANDSHAKE_AID;
  process.env.A2A_SECURITY_HANDSHAKE_AID = badAid;
  AAT._resetSelf();
  const self = AAT.getSelf();
  process.env.A2A_SECURITY_HANDSHAKE_AID = old;
  AAT._resetSelf();
  assert.strictEqual(self.ok, false);
  assert.ok(/不匹配/.test(self.reason), `reason=${self.reason}`);
});

// ─────────────────────────────────────────────
// 签发约束
// ─────────────────────────────────────────────
test('audience 必填；不允许 "' + '*"', () => {
  assert.strictEqual(AAT.sign({}).ok, false);
  const r = AAT.sign({ audience: '*' });
  assert.strictEqual(r.ok, false);
  assert.ok(/受众/.test(r.reason));
});

test('正常签发得到三段式 token', () => {
  const r = AAT.sign({ audience: PEER_ID, capabilities: ['a2a:send'] });
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.token.split('.').length, 3);
  assert.strictEqual(r.issuer, MY_ID);
});

// ─────────────────────────────────────────────
// 验证：核心反例
// ─────────────────────────────────────────────
/** 在临时 config 里固定 peer 的公钥，然后验证 */
function withPinned(jwk, fn) {
  const loaderPath = require.resolve('../config/loader.js');
  const orig = require.cache[loaderPath];
  require.cache[loaderPath] = {
    id: loaderPath, filename: loaderPath, loaded: true,
    exports: {
      getAgentList: () => ([
        { id: 'mingde', name: '明德', host: 'peer.example', port: 3100, url: 'http://peer.example:3100', trust: 3, aidPublicKey: jwk },
      ]),
    },
  };
  try { return fn(); } finally {
    if (orig) require.cache[loaderPath] = orig; else delete require.cache[loaderPath];
  }
}

/** 用指定私钥签发一条「声称来自 peer」的消息 */
function forgedToken({ key = PEER.privateKey, aud = MY_ID, ttl = 300, iss = PEER_ID } = {}) {
  const { createAAT } = require('../../csb-security/lib/identity/aat.js');
  return createAAT({ privateKey: key, issuer: iss, audience: aud, capabilities: ['a2a:send'], ttl });
}

const SENDER = { name: '明德', url: PEER_URL, id: PEER_ID };

test('✅ 固定公钥 + 正确签名 + 正确受众 → 通过', () => {
  withPinned(PEER.publicJwk, () => {
    const token = forgedToken();
    const r = AAT.verifyInbound({ ...SENDER, aat: token }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, true, r.reason);
    assert.strictEqual(r.source, 'aat');
    assert.strictEqual(r.issuer, PEER_ID);
    assert.strictEqual(r.trustLevel, 2);
  });
});

test('🛡️ 自签名：攻击者用自己的私钥冒充 peer → 签名不匹配', () => {
  withPinned(PEER.publicJwk, () => {
    const token = forgedToken({ key: EVIL.privateKey });
    const r = AAT.verifyInbound({ ...SENDER, aat: token }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'bad_signature');
  });
});

test('🛡️ 没有固定公钥 → no_pinned_key（不静默放行，也不误信）', () => {
  withPinned(undefined, () => {
    const token = forgedToken();
    const r = AAT.verifyInbound({ ...SENDER, aat: token }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'no_pinned_key');
    assert.ok(/未固定/.test(r.reason));
  });
});

test('🛡️ ★ 发送方自带的公钥不被采信（否则等于自签名）', () => {
  withPinned(undefined, () => {
    // 攻击者：自己生成密钥，用自己公钥签名，再把公钥塞进 sender 里
    const token = forgedToken({ key: EVIL.privateKey });
    const r = AAT.verifyInbound(
      { ...SENDER, aat: token, aidPublicKey: EVIL.publicJwk, publicKey: EVIL.publicJwk },
      { expectedAudience: MY_ID },
    );
    assert.strictEqual(r.ok, false, '必须拒绝：公钥只能来自本地固定，不能来自发送方');
    assert.strictEqual(r.error, 'no_pinned_key');
  });
});

test('🛡️ 受众混淆：token 发给别人 → audience_mismatch', () => {
  withPinned(PEER.publicJwk, () => {
    const token = forgedToken({ aud: 'someone-else@x:1' });
    const r = AAT.verifyInbound({ ...SENDER, aat: token }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'audience_mismatch');
  });
});

test('🛡️ 未传 expectedAudience → 直接拒绝（不允许「不校验受众」）', () => {
  withPinned(PEER.publicJwk, () => {
    const token = forgedToken();
    const r = AAT.verifyInbound({ ...SENDER, aat: token }, {});
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'missing_expected_audience');
  });
});

test('🛡️ 篡改 payload → bad_signature', () => {
  withPinned(PEER.publicJwk, () => {
    const token = forgedToken();
    const [h, p, s] = token.split('.');
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString('utf8'));
    payload.capabilities = ['admin:all'];
    const tampered = `${h}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${s}`;
    const r = AAT.verifyInbound({ ...SENDER, aat: tampered }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'bad_signature');
  });
});

test('🛡️ 重放：同一 token 第二次 → replay_detected', () => {
  withPinned(PEER.publicJwk, () => {
    const token = forgedToken();
    const first = AAT.verifyInbound({ ...SENDER, aat: token }, { expectedAudience: MY_ID });
    assert.strictEqual(first.ok, true, first.reason);
    const second = AAT.verifyInbound({ ...SENDER, aat: token }, { expectedAudience: MY_ID });
    assert.strictEqual(second.ok, false);
    assert.strictEqual(second.error, 'replay_detected');
  });
});

test('🛡️ 过期 token → expired', () => {
  withPinned(PEER.publicJwk, () => {
    // 手工造：iat 在 10 分钟前、exp 在 5 分钟前（exp 仍 > iat，才是真正的「已过期」）
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: 'EdDSA', typ: 'JWT' };
    const payload = {
      iss: PEER_ID, sub: PEER_ID, aud: MY_ID,
      iat: now - 600, exp: now - 300,
      jti: `aat-exp-${now}-${crypto.randomBytes(4).toString('hex')}`,
      capabilities: ['a2a:send'],
    };
    const si = `${Buffer.from(JSON.stringify(header)).toString('base64url')}.${Buffer.from(JSON.stringify(payload)).toString('base64url')}`;
    const sig = crypto.sign(null, Buffer.from(si), PEER.privateKey);
    const token = `${si}.${sig.toString('base64url')}`;
    const r = AAT.verifyInbound({ ...SENDER, aat: token }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'expired');
  });
});

test('🛡️ ttl 为负（exp <= iat）→ invalid_exp（同样拒绝）', () => {
  withPinned(PEER.publicJwk, () => {
    const token = forgedToken({ ttl: -10 });
    const r = AAT.verifyInbound({ ...SENDER, aat: token }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, false);
    assert.ok(['invalid_exp', 'expired'].includes(r.error), `error=${r.error}`);
  });
});

test('🛡️ 跨主机冒用：签名主体 host 与声称来源不一致 → issuer_host_mismatch', () => {
  withPinned(PEER.publicJwk, () => {
    // peer 的密钥签的，但消息声称来自另一个地址
    const token = forgedToken();
    const r = AAT.verifyInbound(
      { name: '明德', url: 'http://evil.example:3100/a2a/json-rpc', id: 'x@evil.example:3100', aat: token },
      { expectedAudience: MY_ID },
    );
    // 因为 sender.url 变了，固定公钥匹配不到 → no_pinned_key 也属正确拒绝
    assert.strictEqual(r.ok, false, '必须拒绝');
    assert.ok(['no_pinned_key', 'issuer_host_mismatch'].includes(r.error), `error=${r.error}`);
  });
});

test('🛡️ 无 aat 字段 → no_token（不抛异常）', () => {
  const r = AAT.verifyInbound({ name: '明德', url: PEER_URL }, { expectedAudience: MY_ID });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_token');
});

test('🛡️ 非 JWT 垃圾串 → malformed', () => {
  withPinned(PEER.publicJwk, () => {
    const r = AAT.verifyInbound({ ...SENDER, aat: 'not-a-jwt' }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'malformed');
  });
});

// ─────────────────────────────────────────────
// attach 不影响可用性
// ─────────────────────────────────────────────
test('attach：签发失败时保留原 sender 并带 _aatError（不中断发送）', () => {
  const old = process.env.A2A_SECURITY_HANDSHAKE_KEY;
  process.env.A2A_SECURITY_HANDSHAKE_KEY = '/nonexistent/key.pem';
  AAT._resetSelf();
  const s = AAT.attach({ name: '若兰', url: 'http://x' }, PEER_ID);
  process.env.A2A_SECURITY_HANDSHAKE_KEY = old;
  AAT._resetSelf();
  assert.strictEqual(s.name, '若兰');
  assert.ok(s._aatError, '应记录失败原因');
  assert.strictEqual(s.aat, undefined);
});

test('attach：成功后 sender 带 aat', () => {
  const s = AAT.attach({ name: '若兰', url: 'http://10.0.0.1:3100' }, PEER_ID);
  assert.strictEqual(s._aatError, undefined, s._aatError);
  assert.ok(typeof s.aat === 'string' && s.aat.split('.').length === 3);
});

// ─────────────────────────────────────────────
// 公钥导出
// ─────────────────────────────────────────────
test('exportPublicKey 指纹稳定且可复算', () => {
  const r = AAT.exportPublicKey();
  assert.strictEqual(r.ok, true, r.reason);
  assert.strictEqual(r.agentId, MY_ID);
  const der = crypto.createPublicKey({ key: r.publicKey, format: 'jwk' }).export({ type: 'spki', format: 'der' });
  assert.strictEqual(crypto.createHash('sha256').update(der).digest('hex'), r.fingerprint);
});

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n通过: ${passed}\n失败: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
