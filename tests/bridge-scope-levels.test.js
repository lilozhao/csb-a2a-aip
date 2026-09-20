#!/usr/bin/env node
/**
 * A2A Bridge · 档位映射镜像单测（⑤ W-1 · 2026-09-20）
 * 验证 SCOPE_LEVELS 由「生成镜像」提供：四档齐全、frozen、带 AUTO-GENERATED 头、core 直接消费。
 * 风格：手写 assert + console（仓库惯例）。
 * 用法: node tests/bridge-scope-levels.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const bridge = require('../a2a-bridge-core');
const mirror = require('../a2a-scope-levels');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

test('SCOPE_LEVELS 四档齐全且映射正确', () => {
  assert.deepStrictEqual({ ...bridge.SCOPE_LEVELS }, { read: 'L2', notify: 'L2', write: 'L3', shell: 'L3' });
});

test('core 直接消费镜像（同一对象，非复制）', () => {
  assert.strictEqual(bridge.SCOPE_LEVELS, mirror);
});

test('镜像是 frozen 常量', () => {
  assert.ok(Object.isFrozen(mirror));
});

test('镜像带 AUTO-GENERATED 头（防手改）', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'a2a-scope-levels.js'), 'utf8');
  assert.ok(/AUTO-GENERATED/.test(src), '缺 AUTO-GENERATED 标记');
});

test('requiredLevel 与映射一致：write/shell→L3，read/notify→L2', () => {
  assert.strictEqual(bridge.requiredLevel('write'), 'L3');
  assert.strictEqual(bridge.requiredLevel('shell'), 'L3');
  assert.strictEqual(bridge.requiredLevel('read'), 'L2');
  assert.strictEqual(bridge.requiredLevel('notify'), 'L2');
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
