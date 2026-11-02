#!/usr/bin/env node
/**
 * P0-5 灰度观察期日报：读 shadow 日志，回答三个问题
 *   ① 这两周里有多少调用「本会被拦」（wouldBlock）
 *   ② 拦的都是谁（Top-N），有没有真邻居被误伤（B 类）
 *   ③ 观察期还剩多少天（到 2026-11-16）
 *
 * 用法：
 *   node scripts/inbound-auth-shadow-report.js
 *   node scripts/inbound-auth-shadow-report.js --log <path>
 *   node scripts/inbound-auth-shadow-report.js --json
 *
 * 判据：只读日志，不改任何东西。日志不存在 → 明确说「还没有数据」，不编 0。
 */
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const OBSERVE_START = '2026-11-02';
const OBSERVE_END = '2026-11-16';

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}
const asJson = process.argv.includes('--json');
const logFile = path.resolve(arg('--log', process.env.A2A_INBOUND_AUTH_LOG || path.join(ROOT, 'logs', 'inbound-auth-shadow.jsonl')));

function daysLeft(now = new Date()) {
  const end = new Date(`${OBSERVE_END}T23:59:59+08:00`);
  return Math.max(0, Math.ceil((end - now) / 86400000));
}

function main() {
  if (!fs.existsSync(logFile)) {
    const msg = `还没有影子记录：${path.relative(ROOT, logFile)} 不存在 → 说明中间件未生效或观察期尚未开始（不报假数据）`;
    if (asJson) console.log(JSON.stringify({ ok: false, reason: 'no_log', file: logFile, observe: { start: OBSERVE_START, end: OBSERVE_END }, daysLeft: daysLeft() }, null, 2));
    else console.log(`\n⏳ ${msg}\n`);
    return;
  }
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

  const byCls = { A: 0, B: 0, C: 0, D: 0 };
  const perName = new Map();
  let wouldBlock = 0;
  let withAat = 0;

  for (const r of rows) {
    if (byCls[r.cls] !== undefined) byCls[r.cls]++;
    if (r.wouldBlock) wouldBlock++;
    if (r.hasAat) withAat++;
    const key = r.name || '(无名)';
    const cur = perName.get(key) || { name: key, total: 0, wouldBlock: 0, cls: r.cls, url: r.url || '' };
    cur.total++; if (r.wouldBlock) cur.wouldBlock++;
    perName.set(key, cur);
  }

  const top = [...perName.values()].sort((a, b) => b.wouldBlock - a.wouldBlock || b.total - a.total).slice(0, 10);
  const out = {
    ok: true, file: logFile, entries: rows.length,
    range: rows.length ? [rows[0].ts, rows[rows.length - 1].ts] : [],
    observe: { start: OBSERVE_START, end: OBSERVE_END, daysLeft: daysLeft() },
    classes: byCls,
    wouldBlock,
    wouldBlockPct: rows.length ? Math.round((wouldBlock / rows.length) * 1000) / 10 : null,
    withAat,
    top,
  };

  if (asJson) return console.log(JSON.stringify(out, null, 2));

  console.log(`\n📊 入站鉴权 shadow 观察期日报`);
  console.log(`   日志：${path.relative(ROOT, logFile)}  ${rows.length} 条`);
  console.log(`   观察期：${OBSERVE_START} → ${OBSERVE_END}（剩 ${daysLeft()} 天）\n`);
  console.log(`   本会被拦（wouldBlock）：${wouldBlock} 条  ${out.wouldBlockPct}%`);
  console.log(`   带 AAT 头：${withAat} 条\n`);
  for (const k of ['A', 'B', 'C', 'D']) console.log(`   ${k}  ${String(byCls[k]).padStart(4)} 条`);
  console.log('\n   Top-N（按会被拦条数）');
  for (const x of top) if (x.wouldBlock) console.log(`     ${String(x.name).padEnd(14)} 总 ${String(x.total).padStart(3)} ｜ 会拦 ${String(x.wouldBlock).padStart(3)} ｜ ${x.cls} ｜ ${x.url || '(无 url)'}`);
  console.log('');
}

if (require.main === module) main();
module.exports = { daysLeft, OBSERVE_START, OBSERVE_END };
