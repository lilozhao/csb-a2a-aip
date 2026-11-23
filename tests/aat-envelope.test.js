#!/usr/bin/env node
/**
 * tests/aat-envelope.test.js — W-63 入站 AAT 验签「落信封」
 *
 * 灵魂同 tests/aat.test.js：断言重点是**负向**。
 *   · 无票 → 必须能落成 valid:false/error:no_token（不许 omit、不许当正常）
 *   · 伪造 sender → 必须红，且指纹要指出「是哪把 pin 的钥验的」
 *   · 客户端自带的 metadata.aat 不许被当成结论（Symbol 键，JSON 造不出来）
 *   · 指纹认钥不认票：同一把钥的两张票，指纹必须相同
 *
 * 用法: node tests/aat-envelope.test.js
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aat-env-'));
const mkKey = (name) => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
  const p = path.join(tmp, `${name}.pem`);
  fs.writeFileSync(p, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  return { privateKey, publicJwk: publicKey.export({ format: 'jwk' }), path: p };
};
const MINE = mkKey('mine');
const PEER = mkKey('peer');
const EVIL = mkKey('evil');

const MY_ID = 'ruolan@10.0.0.1:3100';
const PEER_ID = 'mingde@peer.example:3100';
const PEER_URL = 'http://peer.example:3100/a2a/json-rpc';

const mineAid = path.join(tmp, 'mine-aid.json');
fs.writeFileSync(mineAid, JSON.stringify({ agent_id: MY_ID, public_key: MINE.publicJwk }));
process.env.A2A_SECURITY_HANDSHAKE_AID = mineAid;
process.env.A2A_SECURITY_HANDSHAKE_KEY = MINE.path;

const AAT = require('../a2a-aat.js');
const ENV = require('../a2a-aat-envelope.js');
const inbox = require('../a2a-inbox.js');

console.log('=== W-63 入站验签落信封测试 ===\n');

function withPinned(jwk, fn) {
  const loaderPath = require.resolve('../config/loader.js');
  const orig = require.cache[loaderPath];
  require.cache[loaderPath] = {
    id: loaderPath, filename: loaderPath, loaded: true,
    exports: { getAgentList: () => ([
      { id: 'mingde', name: '明德', host: 'peer.example', port: 3100, url: 'http://peer.example:3100', trust: 3, aidPublicKey: jwk },
    ]) },
  };
  try { return fn(); } finally {
    if (orig) require.cache[loaderPath] = orig; else delete require.cache[loaderPath];
  }
}

function token({ key = PEER.privateKey, iss = PEER_ID } = {}) {
  return require('../../csb-security/lib/identity/aat.js').createAAT({
    privateKey: key, issuer: iss, audience: MY_ID, capabilities: ['a2a:send'], ttl: 300,
    jti: crypto.randomBytes(8).toString('hex'),
  });
}

const SENDER = { name: '明德', url: PEER_URL, id: PEER_ID };

// ── 正例 ──
test('✅ 有效票 → valid:true 且指纹 = pin 的公钥指纹', () => {
  withPinned(PEER.publicJwk, () => {
    const t = token();
    const r = AAT.verifyInbound({ ...SENDER, aat: t }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, true, r.reason);
    const md = {};
    ENV.stamp(md, ENV.makeVerdict({ valid: true, token: t, issuer: r.issuer, agentId: r.agentId, fingerprint: r.keyFingerprint }));
    const s = ENV.summarize(md);
    assert.strictEqual(s.valid, true);
    assert.strictEqual(s.fingerprint, ENV.keyFingerprint(PEER.publicJwk), '指纹必须与 pin 的公钥一致');
    assert.strictEqual(s.error, null);
  });
});

// ── 负向 1：无票 ──
test('🛡️ 无票 → valid:false / error:no_token（绝不 omit）', () => {
  const s = ENV.summarize(ENV.stamp({}, ENV.makeVerdict({ valid: false, error: 'no_token' })));
  assert.strictEqual(s.valid, false);
  assert.strictEqual(s.error, 'no_token');
  assert.ok('aat' in { aat: s }, '字段必须存在');
});

// ── 负向 2：伪造 sender（自己签自己的名）──
test('🛡️ 冒名：用别人的钥签 → bad_signature，且信封里 valid:false', () => {
  withPinned(PEER.publicJwk, () => {
    const t = token({ key: EVIL.privateKey });
    const r = AAT.verifyInbound({ ...SENDER, aat: t }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'bad_signature');
    // 失败也要带指纹：能分辨「换了钥」 vs 「同一把钥我这边配错」
    assert.ok(r.keyFingerprint, '失败分支必须带 keyFingerprint');
    assert.strictEqual(r.keyFingerprint, ENV.keyFingerprint(PEER.publicJwk), '应指出是 pin 的那把钥验的');
  });
});

// ── 负向 3：客户端伪造结论 ──
test('🛡️ 客户端自带 metadata.aat 伪造 → 不可被读取为本结论', () => {
  const forged = { aat: { valid: true, fingerprint: 'deadbeefdeadbeef', error: null } };
  assert.strictEqual(ENV.read(forged), null, 'Symbol 键无法由 JSON 构造');
  const s = ENV.summarize(forged);
  assert.strictEqual(s.valid, false);
  assert.strictEqual(s.error, 'no_verdict');
});

// ── 负向 4：无 pin ──
test('🛡️ 没有 pin 公钥 → no_pinned_key（不静默放行）', () => {
  const t = token();
  const r = AAT.verifyInbound({ ...SENDER, aat: t }, { expectedAudience: MY_ID });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'no_pinned_key');
});

// ── 负向 5：受众不符 ──
test('🛡️ 受众不是本实例 → audience_mismatch', () => {
  withPinned(PEER.publicJwk, () => {
    const t = require('../../csb-security/lib/identity/aat.js').createAAT({
      privateKey: PEER.privateKey, issuer: PEER_ID, audience: 'someone-else', capabilities: [], ttl: 300,
      jti: crypto.randomBytes(8).toString('hex'),
    });
    const r = AAT.verifyInbound({ ...SENDER, aat: t }, { expectedAudience: MY_ID });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error, 'audience_mismatch');
  });
});

// ── 指纹语义 ──
test('指纹认钥不认票：同一把钥的两张票 → 指纹相同、token 摘要不同', () => {
  const a = ENV.makeVerdict({ valid: true, key: PEER.publicJwk, token: token() });
  const b = ENV.makeVerdict({ valid: true, key: PEER.publicJwk, token: token() });
  assert.strictEqual(a.fingerprint, b.fingerprint, '同钥指纹必须恒定');
  assert.notStrictEqual(a.token, b.token, '不同票的摘要不该相同');
});

test('指纹可区分不同钥', () => {
  assert.notStrictEqual(ENV.keyFingerprint(PEER.publicJwk), ENV.keyFingerprint(EVIL.publicJwk));
});

// ── 收件箱接线 ──
test('✅ 收件箱信封必带 aat 字段（含无结论时的 no_verdict）', () => {
  const p = path.join(tmp, 'inbox.jsonl');
  process.env.A2A_INBOX_PATH = p;
  delete require.cache[require.resolve('../a2a-inbox.js')];
  const ib = require('../a2a-inbox.js');
  ib.record({ taskId: 't1', msg: { parts: [{ text: 'hi' }] }, metadata: { sender: { name: '明德' } } });
  const rows = fs.readFileSync(p, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.strictEqual(rows.length, 1);
  assert.ok(rows[0].aat, '信封必须带 aat 字段');
  assert.strictEqual(rows[0].aat.valid, false);
  assert.strictEqual(rows[0].aat.error, 'no_verdict');
});

test('✅ 结论盖在 sender 上也能落进信封（REST 现拼 restMeta 的路径）', () => {
  const p = path.join(tmp, 'inbox2.jsonl');
  process.env.A2A_INBOX_PATH = p;
  delete require.cache[require.resolve('../a2a-inbox.js')];
  const ib = require('../a2a-inbox.js');
  const sender = { name: '明德', url: PEER_URL };
  ENV.stamp(sender, ENV.makeVerdict({ valid: true, key: PEER.publicJwk, token: 'x.y.z' }));
  ib.record({ taskId: 't2', msg: { parts: [{ text: 'hi' }] }, metadata: { sender } });
  const row = JSON.parse(fs.readFileSync(p, 'utf8').trim());
  assert.strictEqual(row.aat.valid, true, '应能从 sender 上取到结论');
  assert.strictEqual(row.aat.fingerprint, ENV.keyFingerprint(PEER.publicJwk));
});

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed === 0 ? 0 : 1);
