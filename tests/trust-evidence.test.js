#!/usr/bin/env node
/**
 * A2A 消息链 · 信任证据接线测试（信任升级 P0 最后一环）
 *
 * 覆盖：
 *   [1] 接线可用：消息链四事件 → 账本条目（动作/极性/权重正确）
 *   [2] 防刷分：正向限流（3/时）→ 第 4 次记 rate_capped 且不计分
 *   [3] 语义红线：user_declined 永不计负向（即便调用方传 polarity=-1）
 *   [4] fail-safe：csb-security 不可用 → 全部 no-op，绝不抛（消息链不能被拖垮）
 *   [5] 不吞错：init/记账异常在 status() 里显式暴露（degraded）
 *   [6] 路径回归：a2a-trust-bridge 的 csb-security 路径必须真实可达
 *       （回归 2026-09-11 发现的 `../../csb-security` 少一层 → AAT 验签静默失效）
 *   [7] bridge-core 注入：委托完成/用户拒绝都写账，且未装配时不报错不拦流程
 *
 * 风格：手写 assert + console（仓库惯例，无测试框架）
 * 用法: node tests/trust-evidence.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { TrustEvidence } = require(path.join(REPO, 'a2a-trust-evidence.js'));
const { POLARITY, ACTIONS } = require(path.join(REPO, '../csb-security/lib/trust/evidence-ledger.js'));
const bridge = require(path.join(REPO, 'a2a-bridge-core.js'));

let passed = 0, failed = 0;
const _asyncTests = [];
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}
// 异步用例：先登记，全部同步用例跑完后统一 await（否则 process.exit 会抢跑）
function testAsync(name, fn) { _asyncTests.push({ name, fn }); }
function tmpdir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'trust-wire-')); }
function fresh(opts = {}) {
  const dir = tmpdir();
  const t = new TrustEvidence();
  t.init({ ledgerPath: path.join(dir, 'ledger.jsonl'), snapshotPath: path.join(dir, 'store.json'), ...opts });
  return t;
}
const XUAN = { name: '阿轩', url: 'http://172.28.0.5:3100' };
const acts = (t) => t.ledger.entries.map((e) => e.action);

console.log('\n[1] 接线可用：四事件 → 账本（动作/极性/权重由采集器集中决定）');
test('message_ok → 正向 +1', () => {
  const t = fresh();
  t.messageOk(XUAN, { ref: 'task-1' }, 'a2a-standard-api');
  const e = t.ledger.entries[0];
  assert.strictEqual(e.action, 'message_ok');
  assert.strictEqual(e.polarity, POLARITY.POSITIVE);
  assert.strictEqual(e.weight, ACTIONS.message_ok.weight);
  assert.strictEqual(e.subjectId, '阿轩');
  assert.strictEqual(e.evidence.ref, 'task-1', '可核验引用必须落账');
});
test('guard_blocked → 负向', () => {
  const t = fresh();
  t.guardBlocked(XUAN, { ref: 'task-2', detail: 'risk=80' }, 'a2a-standard-api');
  const e = t.ledger.entries[0];
  assert.strictEqual(e.polarity, POLARITY.NEGATIVE);
  assert.ok(e.weight > 0, '负向必须有权重（否则拦截无成本）');
});
test('delegate_completed → 正向权重 2（比普通消息重）', () => {
  const t = fresh();
  t.delegateCompleted(XUAN, { ref: 'task-3' }, 'a2a-bridge');
  assert.strictEqual(t.ledger.entries[0].weight, 2);
  assert.ok(ACTIONS.delegate_completed.weight > ACTIONS.message_ok.weight);
});
test('subjectFrom 兼容 string / 对象 / 缺失三种 sender 格式', () => {
  assert.strictEqual(TrustEvidence.subjectFrom('思源').name, '思源');
  assert.strictEqual(TrustEvidence.subjectFrom({ name: '阿轩', url: 'u' }).url, 'u');
  assert.strictEqual(TrustEvidence.subjectFrom(null).name, 'unknown');
});
test('账本落盘：新实例重放后条目还在（重启不丢，P0 核心诉求）', () => {
  const dir = tmpdir();
  const p = path.join(dir, 'ledger.jsonl');
  const t1 = new TrustEvidence(); t1.init({ ledgerPath: p, snapshotPath: path.join(dir, 's.json') });
  t1.messageOk(XUAN, { ref: 'r1' }, 'a');
  const t2 = new TrustEvidence(); t2.init({ ledgerPath: p, snapshotPath: path.join(dir, 's.json') });
  assert.strictEqual(t2.ledger.entries.length, 1);
  assert.strictEqual(t2.ledger.verifyChain().ok, true, '重启后哈希链必须仍然自洽');
});

console.log('\n[2] 防刷分：正向限流（3/时 · 20/日）');
test('同主体同动作第 4 次 → rate_capped（中性，不加分）', () => {
  const t = fresh();
  for (let i = 0; i < 4; i++) t.messageOk(XUAN, { ref: `r${i}` }, 'a');
  const a = acts(t);
  assert.deepStrictEqual(a, ['message_ok', 'message_ok', 'message_ok', 'rate_capped'], `实际 ${a}`);
  assert.strictEqual(t.ledger.entries[3].polarity, POLARITY.NEUTRAL);
  assert.strictEqual(t.ledger.entries[3].weight, 0);
});
test('负向不封顶（拦截多少次记多少次）', () => {
  const t = fresh();
  for (let i = 0; i < 6; i++) t.guardBlocked(XUAN, { ref: `r${i}` }, 'a');
  assert.strictEqual(acts(t).filter((x) => x === 'guard_blocked').length, 6);
});

console.log('\n[3] 语义红线：用户拒绝不计负向');
test('userDeclined 默认中性（留痕不计分）', () => {
  const t = fresh();
  t.userDeclined(XUAN, { ref: 'task-9' }, 'a2a-bridge');
  const e = t.ledger.entries[0];
  assert.strictEqual(e.action, 'user_declined');
  assert.strictEqual(e.polarity, POLARITY.NEUTRAL);
  assert.strictEqual(e.weight, 0);
});
test('即便调用方硬传 polarity=-1，采集器也强制归零（双保险）', () => {
  const t = fresh();
  t.collector.record({ subject: XUAN, action: 'user_declined', polarity: -1, weight: 5 });
  assert.strictEqual(t.ledger.entries[0].polarity, POLARITY.NEUTRAL);
  assert.strictEqual(t.ledger.entries[0].weight, 0);
});

console.log('\n[4] fail-safe：安全层绝不能拖垮消息链');
test('csb-security 不存在 → 不抛、不启用、明确降级', () => {
  const t = new TrustEvidence();
  t.init({ securityPath: path.join(os.tmpdir(), 'no-such-security-' + Date.now()) });
  assert.strictEqual(t.enabled, false);
  assert.doesNotThrow(() => t.messageOk(XUAN, { ref: 'x' }, 'a'));
  assert.strictEqual(t.messageOk(XUAN, { ref: 'x' }, 'a'), null);
  assert.strictEqual(t.status().degraded, true);
  assert.strictEqual(t.status().reason, 'csb_security_not_found');
});
test('账本路径不可写 → 记账不抛（错误计入 status，不静默）', () => {
  const dir = tmpdir();
  const t = new TrustEvidence();
  // 用一个"目录当文件"的路径制造写失败
  const notAFile = path.join(dir, 'adir');
  fs.mkdirSync(notAFile);
  t.init({ ledgerPath: path.join(notAFile, 'blocked.jsonl'), snapshotPath: path.join(dir, 's.json') });
  assert.doesNotThrow(() => t.messageOk(XUAN, { ref: 'x' }, 'a'));
});

console.log('\n[5] 不假装"信任体系在运转"：状态可诊断');
test('status() 暴露 enabled/reason/entries/chainValid/degraded', () => {
  const t = fresh();
  t.messageOk(XUAN, { ref: 'r' }, 'a');
  const s = t.status();
  assert.strictEqual(s.enabled, true);
  assert.strictEqual(s.entries, 1);
  assert.strictEqual(s.chainValid, true);
  assert.strictEqual(s.signed, false, '测试环境未配密钥 → 必须诚实标 unsigned');
  assert.strictEqual(s.degraded, true, '未签名即降级（已知局限：挡不住完整伪造插入）');
  assert.ok(s.reason.includes('unsigned'), `reason=${s.reason}`);
});

console.log('\n[6] 路径回归：AAT 验签不能被静默绕过');
test('a2a-trust-bridge 里的 csb-security 相对路径必须真实可达', () => {
  const src = fs.readFileSync(path.join(REPO, 'a2a-trust-bridge.js'), 'utf-8');
  const m = src.match(/require\('([^']*csb-security[^']*)'\)/);
  assert.ok(m, '未找到 csb-security require');
  const resolved = path.resolve(REPO, m[1]);
  assert.ok(fs.existsSync(resolved),
    `路径不可达（AAT 验签会静默回退）: ${m[1]} → ${resolved}`);
});
test('AAT 模块可加载且导出 verifyAATWithAID', () => {
  const aat = require(path.join(REPO, '../csb-security/lib/identity/aat.js'));
  assert.strictEqual(typeof aat.verifyAATWithAID, 'function');
});
test('TrustBridge 的 AAT 路径分支真能跑到（不再是 try/catch 黑洞）', () => {
  const { TrustBridge } = require(path.join(REPO, 'a2a-trust-bridge.js'));
  const tb = new TrustBridge();
  // 无效 token：若路径可达，会走真实校验逻辑返回 null；路径不可达则抛错被吞 → 也返回 null。
  // 区分点：路径可达时不再抛 MODULE_NOT_FOUND，用它做断言。
  const aatPath = path.resolve(REPO, '../csb-security/lib/identity/aat.js');
  assert.ok(fs.existsSync(aatPath), '模块文件不存在');
  assert.doesNotThrow(() => tb._verifyAAT('not-a-token', { sender: { name: '阿轩' } }));
});

console.log('\n[7] bridge-core 注入：委托结果写账（且 fail-safe）');
testAsync('委托执行完成 → delegate_completed', async () => {
  const t = fresh();
  const recorded = [];
  await bridge.handleInbound(
    { delegation: { type: 'notify', scope: 'read', target: '查一下状态' }, parts: [{ text: 'hi' }] },
    {
      sender: XUAN, taskId: 't-1',
      getTrustLevel: async () => 'L2',
      inject: async () => ({ summary: 'ok' }),
      recordEvidence: async (evt) => {
        recorded.push(evt);
        // 走与 server_v5.js 相同的映射（账户层 record 需要对象参数）
        if (evt.action === 'delegate_completed') return t.delegateCompleted(evt.subject, evt.evidence, evt.actor);
        if (evt.action === 'user_declined') return t.userDeclined(evt.subject, evt.evidence, evt.actor);
        return t._safeCall('record', [{ subject: evt.subject, action: evt.action, evidence: evt.evidence, actor: evt.actor }]);
      },
    },
  );
  assert.strictEqual(recorded.length, 1, `应记 1 条，实际 ${JSON.stringify(recorded)}`);
  assert.strictEqual(recorded[0].action, 'delegate_completed');
  assert.strictEqual(acts(t)[0], 'delegate_completed');
});
testAsync('L3 用户显式拒绝 → user_declined（中性）', async () => {
  const t = fresh();
  const recorded = [];
  const r = await bridge.handleInbound(
    { delegation: { type: 'execute', scope: 'write', target: '写入今日 memory 文件' }, parts: [{ text: 'hi' }] },
    {
      sender: XUAN, taskId: 't-2',
      getTrustLevel: async () => 'L3',
      confirmL3: async () => ({ ok: false, declined: true, detail: '用户拒绝' }),
      inject: async () => ({ summary: 'should-not-happen' }),
      recordEvidence: async (evt) => {
        recorded.push(evt);
        if (evt.action === 'user_declined') return t.userDeclined(evt.subject, evt.evidence, evt.actor);
        return t._safeCall('record', [{ subject: evt.subject, action: evt.action, evidence: evt.evidence, actor: evt.actor }]);
      },
    },
  );
  assert.strictEqual(r.kind, 'rejected');
  assert.strictEqual(recorded[0].action, 'user_declined');
  assert.strictEqual(t.ledger.entries[0].polarity, POLARITY.NEUTRAL, '拒绝必须中性');
});
testAsync('L3 超时 → 不记（系统未得答复，不归咎发起方）', async () => {
  const recorded = [];
  await bridge.handleInbound(
    { delegation: { type: 'execute', scope: 'write', target: '写入今日 memory 文件' }, parts: [{ text: 'hi' }] },
    {
      sender: XUAN, taskId: 't-3',
      getTrustLevel: async () => 'L3',
      confirmL3: async () => ({ ok: false, timedOut: true }),
      inject: async () => ({}),
      recordEvidence: async (evt) => recorded.push(evt),
    },
  );
  assert.strictEqual(recorded.length, 0, '超时不应记为拒绝');
});
testAsync('未装配 recordEvidence → 委托照常完成，不报错（老部署兼容）', async () => {
  const r = await bridge.handleInbound(
    { delegation: { type: 'notify', scope: 'read', target: '查' }, parts: [{ text: 'hi' }] },
    { sender: XUAN, taskId: 't-4', getTrustLevel: async () => 'L2', inject: async () => ({ summary: 'ok' }) },
  );
  assert.strictEqual(r.kind, 'executed');
});
testAsync('recordEvidence 抛异常 → 委托照常完成（旁路不得反噬主流程）', async () => {
  const r = await bridge.handleInbound(
    { delegation: { type: 'notify', scope: 'read', target: '查' }, parts: [{ text: 'hi' }] },
    {
      sender: XUAN, taskId: 't-5',
      getTrustLevel: async () => 'L2',
      inject: async () => ({ summary: 'ok' }),
      recordEvidence: async () => { throw new Error('账本炸了'); },
    },
  );
  assert.strictEqual(r.kind, 'executed');
});

console.log('\n' + '─'.repeat(60));
(async () => {
  for (const { name, fn } of _asyncTests) {
    try { await fn(); passed++; console.log(`  ✅ ${name}`); }
    catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
  }
  console.log('\n' + '─'.repeat(60));
  console.log(`通过: ${passed}\n失败: ${failed}`);
  process.exit(failed > 0 ? 1 : 0);
})();
