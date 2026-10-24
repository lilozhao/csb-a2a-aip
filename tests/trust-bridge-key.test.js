#!/usr/bin/env node
/**
 * tests/trust-bridge-key.test.js —— 握手信任：存进去的键必须查得到
 *
 * 背景（2026-10-24 · P0）：
 *   registerHandshakeSession 用 caller_id（mingde@host:3100）作键，
 *   resolveTrustLevel 用 senderName（明德）查 —— 两个命名空间，永远查不到。
 *   生产环境里这条信任路径**从未命中过一次**。
 *
 *   更深的坑：name 是攻击者可控字段。只按名字匹配，伪造者填个「明德」就能拿信任。
 *   所以正确解不是「把键改一致」，而是**按 host 锚定**。
 *
 * 用法: node tests/trust-bridge-key.test.js
 */
'use strict';

const assert = require('assert');
const { TrustBridge, _internals } = require('../a2a-trust-bridge.js');
const { stripEmoji, hostFromAgentId, hostFromUrl, localPart } = _internals;

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const MINGDE_ID = 'mingde@csbc.lilozkzy.top:3100';
const mkSession = (over = {}) => ({
  caller_id: MINGDE_ID,
  callee_id: 'ruolan@172.28.0.214:3100',
  scopes_granted: ['a2a:send'],
  security_level: 1,
  ttl: 300,
  session_id: 'sess-test-1',
  ...over,
});

console.log('=== 握手信任桥接测试 ===\n');

// ── 工具函数 ──
test('hostFromAgentId: 从 agent id 取 host:port', () => {
  assert.strictEqual(hostFromAgentId(MINGDE_ID), 'csbc.lilozkzy.top:3100');
  assert.strictEqual(hostFromAgentId('无at'), '');
});

test('hostFromUrl: 从 URL 取 host:port（含路径）', () => {
  assert.strictEqual(hostFromUrl('http://csbc.lilozkzy.top:3100/a2a/json-rpc'), 'csbc.lilozkzy.top:3100');
  assert.strictEqual(hostFromUrl('https://h.example:443'), 'h.example:443');
});

test('stripEmoji / localPart', () => {
  assert.strictEqual(stripEmoji('明德 🎋'), '明德');
  assert.strictEqual(localPart(MINGDE_ID), 'mingde');
});

// ── 核心回归：旧 bug（按名字查不到）──
test('★ 回归：注册后按完整 caller_id 查得到', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession());
  const r = tb.resolveTrustLevel(MINGDE_ID);
  assert.ok(r, '按 caller_id 必须命中');
  assert.strictEqual(r.trustLevel, 1);
  assert.strictEqual(r.matchedBy, 'senderName:id');
});

test('★ 按 sender.url 的 host 查得到（强匹配，主路径）', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession());
  const r = tb.resolveTrustLevel('随便什么名字', {
    sender: { name: '随便什么名字', url: 'http://csbc.lilozkzy.top:3100/a2a/json-rpc' },
  });
  assert.ok(r, 'host 匹配必须命中');
  assert.strictEqual(r.source, 'handshake');
  assert.strictEqual(r.matchedBy, 'sender.url');
  assert.deepStrictEqual(r.scopes, ['a2a:send']);
});

test('★ 按 sender.id 的 host 查得到', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession());
  const r = tb.resolveTrustLevel('x', { sender: { id: MINGDE_ID } });
  assert.ok(r);
  assert.strictEqual(r.matchedBy, 'sender.id');
});

// ── 安全：仅凭名字不给信任 ──
test('🛡️ 仅凭名字（无 url/id）**不授予**信任', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession(), { names: ['明德'] });
  const r = tb.resolveTrustLevel('明德', {});
  assert.strictEqual(r, null, 'name 可伪造，不能只凭名字给信任');
});

test('🛡️ 伪造者填「明德」但没有 url → 拿不到信任', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession(), { names: ['明德'] });
  const r = tb.resolveTrustLevel('明德🌸', { sender: { name: '明德🌸' } });
  assert.strictEqual(r, null);
});

test('allowNameOnly=true 时才允许按名字（调试用，且标 weak）', () => {
  const tb = new TrustBridge({ allowNameOnly: true });
  tb.registerHandshakeSession(mkSession(), { names: ['明德'] });
  const r = tb.resolveTrustLevel('明德', {});
  assert.ok(r);
  assert.strictEqual(r.matchedBy, 'name(weak)');
});

// ── host 不同，同名不串 ──
test('🛡️ 不同主机的同名 agent 不会互相冒用', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession()); // csbc.lilozkzy.top
  const r = tb.resolveTrustLevel('mingde', {
    sender: { id: 'mingde@evil.example:3100' },
  });
  assert.strictEqual(r, null, '主机不匹配就不该命中');
});

// ── TTL ──
test('会话过期后查不到，且别名一并清除', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession({ ttl: 0 }));
  const r = tb.resolveTrustLevel(MINGDE_ID);
  assert.strictEqual(r, null, 'ttl=0 应立即过期');
  assert.strictEqual(tb.aliases.size, 0, '孤儿别名必须清掉');
});

test('过期后该 host 也不再命中', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession({ ttl: 0 }));
  const r = tb.resolveTrustLevel('x', { sender: { url: 'http://csbc.lilozkzy.top:3100/a2a/json-rpc' } });
  assert.strictEqual(r, null);
});

// ── 无会话 ──
test('没有任何会话时返回 null（不抛异常）', () => {
  const tb = new TrustBridge();
  assert.strictEqual(tb.resolveTrustLevel('明德', {}), null);
  assert.strictEqual(tb.resolveTrustLevel(undefined, undefined), null);
});

// ── 重新握手覆盖 ──
test('重新握手后旧别名不残留（指向新会话）', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession({ session_id: 'old' }));
  tb.registerHandshakeSession(mkSession({ session_id: 'new' }));
  const r = tb.resolveTrustLevel('x', { sender: { url: 'http://csbc.lilozkzy.top:3100/' } });
  assert.strictEqual(r.sessionId, 'new');
  // 别名数量应保持稳定（不因重复注册而膨胀）
  const before = tb.aliases.size;
  tb.registerHandshakeSession(mkSession({ session_id: 'newer' }));
  assert.strictEqual(tb.aliases.size, before, '重复注册不得让别名无限膨胀');
});

// ── 别名冲突告警 ──
test('同名不同主机会告警（不静默覆盖）', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession(), { names: ['明德'] });
  const warns = [];
  const orig = console.warn;
  console.warn = (...a) => warns.push(a.join(' '));
  try {
    tb.registerHandshakeSession(mkSession({ caller_id: 'mingde@other.host:3100' }), { names: ['明德'] });
  } finally { console.warn = orig; }
  assert.ok(warns.some(w => w.includes('别名冲突')), '应告警，不能静默覆盖');
});

// ── listSessions ──
test('listSessions 带别名、跳过已过期', () => {
  const tb = new TrustBridge();
  tb.registerHandshakeSession(mkSession());
  tb.registerHandshakeSession(mkSession({ caller_id: 'gone@x:1', ttl: 0, session_id: 'gone' }));
  const list = tb.listSessions();
  assert.strictEqual(list.length, 1, '过期会话不该出现在列表里');
  assert.ok(list[0].aliases.includes('csbc.lilozkzy.top:3100'));
});

console.log(`\n通过: ${passed}\n失败: ${failed}\n`);
process.exit(failed > 0 ? 1 : 0);
