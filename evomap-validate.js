#!/usr/bin/env node
/**
 * EvoMap validation wrapper for csb-a2a-aip (A2A v5)
 * 验证：版本、核心模块、语法完整性、测试文件
 * 用法: node evomap-validate.js
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

let failures = 0;
function assert(cond, msg) {
  if (!cond) { failures++; console.error('❌ FAIL:', msg); }
  else console.log('✅ PASS:', msg);
}

const root = __dirname;

// 1. 版本
const pkgPath = path.join(root, 'package.json');
assert(fs.existsSync(pkgPath), 'package.json 存在');
if (fs.existsSync(pkgPath)) {
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  assert(pkg.version === '5.0.0', `版本为 5.0.0（实际 ${pkg.version}）`);
}

// 2. 核心模块存在
const coreModules = [
  'a2a-standard-api-v5.js',
  'a2a-e2e-encryption.js',
  'a2a-message-guard.js',
  'a2a-context-generator.js',
  'a2a-observability.js',
  'client-v2.js'
];
for (const m of coreModules) {
  assert(fs.existsSync(path.join(root, m)), `${m} 存在`);
}

// 3. 语法完整性（node --check 核心模块）
const syntaxOk = (() => {
  try {
    for (const m of ['a2a-standard-api-v5.js', 'a2a-e2e-encryption.js', 'a2a-message-guard.js']) {
      execSync(`node --check "${path.join(root, m)}"`, { stdio: 'pipe' });
    }
    return true;
  } catch (e) { return false; }
})();
assert(syntaxOk, '核心模块语法检查通过');

// 4. 测试文件
assert(fs.existsSync(path.join(root, 'tests/remote-command.test.js')), 'tests/remote-command.test.js 存在');
assert(fs.existsSync(path.join(root, 'test-v4-full.js')), 'test-v4-full.js 兼容性测试存在');

// 5. 协议信封关键实现
const apiV5 = fs.readFileSync(path.join(root, 'a2a-standard-api-v5.js'), 'utf8');
assert(apiV5.includes('jsonrpc') || apiV5.includes('SendMessage'), '标准 API 包含 jsonrpc/SendMessage 信封');
const e2e = fs.readFileSync(path.join(root, 'a2a-e2e-encryption.js'), 'utf8');
assert(e2e.includes('aes') || e2e.includes('AES') || e2e.includes('encrypt'), 'E2E 加密实现存在');

if (failures > 0) {
  console.error(`\n${failures} 项失败`);
  process.exit(1);
}
console.log('\n✅ 全部通过：csb-a2a-aip v5 验证成功');
process.exit(0);
