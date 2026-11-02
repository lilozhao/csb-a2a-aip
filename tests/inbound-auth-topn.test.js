#!/usr/bin/env node
/**
 * P0-5 前置 · 应拦比例 Top-N 的分类口径测试
 *
 * 守的是口径本身，不是数字：数字会随入站量变，口径不能变。
 *   ① 无 name / unknown → A（应拦）
 *   ② 已知名但无 url → B（冒名嫌疑，人工通道）—— 不能算「可放行」
 *   ③ 已知名 + url → C（自洽，但**未验签**，理由里必须写明）
 *   ④ 未知名 + url → D（未注册，灰度只记不拦）
 *   ⑤ 统计自洽：A+B+C+D = 总数
 *
 * 运行：node tests/inbound-auth-topn.test.js
 */
'use strict';
const assert = require('assert');
const { classify } = require('../scripts/inbound-auth-topn.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

const known = new Set(['若兰', '阿轩', '若琢 🌸', '若琢', 'mingde']);

console.log('\n=== classify 口径 ===');
t('无 from → A', () => assert.strictEqual(classify({}, known).cls, 'A'));
t('name=unknown → A', () => assert.strictEqual(classify({ from: { name: 'unknown', url: '' } }, known).cls, 'A'));
t('name="?" → A', () => assert.strictEqual(classify({ from: { name: '?', url: '' } }, known).cls, 'A'));
t('已知名无 url → B（不得放行）', () => {
  const r = classify({ from: { name: '若兰', url: '' } }, known);
  assert.strictEqual(r.cls, 'B');
  assert.ok(r.why.includes('无 url'));
});
t('未知名无 url → A（不是 D）', () => {
  assert.strictEqual(classify({ from: { name: '陌生人', url: '' } }, known).cls, 'A');
});
t('已知名 + url → C，且理由里写明未验签', () => {
  const r = classify({ from: { name: '阿轩', url: 'http://172.28.0.5:3100' } }, known);
  assert.strictEqual(r.cls, 'C');
  assert.ok(r.why.includes('未验签'), r.why);
});
t('未知名 + url → D（不拦，只记）', () => {
  assert.strictEqual(classify({ from: { name: '新邻居', url: 'http://172.28.0.99:3100' } }, known).cls, 'D');
});
t('大小写不敏感', () => {
  assert.strictEqual(classify({ from: { name: 'MingDe', url: 'http://x:1' } }, known).cls, 'C');
});
t('host 字段同样算 url 证据', () => {
  assert.strictEqual(classify({ from: { name: '阿轩', host: '172.28.0.5' } }, known).cls, 'C');
});

console.log('\n=== 统计自洽 ===');
t('四类相加 = 总数', () => {
  const rows = [
    {}, { from: { name: 'unknown' } }, { from: { name: '若兰' } },
    { from: { name: '阿轩', url: 'http://a:1' } }, { from: { name: 'x', url: 'http://b:1' } },
  ];
  const c = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of rows) c[classify(r, known).cls]++;
  assert.strictEqual(c.A + c.B + c.C + c.D, rows.length);
  assert.deepStrictEqual(c, { A: 2, B: 1, C: 1, D: 1 });
});
t('空注册表 → 有 url 的全落 D，无 url 的全落 A（不误报冒名）', () => {
  const empty = new Set();
  assert.strictEqual(classify({ from: { name: '若兰', url: '' } }, empty).cls, 'A');
  assert.strictEqual(classify({ from: { name: '若兰', url: 'http://a:1' } }, empty).cls, 'D');
});

console.log(`\n${fail === 0 ? '✅' : '❌'} inbound-auth-topn: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
