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

/**
 * 读 identity 里的注入适配器声明（读不到就返回空串，不抛）
 *
 * ★★ 2026-09-16 重要修正（墨丘指出）：**不得复用 `identity.adapter`！**
 *   `llm-router.js:299` → `preferredAdapter = A2A_ADAPTER || identity.adapter`
 *   —— 该字段是 **LLM 路由专属**（取值如 direct/openclaw/hermes/openai）。
 *   复用它会把「注入通道」和「模型后端」两件事绑死：改一个会连带改另一个。
 *   ⇒ 注入适配器改用**专用字段** `injectAdapter`（或 `bridge.injectAdapter`），env 仍最高优先。
 */
function readIdentityInfo() {
  try {
    const p = process.env.A2A_IDENTITY_PATH || path.join(__dirname, '..', 'identity.json');
    if (!fs.existsSync(p)) return { injectAdapter: '', platform: '' };
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      injectAdapter: String((j.injectAdapter || (j.bridge && j.bridge.injectAdapter) || '')).trim(),
      platform: String(j.platform || '').trim(),
    };
  } catch (_) { return { injectAdapter: '', platform: '' }; }
}

/** 兼容旧名（返回注入适配器声明，**不再**读 identity.adapter） */
function readIdentityAdapter() { return readIdentityInfo().injectAdapter; }

/** 归一化种类名：env > 专用字段 > platform > 默认 openclaw */
function resolveAdapterKind() {
  const info = readIdentityInfo();
  const raw = process.env.A2A_BRIDGE_ADAPTER || info.injectAdapter || info.platform || 'openclaw';
  return String(raw).trim().toLowerCase();
}

/** 返回适配器模块（openclaw-gateway | hermes） */
function resolveInjectAdapter() {
  const kind = resolveAdapterKind();
  if (kind === 'hermes') return require('./hermes');
  return require('./openclaw-gateway');
}

module.exports = { resolveInjectAdapter, resolveAdapterKind, readIdentityAdapter, readIdentityInfo };
