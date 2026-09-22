#!/usr/bin/env node
/**
 * [T-5 / 2026-09-22] 「对外广告地址」单一真相源 测试
 *
 * 背景：
 *   `/.well-known/ai-catalog.json` 曾硬编码 http://172.28.0.5:3100（抄模板残留）——
 *   于是每个 v5 实例的 catalog 都广告成阿轩的地址（全社区通病）。
 *   本测试钉死 a2a-advertise-host.js 的优先级 + 源码里不再残留该硬编码。
 *
 * 风格：手写 assert + console（仓库惯例，无测试框架）
 * 用法: node tests/advertise-host.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const resolve = require('../a2a-advertise-host.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log('\n[T-5] a2a-advertise-host 单一真相源\n');

t('env A2A_HOST 最高优先', () => {
  const old = process.env.A2A_HOST;
  process.env.A2A_HOST = '10.0.0.9';
  try {
    assert.strictEqual(resolve({ publicHost: 'a', host: 'b' }, null), '10.0.0.9');
  } finally { old === undefined ? delete process.env.A2A_HOST : (process.env.A2A_HOST = old); }
});

t('无 env → identity.publicHost', () => {
  const old = process.env.A2A_HOST; delete process.env.A2A_HOST;
  try { assert.strictEqual(resolve({ publicHost: 'a', host: 'b' }, null), 'a'); }
  finally { if (old !== undefined) process.env.A2A_HOST = old; }
});

t('无 publicHost → identity.host', () => {
  const old = process.env.A2A_HOST; delete process.env.A2A_HOST;
  try { assert.strictEqual(resolve({ host: 'b' }, null), 'b'); }
  finally { if (old !== undefined) process.env.A2A_HOST = old; }
});

t('都缺 → config.getSelf().host', () => {
  const old = process.env.A2A_HOST; delete process.env.A2A_HOST;
  try { assert.strictEqual(resolve({}, { getSelf: () => ({ host: 'c' }) }), 'c'); }
  finally { if (old !== undefined) process.env.A2A_HOST = old; }
});

t('config.getSelf 抛错 → 兜底 localhost（不抛）', () => {
  const old = process.env.A2A_HOST; delete process.env.A2A_HOST;
  try { assert.strictEqual(resolve({}, { getSelf: () => { throw new Error('boom'); } }), 'localhost'); }
  finally { if (old !== undefined) process.env.A2A_HOST = old; }
});

t('全空 → localhost', () => {
  const old = process.env.A2A_HOST; delete process.env.A2A_HOST;
  try { assert.strictEqual(resolve(null, null), 'localhost'); }
  finally { if (old !== undefined) process.env.A2A_HOST = old; }
});

// 去掉注释行，只在「有效代码」里查残留（注释里提到 bug 历史是允许的）
function codeOnly(src) {
  return src.split('\n').filter(l => {
    const s = l.trim();
    return !(s.startsWith('//') || s.startsWith('*') || s.startsWith('/*'));
  }).join('\n');
}

t('server_v5.js 代码中不再硬编码 172.28.0.5:3100', () => {
  const src = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server_v5.js'), 'utf8'));
  assert.ok(!src.includes('172.28.0.5:3100'), 'server_v5.js 代码仍含 172.28.0.5:3100');
});

t('server_v4.js 代码中不再硬编码 172.28.0.5:3100', () => {
  const src = codeOnly(fs.readFileSync(path.join(__dirname, '..', 'server_v4.js'), 'utf8'));
  assert.ok(!src.includes('172.28.0.5:3100'), 'server_v4.js 代码仍含 172.28.0.5:3100');
});

console.log(`\n  ${pass} 通过 / ${fail} 失败\n`);
process.exit(fail ? 1 : 0);
