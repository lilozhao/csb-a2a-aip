#!/usr/bin/env node
/**
 * a2a-bridge-confirm.js 测试（M2 Step 4）
 * 覆盖：批准 / 拒绝 / 超时=拒绝 / 同源聚合 / 幂等 / 投递失败 / 审计记录
 * 用法：node tests/bridge-confirm.test.js
 */
'use strict';

const assert = require('assert');
const { ConfirmFlow, DECISION } = require('../a2a-bridge-confirm.js');

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const env = (scope = 'write', task = '写文件操作') => ({ scope, task, delegator: 'http://172.28.0.5:3100' });

function makeFlow(opts = {}) {
  const sent = [];
  const audits = [];
  const flow = new ConfirmFlow({
    sendConfirmRequest: async (req) => { sent.push(req); },
    audit: (e) => audits.push(e),
    timeoutMs: opts.timeoutMs || 500,
    now: opts.now,
  });
  return { flow, sent, audits };
}

async function main() {
  console.log('🧪 a2a-bridge-confirm 测试');

  // 1. 批准流
  await test('用户批准 → ok=true', async () => {
    const { flow, sent } = makeFlow();
    const p = flow.confirmL3(env(), { taskId: 't1', sender: { url: 'http://172.28.0.5:3100' } });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(sent.length, 1, '应投递确认请求');
    assert.ok(sent[0].summary.includes('写文件操作'));
    flow.resolve('t1', { approved: true, by: '一澜' });
    const r = await p;
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.by, '一澜');
  });

  // 2. 拒绝流
  await test('用户拒绝 → ok=false declined', async () => {
    const { flow } = makeFlow();
    const p = flow.confirmL3(env(), { taskId: 't2' });
    await new Promise(r => setImmediate(r));
    flow.resolve('t2', { approved: false, by: '一澜' });
    const r = await p;
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.declined, true);
  });

  // 3. 超时=拒绝（阿昭规则）
  await test('超时 → 视为拒绝（不静默执行）', async () => {
    const { flow, audits } = makeFlow({ timeoutMs: 80 });
    const r = await flow.confirmL3(env(), { taskId: 't3' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.timedOut, true);
    assert.ok(/超时/.test(r.detail));
    assert.ok(audits.some(a => a.event === 'timed_out'), '应有超时审计');
  });

  // 4. 同源聚合（不重复投递）
  await test('同源同窗口聚合 → 只投递一次', async () => {
    const { flow, sent, audits } = makeFlow({ timeoutMs: 2000 });
    const p1 = flow.confirmL3(env('write', '任务A'), { taskId: 'a1', sender: { url: 'http://172.28.0.5:3100' } });
    await new Promise(r => setImmediate(r));
    const p2 = flow.confirmL3(env('write', '任务B'), { taskId: 'a2', sender: { url: 'http://172.28.0.5:3100' } });
    await new Promise(r => setImmediate(r));
    assert.strictEqual(sent.length, 1, '同源应聚合，只投一次');
    assert.ok(audits.some(a => a.event === 'aggregated'));
    flow.resolve('a1', { approved: true, by: '一澜' });
    await p1;
    // a2 被聚合，仍等待自身决策
    flow.resolve('a2', { approved: true, by: '一澜' });
    const r2 = await p2;
    assert.strictEqual(r2.ok, true);
  });

  // 5. 幂等：重复确认同 taskId
  await test('幂等：同 taskId 重复确认取首次决策', async () => {
    const { flow } = makeFlow({ timeoutMs: 5000 });
    const p = flow.confirmL3(env(), { taskId: 'i1' });
    await new Promise(r => setImmediate(r));
    flow.resolve('i1', { approved: true, by: '一澜' });
    await p;
    const r2 = await flow.confirmL3(env(), { taskId: 'i1' });
    assert.strictEqual(r2.ok, true);
    assert.strictEqual(r2.by, '一澜');
    const rec = flow.getRecord('i1');
    assert.strictEqual(rec.decision, DECISION.APPROVED);
  });

  // 6. 投递失败 → 拒绝（不静默执行）
  await test('确认请求投递失败 → 拒绝', async () => {
    const flow = new ConfirmFlow({ sendConfirmRequest: async () => { throw new Error('IM 断线'); }, timeoutMs: 500 });
    const r = await flow.confirmL3(env(), { taskId: 'd1' });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.declined, true);
    assert.ok(/投递失败/.test(r.detail));
  });

  // 7. 审计记录完整（批准含 by/latency）
  await test('审计记录：批准含 by 与 latency', async () => {
    const { flow, audits } = makeFlow();
    const p = flow.confirmL3(env(), { taskId: 'au1' });
    await new Promise(r => setImmediate(r));
    flow.resolve('au1', { approved: true, by: '一澜' });
    await p;
    const a = audits.find(x => x.event === 'approved');
    assert.ok(a && a.by === '一澜' && typeof a.latencyMs === 'number');
  });

  // 8. 未知 taskId 答复被忽略
  await test('未知 taskId 答复 → 忽略', async () => {
    const { flow } = makeFlow();
    const r = flow.resolve('ghost', { approved: true });
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.detail, 'unknown taskId');
  });

  // 9. prune 清理已完成记录
  await test('prune 清理已完成记录', async () => {
    let t = 1000;
    const flow = new ConfirmFlow({ sendConfirmRequest: async () => {}, timeoutMs: 50, now: () => t });
    const p = flow.confirmL3(env(), { taskId: 'p1' });
    await p; // 超时完成
    t += 2 * 60 * 60 * 1000; // 2h 后
    const n = flow.prune(60 * 60 * 1000);
    assert.strictEqual(n, 1);
    assert.strictEqual(flow.getRecord('p1'), null);
  });

  console.log(`\n📊 结果: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
