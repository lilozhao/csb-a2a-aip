#!/usr/bin/env node
/**
 * A2A Bridge Core · 单元测试（M2 Step 1）
 * 覆盖 RFC v0.2 §5 验收用例 1-6（信封/等级/拒绝路径纯逻辑部分）
 * 风格：手写 assert + console（仓库惯例，无测试框架）
 *
 * 用法: node tests/bridge-core.test.js
 */
const assert = require('assert');
const bridge = require('../a2a-bridge-core');

const {
  validateEnvelope,
  requiredLevel,
  trustSufficient,
  handleInbound,
  buildReceipt,
  buildFailureReceipt,
  REASON,
} = bridge;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

// ============================================
// 1. 信封校验
// ============================================
console.log('\n[1] delegation 信封校验');

test('合法 execute/write 信封通过', () => {
  const r = validateEnvelope({
    delegation: { type: 'execute', scope: 'write', target: '把这段文本写入今日 memory 文件', timeout: 300000 },
  });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.envelope.refusable, true); // 恒 true
  assert.strictEqual(r.envelope.timeoutMs, 300000);
});

test('合法 notify/read 信封通过（无 timeout 用默认 30min）', () => {
  const r = validateEnvelope({ delegation: { type: 'notify', scope: 'read', target: '查一下你的状态' } });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.envelope.timeoutMs, bridge.DEFAULTS.ENVELOPE_TIMEOUT_MS);
});

test('无信封 → ok=null（非委托消息）', () => {
  const r = validateEnvelope({ parts: [{ text: '你好' }] });
  assert.strictEqual(r.ok, null);
});

test('refusable=false 无效声明 → 拒绝（T4 全票 A）', () => {
  const r = validateEnvelope({ delegation: { type: 'execute', scope: 'write', target: 'x', refusable: false } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, REASON.REFUSAL_NOT_ALLOWED);
});

test('type 非法 → 拒绝', () => {
  const r = validateEnvelope({ delegation: { type: 'rm -rf', scope: 'write', target: 'x' } });
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.reason, REASON.ENVELOPE_INVALID);
});

test('scope 非法 → 拒绝', () => {
  const r = validateEnvelope({ delegation: { type: 'execute', scope: 'admin', target: 'x' } });
  assert.strictEqual(r.ok, false);
});

test('target 空 → 拒绝（含混即拒：分类器只兜底）', () => {
  const r = validateEnvelope({ delegation: { type: 'execute', scope: 'read', target: '   ' } });
  assert.strictEqual(r.ok, false);
});

test('timeout 非法（负数）→ 拒绝', () => {
  const r = validateEnvelope({ delegation: { type: 'execute', scope: 'read', target: 'x', timeout: -1 } });
  assert.strictEqual(r.ok, false);
});

test('delegation 非对象 → 拒绝', () => {
  const r = validateEnvelope({ delegation: 'execute please' });
  assert.strictEqual(r.ok, false);
});

// ============================================
// 2. 等级判定（T2 全票 B）
// ============================================
console.log('\n[2] 等级判定（read/notify=L2；write/shell=L3）');

test('scope → 等级门槛映射', () => {
  assert.strictEqual(requiredLevel('read'), 'L2');
  assert.strictEqual(requiredLevel('notify'), 'L2');
  assert.strictEqual(requiredLevel('write'), 'L3');
  assert.strictEqual(requiredLevel('shell'), 'L3');
});

test('L2 可发起 read，不可发起 write', () => {
  assert.strictEqual(trustSufficient('L2', 'read'), true);
  assert.strictEqual(trustSufficient('L2', 'write'), false);
});

test('L3 可发起全部', () => {
  assert.strictEqual(trustSufficient('L3', 'write'), true);
  assert.strictEqual(trustSufficient('L3', 'shell'), true);
});

test('L0/L1 连 read 都不可发起', () => {
  assert.strictEqual(trustSufficient('L0', 'read'), false);
  assert.strictEqual(trustSufficient('L1', 'read'), false);
});

test('未知等级/未知 scope → 不达标（双保险）', () => {
  assert.strictEqual(trustSufficient('LX', 'read'), false);
  assert.strictEqual(trustSufficient('L3', 'sudo'), false);
});

// ============================================
// 3. 结构化回执
// ============================================
console.log('\n[3] 结构化回执四要素（delegator/scope/duration/result）');

test('成功回执含四要素', () => {
  const r = buildReceipt({ delegator: '若兰 (url)', scope: 'write', startedAt: Date.now() - 1000, result: { status: 'completed', summary: 'ok' } });
  assert.ok(r.receipt.delegator.includes('若兰'));
  assert.strictEqual(r.receipt.scope, 'write');
  assert.ok(r.receipt.durationMs >= 1000);
  assert.strictEqual(r.receipt.result.status, 'completed');
});

test('失败回执带 reason + fallbackHint（P0 诚实指路）', () => {
  const r = buildFailureReceipt({ delegator: 'x', scope: 'write', startedAt: Date.now(), reason: REASON.BRIDGE_UNAVAILABLE, detail: '断连', fallbackHint: '走主会话通道' });
  assert.strictEqual(r.receipt.result.status, 'failed');
  assert.strictEqual(r.receipt.result.reason, REASON.BRIDGE_UNAVAILABLE);
  assert.strictEqual(r.receipt.result.fallbackHint, '走主会话通道');
});

