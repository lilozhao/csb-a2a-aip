#!/usr/bin/env node
/**
 * tests/entrypoint.test.js — package 入口冒烟
 *
 * 背景（2026-11-28）：package.json 的 main/start 指向不存在的 server.js，
 *   新用户 `npm start` 直接 MODULE_NOT_FOUND。这个测试只做静态检查，
 *   不真的启动服务（避免占用 3100 / 触发注册表心跳）。
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));

test('main 指向真实存在的文件', () => {
  assert.ok(pkg.main, 'package.json 缺 main');
  assert.ok(fs.existsSync(path.join(ROOT, pkg.main)), `main 不存在: ${pkg.main}`);
});

test('start 脚本指向真实存在的文件', () => {
  const m = /^node\s+([^\s]+)/.exec(pkg.scripts?.start || '');
  assert.ok(m, `start 不是 node <file> 形式: ${pkg.scripts?.start}`);
  assert.ok(fs.existsSync(path.join(ROOT, m[1])), `start 目标不存在: ${m[1]}`);
});

test('入口文件只委托给 server_v5.js，不复制启动逻辑', () => {
  const entry = fs.readFileSync(path.join(ROOT, pkg.main), 'utf8');
  assert.match(entry, /require\(['"]\.\/server_v5\.js['"]\)/, '入口应 require ./server_v5.js');
  assert.doesNotMatch(entry, /app\.listen\(/, '入口不应自己 listen');
});
