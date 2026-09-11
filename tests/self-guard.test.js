#!/usr/bin/env node
/**
 * A2A 自环调用守卫 · 单元测试
 * 覆盖 a2a-self-guard.js 的三条判定规则 + 配置开关 + 标准 API 集成（拒绝任务形态）
 * 风格：手写 assert + console（仓库惯例，无测试框架）
 *
 * 用法: node tests/self-guard.test.js
 */
const assert = require('assert');
const guard = require('../a2a-self-guard');
const { A2AStandardAPI } = require('../a2a-standard-api-v5');
const { TaskStore, TASK_STATE } = require('../a2a-task-store');

const { isSelfCall, loadConfig, REASON, _resetLocalAddresses } = guard;
const SELF = { name: '若兰', port: 3100 };
const ENV_SAVE = { ...process.env };

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

// 清掉可能影响判定的环境变量，保证默认配置
for (const k of ['A2A_SELF_GUARD', 'A2A_SELF_GUARD_ALLOW_LOCAL', 'A2A_SELF_GUARD_RESPONSE']) delete process.env[k];
_resetLocalAddresses();

console.log('\n[1] R1 — sender 名字就是自己');

test('sender 字符串 = 自己 → 自环', () => {
  const r = isSelfCall({ sender: '若兰', identity: SELF, remoteAddr: '172.28.0.5' });
  assert.strictEqual(r.self, true);
  assert.strictEqual(r.reason, REASON.SENDER_NAME);
  assert.strictEqual(r.detail.rule, 'R1');
});

test('sender 对象 name = 自己 → 自环', () => {
  const r = isSelfCall({ sender: { name: '若兰', url: 'http://172.28.0.214:3100' }, identity: SELF });
  assert.strictEqual(r.self, true);
  assert.strictEqual(r.reason, REASON.SENDER_NAME);
});

test('大小写/空白差异仍判自环', () => {
  const r = isSelfCall({ sender: '  若兰 ', identity: SELF, remoteAddr: '172.28.0.5' });
  assert.strictEqual(r.self, true);
});

test('其他 Agent 名字 → 非自环', () => {
  const r = isSelfCall({ sender: '阿轩', identity: SELF, remoteAddr: '172.28.0.5' });
  assert.strictEqual(r.self, false);
});

console.log('\n[2] R2 — sender URL 指向本机 + 自身端口');

test('http://127.0.0.1:3100 → 自环', () => {
  const r = isSelfCall({ sender: '未知', senderUrl: 'http://127.0.0.1:3100', identity: SELF });
  assert.strictEqual(r.self, true);
  assert.strictEqual(r.reason, REASON.SENDER_URL);
  assert.strictEqual(r.detail.rule, 'R2');
});

test('裸 host:port（无协议）→ 自环', () => {
  const r = isSelfCall({ sender: { name: 'someone' }, senderUrl: 'localhost:3100', identity: SELF });
  assert.strictEqual(r.self, true);
  assert.strictEqual(r.reason, REASON.SENDER_URL);
});

test('本机地址 + 自身端口 → 自环', () => {
  const r = isSelfCall({ senderUrl: 'http://172.28.0.214:3100/a2a/json-rpc', identity: { name: '若兰', port: 3100, host: '172.28.0.214' } });
  assert.strictEqual(r.self, true);
  assert.strictEqual(r.reason, REASON.SENDER_URL);
});

test('同机但端口不同（别的 Agent）→ 非自环', () => {
  const r = isSelfCall({ senderUrl: 'http://127.0.0.1:4100', identity: SELF });
  assert.strictEqual(r.self, false);
});

console.log('\n[3] R3 — 无 sender 信息的裸本机调用');

test('无 sender + 回环来源 → 自环', () => {
  const r = isSelfCall({ identity: SELF, remoteAddr: '127.0.0.1' });
  assert.strictEqual(r.self, true);
  assert.strictEqual(r.reason, REASON.LOOPBACK_NO_SENDER);
  assert.strictEqual(r.detail.rule, 'R3');
});

test('IPv6 映射回环 ::ffff:127.0.0.1 → 自环', () => {
  const r = isSelfCall({ identity: SELF, remoteAddr: '::ffff:127.0.0.1' });
  assert.strictEqual(r.self, true);
});

test('无 sender + 外部来源（其他容器）→ 非自环', () => {
  const r = isSelfCall({ identity: SELF, remoteAddr: '172.28.0.5' });
  assert.strictEqual(r.self, false);
});

console.log('\n[4] 配置开关');