// ============================================
// 4. handleInbound 编排（mock 依赖）
// ============================================
console.log('\n[4] handleInbound 编排');

function mkCtx(overrides = {}) {
  return {
    sender: { name: '言蹊', url: 'http://test:3100' },
    taskId: 'task-1',
    getTrustLevel: async () => 'L3',
    inject: async () => ({ summary: '已写入 memory/2026-09-09.md', artifact: 'file://memory/2026-09-09.md' }),
    confirmL3: async () => ({ ok: true, by: 'user' }),
    recordDegrade: async () => {},
    ...overrides,
  };
}

test('无信封 → not-delegation（走原逻辑）', async () => {
  const r = await handleInbound({ parts: [{ text: 'hi' }] }, mkCtx());
  assert.strictEqual(r.kind, 'not-delegation');
});

test('验收用例1：读类委托 L2 执行，无 confirmL3 调用', async () => {
  let confirmed = false;
  const r = await handleInbound(
    { delegation: { type: 'execute', scope: 'read', target: '查你的状态' } },
    mkCtx({ getTrustLevel: async () => 'L2', confirmL3: async () => { confirmed = true; return { ok: true }; } })
  );
  assert.strictEqual(r.kind, 'executed');
  assert.strictEqual(confirmed, false); // L2 不触发用户确认
  assert.strictEqual(r.receipt.receipt.result.status, 'completed');
});

test('验收用例2：写类委托 L3 → confirmL3 被调用且通过后执行', async () => {
  let confirmed = false;
  const r = await handleInbound(
    { delegation: { type: 'execute', scope: 'write', target: '写入文件' } },
    mkCtx({ confirmL3: async () => { confirmed = true; return { ok: true, by: '一澜' }; } })
  );
  assert.strictEqual(confirmed, true);
  assert.strictEqual(r.kind, 'executed');
});

test('验收用例3：L3 确认超时 → 拒绝 + confirm_timeout', async () => {
  const r = await handleInbound(
    { delegation: { type: 'execute', scope: 'write', target: '写入文件' } },
    mkCtx({ confirmL3: async () => ({ ok: false, timedOut: true, detail: '5 分钟无响应' }) })
  );
  assert.strictEqual(r.kind, 'rejected');
  assert.strictEqual(r.receipt.receipt.result.reason, REASON.CONFIRM_TIMEOUT);
});

test('验收用例4：用户拒绝写委托 → user_declined，不执行', async () => {
  let injected = false;
  const r = await handleInbound(
    { delegation: { type: 'execute', scope: 'write', target: '删除文件' } },
    mkCtx({ confirmL3: async () => ({ ok: false, declined: true }), inject: async () => { injected = true; } })
  );
  assert.strictEqual(injected, false);
  assert.strictEqual(r.receipt.receipt.result.reason, REASON.USER_DECLINED);
});

test('验收用例5：等级不足（L1 发 write）→ trust_insufficient', async () => {
  const r = await handleInbound(
    { delegation: { type: 'execute', scope: 'write', target: 'x' } },
    mkCtx({ getTrustLevel: async () => 'L1' })
  );
  assert.strictEqual(r.kind, 'rejected');
  assert.strictEqual(r.receipt.receipt.result.reason, REASON.TRUST_INSUFFICIENT);
});

test('验收用例6：被委托方主会话拒绝（T4 拒绝权）→ target_refused', async () => {
  const r = await handleInbound(
    { delegation: { type: 'execute', scope: 'read', target: 'x' } },
    mkCtx({ getTrustLevel: async () => 'L2', inject: async () => ({ refused: true, detail: '超出能力边界' }) })
  );
  assert.strictEqual(r.kind, 'rejected');
  assert.strictEqual(r.receipt.receipt.result.reason, REASON.TARGET_REFUSED);
});

test('验收用例7：桥接不可用 → degraded + 降级事件留痕 + fallbackHint', async () => {
  let degraded = null;
  const r = await handleInbound(
    { delegation: { type: 'execute', scope: 'read', target: 'x' } },
    mkCtx({
      getTrustLevel: async () => 'L2',
      inject: async () => { throw new Error('gateway 断连'); },
      recordDegrade: async (evt) => { degraded = evt; },
    })
  );
  assert.strictEqual(r.kind, 'degraded');
  assert.ok(degraded, '降级事件应留痕');
  assert.strictEqual(degraded.phase, 'inject');
  assert.strictEqual(r.receipt.receipt.result.reason, REASON.BRIDGE_UNAVAILABLE);
  assert.ok(r.receipt.receipt.result.fallbackHint);
});

test('信封非法 → rejected + envelope_invalid（不查信任不注入）', async () => {
  let injected = false;
  const r = await handleInbound(
    { delegation: { type: 'bogus', scope: 'write', target: 'x' } },
    mkCtx({ inject: async () => { injected = true; } })
  );
  assert.strictEqual(injected, false);
  assert.strictEqual(r.receipt.receipt.result.reason, REASON.ENVELOPE_INVALID);
});

// ============================================
// 汇总
// ============================================
console.log(`\n${'='.repeat(50)}`);
console.log(`结果: ${passed} 通过 / ${failed} 失败`);
if (failed > 0) process.exit(1);
console.log('全部通过 ✅');
