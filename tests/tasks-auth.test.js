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
t('172.28.0.214 是内网（Agent 段）', () => assert(api._isInternalIp('172.28.0.214')));
t('172.28.0.2 是内网（Agent 段下界）', () => assert(api._isInternalIp('172.28.0.2')));
t('172.28.0.5 是内网（Agent 段）', () => assert(api._isInternalIp('172.28.0.5')));
t('172.28.0.1 不是内网（网关=宿主机入口，要 token）', () => assert(!api._isInternalIp('172.28.0.1')));
t('::ffff:172.28.0.1 不是内网（网关）', () => assert(!api._isInternalIp('::ffff:172.28.0.1')));
t('::ffff:172.28.0.5 是内网', () => assert(api._isInternalIp('::ffff:172.28.0.5')));
t('公网 8.8.8.8 不是内网', () => assert(!api._isInternalIp('8.8.8.8')));
t('空 IP 不是内网', () => assert(!api._isInternalIp('')));

// ── 2026-11-09 W-51 事故：环回经隧道/反代伪装成内网 ─────────────────
// 注意：复用文件上方的 mkReq(ip, authHeader)。这里传 headers 对象时用 mkReqH。
function mkReqH(ip, headers) {
  return { socket: { remoteAddress: ip }, headers: headers || {} };
}
t('环回 + 无转发头 → 视为真本机（不算 proxied）', () => {
  assert.strictEqual(api._isLoopbackViaProxy(mkReqH('127.0.0.1', {})), false);
});
t('环回 + X-Forwarded-For → 判为经转发（不再享受内网豁免）', () => {
  assert.strictEqual(api._isLoopbackViaProxy(mkReqH('127.0.0.1', { 'x-forwarded-for': '47.121.28.125' })), true);
});
t('环回 + X-Real-IP → 判为经转发', () => {
  assert.strictEqual(api._isLoopbackViaProxy(mkReqH('127.0.0.1', { 'x-real-ip': '1.2.3.4' })), true);
});
t('环回 + Via → 判为经转发', () => {
  assert.strictEqual(api._isLoopbackViaProxy(mkReqH('127.0.0.1', { via: '1.1 squid' })), true);
});
t('非环回（内网 Agent 段）+ 转发头 → 不算 proxiedLoopback（仍按内网放行）', () => {
  assert.strictEqual(api._isLoopbackViaProxy(mkReqH('172.28.0.5', { 'x-forwarded-for': '1.2.3.4' })), false);
});
t('空转发头不算（x-forwarded-for 为空串）', () => {
  assert.strictEqual(api._isLoopbackViaProxy(mkReqH('127.0.0.1', { 'x-forwarded-for': '' })), false);
});


// 2) 内网免鉴权
process.env.A2A_TASKS_TOKEN = 'secret-token-xyz';
const api1 = mkApi();
t('[方案B] 内网 IP 无 token → 401（取消内网豁免）', () => {
  const res = mkRes();
  assert.strictEqual(api1._checkTasksAuth(mkReq('172.28.0.99', null), res), false);
  assert.strictEqual(res._status, 401);
});
t('[方案B] 内网 IP + 正确 token → 放行', () => {
  const res = mkRes();
  assert.strictEqual(api1._checkTasksAuth(mkReq('172.28.0.99', 'Bearer secret-token-xyz'), res), true);
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

t('★ 环回+XFF+无 token → 401（7102 泄漏事故的回归锁）', () => {
  const res = mkRes();
  const got = api1._checkTasksAuth(mkReqH('127.0.0.1', { 'x-forwarded-for': '47.121.28.125' }), res);
  assert.strictEqual(got, false, '必须拒绝——否则公网经隧道可读全量对话历史');
  assert.strictEqual(res._status, 401);
  assert.ok(/转发|Bearer/.test(res._json?.next_step || ''), '拒绝必须带可执行的 next_step');
});
t('★ [方案B] 环回+无转发头+无 token → 401（隧道与真本机不可区分，一律要 token）', () => {
  const res = mkRes();
  assert.strictEqual(api1._checkTasksAuth(mkReqH('127.0.0.1', {}), res), false);
  assert.strictEqual(res._status, 401);
});
t('★ [方案B] A2A_TASKS_ALLOW_LOCAL=1 时，纯本机环回才免 token', () => {
  process.env.A2A_TASKS_ALLOW_LOCAL = '1';
  try {
    const res = mkRes();
    assert.strictEqual(api1._checkTasksAuth(mkReqH('127.0.0.1', {}), res), true);
    // 但带转发头的仍要拒
    const res2 = mkRes();
    assert.strictEqual(api1._checkTasksAuth(mkReqH('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' }), res2), false);
  } finally {
    delete process.env.A2A_TASKS_ALLOW_LOCAL;
  }
});
t('★ 环回+XFF+正确 token → 放行（合法外部带令牌要能用）', () => {
  const res = mkRes();
  assert.strictEqual(
    api1._checkTasksAuth(mkReqH('127.0.0.1', { 'x-forwarded-for': '47.121.28.125', authorization: 'Bearer secret-token-xyz' }), res),
    true
  );
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
t('[方案B] 未配密钥时内网也拒（fail-safe 一视同仁）', () => {
  const api2 = mkApi();
  const res = mkRes();
  assert.strictEqual(api2._checkTasksAuth(mkReq('172.28.0.7', null), res), false);
  assert.strictEqual(res._status, 401);
});

// 7) 回退链：A2A_TASKS_TOKEN 优先，回退 A2A_GATEWAY_TOKEN
t('回退 A2A_GATEWAY_TOKEN', () => {
  delete process.env.A2A_TASKS_TOKEN;
  process.env.A2A_GATEWAY_TOKEN = 'gw-token';
  const api3 = mkApi();
  const res = mkRes();
  assert.strictEqual(api3._checkTasksAuth(mkReq('8.8.8.8', 'Bearer gw-token'), res), true);
});

// 端到端反证：隧道进来的环回请求，即使"看起来是内网"，也必须 401
// 清理
delete process.env.A2A_TASKS_TOKEN;
delete process.env.A2A_GATEWAY_TOKEN;

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);