test('A2A_SELF_GUARD=false → 全部放行', () => {
  const cfg = loadConfig({ A2A_SELF_GUARD: 'false' });
  const r = isSelfCall({ sender: '若兰', identity: SELF, remoteAddr: '127.0.0.1', config: cfg });
  assert.strictEqual(cfg.enabled, false);
  assert.strictEqual(r.self, false);
});

test('A2A_SELF_GUARD_ALLOW_LOCAL=true → R3 放行，R1/R2 仍拦', () => {
  const cfg = loadConfig({ A2A_SELF_GUARD_ALLOW_LOCAL: 'true' });
  assert.strictEqual(isSelfCall({ identity: SELF, remoteAddr: '127.0.0.1', config: cfg }).self, false);
  assert.strictEqual(isSelfCall({ sender: '若兰', config: cfg, identity: SELF }).self, true);
  assert.strictEqual(isSelfCall({ senderUrl: 'http://127.0.0.1:3100', config: cfg, identity: SELF }).self, true);
});

test('自定义拒绝文本生效', () => {
  const cfg = loadConfig({ A2A_SELF_GUARD_RESPONSE: 'LOOP_HERE' });
  assert.strictEqual(cfg.responseText, 'LOOP_HERE');
});

console.log('\n[5] 集成 — A2AStandardAPI 快速拒绝');

function makeApi(envOverrides = {}) {
  Object.assign(process.env, envOverrides);
  const api = new A2AStandardAPI({ identity: SELF, taskStore: new TaskStore(), selfGuardConfig: loadConfig(process.env) });
  return api;
}

test('_checkSelfMessage：裸回环调用识别为自环', () => {
  const api = makeApi();
  const r = api._checkSelfMessage({ message: { role: 'user', parts: [{ text: 'hi' }] } }, { socket: { remoteAddress: '::ffff:127.0.0.1' }, headers: {} });
  assert.strictEqual(r.self, true);
  assert.strictEqual(r.reason, REASON.LOOPBACK_NO_SENDER);
});

test('_buildSelfRejectedTask：终态 REJECTED + SELF_MESSAGE_IGNORED', () => {
  const api = makeApi();
  const res = api._buildSelfRejectedTask(
    { message: { role: 'user', messageId: 'm1', parts: [{ text: '自己发给自己' }] } },
    { self: true, reason: REASON.SENDER_NAME, detail: { rule: 'R1' } },
  );
  assert.ok(res.task && res.task.id, '应返回 task');
  assert.strictEqual(res.task.status.state, TASK_STATE.REJECTED);
  assert.strictEqual(res.task.status.message, 'SELF_MESSAGE_IGNORED');
  assert.strictEqual(res.task.metadata.selfGuard.reason, 'sender_name');
  const texts = (res.task.artifacts || []).flatMap(a => (a.parts || []).map(p => p.text));
  assert.ok(texts.includes('SELF_MESSAGE_IGNORED'));
  // 不写主记忆：不产生 LLM 回复走位
  const histTexts = (res.task.history || []).map(h => h.parts?.[0]?.text).filter(Boolean);
  assert.ok(histTexts.includes('SELF_MESSAGE_IGNORED'));
});

test('外部正常调用不被误伤', () => {
  const api = makeApi();
  const r = api._checkSelfMessage(
    { sender: '阿轩', message: { role: 'user', parts: [{ text: 'hi' }] } },
    { socket: { remoteAddress: '172.28.0.5' }, headers: {} },
  );
  assert.strictEqual(r.self, false);
});

test('守卫内部异常时放行（诚实不误伤）', () => {
  const api = makeApi();
  api.selfGuardConfig = null; // 触发兜底加载路径
  const r = api._checkSelfMessage(null, null);
  assert.strictEqual(r.self, false);
});

console.log('\n[6] 拒绝路径不挂起（耗时 < 50ms）');

test('自环判定为纯同步计算，无网络等待', () => {
  const t0 = Date.now();
  for (let i = 0; i < 200; i++) isSelfCall({ identity: SELF, remoteAddr: '127.0.0.1' });
  const dt = Date.now() - t0;
  assert.ok(dt < 50, `200 次判定耗时 ${dt}ms，应远小于 50ms`);
});

// 还原环境
process.env = ENV_SAVE;

console.log(`\n${'='.repeat(46)}`);
console.log(`  通过 ${passed} / ${passed + failed}`);
console.log(`${'='.repeat(46)}\n`);
process.exit(failed > 0 ? 1 : 0);
