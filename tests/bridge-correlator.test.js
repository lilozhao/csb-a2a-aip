#!/usr/bin/env node
/**
 * a2a-bridge-correlator.js 测试（M2 Step 2）
 * 覆盖：成功流 / 执行失败 / 注入未打通 / 超时 / 关联查询 / 回执四要素 / 并行隔离
 * 用法：node tests/bridge-correlator.test.js
 */
'use strict';

const assert = require('assert');
const { BridgeCorrelator, TASK_STATE, RESULT_CODE, FAIL_REASON } = require('../a2a-bridge-correlator.js');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}: ${e.message}`); });
}

/** mock 依赖工厂：记录状态流转 */
function mockDeps(overrides = {}) {
  const calls = { created: [], updated: [], receipts: [] };
  const deps = {
    createTask: async (t) => { calls.created.push(t); return `task_${calls.created.length}`; },
    updateTask: async (id, state, meta) => { calls.updated.push({ id, state, meta }); },
    sendReceipt: async (r) => { calls.receipts.push(r); },
    now: () => 1000,
    ...overrides,
  };
  return { deps, calls };
}

const sampleEnvelope = (overrides = {}) => ({
  delegation: {
    id: 'del_test_001',
    delegator: 'https://axuan.example/a2a',
    scope: 'notify',
    type: 'execute',
    timeoutMs: 5000,
    ...overrides,
  },
});

async function main() {
  console.log('🧪 a2a-bridge-correlator 测试');

  // 1. 成功流：submitted → working → completed + 四要素回执
  await test('成功流：状态流转 + 回执四要素', async () => {
    const { deps, calls } = mockDeps();
    const c = new BridgeCorrelator(deps);
    const env = sampleEnvelope();
    const receipt = await c.run(env, async (e, taskId) => {
      assert.strictEqual(e.delegation.id, 'del_test_001');
      assert.ok(taskId);
      return { summary: '已通知阿轩', artifactRef: 'thread/123' };
    });
    // 状态顺序
    const states = calls.updated.map(u => u.state);
    assert.deepStrictEqual(states, [TASK_STATE.WORKING, TASK_STATE.COMPLETED]);
    // 回执四要素
    assert.strictEqual(receipt.delegator, 'https://axuan.example/a2a');
    assert.strictEqual(receipt.scope, 'notify');
    assert.strictEqual(typeof receipt.durationMs, 'number');
    assert.strictEqual(receipt.result.code, RESULT_CODE.SUCCESS);
    assert.strictEqual(receipt.result.summary, '已通知阿轩');
    assert.strictEqual(receipt.result.artifactRef, 'thread/123');
    assert.strictEqual(calls.receipts.length, 1);
    assert.strictEqual(receipt.delegationId, 'del_test_001');
  });

  // 2. 执行失败：failed + reason
  await test('执行失败：failed 带原因', async () => {
    const { deps, calls } = mockDeps();
    const c = new BridgeCorrelator(deps);
    const receipt = await c.run(sampleEnvelope(), async () => { throw new Error('磁盘满了'); });
    assert.strictEqual(receipt.result.code, RESULT_CODE.FAILED);
    assert.strictEqual(receipt.result.reason, FAIL_REASON.EXECUTION_ERROR);
    assert.ok(receipt.result.summary.includes('磁盘满了'));
    assert.strictEqual(calls.updated.at(-1).state, TASK_STATE.FAILED);
  });

  // 3. 超时：reason = timeout
  await test('执行超时：reason=timeout', async () => {
    const { deps } = mockDeps();
    const c = new BridgeCorrelator(deps);
    const receipt = await c.run(sampleEnvelope({ timeoutMs: 50 }), async () => {
      await new Promise(r => setTimeout(r, 200));
      return { summary: '太慢了' };
    });
    assert.strictEqual(receipt.result.code, RESULT_CODE.FAILED);
    assert.strictEqual(receipt.result.reason, FAIL_REASON.TIMEOUT);
  });

  // 4. task 创建失败：reason = injection_failed（桥接断，星尘场景）
  await test('task 创建失败：reason=injection_failed', async () => {
    const { deps } = mockDeps({ createTask: async () => { throw new Error('taskStore 不可用'); } });
    const c = new BridgeCorrelator(deps);
    const receipt = await c.run(sampleEnvelope(), async () => ({ summary: '不会到这' }));
    assert.strictEqual(receipt.result.code, RESULT_CODE.FAILED);
    assert.strictEqual(receipt.result.reason, FAIL_REASON.INJECTION_FAILED);
  });

  // 5. 执行体显式拒绝（T4 拒绝权）：带 code 的 throw
  await test('被委托方拒绝：reason=target_refused', async () => {
    const { deps } = mockDeps();
    const c = new BridgeCorrelator(deps);
    const err = new Error('主会话拒绝执行此委托');
    err.code = FAIL_REASON.TARGET_REFUSED;
    const receipt = await c.run(sampleEnvelope(), async () => { throw err; });
    assert.strictEqual(receipt.result.reason, FAIL_REASON.TARGET_REFUSED);
  });

  // 6. 关联查询：delegationId ↔ taskId 双向
  await test('关联查询：双向可查', async () => {
    const { deps } = mockDeps();
    const c = new BridgeCorrelator(deps);
    await c.run(sampleEnvelope(), async () => ({ summary: 'ok' }));
    const byDel = c.lookupByDelegation('del_test_001');
    assert.ok(byDel && byDel.taskId);
    const byTask = c.lookupByTask(byDel.taskId);
    assert.strictEqual(byTask.delegationId, 'del_test_001');
    assert.strictEqual(c.lookupByDelegation('nope'), null);
  });

  // 7. 并行执行隔离：runningCount + 各自 taskId
  await test('并行执行隔离', async () => {
    const { deps, calls } = mockDeps();
    const c = new BridgeCorrelator(deps);
    const gate = { release: null, promise: null };
    gate.promise = new Promise(r => { gate.release = r; });
    const p1 = c.run(sampleEnvelope({ id: 'del_p1' }), async () => { await gate.promise; return { summary: 'p1' }; });
    const p2 = c.run(sampleEnvelope({ id: 'del_p2' }), async () => { await new Promise(r => setTimeout(r, 50)); return { summary: 'p2' }; });
    // 等两个 run 都推进过 createTask/注册点（async 在首个 await 处让出）
    await new Promise(r => setImmediate(r));
    assert.strictEqual(c.runningCount, 2); // p1 在等门，p2 在 50ms 延迟中
    const r2 = await p2;
    gate.release();
    const r1 = await p1;
    assert.strictEqual(r1.result.summary, 'p1');
    assert.strictEqual(r2.result.summary, 'p2');
    assert.strictEqual(c.runningCount, 0);
    assert.notStrictEqual(r1.delegationId, r2.delegationId);
  });

  // 8. 无 sendReceipt 时也能完成（本地记录模式）
  await test('无 sendReceipt：仍返回回执', async () => {
    const { deps } = mockDeps({ sendReceipt: null });
    const c = new BridgeCorrelator(deps);
    const receipt = await c.run(sampleEnvelope(), async () => ({ summary: 'ok' }));
    assert.strictEqual(receipt.result.code, RESULT_CODE.SUCCESS);
  });

  // 9. 回执发送失败不阻断
  await test('sendReceipt 抛错不阻断', async () => {
    const { deps } = mockDeps({ sendReceipt: async () => { throw new Error('网络断'); } });
    const c = new BridgeCorrelator(deps);
    const receipt = await c.run(sampleEnvelope(), async () => ({ summary: 'ok' }));
    assert.strictEqual(receipt.result.code, RESULT_CODE.SUCCESS);
  });

  console.log(`\n📊 结果: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
