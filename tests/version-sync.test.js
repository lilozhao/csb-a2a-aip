#!/usr/bin/env node
/**
 * tests/version-sync.test.js — 版本号「单一事实源」必须真的单一
 * ------------------------------------------------------------------
 * 起因（2026-10-28 · 若琢反馈）：
 *   发 v5.3.11 时只改了 package.json 的 version，漏了 VERSION 文件。
 *   而 server_v5.js 读的是 **VERSION 文件**（10-24 定的单一事实源）
 *   → 服务明明跑着 5.3.11 的代码，/health 却报 5.3.10。
 *
 * 这类偏差最坏的地方不是"报错"，而是**外观正常**：
 *   谁都没崩，只是所有"你跑的是哪个版本"的判断从此不可信——
 *   aat-doctor 会拿错的版本去比，线上排障会对着错的版本查 bug。
 *   跟 ac94694（配置在、代码没了）同族：**看起来在正常工作**。
 *
 * 所以这里不查"版本够不够新"，只查**各处声明是否一致**——机械可比对。
 *
 * 用法: node tests/version-sync.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}: ${e.message}`); }
}

const readTrim = (f) => {
  const p = path.join(ROOT, f);
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null;
};
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
const fileVersion = readTrim('VERSION');

console.log('\n版本一致性（单一事实源）');

test('VERSION 文件存在且非空', () => {
  assert.ok(fileVersion, 'VERSION 文件缺失或为空');
});

test('VERSION 与 package.json 完全一致', () => {
  assert.strictEqual(fileVersion, pkgVersion,
    `VERSION=${fileVersion} 但 package.json=${pkgVersion}（server_v5.js 读 VERSION，会报错版本）`);
});

test('VERSION 形如 x.y.z', () => {
  assert.match(fileVersion || '', /^\d+\.\d+\.\d+$/, `VERSION="${fileVersion}" 不是 x.y.z`);
});

// CHANGELOG 里必须有对应版本的段落，否则「改了但没记账」
test('CHANGELOG 有该版本段落', () => {
  const cl = readTrim('CHANGELOG.md') || '';
  assert.ok(cl.includes(`## v${pkgVersion}`), `CHANGELOG 缺 "## v${pkgVersion}" 段落`);
});

// 发版流程里最容易漏的就是"只改一处"：把该改的清单显式列出来，
// 让下一个人（或下一个我）照着改，不用再去翻 server_v5.js 猜。
console.log('\n发版清单（改版本号时逐项过）');
for (const f of ['VERSION', 'package.json', 'CHANGELOG.md']) {
  const ok = f === 'CHANGELOG.md' ? (readTrim(f) || '').includes(`## v${pkgVersion}`) : true;
  console.log(`  ${ok ? '·' : '!'} ${f}`);
}

console.log(`\n通过: ${passed}\n失败: ${failed}`);
process.exit(failed > 0 ? 1 : 0);
