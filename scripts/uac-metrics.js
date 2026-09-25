#!/usr/bin/env node
/**
 * uac-metrics.js —— UAC 运营指标（P3 · 2026-09-25）
 *
 * **只读**：读信任账本 → 聚合指标。不写账、不产生副作用。
 * 口径（详见 docs/UAC-P3-PLAN.md §2 R3）：
 *   M1 自动放行率   = auto_approved ÷ (auto_approved + not_hit)   ← 分母写死＝「带 UAC 的判定」
 *   M2 未命中原因分布（reason 码表以 a2a-bridge-uac.js 为准）
 *   M3 每 peer 用量（有策略时给 rate 用量比）
 *   M4 按日趋势（< 3 天不给趋势，标 insufficient）
 *   M5 策略变更 / 签发 计数
 *
 * BR-12：取不到 → null / N/A，**不写 0 冒充**。
 * 指标只描述，**不参与放行判定**（不做 KPI，不设目标值）。
 *
 * 用法:
 *   node scripts/uac-metrics.js [--days 7] [--since D --until D]
 *                               [--policy config/bridge-uac-policy.json] [--ledger <path>] [--json]
 */
'use strict';
const path = require('path');
const fs = require('fs');
const tk = require(path.join(__dirname, '..', 'a2a-uac-toolkit.js'));
const obs = require(path.join(__dirname, '..', 'a2a-uac-observability.js'));

const arg = (n, d = null) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d; };
const has = (n) => process.argv.includes(n);

const days = arg('--days', null);
let from = arg('--since', null), to = arg('--until', null);
if (!from && !to && days) {
  const n = parseInt(days, 10);
  if (!Number.isFinite(n) || n <= 0) { console.error('❌ --days 需为正整数'); process.exit(2); }
  to = new Date().toISOString().slice(0, 10);
  from = new Date(Date.now() - (n - 1) * 86400000).toISOString().slice(0, 10);
}

const polPath = path.resolve(arg('--policy', path.join(__dirname, '..', 'config', 'bridge-uac-policy.json')));
const policy = tk.readJsonSafe(polPath);

const led = obs.readLedger({ ledgerPath: arg('--ledger', null) });
const m = obs.computeMetrics(led.entries, { from, to, policy });

const out = {
  generatedAt: new Date().toISOString(),
  ledgerPath: led.ledgerPath,
  ledgerExists: led.exists,
  ledgerEntries: led.entries.length,
  chainValid: led.chainValid,
  readError: led.error || null,
  policyPath: polPath,
  policyExists: fs.existsSync(polPath),
  window: m.window,
  ...m,
};

if (has('--json')) { console.log(JSON.stringify(out, null, 2)); process.exit(0); }

const pct = (x) => (x === null || x === undefined ? 'N/A' : `${(x * 100).toFixed(1)}%`);
const num = (x) => (x === null || x === undefined ? 'N/A' : String(x));

console.log('📊 UAC 运营指标');
console.log(`   账本：${led.exists ? led.ledgerPath : '不在（N/A）'} · 条目 ${led.entries.length} · 链校验=${led.chainValid === null ? 'N/A' : led.chainValid ? '✅' : '❌'}`);
console.log(`   窗口：${from || '不限'} → ${to || '不限'} · 窗口内 UAC 相关条目 ${m.window.rows}`);
console.log('');
console.log(`【M1 自动放行率】${pct(m.M1_autoApproveRate.rate)}  （放行 ${m.M1_autoApproveRate.hits} / 未命中 ${m.M1_autoApproveRate.notHits} · 分母=${m.M1_autoApproveRate.denominator}）`);
if (m.M1_autoApproveRate.note) console.log(`   ⚠️ ${m.M1_autoApproveRate.note}`);
console.log(`【M2 未命中原因】${Object.keys(m.M2_notHitReasons).length ? Object.entries(m.M2_notHitReasons).map(([k, v]) => `${k}×${v}`).join(' · ') : 'N/A（窗口内无未命中）'}`);
console.log('【M3 每 peer 用量】');
if (!m.M3_perPeer.length) console.log('   N/A（窗口内无带 UAC 的判定）');
for (const p of m.M3_perPeer) {
  console.log(`   - ${p.agentId} · 放行 ${p.hits} / 未命中 ${p.notHits}`
    + (p.rateMax ? ` · 额度 ${num(p.usedInWindow)}/${p.rateMax}（${p.usagePct === null ? 'N/A' : p.usagePct + '%'}）` : ' · 无 rate 策略'));
  if (!p.policyPresent) console.log('     ⚠️ 该 peer 已不在当前策略里（历史条目）');
}
console.log(`【M4 按日趋势】${m.M4_dailyTrend.sufficient ? '' : 'insufficient · '}`);
if (m.M4_dailyTrend.days.length) {
  for (const d of m.M4_dailyTrend.days) console.log(`   ${d.day}  放行 ${d.hits} / 未命中 ${d.notHits}  → ${pct(d.rate)}`);
} else console.log('   N/A（无数据）');
if (!m.M4_dailyTrend.sufficient) console.log(`   ⚠️ ${m.M4_dailyTrend.note}`);
console.log(`【M5 变更/签发】策略变更 ${m.M5_changes.policyChanges} 条${Object.keys(m.M5_changes.byOp).length ? `（${Object.entries(m.M5_changes.byOp).map(([k, v]) => `${k}×${v}`).join(' · ')}）` : ''} · 签发 ${m.M5_changes.issued} 条`);
console.log('\n（指标只描述，不参与放行判定；取不到记 N/A，不记 0）');
