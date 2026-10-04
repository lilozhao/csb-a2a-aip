#!/usr/bin/env node
/**
 * /tasks 鉴权单测（2026-10-04 · 方案 A：内网免 + 外部 bearer）
 * 验证 A2AStandardAPI._checkTasksAuth / _isInternalIp 行为。
 */
const assert = require('assert');
const { A2AStandardAPI } = require('../a2a-standard-api-v5.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅', name); pass++; }
  catch (e) { console.log('  ❌', name, '→', e.message); fail++; }
}

function mkApi() { return new A2AStandardAPI({ identity: { name: 'test', port: 9999 } }); }

// 伪 req/res
function mkReq(ip, authHeader) {
  return { socket: { remoteAddress: ip }, headers: authHeader ? { authorization: authHeader } : {} };
}
function mkRes() {
  const res = { _status: 200, _json: null };
  res.status = (s) => { res._status = s; return res; };
  res.json = (j) => { res._json = j; return res; };
  return res;
}

console.log('/tasks 鉴权单测');

// 1) _isInternalIp：内网地址识别
const api = mkApi();
t('127.0.0.1 是内网', () => assert(api._isInternalIp('127.0.0.1')));
t('::1 是内网', () => assert(api._isInternalIp('::1')));
t('172.28.0.214 是内网（Docker 段）', () => assert(api._isInternalIp('172.28.0.214')));
t('::ffff:172.28.0.5 是内网', () => assert(api._isInternalIp('::ffff:172.28.0.5')));
t('公网 8.8.8.8 不是内网', () => assert(!api._isInternalIp('8.8.8.8')));
t('空 IP 不是内网', () => assert(!api._isInternalIp('')));

// 2) 内网免鉴权
process.env.A2A_TASKS_TOKEN = 'secret-token-xyz';
const api1 = mkApi();
t('内网 IP 免鉴权放行', () => {
  const res = mkRes();
  assert.strictEqual(api1._checkTasksAuth(mkReq('172.28.0.99', null), res), true);
  assert.strictEqual(res._status, 200);
});

// 3) 外部无 token → 401
t('外部无 bearer → 401', () => {
  const res = mkRes();
  assert.strictEqual(api1._checkTasksAuth(mkReq('8.8.8.8', null), res), false);
  assert.strictEqual(res._status, 401);
});

// 4) 外部错 token → 401
t('外部错 bearer → 401', () => {
  const res = mkRes();
  assert.strictEqual(api1._checkTasksAuth(mkReq('8.8.8.8', 'Bearer wrong'), res), false);
  assert.strictEqual(res._status, 401);
});

// 5) 外部对 token → 放行
t('外部正确 bearer → 放行', () => {
  const res = mkRes();
  assert.strictEqual(api1._checkTasksAuth(mkReq('8.8.8.8', 'Bearer secret-token-xyz'), res), true);
});

// 6) 未配密钥：外部 fail-safe 拒绝（不静默放行）
t('未配密钥时外部 → 401（fail-safe）', () => {
  delete process.env.A2A_TASKS_TOKEN;
  delete process.env.A2A_GATEWAY_TOKEN;
  const api2 = mkApi();
  const res = mkRes();
  assert.strictEqual(api2._checkTasksAuth(mkReq('8.8.8.8', 'Bearer anything'), res), false);
  assert.strictEqual(res._status, 401);
});
// 未配密钥：内网仍放行
t('未配密钥时内网仍放行', () => {
  const api2 = mkApi();
  const res = mkRes();
  assert.strictEqual(api2._checkTasksAuth(mkReq('172.28.0.7', null), res), true);
});

// 7) 回退链：A2A_TASKS_TOKEN 优先，回退 A2A_GATEWAY_TOKEN
t('回退 A2A_GATEWAY_TOKEN', () => {
  delete process.env.A2A_TASKS_TOKEN;
  process.env.A2A_GATEWAY_TOKEN = 'gw-token';
  const api3 = mkApi();
  const res = mkRes();
  assert.strictEqual(api3._checkTasksAuth(mkReq('8.8.8.8', 'Bearer gw-token'), res), true);
});

// 清理
delete process.env.A2A_TASKS_TOKEN;
delete process.env.A2A_GATEWAY_TOKEN;

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
