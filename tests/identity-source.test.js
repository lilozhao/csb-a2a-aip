#!/usr/bin/env node
/**
 * tests/identity-source.test.js — 「声称来源 vs 签名主体」判据必须与验证器同口径
 * ------------------------------------------------------------------
 * [2026-11-03 · A-2 第①件]
 *
 * 为什么要有这个测试：
 *   scripts/lib/identity-source.js 是给**出站方**做体检用的（发消息前先自检）。
 *   a2a-aat.js 的 verifyInbound 是给**接收方**做判定的（收消息时判收不收）。
 *   两者描述的是同一条规矩，但写在不同文件里 —— 那是「两套口径」的经典起手式。
 *   所以这里不看它俩各自的注释说得对不对，而是**真签一条 AAT、真跑 verifyInbound**，
 *   再拿 identity-source 的结论去对。任何一边改了行为，这条测试立刻红。
 *
 * 覆盖六种 sender.url：
 *   回环 localhost / 回环 127.0.0.1 / 与本机 iss 同源 / 另一台非回环 / 另一台已 pin 的邻居 / 干脆不给
 */
'use strict';

const assert = require('assert');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const aat = require(path.join(ROOT, 'a2a-aat.js'));
const { checkIdentitySource } = require(path.join(ROOT, 'scripts', 'lib', 'identity-source.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

const self = aat.getSelf();
if (!self.ok) {
  console.error(`❌ 拿不到本机身份，无法跑（${self.reason}）`);
  process.exit(2);
}

// 用一个「不存在但格式合法」的 audience：本测试只验 iss/sender.url 这一层，
// 不去碰真实邻居的消息通道。
const AUD = 'a2a-selftest@127.0.0.1:3999';

console.log('\nidentity-source ↔ verifyInbound 口径一致性');

const cases = [
  { label: '回环 localhost', url: 'http://localhost:3100', expectReject: false, expectVerdict: 'loopback' },
  { label: '回环 127.0.0.1', url: 'http://127.0.0.1:3100', expectReject: false, expectVerdict: 'loopback' },
  { label: '与本机 iss 同源', url: `http://${require(path.join(ROOT, 'scripts', 'lib', 'identity-source.js')).hostOf(self.agentId)}`, expectReject: false, expectVerdict: 'same' },
  { label: '另一台非回环地址', url: 'http://10.1.2.3:3100', expectReject: true, expectVerdict: 'mismatch' },
  { label: '另一台已 pin 的邻居', url: 'http://172.28.0.5:3100', expectReject: true, expectVerdict: 'mismatch' },
  { label: '不给 url', url: undefined, expectReject: false, expectVerdict: 'missing' },
];

for (const c of cases) {
  test(`${c.label}（sender.url=${c.url || '(无)'}）`, () => {
    // 每次都现签一条 —— jti 一次性，复用会被 replay_detected 顶掉
    const s = aat.attach({ name: self.agentId.split('@')[0], url: c.url }, AUD);
    assert.ok(s && s.aat, 'attach 没产出 aat');

    const r = aat.verifyInbound(
      { name: self.agentId, id: self.agentId, url: c.url, aat: s.aat },
      { expectedAudience: AUD },
    );

    // 接收方行为
    if (c.expectReject) {
      assert.strictEqual(r.ok, false, '预期被拒，实际通过了');
      assert.strictEqual(r.error, 'issuer_host_mismatch', `预期 issuer_host_mismatch，实际 ${r.error}`);
    } else {
      assert.strictEqual(r.ok, true, `预期通过，实际被拒：${r.error} ${r.reason || ''}`);
      assert.strictEqual(r.trustLevel, 2, 'AAT 验证应给 L2');
    }

    // 出站自检结论必须同向
    const chk = checkIdentitySource(c.url, self.agentId);
    assert.strictEqual(chk.verdict, c.expectVerdict, `identity-source 判 ${chk.verdict}，期望 ${c.expectVerdict}`);
    assert.strictEqual(chk.peerRejects, c.expectReject,
      `identity-source.peerRejects=${chk.peerRejects}，但验证器实际${c.expectReject ? '拒绝' : '接受'}`);
  });
}

// 纯函数边界：不给 agent_id 时不能崩，也不能假装「同源」
test('参数缺失时报 missing，不报 same', () => {
  const r = checkIdentitySource('', '');
  assert.strictEqual(r.verdict, 'missing');
  assert.strictEqual(r.peerRejects, false);
});

// hostOf 必须能吃 agent_id 形态（name@host:port）——这是它唯一比 URL 解析多做的事
test('hostOf 能吃 agent_id 形态', () => {
  const { hostOf } = require(path.join(ROOT, 'scripts', 'lib', 'identity-source.js'));
  assert.strictEqual(hostOf('ruolan@172.28.0.214:3100'), '172.28.0.214:3100');
  assert.strictEqual(hostOf('HTTP://172.28.0.214:3100/'), '172.28.0.214:3100');
});

console.log(`\n通过: ${passed}  失败: ${failed}`);
process.exit(failed > 0 ? 1 : 0);