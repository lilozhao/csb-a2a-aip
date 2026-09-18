#!/usr/bin/env node
/**
 * a2a_confirm_cli.js —— WorkBuddy 宿主的 L3 人工确认入口（主会话用）
 *
 * 用途：桥接层遇到 scope=write/shell 的委托时不会自己执行，而是落一条 pending 记录；
 *       主会话（知音在野 / 若辰）看过摘要后，用本 CLI 批准或拒绝。
 *
 * 用法：
 *   node a2a_confirm_cli.js list                 列出待确认
 *   node a2a_confirm_cli.js show <taskId>        看某条详情
 *   node a2a_confirm_cli.js approve <taskId> [人] 批准
 *   node a2a_confirm_cli.js decline <taskId> [人] 拒绝
 *
 * 作者: 若辰 ✨ · 2026-09-18
 */
'use strict';

const fs = require('fs');
const path = require('path');

// 载入 .env（确认读回凭证等），与 start_a2a_server.bat 同源
const ENV_PATH = path.join(__dirname, '.env');
try {
  for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !line.trim().startsWith('#')) process.env[m[1]] = m[2];
  }
} catch (_) { /* 无 .env 则依赖外部环境 */ }

const adapter = require('./adapters/workbuddy-local');

function listRecords() {
  const dir = adapter.confirmDir();
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { return null; }
    })
    .filter(Boolean);
}

function show(rec) {
  console.log(`taskId   : ${rec.taskId}`);
  console.log(`scope    : ${rec.scope}`);
  console.log(`委托方   : ${rec.delegator}`);
  console.log(`请求时间 : ${rec.requestedAt}`);
  console.log(`期限     : ${rec.deadlineAt || '(未声明)'}`);
  console.log(`状态     : ${rec.decision}${rec.by ? ` (by ${rec.by} @ ${rec.decidedAt})` : ''}`);
  console.log('任务摘要 :');
  console.log(String(rec.summary || '').split('\n').map((l) => '  ' + l).join('\n'));
}

const [cmd, taskId, by] = process.argv.slice(2);

if (cmd === 'list') {
  const recs = listRecords();
  if (recs.length === 0) { console.log('（无确认记录）'); process.exit(0); }
  for (const r of recs) {
    console.log(`${r.decision === 'pending' ? '⏳' : r.decision === 'approve' ? '✅' : '❌'} ${r.taskId}  scope=${r.scope}  from=${r.delegator}  ${r.decision}`);
  }
  process.exit(0);
}

if (cmd === 'show' && taskId) {
  const rec = listRecords().find((r) => r.taskId === taskId);
  if (!rec) { console.error('未找到:', taskId); process.exit(1); }
  show(rec);
  process.exit(0);
}

if ((cmd === 'approve' || cmd === 'decline') && taskId) {
  const rec = listRecords().find((r) => r.taskId === taskId);
  if (!rec) { console.error('未找到待确认任务:', taskId); process.exit(1); }
  if (rec.decision !== 'pending') { console.error('该任务已有结论:', rec.decision); process.exit(1); }
  console.log('—— 确认前请核对 ——');
  show(rec);
  const out = adapter.resolveConfirm(taskId, cmd === 'approve' ? 'approve' : 'decline', by || '知音在野');
  console.log(`\n已记录：${out.decision} by ${out.by} @ ${out.decidedAt}`);
  process.exit(0);
}

console.log('用法:');
console.log('  node a2a_confirm_cli.js list');
console.log('  node a2a_confirm_cli.js show <taskId>');
console.log('  node a2a_confirm_cli.js approve <taskId> [确认人]');
console.log('  node a2a_confirm_cli.js decline <taskId> [确认人]');
process.exit(1);
