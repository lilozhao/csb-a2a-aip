#!/usr/bin/env node
/**
 * [W-10 / 2026-09-21] TaskStore 启动对账（孤儿回收）测试
 *
 * 背景：任务在途状态（submitted/working）只活在进程内存里；进程在途死亡后，
 *       持久化文件被原样加载 → 孤儿永久 WORKING（小虾 09-14 那 5 条即此机制）。
 *
 * 本测试钉死六条行为：
 *   [1] 孤儿回收：SUBMITTED/WORKING 残留 → 新 store 加载后置 FAILED/orphaned_by_restart
 *   [2] 回收留痕：补一条 agent 侧 history 说明原因（可追溯）
 *   [3] 终态不动：COMPLETED/FAILED/CANCELED/REJECTED 原样保留
 *   [4] 等待类不动：INPUT_REQUIRED / AUTH_REQUIRED 跨重启保留（语义上就是等外部输入）
 *   [5] 可关闭：reconcileOrphans:false → 不回收
 *   [6] 宽限生效：orphanGraceMs 大于实际年龄 → 不回收
 *   +  回写可观测：terminalWriteError 计数 + 不抛出
 *
 * 风格：手写 assert + console（仓库惯例，无测试框架）
 * 用法: node tests/task-store-reconcile.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { TaskStore, TASK_STATE } = require('../a2a-task-store.js');
const correlator = require('../a2a-bridge-correlator.js');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

let seq = 0;
function tmpPath() { return path.join(os.tmpdir(), `a2a-reconcile-${process.pid}-${seq++}.json`); }

/** 造一个持久化文件：把给定 (state) 的任务写进去（模拟重启前的现场） */
function seed(states) {
  const p = tmpPath();
  const store = new TaskStore({ persistencePath: p, reconcileOrphans: false });
  const ids = [];
  for (const [state, msg] of states) {
    const t = store.createTask({});
    store.addHistory(t.id, { role: 'user', parts: [{ text: `in:${state}` }] });
    if (state !== 'TASK_STATE_SUBMITTED') store.updateTaskStatus(t.id, state, msg || 'seed');
    ids.push(t.id);
  }
  store.flushSync();
  return { p, ids };
}

console.log('TaskStore 启动对账（W-10）');

// [1] + [2] 孤儿回收 + 留痕
test('[1] SUBMITTED/WORKING 残留 → 回收为 FAILED/orphaned_by_restart', () => {
  const { p, ids } = seed([['TASK_STATE_WORKING'], ['TASK_STATE_SUBMITTED']]);
  const s = new TaskStore({ persistencePath: p });
  assert.strictEqual(s.orphansReconciled, 2, `应回收 2 条，实际 ${s.orphansReconciled}`);
  for (const id of ids) {
    const t = s.getTask(id);
    assert.strictEqual(t.status.state, TASK_STATE.FAILED);
    assert.strictEqual(t.status.message, 'orphaned_by_restart');
  }
  fs.unlinkSync(p);
});

test('[2] 回收留痕：补一条 agent 侧 history（含 orphaned_by_restart）', () => {
  const { p, ids } = seed([['TASK_STATE_WORKING']]);
  const s = new TaskStore({ persistencePath: p });
  const t = s.getTask(ids[0]);
  const last = t.history[t.history.length - 1];
  assert.strictEqual(last.role, 'ROLE_AGENT');
  assert.ok(/orphaned_by_restart/.test(last.parts[0].text), 'history 应写明原因');
  fs.unlinkSync(p);
});

// [3] 终态不动
test('[3] 终态任务原样保留', () => {
  const { p, ids } = seed([
    ['TASK_STATE_COMPLETED'], ['TASK_STATE_FAILED'], ['TASK_STATE_CANCELED'], ['TASK_STATE_REJECTED'],
  ]);
  const s = new TaskStore({ persistencePath: p });
  assert.strictEqual(s.orphansReconciled, 0, '不应回收终态');
  const states = ids.map((id) => s.getTask(id).status.state);
  assert.deepStrictEqual(states, [
    TASK_STATE.COMPLETED, TASK_STATE.FAILED, TASK_STATE.CANCELED, TASK_STATE.REJECTED,
  ]);
  fs.unlinkSync(p);
});

// [4] 等待类不动
test('[4] INPUT_REQUIRED / AUTH_REQUIRED 跨重启保留', () => {
  const { p, ids } = seed([['TASK_STATE_INPUT_REQUIRED'], ['TASK_STATE_AUTH_REQUIRED']]);
  const s = new TaskStore({ persistencePath: p });
  assert.strictEqual(s.orphansReconciled, 0, '等待类不得回收');
  assert.strictEqual(s.getTask(ids[0]).status.state, TASK_STATE.INPUT_REQUIRED);
  assert.strictEqual(s.getTask(ids[1]).status.state, TASK_STATE.AUTH_REQUIRED);
  fs.unlinkSync(p);
});

// [5] 可关闭
test('[5] reconcileOrphans:false → 不回收', () => {
  const { p, ids } = seed([['TASK_STATE_WORKING']]);
  const s = new TaskStore({ persistencePath: p, reconcileOrphans: false });
  assert.strictEqual(s.orphansReconciled, 0);
  assert.strictEqual(s.getTask(ids[0]).status.state, TASK_STATE.WORKING);
  fs.unlinkSync(p);
});

// [6] 宽限
test('[6] orphanGraceMs 大于实际年龄 → 不回收', () => {
  const { p, ids } = seed([['TASK_STATE_WORKING']]);
  const s = new TaskStore({ persistencePath: p, orphanGraceMs: 60 * 60 * 1000 });
  assert.strictEqual(s.orphansReconciled, 0, '未过宽限期不应回收');
  assert.strictEqual(s.getTask(ids[0]).status.state, TASK_STATE.WORKING);
  fs.unlinkSync(p);
});

// + 回写可观测（② 静默吞错 → 记日志+计数）
test('[+] terminalWriteError 计数且不抛出', () => {
  const before = correlator.getTerminalWriteFailures();
  const handler = correlator.terminalWriteError('task_x', 'completed');
  assert.doesNotThrow(() => handler(new Error('store down')));
  assert.strictEqual(correlator.getTerminalWriteFailures(), before + 1);
});

console.log(`\n结果：${passed} 通过 / ${failed} 失败`);
process.exit(failed === 0 ? 0 : 1);
