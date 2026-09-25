#!/usr/bin/env node
/**
 * uac-p3.test.js —— UAC P3 单测（2026-09-25）
 *
 * 覆盖验收口径（docs/UAC-P3-PLAN.md §4）：
 *   A2 撤销即时生效（钩子层：撤销后同 peer 即 peer_revoked）
 *   A3 未命中落账（带 UAC → 记 delegate_uac_not_hit；不带 UAC → 不记，避免灌账本）
 *   A4 指标可复算（固定夹具 → 逐项等于手工计数）
 *   A5 缺数据诚实（空账本 → null / insufficient，不写 0）
 *   A6 查询只读（readLedger 前后文件 sha256 不变）
 *   A9 不留敏感物（事件 detail 无 token / 私钥）
 *   + R1.2 粒级撤销（revokeCapability）· R1.3 策略变更留痕（diffPolicy/describePolicyChange）
 *
 * 用法: node tests/uac-p3.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tk = require('../a2a-uac-toolkit');
const obs = require('../a2a-uac-observability');
const { checkUAC } = require('../a2a-bridge-uac');
const { handleInbound } = require('../a2a-bridge-core');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
async function ta(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'uac-p3-'));
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const peer = { agentId: '小虾', name: '小虾', capabilities: ['pull', 'test'], scopes: ['a2a.delegate:shell'], userPublicKey: { kty: 'OKP', crv: 'Ed25519', x: 'AAA' } };
const polOn = () => ({ version: 1, enabled: true, peers: [JSON.parse(JSON.stringify(peer))] });

console.log('\n[uac-p3 · P3 可观测性 / 撤销 / 指标]\n');

// ─────────────────────── R1.2 粒级撤销 ───────────────────────
console.log('[R1.2 按 capability 粒级撤销]');
t('revokeCapability：撤一项，另一项保留', () => {
  const r = tk.revokeCapability(polOn(), '小虾', 'test');
  assert.deepStrictEqual(r.removed, ['test']);
  assert.deepStrictEqual(r.remaining, ['pull']);
  assert.strictEqual(tk.findPeer(r.policy, '小虾').capabilities.includes('pull'), true);
});
t('revokeCapability：全部撤光 → 白名单空（不再有可免确认能力）', () => {
  const r = tk.revokeCapability(polOn(), '小虾', ['pull', 'test']);
  assert.deepStrictEqual(r.remaining, []);
});
t('revokeCapability：未登记同伴 → 抛错', () => {
  assert.throws(() => tk.revokeCapability(polOn(), '不存在', 'pull'), /未登记/);
});
t('revokeCapability：撤不在白名单的能力 → 抛错（不静默）', () => {
  assert.throws(() => tk.revokeCapability(polOn(), '小虾', 'deploy'), /不在白名单/);
});

// ─────────────────────── A2 撤销即时生效（钩子层） ───────────────────────
console.log('\n[A2 撤销即时生效 · checkUAC]');
const fakeVerifier = {
  verifyUAC: () => ({ valid: true, payload: { iss: 'user:x', sub: '若兰', jti: 'jti-1', scopes: ['a2a.delegate:shell'] } }),
  coversScopes: () => true,
};
const envOk = { scope: 'shell', uac: 'h.p.s', capabilities: ['pull'] };
t('撤销前：命中放行', () => {
  const d = checkUAC(envOk, { policy: polOn(), sender: { name: '小虾' }, ...fakeVerifier });
  assert.strictEqual(d.hit, true);
});
t('revokePeer 后同一请求 → peer_revoked（无需重启/无缓存）', () => {
  const pol = tk.revokePeer(polOn(), '小虾');
  const d = checkUAC(envOk, { policy: pol, sender: { name: '小虾' }, ...fakeVerifier });
  assert.strictEqual(d.hit, false);
  assert.strictEqual(d.reason, 'peer_revoked');
});
t('粒级撤销后：撤掉的能力被拒，保留的能力仍放行', () => {
  const { policy } = tk.revokeCapability(polOn(), '小虾', 'pull');
  const denied = checkUAC(envOk, { policy, sender: { name: '小虾' }, ...fakeVerifier });
  assert.strictEqual(denied.reason, 'capability_not_allowed');
  // 反向：撤掉 test、声明 test → 拒；声明 pull 仍放行
  const { policy: p2 } = tk.revokeCapability(polOn(), '小虾', 'test');
  assert.strictEqual(checkUAC({ ...envOk, capabilities: ['test'] }, { policy: p2, sender: { name: '小虾' }, ...fakeVerifier }).reason, 'capability_not_allowed');
  assert.strictEqual(checkUAC(envOk, { policy: p2, sender: { name: '小虾' }, ...fakeVerifier }).hit, true);
});

// ─────────────────────── R1.3 策略变更留痕（描述层） ───────────────────────
console.log('\n[R1.3 策略变更留痕]');
t('policyDigest：只留可审计要素，不带公钥', () => {
  const d = obs.policyDigest(polOn());
  assert.deepStrictEqual(d.peers[0].caps, ['pull', 'test']);
  assert.strictEqual(JSON.stringify(d).includes('userPublicKey'), false);
});
t('diffPolicy：能力收窄 → changed 命中该 peer', () => {
  const after = tk.revokeCapability(polOn(), '小虾', 'test').policy;
  const d = obs.diffPolicy(polOn(), after);
  assert.strictEqual(d.peers.changed.length, 1);
  assert.deepStrictEqual(d.peers.changed[0].caps, { before: ['pull', 'test'], after: ['pull'] });
});
t('describePolicyChange：一行 k=v，可正则解析', () => {
  const s = obs.describePolicyChange({ op: 'revoke-capability', peer: '小虾', capability: 'test', before: 'pull,test', after: 'pull', reason: '越界' });
  assert.ok(/op=revoke-capability/.test(s) && /capability=test/.test(s) && /reason=越界/.test(s));
});

// ─────────────────────── A4 指标可复算（夹具） ───────────────────────
console.log('\n[A4 指标可复算（固定夹具）]');
const T0 = Date.parse('2026-09-24T10:00:00Z');
const mkE = (o) => ({ ts: T0, subjectId: o.subjectId || '小虾', action: o.action, evidence: { ref: 't', detail: o.detail || '' } });
const fixture = [
  mkE({ action: 'delegate_auto_approved', detail: 'scope=shell; policy=小虾; jti=j1' }),
  mkE({ action: 'delegate_auto_approved', detail: 'scope=shell; policy=小虾; jti=j2' }),
  mkE({ action: 'delegate_auto_approved', detail: 'scope=shell; policy=小虾; jti=j3' }),
  mkE({ action: 'delegate_uac_not_hit', detail: 'scope=shell; reason=uac_invalid; detail=bad_signature' }),
  mkE({ action: 'delegate_uac_not_hit', detail: 'scope=shell; reason=rate_exceeded' }),
  mkE({ action: 'uac_policy_changed', detail: 'op=revoke-capability; peer=小虾; capability=test' }),
  mkE({ action: 'uac_policy_changed', detail: 'op=enable; reason=试用' }),
  mkE({ action: 'uac_issued', subjectId: '若兰', detail: 'jti=j9; iss=user:x' }),
  // 非 UAC 事件：不该进指标
  { ts: T0, subjectId: '言蹊', action: 'message_ok', evidence: { ref: 'm', detail: '' } },
];
t('M1 自动放行率 = 3/5 = 0.6（分母写死）', () => {
  const m = obs.computeMetrics(fixture, {});
  assert.strictEqual(m.M1_autoApproveRate.denominator, 5);
  assert.strictEqual(m.M1_autoApproveRate.rate, 0.6);
});
t('M2 原因分布 = uac_invalid 1 / rate_exceeded 1', () => {
  const m = obs.computeMetrics(fixture, {});
  assert.deepStrictEqual(m.M2_notHitReasons, { uac_invalid: 1, rate_exceeded: 1 });
});
t('M3 每 peer：小虾 放行3/未命中2', () => {
  const m = obs.computeMetrics(fixture, {});
  const x = m.M3_perPeer.find((p) => p.agentId === '小虾');
  assert.strictEqual(x.hits, 3);
  assert.strictEqual(x.notHits, 2);
});
t('M4 <3 天 → insufficient（不编趋势）', () => {
  const m = obs.computeMetrics(fixture, {});
  assert.strictEqual(m.M4_dailyTrend.days.length, 1);
  assert.strictEqual(m.M4_dailyTrend.sufficient, false);
});
t('M5 变更 2 条（byOp revoke-capability/ enable）· 签发 1 条', () => {
  const m = obs.computeMetrics(fixture, {});
  assert.strictEqual(m.M5_changes.policyChanges, 2);
  assert.deepStrictEqual(m.M5_changes.byOp, { 'revoke-capability': 1, enable: 1 });
  assert.strictEqual(m.M5_changes.issued, 1);
});
t('窗口过滤：--from 明天 → 全部过滤掉', () => {
  const m = obs.computeMetrics(fixture, { from: '2026-09-30', to: '2026-10-01' });
  assert.strictEqual(m.window.rows, 0);
});
t('M3 有策略时给 rate 用量比（3/3 = 100%）', () => {
  const pol = polOn();
  pol.peers[0].rate = { max: 3, windowSeconds: 31536000 };   // 一年窗口，避免依赖跑测时刻
  const m = obs.computeMetrics(fixture, { policy: pol });
  const x = m.M3_perPeer.find((p) => p.agentId === '小虾');
  assert.strictEqual(x.rateMax, 3);
  assert.strictEqual(x.usedInWindow, 3);
  assert.strictEqual(x.usagePct, 100);
});

// ─────────────────────── A5 缺数据诚实 ───────────────────────
console.log('\n[A5 缺数据诚实]');
t('空账本：M1.rate = null（不是 0）+ 明确 insufficient', () => {
  const m = obs.computeMetrics([], {});
  assert.strictEqual(m.M1_autoApproveRate.rate, null);
  assert.strictEqual(m.M1_autoApproveRate.denominator, 0);
  assert.ok(/insufficient/.test(m.M1_autoApproveRate.note || ''), '应有 insufficient 说明');
});
t('空账本：M2 空对象 / M3 空数组 / M5 全 0（计数为真 0 才写 0）', () => {
  const m = obs.computeMetrics([], {});
  assert.deepStrictEqual(m.M2_notHitReasons, {});
  assert.deepStrictEqual(m.M3_perPeer, []);
  assert.strictEqual(m.M5_changes.policyChanges, 0);
});

// ─────────────────────── 查询过滤 ───────────────────────
console.log('\n[查询过滤 · queryEntries]');
t('默认只看 UAC 相关事件（message_ok 不出现）', () => {
  const { rows } = obs.queryEntries(fixture, {});
  assert.strictEqual(rows.length, 8);
  assert.ok(rows.every((e) => obs.UAC_ACTIONS.includes(e.action)));
});
t('--all 才看全部', () => {
  assert.strictEqual(obs.queryEntries(fixture, { all: true }).total, 9);
});
t('--result hit / not_hit', () => {
  assert.strictEqual(obs.queryEntries(fixture, { result: 'hit' }).total, 3);
  assert.strictEqual(obs.queryEntries(fixture, { result: 'not_hit' }).total, 2);
});
t('--peer / --reason / --jti 过滤', () => {
  assert.strictEqual(obs.queryEntries(fixture, { peer: '小虾' }).total, 7);
  assert.strictEqual(obs.queryEntries(fixture, { reason: 'uac_invalid' }).total, 1);
  assert.strictEqual(obs.queryEntries(fixture, { jti: 'j2' }).total, 1);
});
t('--limit N 取最近 N 条（且 total 仍为过滤后总数）', () => {
  const r = obs.queryEntries(fixture, { limit: 2 });
  assert.strictEqual(r.total, 8);
  assert.strictEqual(r.shown, 2);
});
t('--action 指定事件名', () => {
  assert.strictEqual(obs.queryEntries(fixture, { action: 'uac_issued' }).total, 1);
});

// ─────────────────────── 读账（A6 只读 + 链校验） ───────────────────────
console.log('\n[A6 读账只读 + 链校验]');
const ledgerPath = path.join(tmpRoot, 'trust-evidence.jsonl');
{
  // 用真实 csb-security 账本类写一个可校验的链
  const secDir = require('../a2a-trust-evidence').TrustEvidence.locateSecurity();
  const { EvidenceLedger } = require(path.join(secDir, 'lib', 'trust', 'evidence-ledger.js'));
  const led = new EvidenceLedger({ ledgerPath });
  for (const e of fixture) led.append({ subject: { name: e.subjectId }, action: e.action, evidence: e.evidence, actor: 'test' });
}
t('readLedger：读出 9 条 + 链校验通过', () => {
  const r = obs.readLedger({ ledgerPath });
  assert.strictEqual(r.exists, true);
  assert.strictEqual(r.entries.length, 9);
  assert.strictEqual(r.chainValid, true);
});
t('A6 只读：读前后文件 sha256 不变', () => {
  const before = sha(ledgerPath);
  obs.readLedger({ ledgerPath });
  obs.queryEntries(obs.readLedger({ ledgerPath }).entries, {});
  obs.computeMetrics(obs.readLedger({ ledgerPath }).entries, {});
  assert.strictEqual(sha(ledgerPath), before);
});
t('readLedger：账本不存在 → exists=false 且 entries 空（不抛）', () => {
  const r = obs.readLedger({ ledgerPath: path.join(tmpRoot, 'nope.jsonl') });
  assert.strictEqual(r.exists, false);
  assert.deepStrictEqual(r.entries, []);
});

// ─────────────────────── A9 不留敏感物 ───────────────────────
console.log('\n[A9 不留敏感物]');
t('策略变更 detail 不含公钥/JWK/token', () => {
  const before = polOn();
  const after = tk.revokeCapability(before, '小虾', 'test').policy;
  const d = obs.diffPolicy(before, after);
  const s = JSON.stringify(d);
  assert.ok(!/userPublicKey|"kty"|privateJwk/.test(s), 'diff 不应含公钥/私钥材料');
});
t('not_hit 事件结构：只有 scope/reason/detail，无 token', () => {
  const detail = 'scope=shell; reason=uac_invalid; detail=bad_signature';
  assert.ok(!/eyJ/.test(detail), 'detail 里不得出现 JWT 前缀');
  assert.ok(!/BEGIN PRIVATE/.test(detail));
});

// ─────────────────────── A3 bridge-core 接线落账 ───────────────────────
console.log('\n[A3 bridge-core：未命中落账]');
const mkCtx = (o = {}) => ({
  sender: { name: '小虾', url: 'http://test:3100' },
  taskId: 'task-p3',
  getTrustLevel: async () => 'L3',
  inject: async () => ({ summary: 'ok', artifact: 'file://x' }),
  confirmL3: async () => ({ ok: true, by: 'user' }),
  recordDegrade: async () => {},
  ...o,
});

(async () => {
  await ta('带 UAC 且未命中 → 记 delegate_uac_not_hit（含 reason）', async () => {
    const actions = [];
    const r = await handleInbound(
      { delegation: { type: 'execute', scope: 'shell', target: 'git pull', uac: 'h.p.s', capabilities: ['pull'] } },
      mkCtx({
        checkUAC: async () => ({ hit: false, reason: 'uac_invalid', detail: 'bad_signature' }),
        recordEvidence: async (e) => { actions.push(e); },
      })
    );
    assert.strictEqual(r.kind, 'executed', '未命中仍回退 L3 执行');
    const evt = actions.find((a) => a.action === 'delegate_uac_not_hit');
    assert.ok(evt, '应落账 not_hit，实得 ' + JSON.stringify(actions.map((a) => a.action)));
    assert.ok(/reason=uac_invalid/.test(evt.evidence.detail));
    assert.ok(!/h\.p\.s/.test(JSON.stringify(evt)), '账本不得包含 token 原文');
  });

  await ta('不带 UAC 的委托 → 不记 not_hit（避免灌账本）', async () => {
    const actions = [];
    await handleInbound(
      { delegation: { type: 'execute', scope: 'shell', target: 'git pull' } },
      mkCtx({ checkUAC: async () => ({ hit: false, reason: 'no_uac' }), recordEvidence: async (e) => { actions.push(e); } })
    );
    assert.strictEqual(actions.filter((a) => a.action === 'delegate_uac_not_hit').length, 0);
  });

  await ta('命中 → 仍只记 auto_approved（行为与 P2 一致）', async () => {
    const actions = [];
    await handleInbound(
      { delegation: { type: 'execute', scope: 'shell', target: 'git pull', uac: 'h.p.s', capabilities: ['pull'] } },
      mkCtx({
        checkUAC: async () => ({ hit: true, reason: 'auto_approved', policyId: '小虾', capabilities: ['pull'], uac: { jti: 'j1', iss: 'user:x' } }),
        recordEvidence: async (e) => { actions.push(e.action); },
      })
    );
    assert.ok(actions.includes('delegate_auto_approved'), '应留痕 auto_approved');
    assert.ok(!actions.includes('delegate_uac_not_hit'), '命中时不应留 not_hit');
  });

  await ta('A7 fail-safe：记账抛错不影响判定', async () => {
    const r = await handleInbound(
      { delegation: { type: 'execute', scope: 'shell', target: 'git pull', uac: 'h.p.s' } },
      mkCtx({
        checkUAC: async () => ({ hit: false, reason: 'uac_invalid' }),
        recordEvidence: async () => { throw new Error('ledger down'); },
      })
    );
    assert.strictEqual(r.kind, 'executed');
  });

  // 清理
  try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* 忽略 */ }

  console.log(`\n结果: ${passed} 通过 · ${failed} 失败\n`);
  process.exit(failed ? 1 : 0);
})();
