#!/usr/bin/env node
/**
 * uac-audit.js —— UAC 审计查询（P3 · 2026-09-25）
 *
 * **只读**：读信任账本、过滤、打印。不写账、不产生副作用（验收 A6）。
 * 数据源：`delegate_auto_approved`（P2）+ `delegate_uac_not_hit` / `uac_policy_changed` / `uac_issued`（P3）
 *
 * 用法:
 *   node scripts/uac-audit.js [--since 2026-09-20] [--until 2026-09-25]
 *                             [--peer 小虾] [--result hit|not_hit] [--reason uac_invalid]
 *                             [--jti <jti>] [--action <事件名>] [--all] [--limit 50]
 *                             [--ledger <path>] [--json]
 *
 * 说明:
 *   - 默认只看 **UAC 相关事件**（--all 才看全部账本条目）
 *   - `--limit N` 取**最近 N 条**（过滤后）
 *   - 取不到 → 显式报 `N/A`，不拿 0 冒充（BR-12）
 */
'use strict';
const path = require('path');
const obs = require(path.join(__dirname, '..', 'a2a-uac-observability.js'));

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

const q = {
  from: arg('--since', null),
  to: arg('--until', null),
  peer: arg('--peer', null),
  result: arg('--result', null),
  reason: arg('--reason', null),
  jti: arg('--jti', null),
  action: arg('--action', null),
  all: has('--all'),
  limit: arg('--limit', null) ? parseInt(arg('--limit'), 10) : 0,
};
if (q.result && !['hit', 'not_hit'].includes(q.result)) { console.error('❌ --result 只能是 hit | not_hit'); process.exit(2); }

const led = obs.readLedger({ ledgerPath: arg('--ledger', null) });
const { rows, total, shown } = obs.queryEntries(led.entries, q);

const result = {
  ledgerPath: led.ledgerPath,
  ledgerExists: led.exists,
  chainValid: led.chainValid,
  signed: led.signed,
  readError: led.error || null,
  filter: q,
  entriesInLedger: led.entries.length,
  matched: total,
  shown,
  rows,
};

if (has('--json')) { console.log(JSON.stringify(result, null, 2)); process.exit(0); }

const fmtTs = (ts) => new Date(ts).toISOString().replace('T', ' ').slice(0, 19);
console.log(`🔎 UAC 审计查询 · ${led.ledgerPath}`);
console.log(`   账本：${led.exists ? `在（${led.entries.length} 条）` : '不在'} · 链校验=${led.chainValid === null ? 'N/A' : led.chainValid ? '✅' : '❌'} · 签名=${led.signed === null ? 'N/A' : led.signed ? '✅' : '❌（未签名）'}`);
if (led.error) console.log(`   ⚠️ 读取告警：${led.error}`);
const fdesc = Object.entries(q).filter(([, v]) => v !== null && v !== false && v !== 0).map(([k, v]) => `${k}=${v}`).join(' ');
console.log(`   过滤：${fdesc || '(无)'} → 命中 ${total} 条${shown !== total ? `（显示最近 ${shown} 条）` : ''}`);
if (!rows.length) {
  console.log('\n（窗口内无匹配条目 —— 这不是「零事件」，是「查不到」：先确认账本装配与 UAC 是否真跑过）');
  process.exit(0);
}
console.log('');
console.log('   时间(UTC)            | peer        | 事件                      | 摘要');
console.log('   ' + '-'.repeat(100));
for (const e of rows) {
  const peer = e.subjectId || (e.subject && e.subject.name) || '?';
  const detail = (e.evidence && e.evidence.detail) || e.note || '';
  console.log(`   ${fmtTs(e.ts)} | ${String(peer).padEnd(11)} | ${String(e.action).padEnd(25)} | ${String(detail).slice(0, 72)}`);
}
console.log('');
