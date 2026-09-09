#!/usr/bin/env node
/**
 * A2A Bridge Correlator · 单元测试（M2 Step 2）
 * 覆盖：回执格式化（四要素进 Artifact/Message）+ Task 状态应用（COMPLETED/REJECTED/FAILED）
 * 风格：手写 assert + console（仓库惯例）
 *
 * 用法: node tests/bridge-correlator.test.js
 */
const assert = require('assert');
const bridge = require('../a2a-bridge-core');
const correlator = require('../a2a-bridge-correlator');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}

// ============================================
// 迷你 mock TaskStore（内存，对齐 a2a-task-store 接口）
// ============================================
function mkTaskStore() {
  const tasks = new Map();
  return {
    tasks,
    createTask: (opts = {}) => {
      const t = { id: 'task-' + (tasks.size + 1), status: 'TASK_STATE_SUBMITTED', history: [], artifacts: [], metadata: opts.metadata || {}, statusNotes: [] };
      tasks.set(t.id, t);
      return t;
    },
    addArtifact: (id, art) => tasks.get(id).artifacts.push(art),
    addHistory: (id, msg) => tasks.get(id).history.push(msg),
    updateTaskStatus: (id, state, note) => { const t = tasks.get(id); t.status = state; t.statusNotes.push(note); },
    setMetadata: (id, md) => Object.assign(tasks.get(id).metadata, md),
    getTask: (id) => tasks.get(id),
  };
}

// ============================================
// 测试
// ============================================
console.log('\n[1] 回执格式化（四要素 → Artifact / Message）');

test('executed 回执 → Artifact 含 JSON 四要素', () => {
  const receipt = bridge.buildReceipt({
    delegator: '言蹊 (http://x:3100)', scope: 'write', startedAt: Date.now() - 500,
    result: { status: 'completed', summary: '已写入', artifact: 'file://m.md' },
  });
  const art = correlator.formatReceiptArtifact(receipt);
  assert.strictEqual(art.name, 'bridge-receipt');
  const parsed = JSON.parse(art.parts[0].text);
  assert.strictEqual(parsed.receipt.scope, 'write');
  assert.ok(parsed.receipt.durationMs >= 500);
  assert.strictEqual(parsed.receipt.result.status, 'completed');
});

test('失败回执 → Message 含 reason + fallbackHint（P0 诚实指路）', () => {
  const receipt = bridge.buildFailureReceipt({
    delegator: 'x', scope: 'write', startedAt: Date.now(),
    reason: bridge.REASON.BRIDGE_UNAVAILABLE, detail: '断连', fallbackHint: '走主会话/论坛复核通道',
  });
  const msg = correlator.formatReceiptMessage(receipt, 'degraded');
  assert.ok(msg.parts[0].text.includes('桥接不可用'));
  assert.ok(msg.parts[0].text.includes('fallback: 走主会话/论坛复核通道'));
});

test('rejected 回执 → Message 标明拒绝原因', () => {
  const receipt = bridge.buildFailureReceipt({
    delegator: 'x', scope: 'write', startedAt: Date.now(),
    reason: bridge.REASON.USER_DECLINED, detail: '用户未确认',
  });
  const msg = correlator.formatReceiptMessage(receipt, 'rejected');
  assert.ok(msg.parts[0].text.includes('被拒绝'));
  assert.ok(msg.parts[0].text.includes('user_declined'));
});

console.log('\n[2] Task 状态应用（澈：复用标准生命周期）');

test('executed → TASK_STATE_COMPLETED + artifact + history', async () => {
  const store = mkTaskStore();
  const task = store.createTask();
  const bridgeResult = await bridge.handleInbound(
    { delegation: { type: 'execute', scope: 'read', target: '查状态' } },
    {
      sender: { name: '星尘', url: 'http://s:3100' }, taskId: task.id,
      getTrustLevel: async () => 'L2',
      inject: async () => ({ summary: '在线', artifact: 'status-ok' }),
    }
  );
  const applied = correlator.applyToTask(store, task.id, bridgeResult);
  assert.strictEqual(applied.status, 'TASK_STATE_COMPLETED');
  assert.strictEqual(applied.artifacts.length, 1);
  assert.strictEqual(applied.artifacts[0].name, 'bridge-receipt');
  assert.ok(applied.history.length >= 1);
});

