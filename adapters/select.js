#!/usr/bin/env node
/**
 * adapters/select.js —— 注入适配器选择（P0-D 装配）
 *
 * 选择顺序（优先级从高到低）：
 *   1. env `A2A_BRIDGE_ADAPTER`（显式覆盖，便于灰度/回滚）
 *   2. identity.json 的 `adapter` 字段
 *   3. identity.json 的 `platform` 字段
 *   4. 默认 `openclaw`（**零行为变化**——未声明的实例照旧）
 *
 * 注意：**选到 hermes ≠ 已启用**。Hermes 侧还有独立开关 `A2A_BRIDGE_HERMES=off`（默认关），
 *      未开启时 hermes.inject 会抛错 → bridge core 走 C5 诚实降级（不会静默假成功）。
 *
 * 作者：若兰 🌸 · 2026-09-16
 */
'use strict';

const fs = require('fs');
const path = require('path');

/** 读 identity 里的 adapter/platform（读不到就返回空串，不抛） */
function readIdentityAdapter() {
  try {
    const p = process.env.A2A_IDENTITY_PATH || path.join(__dirname, '..', 'identity.json');
    if (!fs.existsSync(p)) return '';
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return String(j.adapter || j.platform || '').trim();
  } catch (_) { return ''; }
}

/** 归一化种类名 */
function resolveAdapterKind() {
  const raw = process.env.A2A_BRIDGE_ADAPTER || readIdentityAdapter() || 'openclaw';
  return String(raw).trim().toLowerCase();
}

/** 返回适配器模块（openclaw-gateway | hermes） */
function resolveInjectAdapter() {
  const kind = resolveAdapterKind();
  if (kind === 'hermes') return require('./hermes');
  return require('./openclaw-gateway');
}

module.exports = { resolveInjectAdapter, resolveAdapterKind, readIdentityAdapter };
