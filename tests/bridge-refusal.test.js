#!/usr/bin/env node
/**
 * detectRefusal 「裸词误判」回归测试 · 2026-09-15
 * 背景：原实现对整个回复全域匹配裸词（/拒绝|不能执行|…/），
 *   执行成功的回执里带统计数字「拒绝 4」→ 被误判为拒绝 → target_refused 假阴性。
 * 覆盖：2 个真实误判样本 + 4 类真拒绝 + 正常执行。
 * 用法: node tests/bridge-refusal.test.js
 */
const assert = require('assert');
const { detectRefusal } = require('../adapters/openclaw-gateway');

let passed = 0, failed = 0;
function t(name, input, expected) {
  const got = detectRefusal(input);
  try { assert.strictEqual(got, expected); passed++; console.log(`  ✅ ${name}`); }
  catch { failed++; console.log(`  ❌ ${name}\n     期望 ${expected} 实得 ${got}\n     输入: ${JSON.stringify(String(input).slice(0, 80))}`); }
}

console.log('\n[detectRefusal 误判回归 · 2026-09-15]');

// —— 真实误判样本（执行成功，必须 false）——
t('执行成功回执含「拒绝 4」统计数字', '✅ 桥接委托已执行\n- delegator: 若兰\n- summary: 任务总数 466（完成 452 / 失败 3 / 拒绝 4 / 取消 1）', false);
t('执行成功回执含 uptime/hostname（首条 5.9s 那条）', '✅ 任务执行完毕｜hostname: a2683e996a1d｜A2A 5.0.0 / uptime 34994s\n 执行的命令: curl http://127.0.0.1:3100/health', false);
t('正常执行总结', '已执行完毕，结果如下：git HEAD 为 c40e229，工作区 0 改动。', false);
t('长报告中后段出现「拒绝」不误伤（窗口外）', '✅ 完成。'.padEnd(320, '数据') + ' 拒绝执行本委托的进程数为 4', false);

// —— 真拒绝（必须 true）——
t('显式标记 ⛔', '⛔ 我拒绝执行该委托（超出我的权限范围）', true);
t('语式化拒绝 + 动作', '我拒绝执行该任务。', true);
t('抱歉 + 不能执行', '抱歉，我不能执行这个任务。', true);
t('无权处理', '无权处理该请求，请找宿主。', true);
t('超出能力', '这个请求超出我的能力范围。', true);
t('英文 decline to execute', 'I decline to execute this task.', true);
t('英文 out of scope', 'This is out of scope for me.', true);

console.log(`\n结果: ${passed} 通过 · ${failed} 失败\n`);
process.exit(failed ? 1 : 0);
