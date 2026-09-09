#!/usr/bin/env node
/**
 * OpenClaw Gateway 注入适配器 · 单元测试（M2 Step 3）
 * 覆盖：消息组装格式 / 请求构造 / 缺配置错误 / 结果匹配（mock http，不真发消息）
 * 风格：手写 assert + console（仓库惯例）
 *
 * 用法: node tests/bridge-adapter.test.js
 */
const assert = require('assert');
const http = require('http');

const adapter = require('../adapters/openclaw-gateway');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}

// ============================================
// mock http.request（捕获请求 + 回放响应）
// ============================================
function mockHttp(responseBody, statusCode = 200) {
  const original = http.request;
  const calls = [];
  http.request = (options, cb) => {
    calls.push(options);
    const mockRes = new (require('stream').Readable)();
    mockRes._read = () => {};
    mockRes.statusCode = statusCode;
    process.nextTick(() => {
      cb(mockRes);
      mockRes.push(typeof responseBody === 'string' ? responseBody : JSON.stringify(responseBody));
      mockRes.push(null);
    });
    return {
      on: () => mockRes, // 错误/超时监听（不触发）
      write: () => {}, end: () => {},
      destroy: () => {},
      setTimeout: () => {},
    };
  };
  return {
    calls,
    restore: () => { http.request = original; },
  };
}

// ============================================
// 测试
// ============================================
console.log('\n[1] 委托消息组装');

test('buildInjectMessage 含 taskId 标记 + 委托四要素 + 拒绝权声明', () => {
  const msg = adapter.buildInjectMessage({
    taskId: 'task-42',
    delegatorLabel: '言蹊 (http://y:3100)',
    envelope: { type: 'execute', scope: 'write', target: '把 X 写入 memory', timeoutMs: 300000 },
  });
  assert.ok(msg.includes('【A2A 桥接委托 #task-42】'));
  assert.ok(msg.includes('言蹊'));
  assert.ok(msg.includes('write'));
  assert.ok(msg.includes('把 X 写入 memory'));
  assert.ok(msg.includes('桥接结果 #task-42'));
  assert.ok(msg.includes('拒绝权在你'));
});

test('无 timeout 用默认表述', () => {
  const msg = adapter.buildInjectMessage({
    taskId: 't1',
    envelope: { type: 'notify', scope: 'read', target: '查状态' },
  });
  assert.ok(msg.includes('30 分钟'));
});

console.log('\n[2] 配置与错误路径');

test('缺 token → 明确报错', async () => {
  const old = process.env.A2A_GATEWAY_TOKEN; delete process.env.A2A_GATEWAY_TOKEN;
  const old2 = process.env.OPENCLAW_GATEWAY_TOKEN; delete process.env.OPENCLAW_GATEWAY_TOKEN;
  try {
    const r = await adapter.inject({ taskId: 't', envelope: {} });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('token'));
  } finally {
    if (old) process.env.A2A_GATEWAY_TOKEN = old;
    if (old2) process.env.OPENCLAW_GATEWAY_TOKEN = old2;
  }
});

test('缺主会话目标 to → 明确报错', async () => {
  const old = process.env.OPENCLAW_GATEWAY_TOKEN; process.env.OPENCLAW_GATEWAY_TOKEN = 'tok';
  const oldTo = process.env.A2A_BRIDGE_MAIN_TO; delete process.env.A2A_BRIDGE_MAIN_TO;
  try {
    const r = await adapter.inject({ taskId: 't', envelope: {} });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('A2A_BRIDGE_MAIN_TO'));
  } finally {
    if (old) process.env.OPENCLAW_GATEWAY_TOKEN = old; else delete process.env.OPENCLAW_GATEWAY_TOKEN;
    if (oldTo) process.env.A2A_BRIDGE_MAIN_TO = oldTo;
  }
});

console.log('\n[3] inject 请求构造（mock http）');

test('inject 正确构造 /tools/invoke message/send 请求', async () => {
  const mock = mockHttp({ ok: true, result: { messageId: 'msg-1' } });
  const old = process.env.OPENCLAW_GATEWAY_TOKEN; process.env.OPENCLAW_GATEWAY_TOKEN = 'tok';
  try {
    const r = await adapter.inject(
      { taskId: 'task-7', delegatorLabel: '星尘 (u)', envelope: { type: 'execute', scope: 'read', target: '查状态', timeoutMs: 60000 } },
      { to: 'ou_test_user' }
    );
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.sent, true);
    assert.strictEqual(r.result.taskId, 'task-7');
    // 请求验证
    const call = mock.calls[0];
    assert.strictEqual(call.path, '/tools/invoke');
    assert.strictEqual(call.method, 'POST');
    assert.ok(call.headers.Authorization.includes('tok'));
  } finally {
    mock.restore();
    if (old) process.env.OPENCLAW_GATEWAY_TOKEN = old; else delete process.env.OPENCLAW_GATEWAY_TOKEN;
  }
});

test('gateway 返回错误 → 透传 error', async () => {
  const mock = mockHttp({ ok: false, error: { type: 'tool_error', message: 'execution failed' } });
  const old = process.env.OPENCLAW_GATEWAY_TOKEN; process.env.OPENCLAW_GATEWAY_TOKEN = 'tok';
  try {
    const r = await adapter.inject({ taskId: 't', envelope: {} }, { to: 'ou_x' });
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes('execution failed'));
  } finally {
    mock.restore();
    if (old) process.env.OPENCLAW_GATEWAY_TOKEN = old; else delete process.env.OPENCLAW_GATEWAY_TOKEN;
  }
});

console.log('\n[4] 结果回收匹配');

test('extractReply 从 read 结果提取匹配 taskId 的回复', () => {
  const raw = {
    messages: [
      { text: '无关消息' },
      { text: '桥接结果 #task-9\n已写入 memory/2026-09-09.md ✅' },
    ],
  };
  const reply = adapter.extractReply(raw, 'task-9');
  assert.ok(reply && reply.includes('已写入'));
});

test('fetchResult 无匹配 → matched=false', async () => {
  const mock = mockHttp({ ok: true, result: { messages: [{ text: '普通闲聊' }] } });
  const old = process.env.OPENCLAW_GATEWAY_TOKEN; process.env.OPENCLAW_GATEWAY_TOKEN = 'tok';
  try {
    const r = await adapter.fetchResult('task-nope', { to: 'ou_x' });
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.matched, false);
  } finally {
    mock.restore();
    if (old) process.env.OPENCLAW_GATEWAY_TOKEN = old; else delete process.env.OPENCLAW_GATEWAY_TOKEN;
  }
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
