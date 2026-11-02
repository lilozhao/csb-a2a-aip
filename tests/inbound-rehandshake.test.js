#!/usr/bin/env node
/**
 * B 类「一次性重新握手续期」工具的口径测试
 *
 * 判据：
 *   1. 通知文本必须写明「怎么续期」（X-CSB-AAT 头 + 受众要对）
 *   2. 通知文本不能说对方是冒充的 —— 只能说「我这边没有你的凭据」
 *   3. --card 的结果必须自带免责说明（端点自称 ≠ 同一 agent）
 *   4. 没有影子日志时不许编数据
 *
 * 运行：node tests/inbound-rehandshake.test.js
 */
'use strict';
const assert = require('assert');
const { noticeFor } = require('../scripts/inbound-rehandshake.js');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); pass++; }
  catch (e) { console.log(`  ❌ ${name}\n     ${e.message}`); fail++; }
}

console.log('\n=== 通知文本口径 ===');
const txt = noticeFor('若辰', '');
t('写明续期步骤（X-CSB-AAT 头）', () => assert.ok(txt.includes('X-CSB-AAT')));
t('写明受众要对（受众混淆会被拒）', () => assert.ok(txt.includes('受众')));
t('不下「判定为冒名」这种结论（只说「我这边没有你的凭据」）', () => {
  assert.ok(!/判定为冒名|确认冒名|你确实是冒充/.test(txt));
  assert.ok(txt.includes('不是说你'), '必须有一句明确的免责说明');
  assert.ok(txt.includes('无法机械核对'), '要说清是「核不了」不是「查实了」');
});
t('说明灰度期只记不拦（不制造恐慌）', () => assert.ok(txt.includes('只记不拦')));
t('说明可复核（日志可逐条查）', () => assert.ok(txt.includes('可逐条复核')));
t('提供来源时把来源带出来（便于对方自查）', () => {
  assert.ok(noticeFor('若辰', 'http://172.28.0.13:3100').includes('172.28.0.13:3100'));
});
t('没来源时不硬编一行「无」', () => {
  assert.ok(!noticeFor('若辰', '').includes('我这边记录的来源'));
});

console.log('\n=== 无数据不编造 ===');
t('日志不存在 → 输出「不报假数据」，不出现 0 条统计', () => {
  const { execFileSync } = require('child_process');
  const path = require('path');
  const out = execFileSync(process.execPath, [
    path.join(__dirname, '..', 'scripts', 'inbound-rehandshake.js'), '--pending',
    '--log', '/nonexistent/shadow.jsonl',
  ], {
    encoding: 'utf8',
    env: { ...process.env, A2A_INBOUND_AUTH_LOG: '/nonexistent/shadow.jsonl' },
  });
  assert.ok(out.includes('不报假数据') || out.includes('还没有影子记录'), out);
});

console.log(`\n${fail === 0 ? '✅' : '❌'} inbound-rehandshake: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
