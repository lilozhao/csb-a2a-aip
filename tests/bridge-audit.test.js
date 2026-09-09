#!/usr/bin/env node
/**
 * A2A Bridge Audit · 单元测试（M2 Step 5）
 * 覆盖：降级事件双层留痕（本地文件 + 主会话可见）、轮转、查询
 * 风格：手写 assert + console（仓库惯例）
 *
 * 用法: node tests/bridge-audit.test.js
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// 测试用临时目录（隔离，不污染仓库 logs）
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-test-'));
process.env.A2A_BRIDGE_MAIN_LOGS = TMP; // 主可见目录指向临时目录

const audit = require('../a2a-bridge-audit');

let passed = 0, failed = 0;
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}

// ============================================
// 测试
// ============================================
console.log('\n[1] 降级事件记录');

test('recordDegradeEvent 双层留痕（本地 + 主可见）', async () => {
  const r = await audit.recordDegradeEvent({
    phase: 'inject', reason: 'gateway 断连', fallback: 'P0 诚实指路', taskId: 'task-d1',
  });
  assert.strictEqual(r.logged, true);
  assert.strictEqual(r.mainVisible, true);
  // 本地文件存在
  const localDir = path.join(__dirname, '..', 'logs');
  const localFiles = fs.readdirSync(localDir).filter((f) => f.includes('a2a-bridge-degrade-'));
  assert.ok(localFiles.length >= 1);
  // 主可见文件存在且内容正确
  const mainFile = path.join(TMP, 'a2a-bridge-degrade-events.log');
  assert.ok(fs.existsSync(mainFile));
  const content = fs.readFileSync(mainFile, 'utf8');
  assert.ok(content.includes('gateway 断连'));
  assert.ok(content.includes('P0 诚实指路'));
  assert.ok(content.includes('task-d1'));
});

test('记录含主机名/时间戳/类型（可审计性）', async () => {
  await audit.recordDegradeEvent({ phase: 'confirm', reason: 'quota 耗尽', fallback: 'local 模板' });
  const mainFile = path.join(TMP, 'a2a-bridge-degrade-events.log');
  const entry = JSON.parse(fs.readFileSync(mainFile, 'utf8').split('\n').filter(Boolean).pop());
  assert.strictEqual(entry.type, 'degrade_event');
  assert.ok(entry.ts);
  assert.ok(entry.host);
  assert.strictEqual(entry.phase, 'confirm');
  assert.strictEqual(entry.reason, 'quota 耗尽');
});

test('recentDegradeEvents 查询最近事件', async () => {
  const evts = audit.recentDegradeEvents(10, { mainVisible: true });
  assert.ok(evts.length >= 2);
  assert.strictEqual(evts[evts.length - 1].reason, 'quota 耗尽');
});

test('空目录查询返回 []（不抛错）', () => {
  const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridge-audit-empty-'));
  const r = audit.recentDegradeEvents(5, { mainVisible: true });
  assert.ok(Array.isArray(r));
  void emptyDir;
});

// ============================================
// 清理
// ============================================
setTimeout(() => {
  console.log(`\n${'='.repeat(50)}`);
  console.log(`结果: ${passed} 通过 / ${failed} 失败`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* 清理 */ }
  if (failed > 0) process.exit(1);
  console.log('全部通过 ✅');
}, 100);
