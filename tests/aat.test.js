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

// ─────────────────────────────────────────────
// 受众推断：查不到必须返回 null，不许回落成 agent@<host>
//   （2026-10-25 若兰：旧回落会签出 100% audience_mismatch 的 token，且双方零报错）
// ─────────────────────────────────────────────
test('audienceForUrl：未登记的 host → null（不回落成 agent@<host>）', () => {
  const aud = AAT.audienceForUrl('http://10.99.99.99:3999');
  assert.strictEqual(aud, null, `不该回落到占位值，实际得到: ${aud}`);
});

test('audienceForUrl：config 命中的 host → <身份名>@<host>（不用 config 键）', () => {
  // 用当前 config 里的真实条目推导，避免把某台机器的地址写死进测试
  const list = (require('../config/loader.js').getAgentList() || []).filter((a) => a && a.id && a.url);
  if (!list.length) { console.log('     （config 无可用条目，跳过正向用例）'); return; }
  const a = list[0];
  const host = String(a.url).replace(/^[a-z]+:\/\//i, '').replace(/\/+$/, '').toLowerCase();
  // 2026-10-26：接收侧 expectedAudience 取 identity 名，发送侧必须同源
  const identity = a.agentId || String(a.name || a.id).replace(/\s*[🌸🔧💼📜🧙🚤🦐🌿✨💧🌊🌟🎋🌱]\s*/gu, '').trim() || a.id;
  assert.strictEqual(AAT.audienceForUrl(a.url), `${identity}@${host}`);
});

test('audienceForUrl：键=ASCII、名=中文 → 取中文名（舟楫 audience_mismatch 回归）', () => {
  // 直接验证取材规则：config 键 zhouji / name 舟楫 🚤 时，aud 必须是 舟楫@host
  const aud = AAT.audienceForUrl('http://172.28.0.27:3100');
  if (aud === null) { console.log('     （config 无该条目，跳过）'); return; }
  assert.ok(!aud.startsWith('zhouji@'), `不该用 config 键作 aud，实际: ${aud}`);
  assert.strictEqual(aud, '舟楫@172.28.0.27:3100');
});

// ─────────────────────────────────────────────
// 同 host 多条目：顺序不该决定能不能验过
//   2026-10-25 阿契实测：config 里同一台机器有三条（模板短名 / 中文名 / 完整 id），
//   findPinnedKey 按 host 取第一个命中 —— 命中无公钥那条就必然 no_pinned_key。
//   他的修法是让所有同 host 条目都带同一把钥；代码层更该做的是别让顺序当判据。
// ─────────────────────────────────────────────
test('findPinnedKeyByIssuer：无公钥条目排在前，仍应选中后面那条有公钥的', () => {
  const picked = AAT.__test._pickPinnedEntry([
    { id: 'ruolan', name: '若兰', url: 'http://10.0.0.9:3100' },                 // 无公钥，排第一
    { id: 'ruolan-full', name: '若兰', url: 'http://10.0.0.9:3100', aidPublicKey: MINE.publicJwk },
  ]);
  assert.strictEqual(picked.ok, true, picked.reason);
  assert.strictEqual(picked.key.x, MINE.publicJwk.x, '应选中带公钥那条');
});

test('_pickPinnedEntry：多条都无公钥 → no_pinned_key，且报出条目数', () => {
  const picked = AAT.__test._pickPinnedEntry([
    { id: 'a', name: '甲', url: 'http://10.0.0.9:3100' },
    { id: 'b', name: '乙', url: 'http://10.0.0.9:3100' },
  ]);
  assert.strictEqual(picked.ok, false);
  assert.strictEqual(picked.error, 'no_pinned_key');
  assert.ok(/2 条/.test(picked.reason), `应报出条目数，实际: ${picked.reason}`);
});

test('_pickPinnedEntry：多条公钥相同 → 采用（无歧义）', () => {
  const picked = AAT.__test._pickPinnedEntry([
    { id: 'a', name: '甲', url: 'http://10.0.0.9:3100', aidPublicKey: MINE.publicJwk },
    { id: 'b', name: '乙', url: 'http://10.0.0.9:3100', aidPublicKey: MINE.publicJwk },
  ]);
  assert.strictEqual(picked.ok, true, picked.reason);
  assert.strictEqual(picked.key.x, MINE.publicJwk.x);
});

test('🛡️ _pickPinnedEntry：多条公钥不同 → key_conflict 拒绝（不许猜）', () => {
  const picked = AAT.__test._pickPinnedEntry([
    { id: 'a', name: '甲', url: 'http://10.0.0.9:3100', aidPublicKey: MINE.publicJwk },
    { id: 'b', name: '乙', url: 'http://10.0.0.9:3100', aidPublicKey: PEER.publicJwk },
  ]);
  assert.strictEqual(picked.ok, false, '公钥冲突时必须拒绝');
  assert.strictEqual(picked.error, 'key_conflict');
  assert.ok(/身份歧义/.test(picked.reason), `应说明身份歧义，实际: ${picked.reason}`);
});

// ─────────────────────────────────────────────
// aat-keys.js locate()：完整 agent_id 要能落到短名键上
//   2026-10-25 榫实测：agents.json 的键是短名 `ruolan`，pin 传的是
//   `ruolan@172.28.0.214:3100` → 精确查失败 + 名字匹配失败（'ruolan' ≠ '若兰'）
//   → 报「config 里找不到」。同一个人的两种写法，工具得能对上，
//   不该逼用户加两把键（他原来的修法是「公钥写两处」）。
// ─────────────────────────────────────────────
test('locate：完整 agent_id（name@host:port）应解析到短名键', () => {
  const { locate } = require('../scripts/aat-keys.js').__test;
  const list = require('../config/loader.js').getAgentList() || [];
  const a = list.find((x) => x && x.id && x.url && !String(x.id).includes('@'));
  if (!a) { console.log('     （无可用于该用例的条目，跳过）'); return; }
  const fullId = `${a.id}@${String(a.url).replace(/^[a-z]+:\/\//i, '')}`;
  const hit = locate(fullId);
  assert.ok(hit, `完整 id "${fullId}" 应能定位，实际 null`);
  assert.strictEqual(hit.key, a.id, `应落到短名键 ${a.id}`);
});

test('locate：不存在的 agent → null（不猜）', () => {
  const { locate } = require('../scripts/aat-keys.js').__test;
  assert.strictEqual(locate('nobody@10.255.255.1:9999'), null);
});

// 清理
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* 忽略 */ }

console.log(`\n通过: ${passed}\n失败: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
