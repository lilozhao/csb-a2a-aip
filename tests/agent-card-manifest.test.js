#!/usr/bin/env node
/**
 * agent-card-manifest.test.js —— Agent Card `harness_manifest` / `experience_ref` 验收
 *
 * 对应 Harness² 对照表 P0 #4：
 *   「csb-a2a-aip Agent Card 加 harness_manifest」——让「可携带」从口号变字段
 *   判据（原文）：manifest 缺 skills[] 或 plugins[] → 判 N/A，不硬凑
 *
 * 字段实现见提交 0062b44（2026-10-20），彼时无测试；本文件补齐。
 * 风格：手写 assert（仓库惯例）。
 *
 * 用法：node tests/agent-card-manifest.test.js
 */

'use strict';

const assert = require('assert');
const card = require('../agent-card/schema');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

const BASE = {
  name: '若兰 🌸',
  id: 'agent-ruolan-001',
  type: 'persistent',
  capabilities: [{ name: 'forum.post' }],
  endpoints: { 'a2a': 'http://127.0.0.1:3100' },
  status: 'online',
};

// ── 1. 未声明 → 判 N/A，不硬凑 ──────────────────────────
t('未提供 harness_manifest → 卡上无该字段（不生成空壳）', () => {
  const c = card.build(BASE);
  assert.strictEqual(c.harness_manifest, undefined);
});

t('提供 C1–C8 全部声明 → n_a 为空，components 八个都在', () => {
  const comps = {};
  ['C1', 'C2', 'C3', 'C4', 'C5', 'C6', 'C7', 'C8'].forEach(k => {
    comps[k] = { version: '1.0', readonly: k === 'C1' || k === 'C2', note: '' };
  });
  const c = card.build({ ...BASE, harness_manifest: { version: '1', components: comps } });
  assert.strictEqual(c.harness_manifest.n_a.length, 0);
  assert.strictEqual(Object.keys(c.harness_manifest.components).length, 8);
});

t('只声明 C1/C2 → 其余六块进 n_a（透明呈现，不猜）', () => {
  const c = card.build({
    ...BASE,
    harness_manifest: { components: { C1: { readonly: true }, C2: { readonly: true } } },
  });
  assert.deepStrictEqual(c.harness_manifest.n_a, ['C3', 'C4', 'C5', 'C6', 'C7', 'C8']);
});

// ── 2. 红线：C1/C2 必须 readonly:true ────────────────────
t('C1 声明 readonly:false → validate 报错（红线：C1 只读）', () => {
  const c = card.build({
    ...BASE,
    harness_manifest: { components: { C1: { readonly: false }, C2: { readonly: true } } },
  });
  const v = card.validate(c);
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(e => /C1.*readonly:true/.test(e)), '应指出 C1 必须 readonly:true');
});

t('C2 声明 readonly:false → validate 报错', () => {
  const c = card.build({
    ...BASE,
    harness_manifest: { components: { C1: { readonly: true }, C2: { readonly: false } } },
  });
  const v = card.validate(c);
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(e => /C2.*readonly:true/.test(e)));
});

t('C1/C2 均 readonly:true → validate 通过', () => {
  const c = card.build({
    ...BASE,
    harness_manifest: { components: { C1: { readonly: true }, C2: { readonly: true } } },
  });
  const v = card.validate(c);
  assert.strictEqual(v.valid, true, v.errors.join('; '));
});

t('未声明 C1/C2（不在清单里）→ 不报 readonly 错（未声明 ≠ 违规）', () => {
  const c = card.build({
    ...BASE,
    harness_manifest: { components: { C3: { readonly: false } } },
  });
  const v = card.validate(c);
  assert.strictEqual(v.valid, true, v.errors.join('; '));
});

// ── 3. skills[] / plugins[] ─────────────────────────────
t('skills 提供 → 规范化保留 name/version/domain', () => {
  const c = card.build({
    ...BASE,
    harness_manifest: {
      skills: [{ name: 'forum-post', version: '2.0', domain: 'community' }],
    },
  });
  const s = c.harness_manifest.skills;
  assert.strictEqual(s.length, 1);
  assert.deepStrictEqual(s[0], { name: 'forum-post', version: '2.0', domain: 'community' });
});

t('skills 缺 name 的条目 → 被过滤（不猜名字）', () => {
  const c = card.build({
    ...BASE,
    harness_manifest: { skills: [{ version: '1.0' }, { name: 'ok' }, null] },
  });
  assert.strictEqual(c.harness_manifest.skills.length, 1);
  assert.strictEqual(c.harness_manifest.skills[0].name, 'ok');
});

t('未提供 skills → 空数组（不是 null，也不是硬凑一条）', () => {
  const c = card.build({ ...BASE, harness_manifest: { components: {} } });
  assert.deepStrictEqual(c.harness_manifest.skills, []);
});

t('plugins 同 skills 规则', () => {
  const c = card.build({
    ...BASE,
    harness_manifest: { plugins: [{ name: 'a2a-server', version: '5.0.0' }, { version: 'x' }] },
  });
  assert.strictEqual(c.harness_manifest.plugins.length, 1);
});

// ── 4. experience_ref（C3 EXPERIENCE 层指针）────────────
t('experience_ref 被保留到卡上', () => {
  const c = card.build({ ...BASE, experience_ref: 'csb://mem/experience/ruolan' });
  assert.strictEqual(c.experience_ref, 'csb://mem/experience/ruolan');
});

t('未提供 experience_ref → 不生成该字段', () => {
  const c = card.build(BASE);
  assert.strictEqual(c.experience_ref, undefined);
});

// ── 5. components 结构异常 ──────────────────────────────
t('harness_manifest.components 非对象 → validate 报错', () => {
  const c = card.build({ ...BASE, harness_manifest: { components: {} } });
  c.harness_manifest.components = 'oops';   // 手改
  const v = card.validate(c);
  assert.strictEqual(v.valid, false);
  assert.ok(v.errors.some(e => /components 必须是对象/.test(e)));
});

t('非 C1–C8 的键 → 被忽略（不认识的不偷塞进来）', () => {
  const c = card.build({
    ...BASE,
    harness_manifest: { components: { C1: { readonly: true }, C99: { readonly: false } } },
  });
  assert.strictEqual(c.harness_manifest.components.C99, undefined);
});

// ── 汇总 ────────────────────────────────────────────────
console.log(`\n[agent-card-manifest] 通过: ${passed} / 失败: ${failed}\n`);
if (failed > 0) process.exit(1);
