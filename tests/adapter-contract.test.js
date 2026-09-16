#!/usr/bin/env node
/**
 * adapter-contract.test.js —— **适配器契约门禁**（每个适配器都必须过）
 *
 * 缘起：2026-09-16 给 Hermes 写适配器时，「同名函数 ≠ 同契约」一晚踩三次
 *   （参数名 / 返回结构 / 缺省语义），两次是「逐参数逐字段对照」能挡住的。
 * ⇒ 本测试 = 那道门禁：**在 adapters/ 下新增适配器，必须自动通过这里**。
 *
 * 用法: node tests/adapter-contract.test.js
 */
'use strict';
const assert = require('assert');
const path = require('path');
const { validateAdapter, listAdapters } = require('../adapters/_contract');

let passed = 0, failed = 0;
function t(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed++; console.log(`  ✅ ${name}`); })
    .catch((e) => { failed++; console.log(`  ❌ ${name}\n     ${e.message}`); });
}

(async () => {
  console.log('\n[adapter-contract · 门禁]\n');

  const adapters = listAdapters(path.join(__dirname, '..', 'adapters'));
  await t(`发现适配器 ${adapters.length} 个：${adapters.map((a) => a.name).join(', ')}`, () => {
    assert.ok(adapters.length >= 2, '至少应有 openclaw-gateway 与 hermes');
  });

  for (const { name, file } of adapters) {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const adapter = require(file);

    await t(`${name}：契约校验（方法齐备 / 纯函数行为 / 配置字段 / CONTRACT 声明）`, () => {
      const r = validateAdapter(adapter, { name });
      assert.ok(r.ok, r.errors.join(' | '));
    });

    await t(`${name}：fetchResult 在「无凭证」时应**不抛错**且返回 {ok:false,error}`, async () => {
      const savedTok = process.env.OPENCLAW_GATEWAY_TOKEN;
      const savedA2ATok = process.env.A2A_GATEWAY_TOKEN;
      delete process.env.OPENCLAW_GATEWAY_TOKEN;
      delete process.env.A2A_GATEWAY_TOKEN;
      try {
        const r = await adapter.fetchResult('contract-probe-task', { path: 'C' });
        assert.strictEqual(typeof r, 'object', '应返回对象');
        assert.strictEqual(r.ok, false, '无凭证时应 ok:false');
        assert.strictEqual(typeof r.error, 'string', '应带可读 error');
      } finally {
        if (savedTok !== undefined) process.env.OPENCLAW_GATEWAY_TOKEN = savedTok;
        if (savedA2ATok !== undefined) process.env.A2A_GATEWAY_TOKEN = savedA2ATok;
      }
    });

    await t(`${name}：canonical 参数名 sinceMs 被接受（毫秒时间下界）`, () => {
      const src = require('fs').readFileSync(file, 'utf8');
      assert.ok(/opts\.sinceMs/.test(src), '必须接受 opts.sinceMs（bridge 传的就是它）');
    });
  }

  // 反向自检：门禁本身要能抓出「缺 CONTRACT」的假适配器
  await t('门禁自检：缺 CONTRACT / 缺方法 / 结构不符 的假适配器必须被判失败', () => {
    const fake = { inject() {}, injectIsolated() {}, resolveConfig: () => ({}), fetchResult: async () => ({ ok: true }), buildInjectMessage: () => 'x' };
    const r = validateAdapter(fake, { name: 'fake' });
    assert.strictEqual(r.ok, false, '假适配器必须不通过');
    assert.ok(r.errors.some((e) => /CONTRACT/.test(e)), '应报出缺 CONTRACT');
    assert.ok(r.errors.some((e) => /detectRefusal/.test(e)), '应报出缺方法');
    assert.ok(r.errors.some((e) => /channel/.test(e)), '应报出 resolveConfig 缺字段');
  });

  console.log(`\n结果：${passed} 通过 / ${failed} 失败（共 ${passed + failed}）\n`);
  if (failed > 0) process.exit(1);
})();
