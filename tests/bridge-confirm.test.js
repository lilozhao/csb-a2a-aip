#!/usr/bin/env node
/**
 * A2A Bridge Confirm · 单元测试（M2 Step 4）
 * 覆盖：确认消息组装 / 回复解析（确认/拒绝/无关）/ 确认流（批准/拒绝/超时/发送失败）
 * 风格：手写 assert + console（仓库惯例）
 *
 * 用法: node tests/bridge-confirm.test.js
 */
const assert = require('assert');
const confirm = require('../a2a-bridge-confirm');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}

// ============================================
// mock adapter（可控回复队列）
// ============================================
function mkAdapter(replies) {
  // replies: 数组，依次作为 read 结果；'__TIMEOUT__' 表示一直无匹配
  let idx = 0;
  return {
    sendCalls: [],
    inject: async (frame) => { adapter.sendCalls.push(frame); return { ok: true, result: { sent: true } }; },
    fetchResult: async () => {
      const r = replies[Math.min(idx, replies.length - 1)];
      idx++;
      return { ok: true, result: { raw: { messages: r === '__TIMEOUT__' || r === undefined ? [{ text: '无关闲聊' }] : r } } };
    },
  };
}
let adapter;

// ============================================
// 测试
// ============================================
console.log('\n[1] 确认消息组装');

test('buildConfirmMessage 含 taskId 标记 + 委托信息 + 超时声明', () => {
  const msg = confirm.buildConfirmMessage({
    taskId: 'task-5',
    delegatorLabel: '星尘 (http://s:3100)',
    envelope: { type: 'execute', scope: 'write', target: '删除 /tmp/x', timeoutMs: 300000 },
  });
  assert.ok(msg.includes('【A2A 桥接 L3 确认 #task-5】'));
  assert.ok(msg.includes('星尘'));
  assert.ok(msg.includes('删除 /tmp/x'));
  assert.ok(msg.includes('确认 #task-5'));
  assert.ok(msg.includes('自动拒绝'));
});

console.log('\n[2] 回复解析');

test('「确认 #task-5」→ approve', () => {
  assert.strictEqual(confirm.parseConfirmReply('确认 #task-5', 'task-5').decision, 'approve');
});

test('「拒绝 #task-5 内容越权」→ decline + reason', () => {
  const r = confirm.parseConfirmReply('拒绝 #task-5 内容越权了', 'task-5');
  assert.strictEqual(r.decision, 'decline');
  assert.ok(r.reason.includes('越权'));
});

test('无关消息（无 taskId）→ null', () => {
  assert.strictEqual(confirm.parseConfirmReply('今天天气不错', 'task-5').decision, null);
});

test('英文 approve/decline 也识别', () => {
  assert.strictEqual(confirm.parseConfirmReply('approve #task-5', 'task-5').decision, 'approve');
  assert.strictEqual(confirm.parseConfirmReply('decline #task-5', 'task-5').decision, 'decline');
});

console.log('\n[3] confirmL3 确认流');

test('宿主确认 → ok:true', async () => {
  adapter = mkAdapter([[{ text: '确认 #task-c1' }]]);
  const r = await confirm.confirmL3(
    { type: 'execute', scope: 'write', target: '写入文件' },
    { taskId: 'task-c1', sender: { name: '阿轩', url: 'http://a:3100' } },
    { adapter, pollIntervalMs: 1, timeoutMs: 1000 }
  );
  assert.strictEqual(r.ok, true);
  assert.ok(adapter.sendCalls.length >= 1);
  assert.ok(adapter.sendCalls[0].envelope.target.includes('L3 确认'));
});

test('宿主拒绝 → declined + detail', async () => {
  adapter = mkAdapter([[{ text: '拒绝 #task-c2 太危险了' }]]);
  const r = await confirm.confirmL3(
    { type: 'execute', scope: 'shell', target: 'rm -rf' },
    { taskId: 'task-c2', sender: { name: 'x', url: 'u' } },
    { adapter, pollIntervalMs: 1, timeoutMs: 1000 }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.declined, true);
  assert.ok(r.detail.includes('危险'));
});

test('无回复超时 → timedOut（不静默执行）', async () => {
  adapter = mkAdapter(['__TIMEOUT__']);
  const r = await confirm.confirmL3(
    { type: 'execute', scope: 'write', target: 'x' },
    { taskId: 'task-c3', sender: { name: 'x', url: 'u' } },
    { adapter, pollIntervalMs: 5, timeoutMs: 50 }
  );
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.timedOut, true);
  assert.ok(r.detail.includes('超时'));
});

test('发送失败 → declined（确认不可达不执行）', async () => {
  const badAdapter = {
    inject: async () => ({ ok: false, error: 'gateway down' }),
    fetchResult: async () => ({ ok: false, error: 'x' }),
  };
  const r = await confirm.confirmL3(
    { type: 'execute', scope: 'write', target: 'x' },
    { taskId: 'task-c4', sender: { name: 'x', url: 'u' } },
    { adapter: badAdapter, pollIntervalMs: 1, timeoutMs: 100 }
  );
  assert.strictEqual(r.ok, false);
  assert.ok(r.detail.includes('发送失败'));
});

test('多轮后确认（前几轮无关消息）→ ok:true', async () => {
  adapter = mkAdapter([
    [{ text: '在开会' }],
    [{ text: '在开会' }],
    [{ text: '确认 #task-c5' }],
  ]);
  const r = await confirm.confirmL3(
    { type: 'execute', scope: 'write', target: 'x' },
    { taskId: 'task-c5', sender: { name: 'x', url: 'u' } },
    { adapter, pollIntervalMs: 1, timeoutMs: 2000 }
  );
  assert.strictEqual(r.ok, true);
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
