#!/usr/bin/env node
/**
 * prune-sessions.js — 精简会话列表（保守策略）
 * ============================================================
 * 只删「噪声」，保留所有真实对话与有标签的记录。
 *
 *   删：
 *     · :heartbeat 会话（任意年龄，纯心跳噪声）
 *     · cron :run: 子会话（超过 --days 天）
 *     · 桥接注入会话（超过 --days 天）—— 仅当 --include-bridge
 *   留：
 *     · agent:main:main（主会话）
 *     · feishu / 用户渠道会话
 *     · 任何有 label 的「名场面」记录（除非对应规则显式命中）
 *     · 最近 --days 天内的所有会话
 *
 * 用法：
 *   node scripts/prune-sessions.js                 # dry-run
 *   node scripts/prune-sessions.js --apply         # 真删
 *   node scripts/prune-sessions.js --apply --days 7 --include-bridge
 * ============================================================
 * 维护：若兰 🌸 · 2026-09-19
 */
'use strict';

const fs = require('fs');
const { execFile } = require('child_process');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const INCLUDE_BRIDGE = args.includes('--include-bridge');
const INCLUDE_RUNS = args.includes('--include-runs');   // 删所有 cron :run: 子会话（不限年龄）
const di = args.indexOf('--days');
const DAYS = di >= 0 ? parseInt(args[di + 1], 10) : 7;
const CUT = Date.now() - DAYS * 86400 * 1000;

const STORE = process.env.OPENCLAW_SESSIONS_STORE
  || '/home/node/.openclaw/agents/main/sessions/sessions.json';

function del(key) {
  return new Promise((resolve) => {
    execFile('openclaw', ['gateway', 'call', 'sessions.delete', '--params',
      JSON.stringify({ key }), '--json'], { timeout: 8000 },
      (err, stdout, stderr) => resolve({
        ok: !err,
        out: String(stdout || '') + String(stderr || '') + String((err && (err.stdout || err.stderr || err.message)) || ''),
      }));
  });
}

(async () => {
  const j = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  const store = j.sessions || j;
  const buckets = { 'heartbeat': [], 'cron-run': [], 'bridge': [], 'keep': [] };

  for (const [key, v] of Object.entries(store)) {
    const ts = (v && v.updatedAt) || 0;
    const old = ts && ts < CUT;
    if (key.startsWith('agent:main:main') || /:feishu:|:user:|user:/.test(key)) { buckets.keep.push(key); continue; }
    if (key.endsWith(':heartbeat')) { buckets.heartbeat.push(key); continue; }
    if (/:run:/.test(key)) { (INCLUDE_RUNS || old) ? buckets['cron-run'].push(key) : buckets.keep.push(key); continue; }
    if (/:openai:|:a2a-bridge-/.test(key)) {
      (INCLUDE_BRIDGE && old) ? buckets.bridge.push(key) : buckets.keep.push(key);
      continue;
    }
    buckets.keep.push(key);
  }

  const total = Object.keys(store).length;
  console.log(`store : ${STORE}`);
  console.log(`总计  : ${total}  | 模式: ${APPLY ? 'APPLY ✍️' : 'DRY-RUN 👀'}  | 阈值: ${DAYS} 天\n`);
  console.log(`  删除候选 · heartbeat        : ${buckets.heartbeat.length}`);
  console.log(`  删除候选 · cron :run:        : ${buckets['cron-run'].length}${INCLUDE_RUNS ? '' : `（仅 >${DAYS}d）`}`);
  console.log(`  删除候选 · bridge (>${DAYS}d)     : ${buckets.bridge.length}${INCLUDE_BRIDGE ? '' : '（未启用 --include-bridge）'}`);
  console.log(`  保留                       : ${buckets.keep.length}`);
  console.log(`  ── 拟删合计: ${buckets.heartbeat.length + buckets['cron-run'].length + buckets.bridge.length}\n`);

  const toDelete = [...buckets.heartbeat, ...buckets['cron-run'], ...buckets.bridge];
  if (!APPLY) { toDelete.slice(0, 60).forEach(k => console.log('  [dry] ' + k)); if (toDelete.length > 60) console.log(`  … 共 ${toDelete.length} 条`); return; }

  let ok = 0, fail = 0;
  for (const k of toDelete) { const r = await del(k); r.ok ? ok++ : (fail++, console.log(`  [ERR] ${k} :: ${r.out.slice(0, 80)}`)); }
  console.log(`\n--- 已删 ${ok} 条，失败 ${fail} 条 ---`);
})();