test('rejected（用户拒绝）→ TASK_STATE_REJECTED（标准状态）', async () => {
  const store = mkTaskStore();
  const task = store.createTask();
  const bridgeResult = await bridge.handleInbound(
    { delegation: { type: 'execute', scope: 'write', target: '删文件' } },
    {
      sender: { name: '阿轩', url: 'http://a:3100' }, taskId: task.id,
      getTrustLevel: async () => 'L3',
      confirmL3: async () => ({ ok: false, declined: true }),
    }
  );
  const applied = correlator.applyToTask(store, task.id, bridgeResult);
  assert.strictEqual(applied.status, 'TASK_STATE_REJECTED');
  const receipt = JSON.parse(applied.artifacts[0].parts[0].text);
  assert.strictEqual(receipt.receipt.result.reason, bridge.REASON.USER_DECLINED);
});

test('degraded（桥接不可用）→ TASK_STATE_FAILED + 降级事件已留痕', async () => {
  const store = mkTaskStore();
  const task = store.createTask();
  let degradeLogged = null;
  const bridgeResult = await bridge.handleInbound(
    { delegation: { type: 'execute', scope: 'read', target: 'x' } },
    {
      sender: { name: '言蹊', url: 'http://y:3100' }, taskId: task.id,
      getTrustLevel: async () => 'L2',
      inject: async () => { throw new Error('gateway down'); },
      recordDegrade: async (evt) => { degradeLogged = evt; },
    }
  );
  const applied = correlator.applyToTask(store, task.id, bridgeResult);
  assert.strictEqual(applied.status, 'TASK_STATE_FAILED');
  assert.ok(degradeLogged, '降级事件应留痕');
});

test('not-delegation → 返回 null（不触碰 Task，走原管道）', async () => {
  const store = mkTaskStore();
  const task = store.createTask();
  const bridgeResult = await bridge.handleInbound({ parts: [{ text: 'hi' }] }, {
    sender: { name: 'x', url: 'u' }, taskId: task.id,
    getTrustLevel: async () => 'L0',
  });
  const applied = correlator.applyToTask(store, task.id, bridgeResult);
  assert.strictEqual(applied, null);
});

test('hasDelegation 判定（server_v5 分支用）', () => {
  assert.strictEqual(correlator.hasDelegation({ delegation: { type: 'execute', scope: 'read', target: 'x' } }), true);
  assert.strictEqual(correlator.hasDelegation({ parts: [{ text: 'hi' }] }), false);
  assert.strictEqual(correlator.hasDelegation({ delegation: 'bogus' }), false);
});

test('端到端：信封非法 → REJECTED + envelope_invalid artifact', async () => {
  const store = mkTaskStore();
  const task = store.createTask();
  const bridgeResult = await bridge.handleInbound(
    { delegation: { type: 'execute', scope: 'write', target: 'x', refusable: false } }, // T4 无效声明
    { sender: { name: 'x', url: 'u' }, taskId: task.id, getTrustLevel: async () => 'L3' }
  );
  const applied = correlator.applyToTask(store, task.id, bridgeResult);
  assert.strictEqual(applied.status, 'TASK_STATE_REJECTED');
  const receipt = JSON.parse(applied.artifacts[0].parts[0].text);
  assert.strictEqual(receipt.receipt.result.reason, bridge.REASON.REFUSAL_NOT_ALLOWED);
});

// ============================================
// 汇总
// ============================================
setTimeout(() => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`结果: ${passed} 通过 / ${failed} 失败`);
  if (failed > 0) process.exit(1);
  console.log('全部通过 ✅');
}, 100);
