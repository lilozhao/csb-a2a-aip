#!/usr/bin/env node
/**
 * adapters/_contract.js —— 注入适配器**契约校验器**（门禁）
 *
 * 缘起（2026-09-16）：为 Hermes 写适配器时，「同名函数 ≠ 同契约」一晚踩三次：
 *   ① 参数名 `sinceMs`（bridge）vs `since`（adapter）
 *   ② 返回结构：bridge 读 `resp.result`，适配器没给 → `collectTexts(undefined)` → **静默从不解析**
 *   ③ 缺省语义：`path` 默认值不同（一方自带实现、一方靠默认）
 * ⇒ 三次里两次是「**逐参数/逐字段对照**」能挡住的。本文件把这个动作**固化为一套门禁**。
 *
 * 用法：
 *   const { validateAdapter, listAdapters } = require('./_contract');
 *   const r = validateAdapter(require('./hermes'), { name:'hermes' });
 *   if (!r.ok) throw new Error(r.errors.join('; '));
 *
 * 约定：**以 `adapters/openclaw-gateway.js` 为参照实现**（唯一被实践证明可用的）。
 * 作者：若兰 🌸 · 2026-09-16
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** bridge 会调用/消费的适配器方法（缺一即不可用） */
const REQUIRED_METHODS = [
  'inject', 'injectIsolated', 'resolveConfig', 'fetchResult', 'buildInjectMessage', 'detectRefusal',
];

/**
 * fetchResult **成功**返回里必须存在的键
 * - `result`：bridge 的读回循环调 `collectTexts(resp.result)`；缺它 ⇒ 静默空读（本轮真因 #2）
 * - `ok`：ok!==true 时 bridge 视为失败
 */
const REQUIRED_SUCCESS_KEYS = ['ok', 'result'];

/** resolveConfig 必须提供的键（bridge / confirm 都读） */
const REQUIRED_CONFIG_KEYS = ['channel', 'sessionKey', 'mainTo'];

/** canonical 参数名（bridge → adapter）。新适配器必须接受这些名字 */
const CANONICAL_PARAMS = {
  fetchResult: ['taskId', 'sinceMs', 'limit', 'sessionKey'],
  inject: ['envelopeOrFrame', 'taskIdOrOpts', 'maybeOpts'],
};

function validateAdapter(adapter, { name = '(anonymous)' } = {}) {
  const errors = [];
  if (!adapter || typeof adapter !== 'object') {
    return { ok: false, name, errors: ['适配器不是对象'] };
  }

  // 1. 方法齐备
  for (const m of REQUIRED_METHODS) {
    if (typeof adapter[m] !== 'function') errors.push(`缺少方法 ${m}()`);
  }

  // 2. 纯函数行为（无副作用，可直接跑）
  if (typeof adapter.buildInjectMessage === 'function') {
    try {
      const s = adapter.buildInjectMessage({ taskId: 'T1', delegatorLabel: 'X', envelope: {} });
      if (typeof s !== 'string' || !s.includes('T1')) {
        errors.push('buildInjectMessage 应返回**含 taskId** 的字符串（注入帧靠它定位）');
      }
    } catch (e) { errors.push('buildInjectMessage 抛错: ' + e.message); }
  }
  if (typeof adapter.detectRefusal === 'function') {
    try {
      if (adapter.detectRefusal('⛔ 拒绝执行') !== true) errors.push('detectRefusal 未识别显式拒绝标记（⛔ 开头）');
      if (adapter.detectRefusal('任务处理完成。统计：完成 452 / 拒绝 4') !== false) {
        errors.push('detectRefusal 误伤：长报告里的统计数字不应判为拒绝');
      }
    } catch (e) { errors.push('detectRefusal 抛错: ' + e.message); }
  }
  if (typeof adapter.resolveConfig === 'function') {
    try {
      const c = adapter.resolveConfig();
      for (const k of REQUIRED_CONFIG_KEYS) if (!(k in (c || {}))) errors.push(`resolveConfig 返回缺字段 ${k}`);
    } catch (e) { errors.push('resolveConfig 抛错: ' + e.message); }
  }

  // 3. 契约声明（显式、可机读）
  const decl = adapter.CONTRACT;
  if (!decl || decl.version !== 1) {
    errors.push('缺少 `CONTRACT` 声明（应为 { version: 1, fetchResultSuccessKeys: [...] }）');
  } else {
    const keys = decl.fetchResultSuccessKeys || [];
    for (const k of REQUIRED_SUCCESS_KEYS) {
      if (!keys.includes(k)) errors.push(`CONTRACT.fetchResultSuccessKeys 缺 '${k}'（bridge 读回依赖它）`);
    }
  }

  return { ok: errors.length === 0, name, errors };
}

/** 发现 adapters/ 下的所有适配器（排除 select/_contract/index） */
function listAdapters(dir = __dirname) {
  const skip = new Set(['select.js', '_contract.js', 'index.js']);
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.js') && !skip.has(f) && !f.startsWith('.'))
    .map((f) => ({ name: f.replace(/\.js$/, ''), file: path.join(dir, f) }));
}

module.exports = { validateAdapter, listAdapters, REQUIRED_METHODS, REQUIRED_SUCCESS_KEYS, REQUIRED_CONFIG_KEYS, CANONICAL_PARAMS };
