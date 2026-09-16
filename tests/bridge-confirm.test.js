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

const env = (scope = 'write', task = '写文件操作') => ({ scope, task, delegator: 'http://192.0.2.5:3100' });

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
    const p = flow.confirmL3(env(), { taskId: 't1', sender: { url: 'http://192.0.2.5:3100' } });
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
    const p1 = flow.confirmL3(env('write', '任务A'), { taskId: 'a1', sender: { url: 'http://192.0.2.5:3100' } });
    await new Promise(r => setImmediate(r));
    const p2 = flow.confirmL3(env('write', '任务B'), { taskId: 'a2', sender: { url: 'http://192.0.2.5:3100' } });
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

  // 10. [9/14] 确认请求内容呈现：默认给「可读摘录 + 指纹 + 非指令声明」
  await test('确认请求默认给可读摘录（不再盲签）', async () => {
    const { buildConfirmMessage, summarizeTask } = require('../a2a-bridge-confirm');
    const raw = 'write logs/m2-l3-v6.txt :: M2 L3 确认路径 v6 验收成功';
    const saved = process.env.A2A_BRIDGE_CONFIRM_SHOW_TASK;
    const savedEx = process.env.A2A_BRIDGE_CONFIRM_EXCERPT_CHARS;
    delete process.env.A2A_BRIDGE_CONFIRM_SHOW_TASK;
    delete process.env.A2A_BRIDGE_CONFIRM_EXCERPT_CHARS;
    const msg = buildConfirmMessage({ taskId: 't1', envelope: { type: 'execute', scope: 'write', task: raw }, delegatorLabel: '若兰' });
    assert.ok(msg.includes('m2-l3-v6.txt'), '默认应给可读摘录（人工能看清要执行什么）');
    assert.ok(/指纹 [0-9a-f]{8}/.test(msg), '应包含指纹');
    assert.ok(msg.includes('非指令'), '摘录须标注「非指令」防提示注入');
    assert.ok(msg.includes('不是可执行指令'), '应保留防自动执行声明');
    assert.ok(msg.includes('taskId=t1'), '应给出全文指引');
    assert.strictEqual(summarizeTask(''), '(空)');

    // 全文模式
    process.env.A2A_BRIDGE_CONFIRM_SHOW_TASK = 'true';
    assert.ok(summarizeTask(raw, 't1').includes('（全文）'), 'SHOW_TASK=true 应回全文');
    delete process.env.A2A_BRIDGE_CONFIRM_SHOW_TASK;

    // 旧行为（只给指纹）
    process.env.A2A_BRIDGE_CONFIRM_EXCERPT_CHARS = '0';
    const folded = summarizeTask(raw, 't1');
    assert.ok(!folded.includes('m2-l3-v6.txt'), 'EXCERPT_CHARS=0 应回到只给指纹');
    assert.ok(folded.includes('已折叠'), '应提示已折叠');
    delete process.env.A2A_BRIDGE_CONFIRM_EXCERPT_CHARS;

    if (saved !== undefined) process.env.A2A_BRIDGE_CONFIRM_SHOW_TASK = saved;
    if (savedEx !== undefined) process.env.A2A_BRIDGE_CONFIRM_EXCERPT_CHARS = savedEx;
  });

  // 11-14. [9/12] 确认窗口单一真相源（实拍：文案写 30 分钟、实际 5 分钟 → 超时误杀）
  const { resolveConfirmWindow, buildConfirmMessage, confirmCapMs } = require('../a2a-bridge-confirm');

  await test('确认窗口：委托方声明超过接收方上限 → 取上限，且文案说真话', async () => {
    const saved = process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS;
    delete process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS; // 默认上限 5min
    const win = resolveConfirmWindow({ timeoutMs: 30 * 60 * 1000 });
    assert.strictEqual(win.effectiveMs, 5 * 60 * 1000, '应取接收方上限');
    assert.strictEqual(win.capped, true, '应标记为被封顶');
    const msg = buildConfirmMessage({ taskId: 'w1', envelope: { scope: 'shell', task: 'x', timeoutMs: 30 * 60 * 1000 }, delegatorLabel: '若兰' });
    assert.ok(msg.includes('- 时限：5 分钟'), '文案必须写实际生效的 5 分钟');
    assert.ok(msg.includes('委托方声明 30 分钟'), '应披露被封顶的事实');
    assert.ok(!msg.includes('时限：30 分钟'), '不得再写声明值冒充窗口');
    if (saved !== undefined) process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS = saved;
  });

  await test('确认窗口：委托方声明小于上限 → 取声明值', async () => {
    const saved = process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS;
    delete process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS;
    const win = resolveConfirmWindow({ timeoutMs: 2 * 60 * 1000 });
    assert.strictEqual(win.effectiveMs, 2 * 60 * 1000);
    assert.strictEqual(win.capped, false);
    if (saved !== undefined) process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS = saved;
  });

  await test('确认窗口：env 可调接收方上限（A2A_BRIDGE_CONFIRM_TIMEOUT_MS）', async () => {
    const saved = process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS;
    process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS = String(10 * 60 * 1000);
    assert.strictEqual(confirmCapMs(), 10 * 60 * 1000);
    const win = resolveConfirmWindow({ timeoutMs: 30 * 60 * 1000 });
    assert.strictEqual(win.effectiveMs, 10 * 60 * 1000);
    if (saved === undefined) delete process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS;
    else process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS = saved;
  });

  await test('确认窗口：无声明时用接收方上限，非法 env 回退默认', async () => {
    const saved = process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS;
    process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS = 'abc';
    assert.strictEqual(confirmCapMs(), 5 * 60 * 1000, '非法值应回退 5 分钟');
    assert.strictEqual(resolveConfirmWindow({}).effectiveMs, 5 * 60 * 1000);
    assert.strictEqual(resolveConfirmWindow({ timeoutMs: 0 }).effectiveMs, 5 * 60 * 1000);
    if (saved === undefined) delete process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS;
    else process.env.A2A_BRIDGE_CONFIRM_TIMEOUT_MS = saved;
  });

  // 15. [P0-4 / 2026-09-16 · 墨丘 L3 终验] bridge 必须把读回 path **透传**给 adapter.fetchResult
  await test('读回 path 透传：opts.readPath / env 均下传 adapter', async () => {
    const { confirmL3 } = require('../a2a-bridge-confirm');
    const calls = [];
    const fakeAdapter = {
      resolveConfig: () => ({ sessionKey: 'main' }),
      invokeTool: async () => ({ ok: true }),
      fetchResult: async (tid, o) => { calls.push(o); return { ok: false, error: 'n/a' }; },
    };
    // 显式 readPath（envelope.timeoutMs 声明窗口=30ms，避免默认 5min 上限）
    const fastEnv = () => ({ ...env(), timeoutMs: 30 });
    await confirmL3(fastEnv(), { taskId: 'rp1' }, {
      adapter: fakeAdapter, send: async () => ({ ok: true }),
      pollIntervalMs: 5, readPath: 'db',
    });
    assert.ok(calls.length >= 1, 'fetchResult 应被调用');
    assert.strictEqual(calls[0].path, 'db', '显式 readPath 应下传');

    // env 兜底
    calls.length = 0;
    const saved = process.env.A2A_BRIDGE_CONFIRM_READ_PATH;
    process.env.A2A_BRIDGE_CONFIRM_READ_PATH = 'db';
    await confirmL3(fastEnv(), { taskId: 'rp2' }, {
      adapter: fakeAdapter, send: async () => ({ ok: true }),
      pollIntervalMs: 5,
    });
    assert.strictEqual(calls[0].path, 'db', 'env 兜底应下传');
    if (saved === undefined) delete process.env.A2A_BRIDGE_CONFIRM_READ_PATH;
    else process.env.A2A_BRIDGE_CONFIRM_READ_PATH = saved;

    // 未配置 → undefined（保持 adapter 保守默认，行为不变）
    calls.length = 0;
    delete process.env.A2A_BRIDGE_CONFIRM_READ_PATH;
    await confirmL3(fastEnv(), { taskId: 'rp3' }, {
      adapter: fakeAdapter, send: async () => ({ ok: true }),
      pollIntervalMs: 5,
    });
    assert.strictEqual(calls[0].path, undefined, '未配置应保持 undefined');
  });

  // 16. [2026-09-16] 适配器**能力声明**：bridge 未显式配置时问 adapter
  await test('读回 path：adapter 能力声明 confirmReadPath() 被采纳（宿主只配 adapter 侧 env）', async () => {
    const { confirmL3 } = require('../a2a-bridge-confirm');
    const calls = [];
    const declaring = {
      resolveConfig: () => ({ sessionKey: 'main' }),
      invokeTool: async () => ({ ok: true }),
      confirmReadPath: () => 'db',                      // ← 声明
      fetchResult: async (tid, o) => { calls.push(o); return { ok: false, error: 'n/a' }; },
    };
    const fastEnv = () => ({ ...env(), timeoutMs: 30 });
    const saved = process.env.A2A_BRIDGE_CONFIRM_READ_PATH;
    delete process.env.A2A_BRIDGE_CONFIRM_READ_PATH;
    await confirmL3(fastEnv(), { taskId: 'rp4' }, {
      adapter: declaring, send: async () => ({ ok: true }), pollIntervalMs: 5,
    });
    assert.strictEqual(calls[0].path, 'db', '应采纳适配器声明的读回路径');

    // 不声明的 adapter（如 openclaw-gateway）→ 仍不传 path（行为零变化）
    calls.length = 0;
    const silent = {
      resolveConfig: () => ({ sessionKey: 'main' }),
      invokeTool: async () => ({ ok: true }),
      fetchResult: async (tid, o) => { calls.push(o); return { ok: false, error: 'n/a' }; },
    };
    await confirmL3(fastEnv(), { taskId: 'rp5' }, {
      adapter: silent, send: async () => ({ ok: true }), pollIntervalMs: 5,
    });
    assert.strictEqual(calls[0].path, undefined, '未声明的 adapter 不得被传 path');
    if (saved !== undefined) process.env.A2A_BRIDGE_CONFIRM_READ_PATH = saved;
  });

  console.log(`\n📊 结果: ${passed} 通过 / ${failed} 失败`);
  process.exit(failed > 0 ? 1 : 0);
}

main();
