#!/usr/bin/env node
/**
 * adapters-select.test.js —— 注入适配器选择（P0-D 装配）单元测试
 * 覆盖：默认 openclaw（零行为变化）/ env 覆盖 / identity.adapter / identity.platform / 大小写与空白
 * 用法: node tests/adapters-select.test.js
 */
'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0, failed = 0;
function t(name, fn) {
  try { fn(); passed++; console.log(`  ✅ ${name}`); }
  catch (e) { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); }
}

const SEL = '../adapters/select';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'csb-sel-'));
function withIdentity(obj, fn) {
  const p = path.join(tmpDir, `identity-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(p, JSON.stringify(obj));
  const old = process.env.A2A_IDENTITY_PATH;
  process.env.A2A_IDENTITY_PATH = p;
  try { return fn(); } finally {
    if (old === undefined) delete process.env.A2A_IDENTITY_PATH; else process.env.A2A_IDENTITY_PATH = old;
    try { fs.unlinkSync(p); } catch (_) {}
  }
}
function freshSel() { delete require.cache[require.resolve(SEL)]; return require(SEL); }

console.log('\n[adapters/select · P0-D]\n');

t('1. 默认（无 env 无 identity）→ openclaw', () => {
  delete process.env.A2A_BRIDGE_ADAPTER;
  const s = withIdentity({ name: 'x', platform: 'openclaw' }, freshSel);
  assert.strictEqual(s.resolveAdapterKind(), 'openclaw');
  const a = s.resolveInjectAdapter();
  assert.ok(typeof a.inject === 'function');
  assert.ok(typeof a.invokeTool === 'function', '应为 openclaw-gateway');
});

t('2. env A2A_BRIDGE_ADAPTER=hermes → hermes（env 优先级最高）', () => {
  process.env.A2A_BRIDGE_ADAPTER = 'hermes';
  const s = withIdentity({ name: 'x', adapter: 'openclaw' }, freshSel);
  assert.strictEqual(s.resolveAdapterKind(), 'hermes');
  delete process.env.A2A_BRIDGE_ADAPTER;
});

t('3. identity.adapter=hermes → hermes', () => {
  delete process.env.A2A_BRIDGE_ADAPTER;
  let got;
  withIdentity({ name: 'x', adapter: 'hermes' }, () => { got = freshSel().resolveInjectAdapter(); });
  assert.strictEqual(got, require('../adapters/hermes'));
});

t('4. identity.platform=hermes → hermes（回退字段）', () => {
  delete process.env.A2A_BRIDGE_ADAPTER;
  let kind;
  withIdentity({ name: 'x', platform: 'Hermes' }, () => { kind = freshSel().resolveAdapterKind(); });
  assert.strictEqual(kind, 'hermes', '应大小写不敏感');
});

t('5. 未知 kind → 回退 openclaw（不抛）', () => {
  process.env.A2A_BRIDGE_ADAPTER = 'something-else';
  const s = freshSel();
  assert.strictEqual(s.resolveInjectAdapter(), require('../adapters/openclaw-gateway'));
  delete process.env.A2A_BRIDGE_ADAPTER;
});

t('6. identity 缺失/坏 JSON → 不抛，回退 openclaw', () => {
  delete process.env.A2A_BRIDGE_ADAPTER;
  const old = process.env.A2A_IDENTITY_PATH;
  process.env.A2A_IDENTITY_PATH = path.join(tmpDir, 'nope.json');
  const s = freshSel();
  assert.strictEqual(s.resolveAdapterKind(), 'openclaw');
  if (old === undefined) delete process.env.A2A_IDENTITY_PATH; else process.env.A2A_IDENTITY_PATH = old;
});

t('7. hermes 适配器具备 confirm 所需接口面（resolveConfig/fetchResult/invokeTool）', () => {
  const h = require('../adapters/hermes');
  for (const k of ['resolveConfig', 'fetchResult', 'invokeTool', 'inject', 'injectIsolated', 'buildInjectMessage']) {
    assert.strictEqual(typeof h[k], 'function', `hermes.${k} 应为函数`);
  }
});

(async () => {
  // 8. hermes.invokeTool 诚实失败（P0 未实现投递）
  const h = require('../adapters/hermes');
  const r = await h.invokeTool();
  t('8. hermes.invokeTool → {ok:false}（诚实失败，confirmL3 会拒绝而非放行）', () => {
    assert.strictEqual(r.ok, false);
    assert.match(r.error, /未实现/);
  });

  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）\n`);
  if (failed > 0) process.exit(1);
})();
